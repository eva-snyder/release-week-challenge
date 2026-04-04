import './App.css'
import { useEffect, useMemo, useState } from 'react'
import {
  apiFetch,
  clearStoredSessionId,
  setStoredSessionId,
  lastfmLoginUrl,
} from './authUrl'

type Session = {
  ok: true
  user: {
    id: number
    lastfm_username: string
    display_name: string | null
    is_artist: boolean
  }
}

type Campaign = {
  id: string
  title: string
  trackId: string
  trackName: string
  trackArtist: string
  startsAt: string
  endsAt: string
  startsAtMs: number
  endsAtMs: number
  status: 'upcoming' | 'live' | 'ended'
}

/** React 18 Strict Mode runs mount effects twice in dev — handoff tokens are one-time, so share one in-flight request. */
let handoffPromise: Promise<void> | null = null
let handoffTokenInFlight: string | null = null

async function runOAuthHandoffOnce(
  token: string,
  onSuccess: (raw: string) => void,
): Promise<void> {
  if (handoffPromise && handoffTokenInFlight === token) {
    await handoffPromise
    return
  }
  handoffTokenInFlight = token
  handoffPromise = (async () => {
    const res = await apiFetch('/auth/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const raw = await res.text()
    if (!res.ok) {
      let msg = raw
      try {
        const j = JSON.parse(raw) as { error?: string }
        if (j.error) msg = j.error
      } catch {
        /* keep raw */
      }
      throw new Error(msg || 'could not attach session')
    }
    onSuccess(raw)
  })()
  try {
    await handoffPromise
  } finally {
    handoffPromise = null
    handoffTokenInFlight = null
  }
}

function App() {
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [leaderboard, setLeaderboard] = useState<
    Array<{ lastfm_username: string; display_name: string | null; plays: number }>
  >([])
  const [leaderboardContacts, setLeaderboardContacts] = useState<
    Array<{
      lastfm_username: string
      display_name: string | null
      email: string | null
      plays: number
    }>
  >([])
  const [myStats, setMyStats] = useState<{
    mine: { plays: number; rank: number | null }
    campaign: { participants: number; total_plays: number }
  } | null>(null)

  function formatNetworkError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e)
    if (
      raw === 'Failed to fetch' ||
      raw === 'Load failed' ||
      /NetworkError|network request failed/i.test(raw)
    ) {
      return `Can't reach the API. Run both dev servers: (1) backend: cd backend && npm run dev  →  port 8787. (2) frontend: cd web && npm run dev  →  port 5173. Then open the URL Vite prints (e.g. http://127.0.0.1:5173).`
    }
    return raw
  }

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(formatNetworkError(e))
    } finally {
      setBusy(false)
    }
  }

  /** Resolves session first so a failed /api/campaign does not hide a valid login. */
  async function refreshDashboard(): Promise<Session | null> {
    const sRes = await apiFetch('/api/session')
    let nextSession: Session | null = null
    if (sRes.ok) {
      const sJson = (await sRes.json()) as Session
      setSession(sJson)
      nextSession = sJson

      const mRes = await apiFetch('/api/me/stats')
      if (mRes.ok) {
        const mJson = await mRes.json()
        setMyStats({ mine: mJson.mine, campaign: mJson.campaign })
      }
    } else {
      setSession(null)
      setMyStats(null)
      setLeaderboardContacts([])
    }

    const cRes = await apiFetch('/api/campaign')
    if (!cRes.ok) throw new Error(await cRes.text())
    const cJson = await cRes.json()
    setCampaign(cJson.campaign)

    const lbRes = await apiFetch('/api/leaderboard?limit=10')
    if (!lbRes.ok) throw new Error(await lbRes.text())
    const lbJson = await lbRes.json()
    setLeaderboard(lbJson.rows ?? [])

    if (nextSession?.user.is_artist) {
      const contRes = await apiFetch('/api/admin/leaderboard-contacts?limit=10')
      if (contRes.ok) {
        const contJson = (await contRes.json()) as {
          rows?: Array<{
            lastfm_username: string
            display_name: string | null
            email: string | null
            plays: number
          }>
        }
        setLeaderboardContacts(contJson.rows ?? [])
      } else {
        setLeaderboardContacts([])
      }
    } else {
      setLeaderboardContacts([])
    }

    setReady(true)

    return nextSession
  }

  useEffect(() => {
    run(async () => {
      const url = new URL(window.location.href)
      const authError = url.searchParams.get('auth_error')
      const oauthSession = url.searchParams.get('oauth_session')
      if (authError) throw new Error(authError)

      if (url.searchParams.has('connected')) {
        url.searchParams.delete('connected')
        const qs = url.searchParams.toString()
        window.history.replaceState({}, '', url.pathname + (qs ? `?${qs}` : '') + url.hash)
      }

      if (oauthSession) {
        await runOAuthHandoffOnce(oauthSession, (raw) => {
          try {
            const j = JSON.parse(raw) as { session_id?: string }
            if (j.session_id) setStoredSessionId(j.session_id)
          } catch {
            /* ignore */
          }
        })
        window.history.replaceState({}, '', url.origin + url.pathname)
      }

      const nextSession = await refreshDashboard()
      if (oauthSession) {
        if (nextSession) {
          const who =
            nextSession.user.display_name?.trim() || nextSession.user.lastfm_username
          setNotice(`signed in as ${who}`)
        } else {
          setNotice('handoff succeeded but session check failed — refresh and ensure the API on :8787 is running.')
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 12000)
    return () => window.clearTimeout(t)
  }, [notice])

  // Use a cache-busted URL so Chrome doesn't reuse a previously-cached redirect chain.
  const lastfmLoginHint = useMemo(
    () => lastfmLoginUrl({ cacheBust: true }),
    [],
  )

  const statusLabel = useMemo(() => {
    if (!campaign) return null
    if (campaign.status === 'upcoming') return 'not yet open'
    if (campaign.status === 'ended') return 'closed'
    const ms = campaign.endsAtMs - Date.now()
    const d = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
    return d <= 1 ? 'final day' : `${d} days left`
  }, [campaign])

  const showComingSoonBanner =
    ready && (campaign?.status === 'ended' || campaign === null)

  return (
    <div className="page app-lowercase">
      <div className="auth-bar" aria-label="Account">
        {session ? (
          <>
            <span className="auth-greet" title={session.user.lastfm_username}>
              hi, {session.user.display_name?.trim() || session.user.lastfm_username}
            </span>
            <span className="auth-pill auth-pill--ok">signed in</span>
            {session.user.is_artist ? (
              <span className="auth-pill">artist</span>
            ) : null}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() =>
                run(async () => {
                  const lr = await apiFetch('/auth/logout', { method: 'POST' })
                  if (!lr.ok) throw new Error(await lr.text())
                  clearStoredSessionId()
                  setSession(null)
                  setLeaderboard([])
                  setLeaderboardContacts([])
                  setMyStats(null)
                })
              }
            >
              log out
            </button>
          </>
        ) : (
          <div className="auth-signin">
            <a
              className="btn btn--primary"
              href={lastfmLoginHint}
            >
              sign in with last.fm
            </a>
          </div>
        )}
      </div>

      <header className="hero">
        {session ? (
          <p className="hero__hi" aria-live="polite">
            hi, {session.user.display_name?.trim() || session.user.lastfm_username}
          </p>
        ) : null}
        <h1 className="hero__title">eva's release week challenge</h1>
        <p className="hero__lede">
          {!ready ? 'loading…' : campaign?.title ?? 'no challenge yet.'}
          {campaign ? (
            <>
              {' '}
              · <code>{campaign.trackArtist}</code> — <code>{campaign.trackName}</code>
            </>
          ) : null}
        </p>
        <p className="hero__meta">
          {campaign ? (
            <>
              {new Date(campaign.startsAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}{' '}
              —{' '}
              {new Date(campaign.endsAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </>
          ) : ready ? (
            <span className="hero__status">waiting for a challenge</span>
          ) : null}
          {statusLabel ? <span className="hero__dot"> · </span> : null}
          {statusLabel ? <span className="hero__status">{statusLabel}</span> : null}
        </p>
        <div className="hero__rule" aria-hidden />
      </header>

      {showComingSoonBanner ? (
        <p className="challenge-banner" role="status">
          New challenge coming soon…
        </p>
      ) : null}

      <main className="main">
        <section className="band" aria-labelledby="stats-heading">
          <p className="eyebrow" id="stats-label">
            01 — you
          </p>
          <h2 id="stats-heading">your plays</h2>
          {session ? (
            <div className="stat-row">
              <div className="stat">
                <span className="stat__label">plays this window</span>
                <span className="stat__value">{myStats?.mine.plays ?? 0}</span>
              </div>
              <div className="stat">
                <span className="stat__label">rank</span>
                <span className="stat__value">
                  {myStats?.mine.rank != null ? `#${myStats.mine.rank}` : '—'}
                </span>
              </div>
            </div>
          ) : (
            <p className="body-quiet">
              sign in with last.fm to count scrobbles that match this track (link spotify → last.fm so plays
              appear).
            </p>
          )}
        </section>

        <section className="band" aria-labelledby="lb-heading">
          <div className="band__head">
            <div>
              <p className="eyebrow" id="lb-label">
                02 — everyone
              </p>
              <h2 id="lb-heading">leaderboard</h2>
              <p className="body-quiet body-quiet--tight">top ten for this challenge window.</p>
            </div>
            <button
              type="button"
              className="btn btn--text"
              disabled={busy}
              onClick={() => run(async () => refreshDashboard())}
            >
              refresh
            </button>
          </div>

          <div className="lb-table" role="table" aria-label="Leaderboard">
            <div className="lb-row lb-row--head" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">listener</span>
              <span role="columnheader">plays</span>
            </div>
            {leaderboard.length === 0 ? (
              <p className="lb-empty">no plays recorded yet.</p>
            ) : (
              leaderboard.map((row, i) => (
                <div className="lb-row" key={row.lastfm_username} role="row">
                  <span className="lb-rank" role="cell">
                    {i + 1}
                  </span>
                  <span role="cell">{row.display_name ?? 'listener'}</span>
                  <span className="lb-plays" role="cell">
                    {row.plays}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>

        {session?.user.is_artist ? (
          <section className="band band--artist" aria-labelledby="artist-heading">
            <p className="eyebrow">03 — behind the curtain</p>
            <h2 id="artist-heading">artist</h2>
            <div className="stat-row stat-row--tight">
              <div className="stat">
                <span className="stat__label">listeners on board</span>
                <span className="stat__value">{myStats?.campaign.participants ?? 0}</span>
              </div>
              <div className="stat">
                <span className="stat__label">total plays counted</span>
                <span className="stat__value">{myStats?.campaign.total_plays ?? 0}</span>
              </div>
            </div>
            {campaign?.status === 'live' || campaign?.status === 'upcoming' ? (
              <p className="body-quiet artist-tools__note">
                Scrobbles are polled until{' '}
                {campaign
                  ? new Date(campaign.endsAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : ''}
                . Ingest stops when the window closes.
              </p>
            ) : null}
            <button
              type="button"
              className="btn btn--outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const res = await apiFetch('/api/admin/ingest-now', {
                    method: 'POST',
                  })
                  if (!res.ok) throw new Error(await res.text())
                  await refreshDashboard()
                })
              }
            >
              pull latest from last.fm
            </button>

            <div className="artist-contacts">
              <h3 className="artist-contacts__title">listeners (top 10)</h3>
              <p className="body-quiet body-quiet--tight">
                Last.fm usernames for prize follow-up. Email is not collected via Last.fm sign-in.
              </p>
              {leaderboardContacts.length === 0 ? (
                <p className="body-quiet">no listeners with plays in this challenge yet.</p>
              ) : (
                <div className="artist-contacts__table" role="table" aria-label="Listener contact emails">
                  <div className="artist-contacts__row artist-contacts__row--head" role="row">
                    <span role="columnheader">#</span>
                    <span role="columnheader">name</span>
                    <span role="columnheader">last.fm</span>
                    <span role="columnheader">plays</span>
                  </div>
                  {leaderboardContacts.map((row, i) => (
                    <div className="artist-contacts__row" key={row.lastfm_username} role="row">
                      <span role="cell">{i + 1}</span>
                      <span role="cell">{row.display_name ?? '—'}</span>
                      <span role="cell" className="artist-contacts__email">
                        {row.lastfm_username}
                      </span>
                      <span role="cell">{row.plays}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}

        {(busy || error || notice) && (
          <div className="toast-row" role="status">
            {busy ? <span className="toast toast--muted">updating…</span> : null}
            {error ? <span className="toast toast--err">{error}</span> : null}
            {notice ? <span className="toast toast--ok">{notice}</span> : null}
          </div>
        )}
      </main>

      <footer className="footer">
        {/* <p className="footer__line">eva's release week challenge · spotify</p> */}
        <p className="footer__line">
          counts use last.fm scrobbles — connect spotify (or your player) to last.fm so listens show up. prize
          contact may use your last.fm username or a separate process you run as the artist.
        </p>
      </footer>
    </div>
  )
}

export default App

import './App.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FinishSignIn } from './FinishSignIn'
import {
  apiFetch,
  clearStoredSessionId,
  setStoredSessionId,
  lastfmLoginUrl,
  LASTFM_ACCOUNT_AND_SPOTIFY_SETUP_URL,
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

/** After opening Last.fm in the same browser, we poll until auth.getSession succeeds (Last.fm may not redirect to /auth/callback). */
const LASTFM_POLL_KEY = 'tl_lastfm_poll'
const LASTFM_POLL_MAX_MS = 15 * 60 * 1000
const LASTFM_POLL_INTERVAL_MS = 2000

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
      throw new Error('Could not finish signing in. Try again.')
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
  if (typeof window !== 'undefined' && window.location.pathname === '/auth/finish') {
    return <FinishSignIn />
  }

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
  const [lastfmFinishing, setLastfmFinishing] = useState(false)
  /** Bumped when starting Last.fm sign-in so the poll effect re-runs (localStorage alone does not re-render). */
  const [lastfmPollKick, setLastfmPollKick] = useState(0)

  function formatNetworkError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e)
    if (
      raw === 'Failed to fetch' ||
      raw === 'Load failed' ||
      /NetworkError|network request failed/i.test(raw)
    ) {
      return `Can't connect right now. Check your connection and try again.`
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
  const refreshDashboard = useCallback(async (): Promise<Session | null> => {
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
      // Stale cookie / sessionStorage id (new deploy, DB reset, multiple replicas, rotated SESSION_SECRET).
      if (sRes.status === 401) {
        try {
          const j = (await sRes.json()) as { error?: string }
          if (j.error === 'invalid_session' || j.error === 'session_expired') {
            clearStoredSessionId()
            await apiFetch('/auth/logout', { method: 'POST' })
          }
        } catch {
          /* ignore */
        }
      }
      setSession(null)
      setMyStats(null)
      setLeaderboardContacts([])
    }

    const cRes = await apiFetch('/api/campaign')
    if (!cRes.ok) throw new Error('Could not load the challenge.')
    const cJson = await cRes.json()
    setCampaign(cJson.campaign)

    const lbRes = await apiFetch('/api/leaderboard?limit=10')
    if (!lbRes.ok) throw new Error('Could not load the leaderboard.')
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
  }, [])

  useEffect(() => {
    if (session) return
    let cancelled = false
    let intervalId: number | undefined

    function readPollStart(): number | null {
      try {
        const raw = localStorage.getItem(LASTFM_POLL_KEY)
        if (!raw) return null
        const ts = Number(raw)
        if (!Number.isFinite(ts) || Date.now() - ts > LASTFM_POLL_MAX_MS) {
          localStorage.removeItem(LASTFM_POLL_KEY)
          return null
        }
        return ts
      } catch {
        return null
      }
    }

    async function tryCompleteOnce() {
      if (cancelled || readPollStart() == null) {
        setLastfmFinishing(false)
        return
      }
      setLastfmFinishing(true)
      const res = await apiFetch('/api/auth/try-complete-lastfm')
      if (cancelled) return
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        session_id?: string
        user?: Session['user']
      }
      if (j.ok && j.user) {
        try {
          localStorage.removeItem(LASTFM_POLL_KEY)
        } catch {
          /* ignore */
        }
        if (j.session_id) setStoredSessionId(j.session_id)
        await refreshDashboard()
        const who = j.user.display_name?.trim() || j.user.lastfm_username
        setNotice(`signed in as ${who}`)
        setLastfmFinishing(false)
        return
      }
      setLastfmFinishing(true)
    }

    if (readPollStart() == null) {
      setLastfmFinishing(false)
      return () => {
        cancelled = true
      }
    }

    void tryCompleteOnce()
    intervalId = window.setInterval(() => void tryCompleteOnce(), LASTFM_POLL_INTERVAL_MS)
    const onVis = () => void tryCompleteOnce()
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === LASTFM_POLL_KEY && ev.newValue) void tryCompleteOnce()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('storage', onStorage)
    return () => {
      cancelled = true
      if (intervalId) window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('storage', onStorage)
    }
  }, [session, refreshDashboard, lastfmPollKick])

  useEffect(() => {
    run(async () => {
      const url = new URL(window.location.href)
      const authError = url.searchParams.get('auth_error')
      const oauthSession = url.searchParams.get('oauth_session')
      if (authError) {
        if (authError === 'oauth_state_invalid_retry_sign_in') {
          throw new Error('That sign-in link expired. Try signing in again.')
        }
        throw new Error('Sign-in didn’t work. Try again.')
      }

      if (url.searchParams.has('connected')) {
        try {
          localStorage.removeItem(LASTFM_POLL_KEY)
        } catch {
          /* ignore */
        }
        url.searchParams.delete('connected')
        const qs = url.searchParams.toString()
        window.history.replaceState({}, '', url.pathname + (qs ? `?${qs}` : '') + url.hash)
      }

      if (oauthSession) {
        try {
          localStorage.removeItem(LASTFM_POLL_KEY)
        } catch {
          /* ignore */
        }
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
          setNotice('Signed in with Last.fm, but we could not load your account. Try refreshing the page.')
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDashboard])

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
                  if (!lr.ok) throw new Error('Could not log out. Try again.')
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
            <div className="auth-signin__actions">
              <a
                className="btn btn--primary"
                href={lastfmLoginHint}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  try {
                    localStorage.setItem(LASTFM_POLL_KEY, String(Date.now()))
                  } catch {
                    /* ignore */
                  }
                  setLastfmPollKick((k) => k + 1)
                }}
              >
                sign in with last.fm
              </a>
              <a
                className="btn btn--ghost"
                href={LASTFM_ACCOUNT_AND_SPOTIFY_SETUP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                new? set up last.fm + Spotify
              </a>
            </div>
            <p className="auth-hint body-quiet">
              Sign-in opens in a new tab. After you approve, come back here — we’ll finish automatically. Or{' '}
              <a href="/auth/finish">paste the Last.fm URL</a> if you’re on another device.
            </p>
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
              sign in with last.fm to count plays for this track.{' '}
              <a
                href={LASTFM_ACCOUNT_AND_SPOTIFY_SETUP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                no last.fm yet?
              </a>{' '}
              that page helps you create an account and connect Spotify so scrobbles show up.
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
                  if (!res.ok) throw new Error('Could not load the latest plays. Try again.')
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

        {(busy || error || notice || lastfmFinishing) && (
          <div className="toast-row" role="status">
            {busy ? <span className="toast toast--muted">updating…</span> : null}
            {error ? <span className="toast toast--err">{error}</span> : null}
            {notice ? <span className="toast toast--ok">{notice}</span> : null}
            {lastfmFinishing && !session ? (
              <span className="toast toast--muted">finishing sign-in…</span>
            ) : null}
          </div>
        )}
      </main>

      <footer className="footer">
        <p className="footer__line">
          counts use last.fm scrobbles — connect spotify (or your player) to last.fm so listens show up. prize
          contact may use your last.fm username or a separate process you run as the artist.
        </p>
      </footer>
    </div>
  )
}

export default App

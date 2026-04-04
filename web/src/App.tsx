import './App.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FinishSignIn } from './FinishSignIn'
import { LastfmSetupModal } from './LastfmSetupModal'
import {
  apiFetch,
  clearStoredSessionId,
  setStoredSessionId,
  lastfmLoginUrl,
} from './authUrl'
import {
  msUntilNextUtcQuarterHourBoundary,
  POST_INGEST_BURST_INTERVAL_SEC,
  POST_INGEST_BURST_TOTAL_SEC,
} from './ingestRefreshSchedule'

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
      mailing_address: string | null
      shirt_size: string | null
      marketing_opt_in?: number | boolean
      plays: number
    }>
  >([])
  const [prizeContact, setPrizeContact] = useState<{
    email: string | null
    mailing_address: string | null
    shirt_size: string | null
  } | null>(null)
  const [prizeContactLoading, setPrizeContactLoading] = useState(false)
  const [prizeForm, setPrizeForm] = useState({
    email: '',
    mailing_address: '',
    shirt_size: '' as string,
  })
  const [myStats, setMyStats] = useState<{
    mine: { plays: number; rank: number | null; is_prize_winner: boolean }
    campaign: { participants: number; total_plays: number }
  } | null>(null)
  const [marketingForm, setMarketingForm] = useState({
    email: '',
    marketing_opt_in: false,
  })
  /** When opted in, hide the form until the user taps "change preferences". */
  const [showMarketingPrefsForm, setShowMarketingPrefsForm] = useState(false)
  const [lastfmFinishing, setLastfmFinishing] = useState(false)
  /** Bumped when starting Last.fm sign-in so the poll effect re-runs (localStorage alone does not re-render). */
  const [lastfmPollKick, setLastfmPollKick] = useState(0)
  const [lastfmSetupOpen, setLastfmSetupOpen] = useState(false)

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
        const mJson = await mRes.json() as {
          mine: {
            plays: number
            rank: number | null
            is_prize_winner?: boolean
          }
          campaign: { participants: number; total_plays: number }
        }
        setMyStats({
          mine: {
            ...mJson.mine,
            is_prize_winner: Boolean(mJson.mine?.is_prize_winner),
          },
          campaign: mJson.campaign,
        })
      }

      const cpRes = await apiFetch('/api/me/contact-preferences')
      if (cpRes.ok) {
        const cp = (await cpRes.json()) as {
          email?: string | null
          marketing_opt_in?: boolean
        }
        setMarketingForm({
          email: cp.email?.trim() ?? '',
          marketing_opt_in: Boolean(cp.marketing_opt_in),
        })
      } else {
        setMarketingForm({ email: '', marketing_opt_in: false })
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
      setMarketingForm({ email: '', marketing_opt_in: false })
      setShowMarketingPrefsForm(false)
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
      const contRes = await apiFetch('/api/admin/leaderboard-contacts')
      if (contRes.ok) {
        const contJson = (await contRes.json()) as {
          rows?: Array<{
            lastfm_username: string
            display_name: string | null
            email: string | null
            mailing_address: string | null
            shirt_size: string | null
            marketing_opt_in?: number | boolean
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

  /**
   * After each UTC quarter-hour, refresh several times (every 15s for 2 minutes) so slow ingest
   * still updates the leaderboard without a manual tap.
   *
   * Runs for everyone while the challenge is live (not only signed-in users), so the public
   * leaderboard updates too.
   */
  useEffect(() => {
    if (!campaign || campaign.status !== 'live') return
    let cancelled = false
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function arm() {
      const waitMs = msUntilNextUtcQuarterHourBoundary()
      const boundaryWait = window.setTimeout(() => {
        if (cancelled) return
        for (let sec = 0; sec <= POST_INGEST_BURST_TOTAL_SEC; sec += POST_INGEST_BURST_INTERVAL_SEC) {
          timeouts.push(
            window.setTimeout(() => {
              if (cancelled) return
              void refreshDashboard()
            }, sec * 1000),
          )
        }
        timeouts.push(
          window.setTimeout(() => {
            if (cancelled) return
            arm()
          }, POST_INGEST_BURST_TOTAL_SEC * 1000 + 100),
        )
      }, waitMs)
      timeouts.push(boundaryWait)
    }

    arm()
    return () => {
      cancelled = true
      for (const id of timeouts) window.clearTimeout(id)
    }
  }, [campaign?.status, campaign?.id, refreshDashboard])

  /** Background tabs throttle timers; refresh once when the user comes back so the board catches up. */
  useEffect(() => {
    if (!campaign || campaign.status !== 'live') return
    function onVis() {
      if (document.visibilityState === 'visible') void refreshDashboard()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [campaign?.status, campaign?.id, refreshDashboard])

  /** Dev only: open `/?preview_winner=1` to preview the “you won” block without an ended challenge or rank #1. */
  const previewWinner =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview_winner') === '1'

  const isChallengeWinner =
    previewWinner ||
    (Boolean(session) &&
      campaign?.status === 'ended' &&
      myStats != null &&
      myStats.mine.is_prize_winner)

  useEffect(() => {
    if (!isChallengeWinner) {
      setPrizeContact(null)
      setPrizeForm({ email: '', mailing_address: '', shirt_size: '' })
      return
    }
    if (previewWinner && !session) {
      setPrizeContact(null)
      setPrizeForm({ email: '', mailing_address: '', shirt_size: '' })
      setPrizeContactLoading(false)
      return
    }
    let cancelled = false
    setPrizeContactLoading(true)
    apiFetch('/api/me/prize-contact')
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load prize form.')
        return res.json() as Promise<{
          ok?: boolean
          email: string | null
          mailing_address: string | null
          shirt_size: string | null
        }>
      })
      .then((j) => {
        if (cancelled) return
        setPrizeContact({
          email: j.email,
          mailing_address: j.mailing_address,
          shirt_size: j.shirt_size,
        })
        setPrizeForm({
          email: j.email ?? '',
          mailing_address: j.mailing_address ?? '',
          shirt_size: j.shirt_size ?? '',
        })
      })
      .catch(() => {
        if (!cancelled) setPrizeContact(null)
      })
      .finally(() => {
        if (!cancelled) setPrizeContactLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isChallengeWinner, campaign?.id, previewWinner, session])

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

  const showComingSoonBanner = ready && campaign === null

  const playsSection = (
    <section className="band" aria-labelledby="stats-heading">
      <p className="eyebrow" id="stats-label">
        {session ? '01 — you' : '02 — you'}
      </p>
      <h2 id="stats-heading">your plays</h2>
      {session ? (
        <>
          <div className="stat-row">
            <div className="stat stat--value-only">
              <span className="stat__value" aria-label="plays this challenge window">
                {myStats?.mine.plays ?? 0}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">rank</span>
              <span className="stat__value">
                {myStats?.mine.rank != null ? `#${myStats.mine.rank}` : '—'}
              </span>
            </div>
          </div>
          {campaign?.status === 'ended' &&
          myStats?.mine.rank === 1 &&
          myStats.mine.is_prize_winner === false ? (
            <p className="body-quiet body-quiet--tight plays-tie-note">
              you tied for #1 on plays — the shirt prize was randomly picked among everyone tied at the
              top.
            </p>
          ) : null}
        </>
      ) : (
        <p className="body-quiet">
          sign in above to see your plays and rank here.
        </p>
      )}
    </section>
  )

  const leaderboardSection = (
    <section className="band" aria-labelledby="lb-heading">
      <div className="band__head">
        <div>
          <p className="eyebrow" id="lb-label">
            {session ? '02 — everyone' : '01 — everyone'}
          </p>
          <h2 id="lb-heading">leaderboard</h2>
          <p className="body-quiet body-quiet--tight">
            top ten for this challenge window. refreshes each quarter-hour.
          </p>
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
  )

  const prizeClaimComplete =
    Boolean(
      prizeContact?.email?.trim() &&
        prizeContact?.mailing_address?.trim() &&
        prizeContact?.shirt_size?.trim(),
    )

  const winnerPrizeSection = isChallengeWinner ? (
      <section className="band band--winner" aria-labelledby="winner-heading">
        <div className="winner-prize__card">
        {previewWinner ? (
          <p className="winner-prize__preview-hint" role="note">
            dev preview — remove <code>?preview_winner=1</code> from the URL when you&apos;re done.
          </p>
        ) : null}
        <p className="eyebrow">you</p>
        <h2 id="winner-heading" className="winner-prize__title">
          you won!
        </h2>
        <p className="body-quiet body-quiet--tight winner-prize__lede">
          you topped the leaderboard for this release challenge — drop your details so we can send your shirt.
        </p>
        {previewWinner && !session ? (
          <p className="body-quiet body-quiet--tight">
            sign in to load saved details and submit (preview still shows the form below).
          </p>
        ) : null}
        {prizeContactLoading ? (
          <p className="body-quiet">loading…</p>
        ) : prizeClaimComplete ? (
          <p className="winner-prize__thanks" role="status">
            thanks — we have your shipping details on file. we&apos;ll be in touch.
          </p>
        ) : (
          <form
            className="winner-prize__form"
            noValidate={previewWinner && !session}
            onSubmit={(e) => {
              e.preventDefault()
              if (previewWinner && !session) return
              run(async () => {
                const res = await apiFetch('/api/me/prize-contact', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    email: prizeForm.email.trim(),
                    mailing_address: prizeForm.mailing_address.trim(),
                    shirt_size: prizeForm.shirt_size,
                  }),
                })
                if (!res.ok) {
                  const errBody = await res.json().catch(() => ({}))
                  const code =
                    errBody && typeof errBody === 'object' && 'error' in errBody
                      ? String((errBody as { error?: string }).error)
                      : ''
                  if (code === 'invalid_email') {
                    throw new Error('Please enter a valid email address.')
                  }
                  if (code === 'invalid_mailing_address') {
                    throw new Error('Please enter your full mailing address (at least a few lines).')
                  }
                  if (code === 'invalid_shirt_size') {
                    throw new Error('Please choose a shirt size.')
                  }
                  throw new Error('Could not save your details. Try again.')
                }
                setPrizeContact({
                  email: prizeForm.email.trim(),
                  mailing_address: prizeForm.mailing_address.trim(),
                  shirt_size: prizeForm.shirt_size,
                })
                setMarketingForm((m) => ({
                  ...m,
                  email: prizeForm.email.trim(),
                }))
                setNotice('saved — thank you!')
              })
            }}
          >
            <label className="winner-prize__field">
              <span className="winner-prize__label">email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                className="winner-prize__input"
                value={prizeForm.email}
                onChange={(ev) =>
                  setPrizeForm((f) => ({ ...f, email: ev.target.value }))
                }
                required
              />
            </label>
            <label className="winner-prize__field">
              <span className="winner-prize__label">mailing address</span>
              <textarea
                name="mailing_address"
                className="winner-prize__textarea"
                rows={4}
                value={prizeForm.mailing_address}
                onChange={(ev) =>
                  setPrizeForm((f) => ({ ...f, mailing_address: ev.target.value }))
                }
                placeholder="full name, street, city, state / province, postal code, country"
                required
              />
            </label>
            <label className="winner-prize__field">
              <span className="winner-prize__label">unisex shirt size</span>
              <select
                className="winner-prize__input"
                value={prizeForm.shirt_size}
                onChange={(ev) =>
                  setPrizeForm((f) => ({ ...f, shirt_size: ev.target.value }))
                }
                required
              >
                <option value="">choose…</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
                <option value="XL">XL</option>
                <option value="2XL">2XL</option>
                <option value="3XL">3XL</option>
                <option value="4XL">4XL</option>
              </select>
            </label>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !session}
            >
              save details
            </button>
          </form>
        )}
        </div>
      </section>
    ) : null

  const merchSection = (
    <section className="band band--merch" aria-labelledby="merch-heading">
      <div className="merch-prize-row">
        <div className="merch-prize-row__copy">
          <p className="eyebrow" id="merch-label">
            03 — merch
          </p>
          <h2 id="merch-heading">
            {campaign?.status === 'ended' ? "this challenge's prize" : "this week's prize"}
          </h2>
          <p className="body-quiet body-quiet--tight">
            {campaign?.status === 'ended'
              ? '#1 on the leaderboard for this window won the limited edition tee. The next challenge (and more merch) coming soon!'
              : "#1 on the leaderboard when the challenge window closes wins this limited edition 'let the record show, i fell apart' tee!"}
          </p>
        </div>
        <div className="merch-prize-row__visual">
          <div className="merch-prize-row__img-wrap">
            <img
              src="/merch-top-streamer.png"
              alt="Eva Snyder limited edition t-shirt in mustard yellow with forest green graphics, front and back"
              className="merch-prize-row__img"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
      </div>
    </section>
  )

  const marketingSubscribed = marketingForm.marketing_opt_in

  const updatesSection = session ? (
    <section className="band band--updates" aria-labelledby="updates-heading">
      <div className="updates-opt">
        <p className="eyebrow" id="updates-label">
          04 — updates
        </p>
        <div className="updates-opt__title-row">
          <h3 id="updates-heading" className="updates-opt__title">
            new challenges
          </h3>
          <span className="updates-opt__rail" aria-hidden="true">
            optional
          </span>
        </div>
        {marketingSubscribed && !showMarketingPrefsForm ? (
          <div className="updates-opt__subscribed">
            <p className="updates-opt__subscribed-msg" role="status">
              you&apos;ll be updated when new challenges drop.
            </p>
            <button
              type="button"
              className="btn btn--text updates-opt__change"
              onClick={() => setShowMarketingPrefsForm(true)}
            >
              change preferences
            </button>
          </div>
        ) : (
          <>
            <p className="body-quiet body-quiet--tight updates-opt__lede">
              if you want a heads-up when the next challenge goes live, leave your email and opt in
              below.
            </p>
            <form
              className="updates-opt__form"
              onSubmit={(e) => {
                e.preventDefault()
                run(async () => {
                  const res = await apiFetch('/api/me/contact-preferences', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      email: marketingForm.email.trim(),
                      marketing_opt_in: marketingForm.marketing_opt_in,
                    }),
                  })
                  if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}))
                    const code =
                      errBody && typeof errBody === 'object' && 'error' in errBody
                        ? String((errBody as { error?: string }).error)
                        : ''
                    if (code === 'invalid_email') {
                      throw new Error('Enter a valid email, or turn off the checkbox.')
                    }
                    throw new Error('Could not save your preferences. Try again.')
                  }
                  const j = (await res.json()) as {
                    email?: string | null
                    marketing_opt_in?: boolean
                  }
                  const nextOptIn = Boolean(j.marketing_opt_in)
                  setMarketingForm({
                    email: j.email?.trim() ?? '',
                    marketing_opt_in: nextOptIn,
                  })
                  setPrizeForm((f) => ({
                    ...f,
                    email: j.email?.trim() ?? f.email,
                  }))
                  if (nextOptIn) {
                    setShowMarketingPrefsForm(false)
                  }
                  setNotice('preferences saved')
                })
              }}
            >
              <label className="updates-opt__field">
                <span className="updates-opt__label">email</span>
                <input
                  type="email"
                  name="updates_email"
                  autoComplete="email"
                  className="updates-opt__input"
                  value={marketingForm.email}
                  onChange={(ev) => setMarketingForm((f) => ({ ...f, email: ev.target.value }))}
                  placeholder="you@example.com"
                />
              </label>
              <label className="updates-opt__check">
                <input
                  type="checkbox"
                  checked={marketingForm.marketing_opt_in}
                  onChange={(ev) =>
                    setMarketingForm((f) => ({
                      ...f,
                      marketing_opt_in: ev.target.checked,
                    }))
                  }
                />
                <span>email me when there&apos;s a new challenge</span>
              </label>
              <button type="submit" className="btn btn--outline" disabled={busy}>
                save preferences
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  ) : null

  return (
    <div className={`page app-lowercase${!session ? ' page--signed-out' : ''}`}>
      {session ? (
        <div className="auth-bar" aria-label="Account">
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
                setMarketingForm({ email: '', marketing_opt_in: false })
                setShowMarketingPrefsForm(false)
              })
            }
          >
            log out
          </button>
        </div>
      ) : null}

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

      {!session ? (
        <div className="auth-cta" aria-label="Join this challenge">
          <p className="auth-cta__intro">
            join with last.fm to count your listens for this release. sign in if you already use last.fm, or
            tap set up to create an account and link Spotify.
          </p>
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
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setLastfmSetupOpen(true)}
              >
                set up last.fm + Spotify
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showComingSoonBanner ? (
        <p className="challenge-banner" role="status">
          New challenge coming soon…
        </p>
      ) : null}

      <main className="main">
        {session ? (
          <>
            {winnerPrizeSection}
            {playsSection}
            {leaderboardSection}
            {merchSection}
            {updatesSection}
          </>
        ) : (
          <>
            {leaderboardSection}
            {playsSection}
            {merchSection}
          </>
        )}

        {session?.user.is_artist ? (
          <section className="band band--artist" aria-labelledby="artist-heading">
            <p className="eyebrow">04 — behind the curtain</p>
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
              <h3 className="artist-contacts__title">listeners</h3>
              <p className="body-quiet body-quiet--tight">
                Prize email and shipping come from the winner form after the window closes. The &ldquo;news
                opt-in&rdquo; column is from the optional form below the merch block (not Last.fm).
              </p>
              {leaderboardContacts.length === 0 ? (
                <p className="body-quiet">no listeners with plays in this challenge yet.</p>
              ) : (
                <div className="artist-contacts__table" role="table" aria-label="Listener contacts">
                  <div className="artist-contacts__row artist-contacts__row--head" role="row">
                    <span role="columnheader">#</span>
                    <span role="columnheader">name</span>
                    <span role="columnheader">last.fm</span>
                    <span role="columnheader">plays</span>
                    <span role="columnheader">email</span>
                    <span role="columnheader">shirt</span>
                    <span role="columnheader">ship to</span>
                    <span role="columnheader">news</span>
                  </div>
                  {leaderboardContacts.map((row, i) => (
                    <div className="artist-contacts__row" key={row.lastfm_username} role="row">
                      <span role="cell">{i + 1}</span>
                      <span role="cell">{row.display_name ?? '—'}</span>
                      <span role="cell" className="artist-contacts__mono">
                        {row.lastfm_username}
                      </span>
                      <span role="cell">{row.plays}</span>
                      <span role="cell" className="artist-contacts__mono">
                        {row.email ?? '—'}
                      </span>
                      <span role="cell">{row.shirt_size ?? '—'}</span>
                      <span role="cell" className="artist-contacts__ship" title={row.mailing_address ?? ''}>
                        {row.mailing_address?.trim() ? row.mailing_address : '—'}
                      </span>
                      <span role="cell">
                        {row.marketing_opt_in === 1 || row.marketing_opt_in === true ? 'yes' : '—'}
                      </span>
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
          connect spotify to last.fm so streams show up. if you win,
          we&apos;ll ask for email and a shipping address on this site at the end of the challenge window for the tee.
        </p>
      </footer>

      <LastfmSetupModal open={lastfmSetupOpen} onClose={() => setLastfmSetupOpen(false)} />
    </div>
  )
}

export default App

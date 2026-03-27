require('dotenv').config()

const fs = require('fs')
const path = require('path')
const express = require('express')
const cookieParser = require('cookie-parser')
const cors = require('cors')
const cron = require('node-cron')

const { openDb, migratePlaysIfNeeded } = require('./db')
const {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  randomString,
  refreshAccessToken,
  spotifyGet,
} = require('./spotify')
const { ingestOnce: runIngestOnce } = require('./ingest')
const {
  bootstrapChallengeFromEnvIfEmpty,
  syncLatestChallengeWindowFromEnvOrDefaults,
  getActiveChallengeForIngest,
  getChallengeForDisplay,
  rowToCampaignPayload,
} = require('./challenges')

const PORT = Number(process.env.PORT ?? 8787)
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const DB_PATH = process.env.DB_PATH ?? './data.sqlite'
// Default matches typical dev (127.0.0.1 Vite + 127.0.0.1 backend). OAuth error
// redirects use this when state is missing/expired — localhost here caused “jump to
// localhost:5173/” with no visible Spotify step.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173'
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev_secret_change_me'
const INGEST_CRON = process.env.INGEST_CRON ?? '*/15 * * * *'
const ARTIST_SPOTIFY_USER_ID = process.env.ARTIST_SPOTIFY_USER_ID ?? ''

/** Built Vite app: repo layout `web/dist` or Docker `/app/web/dist`. */
function resolveWebDistDir() {
  if (process.env.WEB_DIST_PATH) {
    return path.resolve(process.env.WEB_DIST_PATH)
  }
  const fromRepoRoot = path.join(__dirname, '../../web/dist')
  const fromDocker = path.join(__dirname, '../web/dist')
  if (fs.existsSync(fromRepoRoot)) return fromRepoRoot
  if (fs.existsSync(fromDocker)) return fromDocker
  return fromRepoRoot
}

const WEB_DIST = resolveWebDistDir()
const HAS_WEB_DIST =
  fs.existsSync(WEB_DIST) && fs.existsSync(path.join(WEB_DIST, 'index.html'))

if (!HAS_WEB_DIST) {
  // eslint-disable-next-line no-console
  console.warn(
    '[startup] web/dist not found (WEB_DIST=%s). Build the Vite app (Dockerfile web-build stage or `npm run build` at repo root). / will show API stub only.',
    WEB_DIST,
  )
}

const db = openDb(DB_PATH)
bootstrapChallengeFromEnvIfEmpty(db)
syncLatestChallengeWindowFromEnvOrDefaults(db)
migratePlaysIfNeeded(db)

const BUILD_ID = 'railway-web-dist-v1'

/** Spotify redirects to 127.0.0.1:8787; persisted so nodemon/restart doesn’t drop OAuth state mid-flow. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

function firstQuery(val) {
  if (val == null) return null
  const s = Array.isArray(val) ? val[0] : val
  return typeof s === 'string' ? s : String(s)
}

/**
 * @param {string | null | undefined} raw
 * @param {{ trustedOrigin?: string | null }} [opts] - Origin of this request (`https://your-app.railway.app`).
 *        Lets `?return=` match production even when `FRONTEND_ORIGIN` env is still the dev default.
 */
function normalizeReturnTo(raw, opts = {}) {
  if (raw == null || raw === '') return null
  const str = typeof raw === 'string' ? raw : String(raw)
  let decoded = str
  try {
    decoded = decodeURIComponent(str)
  } catch {
    return null
  }
  let allowedProdOrigin = null
  try {
    allowedProdOrigin = new URL(FRONTEND_ORIGIN).origin
  } catch {
    /* ignore */
  }
  let trusted = null
  try {
    if (opts.trustedOrigin) trusted = new URL(opts.trustedOrigin).origin
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(decoded)
    if (u.protocol === 'http:') {
      const h = u.hostname
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return null
      return u.origin
    }
    if (u.protocol === 'https:') {
      if (allowedProdOrigin && u.origin === allowedProdOrigin) return u.origin
      if (trusted && u.origin === trusted) return u.origin
    }
    return null
  } catch {
    return null
  }
}

/**
 * Public origin for `/auth/login` → OAuth return target.
 * Prefer proxy headers (Railway, etc.): mobile clients sometimes lack a reliable `req.protocol`.
 */
function requestOriginForRedirect(req) {
  try {
    const host = (req.get('x-forwarded-host') || req.get('host') || '').trim()
    if (!host) return null
    const xfProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
    let proto = xfProto === 'https' || xfProto === 'http' ? xfProto : null
    if (!proto) {
      if (req.secure) proto = 'https'
      else if (req.protocol === 'https') proto = 'https'
      else proto = 'http'
    }
    return new URL(`${proto}://${host}`).origin
  } catch {
    return null
  }
}

function isLocalDevOrigin(origin) {
  try {
    const h = new URL(origin).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
  } catch {
    return true
  }
}

function purgeExpiredOAuthTables() {
  const now = Date.now()
  db.prepare('delete from oauth_states where expires_at < ?').run(now)
  db.prepare('delete from oauth_handoffs where expires_at < ?').run(now)
}

function rememberOAuthState(state, returnTo) {
  purgeExpiredOAuthTables()
  const until = Date.now() + OAUTH_STATE_TTL_MS
  db.prepare(
    `
    insert into oauth_states (state, return_to, expires_at) values (?, ?, ?)
    on conflict(state) do update set return_to = excluded.return_to, expires_at = excluded.expires_at
  `,
  ).run(String(state), returnTo, until)
}

function consumeOAuthState(state) {
  const key = String(state)
  purgeExpiredOAuthTables()
  const row = db
    .prepare('select return_to, expires_at from oauth_states where state = ?')
    .get(key)
  if (!row || Date.now() > row.expires_at) {
    if (row) db.prepare('delete from oauth_states where state = ?').run(key)
    return null
  }
  db.prepare('delete from oauth_states where state = ?').run(key)
  return { returnTo: row.return_to }
}

/** Safari often drops Set-Cookie on cross-site OAuth redirects; we hand off via URL + POST (session id in SQLite). */
const SESSION_HANDOFF_TTL_MS = 10 * 60 * 1000

function rememberSessionHandoff(token, sessionId) {
  purgeExpiredOAuthTables()
  const until = Date.now() + SESSION_HANDOFF_TTL_MS
  db.prepare(
    `
    insert into oauth_handoffs (token, session_id, expires_at) values (?, ?, ?)
    on conflict(token) do update set session_id = excluded.session_id, expires_at = excluded.expires_at
  `,
  ).run(String(token), sessionId, until)
}

function consumeSessionHandoff(token) {
  const key = String(token)
  purgeExpiredOAuthTables()
  const row = db
    .prepare('select session_id, expires_at from oauth_handoffs where token = ?')
    .get(key)
  if (!row || Date.now() > row.expires_at) {
    if (row) db.prepare('delete from oauth_handoffs where token = ?').run(key)
    return null
  }
  db.prepare('delete from oauth_handoffs where token = ?').run(key)
  return { sessionId: row.session_id }
}

const app = express()
app.disable('x-powered-by')

if (IS_PRODUCTION || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1)
}

function isAllowedCorsOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false
  if (origin === FRONTEND_ORIGIN) return true
  const n = normalizeReturnTo(origin)
  return Boolean(n && n === origin)
}

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      // Must echo the *exact* request Origin (127.0.0.1 vs localhost are different sites).
      if (isAllowedCorsOrigin(origin)) return cb(null, origin)
      cb(null, false)
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser(SESSION_SECRET))

function setCookie(res, name, value, opts = {}) {
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    signed: true,
    ...opts,
  })
}

function clearCookie(res, name) {
  res.clearCookie(name, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    signed: true,
  })
}

/** Signed cookie or Authorization: Bearer <raw session_id> (SPA fallback when cookies fail cross-port). */
function getSessionIdFromRequest(req) {
  const fromCookie = req.signedCookies?.sid
  if (fromCookie) return String(fromCookie)
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const id = auth.slice(7).trim()
    if (id) return id
  }
  return null
}

function requireUser(req, res, next) {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) return res.status(401).json({ error: 'not_authenticated' })

  const row = db
    .prepare(
      `
      select s.session_id, s.expires_at, u.id as user_id, u.spotify_user_id, u.display_name
      from sessions s
      join users u on u.id = s.user_id
      where s.session_id = ?
    `,
    )
    .get(sessionId)

  if (!row) return res.status(401).json({ error: 'invalid_session' })
  if (Date.now() > row.expires_at) {
    db.prepare('delete from sessions where session_id = ?').run(sessionId)
    return res.status(401).json({ error: 'session_expired' })
  }

  req.user = {
    id: row.user_id,
    spotify_user_id: row.spotify_user_id,
    display_name: row.display_name,
    is_artist:
      ARTIST_SPOTIFY_USER_ID &&
      String(row.spotify_user_id) === String(ARTIST_SPOTIFY_USER_ID),
  }
  next()
}

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    build: BUILD_ID,
    dbPath: DB_PATH,
    cwd: process.cwd(),
    hasWebDist: HAS_WEB_DIST,
    webDist: WEB_DIST,
  }),
)

/** Dev-only hint when the Vite app is not built into `web/dist`. */
if (!HAS_WEB_DIST) {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>top-listeners API</title></head><body>
<p>This is the <strong>backend API</strong> only — no page is served at <code>/</code> until you run <code>npm run build</code> in the repo root.</p>
<p>Open the web app (Vite): <a href="${FRONTEND_ORIGIN}">${FRONTEND_ORIGIN}</a></p>
<p><a href="/health">GET /health</a> — JSON health check.</p>
</body></html>`)
  })
}

app.get('/auth/login', (req, res) => {
  try {
    // Prevent browsers from caching this redirect → Spotify (otherwise “sign in” can skip accounts.spotify.com).
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.setHeader('Pragma', 'no-cache')
    const state = randomString(16)
    const trustedOrigin = requestOriginForRedirect(req)
    const returnTo =
      normalizeReturnTo(firstQuery(req.query.return), { trustedOrigin }) ??
      normalizeReturnTo(req.get('referer'), { trustedOrigin }) ??
      (trustedOrigin && !isLocalDevOrigin(trustedOrigin) ? trustedOrigin : null) ??
      FRONTEND_ORIGIN
    rememberOAuthState(state, returnTo)
    // eslint-disable-next-line no-console
    console.log('[auth/login] returnTo=%s query.return=%s', returnTo, firstQuery(req.query.return))
    res.redirect(302, buildAuthorizeUrl({ state }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.error('[auth/login]', e)
    res.status(500).type('text').send(`Login failed: ${msg}`)
  }
})

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query
    if (error) {
      const consumed = state ? consumeOAuthState(state) : null
      const base = consumed?.returnTo ?? FRONTEND_ORIGIN
      // eslint-disable-next-line no-console
      console.warn(
        '[auth/callback] Spotify error=%s state_ok=%s base=%s',
        String(error),
        Boolean(consumed),
        base,
      )
      return res.redirect(
        `${base}/?auth_error=${encodeURIComponent(String(error))}`,
      )
    }
    if (!code || !state) {
      return res.redirect(
        302,
        `${FRONTEND_ORIGIN}/?auth_error=${encodeURIComponent('missing_code_or_state')}`,
      )
    }

    const consumed = consumeOAuthState(state)
    if (!consumed) {
      // eslint-disable-next-line no-console
      console.warn('[auth/callback] oauth state invalid or expired (server restarted mid-flow before fix?)')
      return res.redirect(
        302,
        `${FRONTEND_ORIGIN}/?auth_error=${encodeURIComponent('oauth_state_invalid_retry_sign_in')}`,
      )
    }
    const returnTo = consumed.returnTo

    const tokenJson = await exchangeCodeForTokens({ code: String(code) })
    const accessToken = tokenJson.access_token
    const refreshToken = tokenJson.refresh_token
    if (!accessToken || !refreshToken) {
      return res.redirect(
        302,
        `${FRONTEND_ORIGIN}/?auth_error=${encodeURIComponent('missing_tokens_from_spotify')}`,
      )
    }

    const me = await spotifyGet({ accessToken, pathAndQuery: '/me' })
    const spotifyUserId = me.id
    const displayName = me.display_name ?? null
    const email =
      typeof me.email === 'string' && me.email.trim() ? me.email.trim() : null

    const now = Date.now()
    const user = db
      .prepare(
        `
        insert into users (spotify_user_id, display_name, email, created_at)
        values (?, ?, ?, ?)
        on conflict(spotify_user_id) do update set
          display_name = excluded.display_name,
          email = coalesce(excluded.email, users.email)
        returning id
      `,
      )
      .get(spotifyUserId, displayName, email, now)

    const userId = user.id

    db.prepare(
      `
      insert into tokens (user_id, refresh_token, updated_at)
      values (?, ?, ?)
      on conflict(user_id) do update set refresh_token = excluded.refresh_token, updated_at = excluded.updated_at
    `,
    ).run(userId, refreshToken, now)

    db.prepare(
      `
      insert into ingestion_state (user_id, last_after_ms, updated_at)
      values (?, 0, ?)
      on conflict(user_id) do nothing
    `,
    ).run(userId, now)

    const sessionId = randomString(24)
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000
    db.prepare(
      `insert into sessions (session_id, user_id, created_at, expires_at) values (?, ?, ?, ?)`,
    ).run(sessionId, userId, now, expiresAt)

    const handoff = randomString(32)
    rememberSessionHandoff(handoff, sessionId)
    // Do not Set-Cookie on this cross-site redirect — Safari drops it. SPA POSTs /auth/handoff.
    res.redirect(
      `${returnTo}/?oauth_session=${encodeURIComponent(handoff)}`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    // eslint-disable-next-line no-console
    console.error('[auth/callback]', e)
    return res.redirect(
      302,
      `${FRONTEND_ORIGIN}/?auth_error=${encodeURIComponent(msg)}`,
    )
  }
})

app.post('/auth/handoff', (req, res) => {
  const token = req.body?.token
  if (token == null || token === '') {
    return res.status(400).json({ error: 'missing_token' })
  }
  const consumed = consumeSessionHandoff(String(token))
  if (!consumed) {
    return res.status(401).json({ error: 'invalid_or_expired_token' })
  }
  const row = db
    .prepare('select expires_at from sessions where session_id = ?')
    .get(consumed.sessionId)
  if (!row || Date.now() > row.expires_at) {
    return res.status(401).json({ error: 'session_gone' })
  }
  setCookie(res, 'sid', consumed.sessionId, {
    maxAge: row.expires_at - Date.now(),
  })
  res.json({ ok: true, session_id: consumed.sessionId })
})

app.post('/auth/logout', (req, res) => {
  const sessionId = getSessionIdFromRequest(req)
  if (sessionId) db.prepare('delete from sessions where session_id = ?').run(sessionId)
  clearCookie(res, 'sid')
  res.json({ ok: true })
})

app.get('/api/session', requireUser, (req, res) => {
  res.json({ ok: true, user: req.user })
})

app.get('/api/campaign', (_req, res) => {
  const c = getChallengeForDisplay(db)
  if (!c) {
    return res.json({ ok: true, campaign: null })
  }
  res.json({
    ok: true,
    campaign: rowToCampaignPayload(c.row, c.status),
  })
})

app.post('/api/me/delete', requireUser, (req, res) => {
  const userId = req.user.id
  db.prepare('delete from users where id = ?').run(userId)
  const sessionId = getSessionIdFromRequest(req)
  if (sessionId) db.prepare('delete from sessions where session_id = ?').run(sessionId)
  clearCookie(res, 'sid')
  res.json({ ok: true })
})

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit ?? 10)))
  const c = getChallengeForDisplay(db)
  if (!c) {
    return res.json({
      ok: true,
      challenge_id: null,
      rows: [],
    })
  }
  const rows = db
    .prepare(
      `
      select u.spotify_user_id, u.display_name, count(*) as plays
      from plays p
      join users u on u.id = p.user_id
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc
      limit ?
    `,
    )
    .all(c.row.id, limit)

  res.json({
    ok: true,
    challenge_id: c.row.id,
    track_id: c.row.track_id,
    window_start_ms: c.row.starts_at_ms,
    window_end_ms: c.row.ends_at_ms,
    rows,
  })
})

/** Same ordering as /api/leaderboard but includes sign-in email for prize / shipping follow-up (artist only). */
app.get('/api/admin/leaderboard-contacts', requireUser, (req, res) => {
  if (!req.user.is_artist) return res.status(403).json({ error: 'forbidden' })
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit ?? 10)))
  const c = getChallengeForDisplay(db)
  if (!c) {
    return res.json({ ok: true, challenge_id: null, rows: [] })
  }
  const rows = db
    .prepare(
      `
      select u.spotify_user_id, u.display_name, u.email, count(*) as plays
      from plays p
      join users u on u.id = p.user_id
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc
      limit ?
    `,
    )
    .all(c.row.id, limit)

  res.json({
    ok: true,
    challenge_id: c.row.id,
    rows,
  })
})

app.get('/api/me/stats', requireUser, (req, res) => {
  const c = getChallengeForDisplay(db)
  if (!c) {
    return res.json({
      ok: true,
      mine: { plays: 0, rank: null },
      campaign: { participants: 0, total_plays: 0 },
    })
  }

  const challengeId = c.row.id

  const myPlays = db
    .prepare(
      `
      select count(*) as plays
      from plays
      where user_id = ? and challenge_id = ?
    `,
    )
    .get(req.user.id, challengeId)

  const rank = db
    .prepare(
      `
      with lb as (
        select p.user_id, count(*) as plays
        from plays p
        where p.challenge_id = ?
        group by p.user_id
      )
      select 1 + count(*) as rank
      from lb
      where plays > (select plays from lb where user_id = ?)
    `,
    )
    .get(challengeId, req.user.id)

  const participants = db
    .prepare(
      `
      select count(distinct user_id) as total
      from plays
      where challenge_id = ?
    `,
    )
    .get(challengeId)

  const totalPlays = db
    .prepare(
      `
      select count(*) as total
      from plays
      where challenge_id = ?
    `,
    )
    .get(challengeId)

  const myCount = Number(myPlays?.plays ?? 0)
  const myRank = myCount > 0 ? Number(rank?.rank ?? null) : null

  res.json({
    ok: true,
    mine: { plays: myCount, rank: myRank },
    campaign: {
      participants: Number(participants?.total ?? 0),
      total_plays: Number(totalPlays?.total ?? 0),
    },
  })
})

async function ingestOnce() {
  const ch = getActiveChallengeForIngest(db)
  if (!ch) return
  await runIngestOnce({
    db,
    challengeId: ch.id,
    trackId: ch.track_id,
    campaignStartMs: ch.starts_at_ms,
    campaignEndMs: ch.ends_at_ms,
  })
}

cron.schedule(INGEST_CRON, () => {
  ingestOnce().catch(() => {})
})

app.post('/api/admin/ingest-now', requireUser, async (req, res) => {
  if (!req.user.is_artist) return res.status(403).json({ error: 'forbidden' })
  await ingestOnce()
  res.json({ ok: true })
})

if (HAS_WEB_DIST) {
  app.use(express.static(WEB_DIST, { index: false }))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/health') {
      return next()
    }
    res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => next(err))
  })
}

// Bind IPv4 explicitly — on some systems default listen (:: only) breaks fetch() to http://127.0.0.1:PORT
app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(
    `backend listening on http://127.0.0.1:${PORT} (0.0.0.0:${PORT} — use this URL from the browser)`,
  )
  // eslint-disable-next-line no-console
  console.log('backend BUILD_ID=%s', BUILD_ID)
  if (HAS_WEB_DIST) {
    // eslint-disable-next-line no-console
    console.log('serving web app from %s', WEB_DIST)
  }
})


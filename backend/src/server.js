require('dotenv').config()

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const express = require('express')
const cookieParser = require('cookie-parser')
const cors = require('cors')
const cron = require('node-cron')

const { openDb, migratePlaysIfNeeded } = require('./db')
const {
  randomString,
  authGetToken,
  buildAuthorizeUrl,
  authGetSession,
} = require('./lastfm')

/** Logged on auth routes + /health — if Railway logs show different ids for /auth/login vs /auth/callback, you have multiple replicas (SQLite OAuth breaks). */
const INSTANCE_ID = randomString(8)
const { ingestOnce: runIngestOnce } = require('./ingest')
const {
  bootstrapChallengeFromEnvIfEmpty,
  insertChallenge,
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
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:5173').trim()
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev_secret_change_me'
const INGEST_CRON = process.env.INGEST_CRON ?? '*/15 * * * *'
const ARTIST_LASTFM_USERNAME = (process.env.ARTIST_LASTFM_USERNAME ?? '').toLowerCase()

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

const BUILD_ID = 'lastfm-v1'

if (IS_PRODUCTION) {
  // eslint-disable-next-line no-console
  console.warn(
    `[startup] instance=${INSTANCE_ID} OAuth + sessions use SQLite. Use exactly one replica (or shared DB); multiple instances break Last.fm login.`,
  )
}

/** Last.fm auth token stored in oauth_states until /auth/callback. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

function firstQuery(val) {
  if (val == null) return null
  const s = Array.isArray(val) ? val[0] : val
  return typeof s === 'string' ? s : String(s)
}

/**
 * @param {string | null | undefined} raw
 * @param {{ trustedOrigin?: string | null, requestHostname?: string | null }} [opts] requestHostname = Express req.hostname (trust proxy); allows ?return= to match live host if FRONTEND_ORIGIN is wrong
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
      const rh = opts.requestHostname
      if (rh && u.hostname === rh) return u.origin
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

function originEquals(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function isAllowedCorsOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false
  if (origin === FRONTEND_ORIGIN) return true
  if (originEquals(origin, FRONTEND_ORIGIN)) return true
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

function clearCookie(res, name, extra = {}) {
  res.clearCookie(name, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    signed: true,
    path: '/',
    ...extra,
  })
}

const OAUTH_RT_COOKIE = 'oauth_rt'
/** Same Last.fm token from auth.getToken — server can auth.getSession after user approves without browser hitting /auth/callback. */
const OAUTH_PT_COOKIE = 'oauth_pt'

/**
 * When SQLite oauth_states misses (multiple Node processes / replicas), recover return URL from
 * this signed cookie set on GET /auth/login before redirecting to Last.fm.
 */
function readReturnToFromOAuthCookie(req) {
  const raw = req.signedCookies?.[OAUTH_RT_COOKIE]
  if (!raw || typeof raw !== 'string') return null
  try {
    const j = JSON.parse(raw)
    const ts = Number(j.ts || 0)
    if (!Number.isFinite(ts) || Date.now() - ts > OAUTH_STATE_TTL_MS) return null
    if (typeof j.returnTo !== 'string' || !j.returnTo.trim()) return null
    const trustedOrigin = requestOriginForRedirect(req)
    const hostMatch = { trustedOrigin, requestHostname: req.hostname || null }
    const n =
      normalizeReturnTo(j.returnTo, hostMatch) ||
      (originEquals(j.returnTo, FRONTEND_ORIGIN) ? FRONTEND_ORIGIN : null)
    return n
  } catch {
    return null
  }
}

/**
 * Exchange approved Last.fm token for DB session. Used by /auth/callback and GET /api/auth/try-complete-lastfm.
 * @param {{ skipHandoff?: boolean }} [opts] — if true, do not allocate oauth_handoffs row (direct sid cookie path).
 */
async function createLastfmSessionFromApprovedToken(token, opts = {}) {
  const { sessionKey, username } = await authGetSession(token)
  const displayName = username
  const now = Date.now()

  const user = db
    .prepare(
      `
      insert into users (lastfm_username, display_name, email, created_at)
      values (?, ?, ?, ?)
      on conflict(lastfm_username) do update set
        display_name = excluded.display_name
      returning id
    `,
    )
    .get(username, displayName, null, now)

  const userId = user.id

  db.prepare(
    `
    insert into tokens (user_id, session_key, updated_at)
    values (?, ?, ?)
    on conflict(user_id) do update set session_key = excluded.session_key, updated_at = excluded.updated_at
  `,
  ).run(userId, sessionKey, now)

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

  let handoff = null
  if (!opts.skipHandoff) {
    handoff = randomString(32)
    rememberSessionHandoff(handoff, sessionId)
  }

  return { sessionId, expiresAt, userId, username, displayName, handoff }
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

/**
 * Single prize winner for a challenge. If several users tie for max plays, one is chosen
 * deterministically (same for every request) using PRIZE_TIE_BREAK_SECRET or SESSION_SECRET.
 * @returns {number | null} user id or null if nobody has plays for this challenge
 */
function getPrizeTieBreakUserId(db, challengeId) {
  const rows = db
    .prepare(
      `
      select p.user_id as user_id, count(*) as plays
      from plays p
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc
    `,
    )
    .all(challengeId)
  if (rows.length === 0) return null
  const maxPlays = Number(rows[0].plays)
  const tied = rows.filter((r) => Number(r.plays) === maxPlays).map((r) => r.user_id)
  if (tied.length === 0) return null
  if (tied.length === 1) return tied[0]
  const sorted = [...tied].sort((a, b) => a - b)
  const salt = String(
    process.env.PRIZE_TIE_BREAK_SECRET ?? process.env.SESSION_SECRET ?? 'dev-prize-tie-break',
  )
  const payload = `${challengeId}:${sorted.join(',')}:${salt}`
  const hash = crypto.createHash('sha256').update(payload).digest()
  const idx = hash.readUInt32BE(0) % sorted.length
  return sorted[idx]
}

function requireUser(req, res, next) {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) return res.status(401).json({ error: 'not_authenticated' })

  const row = db
    .prepare(
      `
      select s.session_id, s.expires_at, u.id as user_id, u.lastfm_username, u.display_name
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

  const lfUser = String(row.lastfm_username).toLowerCase()
  req.user = {
    id: row.user_id,
    lastfm_username: row.lastfm_username,
    display_name: row.display_name,
    is_artist: Boolean(ARTIST_LASTFM_USERNAME && lfUser === ARTIST_LASTFM_USERNAME),
  }
  next()
}

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    build: BUILD_ID,
    instanceId: INSTANCE_ID,
    nodeEnv: process.env.NODE_ENV ?? null,
    frontendOrigin: FRONTEND_ORIGIN,
    frontendOriginLooksDev:
      IS_PRODUCTION && /127\.0\.0\.1|localhost/i.test(FRONTEND_ORIGIN),
    lastfm: {
      hasApiKey: Boolean(String(process.env.LASTFM_API_KEY ?? '').trim()),
      hasApiSecret: Boolean(String(process.env.LASTFM_API_SECRET ?? '').trim()),
    },
    sessionSecretEnvPresent: Boolean(String(process.env.SESSION_SECRET ?? '').trim()),
    sqliteOAuthNote:
      'OAuth state is stored in SQLite on this process. Multiple replicas without sticky sessions break Last.fm login.',
    railwayChecklist: [
      'If instanceId differs between two /health requests without a redeploy, multiple processes are serving traffic — SQLite sessions will not line up. Scale to one container or use a shared database.',
      'Last.fm app callback URL must be exactly: ' + FRONTEND_ORIGIN + '/auth/callback',
      'OAuth return URL is also stored in a signed cookie (oauth_rt) so /auth/callback works even when oauth_states misses another Node process.',
    ],
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

app.get('/auth/login', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.setHeader('Pragma', 'no-cache')
    const token = await authGetToken()
    const trustedOrigin = requestOriginForRedirect(req)
    const hostMatch = { trustedOrigin, requestHostname: req.hostname || null }
    const returnTo =
      normalizeReturnTo(firstQuery(req.query.return), hostMatch) ??
      normalizeReturnTo(req.get('referer'), hostMatch) ??
      (trustedOrigin && !isLocalDevOrigin(trustedOrigin) ? trustedOrigin : null) ??
      FRONTEND_ORIGIN
    rememberOAuthState(token, returnTo)
    setCookie(res, OAUTH_RT_COOKIE, JSON.stringify({ returnTo, ts: Date.now() }), {
      maxAge: OAUTH_STATE_TTL_MS,
      path: '/',
    })
    setCookie(res, OAUTH_PT_COOKIE, String(token), {
      maxAge: OAUTH_STATE_TTL_MS,
      path: '/',
    })
    const lastfmCallbackAbs = `${FRONTEND_ORIGIN.replace(/\/$/, '')}/auth/callback`
    const useCb = String(process.env.LASTFM_AUTH_USE_CB ?? '').trim() === '1'
    // eslint-disable-next-line no-console
    console.log(
      '[auth/login] instance=%s returnTo=%s lastfm_cb=%s use_cb_env=%s token_prefix=%s',
      INSTANCE_ID,
      returnTo,
      lastfmCallbackAbs,
      useCb ? '1' : '0',
      String(token).slice(0, 8),
    )
    res.redirect(302, buildAuthorizeUrl(token, lastfmCallbackAbs))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.error('[auth/login]', e)
    res.status(500).type('text').send(`Login failed: ${msg}`)
  }
})

app.get('/auth/callback', async (req, res) => {
  let returnTo = FRONTEND_ORIGIN
  try {
    const token = firstQuery(req.query.token)?.trim()
    if (!token) {
      clearCookie(res, OAUTH_RT_COOKIE)
      return res.redirect(
        302,
        `${FRONTEND_ORIGIN}/?auth_error=${encodeURIComponent('missing_lastfm_token')}`,
      )
    }

    const consumed = consumeOAuthState(token)
    returnTo = consumed?.returnTo ?? null
    if (!returnTo) {
      returnTo = readReturnToFromOAuthCookie(req)
    }
    if (!returnTo) {
      returnTo = FRONTEND_ORIGIN
    }
    if (!consumed) {
      // eslint-disable-next-line no-console
      console.warn(
        '[auth/callback] oauth_states miss on this instance=%s — using cookie or FRONTEND_ORIGIN for returnTo',
        INSTANCE_ID,
      )
    }
    clearCookie(res, OAUTH_RT_COOKIE)

    const result = await createLastfmSessionFromApprovedToken(token, { skipHandoff: false })
    clearCookie(res, OAUTH_PT_COOKIE)
    const { username, handoff } = result
    // eslint-disable-next-line no-console
    console.log('[auth/callback] ok instance=%s user=%s returnTo=%s', INSTANCE_ID, username, returnTo)
    // Do not Set-Cookie on this cross-site redirect — Safari drops it. SPA POSTs /auth/handoff.
    res.redirect(
      `${returnTo}/?oauth_session=${encodeURIComponent(handoff)}`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    // eslint-disable-next-line no-console
    console.error('[auth/callback]', e)
    clearCookie(res, OAUTH_RT_COOKIE)
    // Polling may have already exchanged the token and set `sid`; Last.fm then redirects here with a one-use token.
    const sessionId = getSessionIdFromRequest(req)
    if (sessionId) {
      const row = db.prepare('select expires_at from sessions where session_id = ?').get(sessionId)
      if (row && Date.now() <= row.expires_at) {
        clearCookie(res, OAUTH_PT_COOKIE)
        return res.redirect(302, `${returnTo}/?connected=1`)
      }
    }
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
  clearCookie(res, OAUTH_PT_COOKIE)
  clearCookie(res, OAUTH_RT_COOKIE)
  res.json({ ok: true })
})

/**
 * Poll after Last.fm approval: same token as auth.getToken works with auth.getSession once user approved,
 * even if Last.fm never 302-redirects the browser to /auth/callback (oauth_pt cookie set on /auth/login).
 */
app.get('/api/auth/try-complete-lastfm', async (req, res) => {
  try {
    const token = req.signedCookies?.[OAUTH_PT_COOKIE]
    if (!token || typeof token !== 'string') {
      return res.json({ ok: false, state: 'none' })
    }
    const { sessionId, expiresAt, username, displayName, userId } = await createLastfmSessionFromApprovedToken(
      token.trim(),
      { skipHandoff: true },
    )
    clearCookie(res, OAUTH_PT_COOKIE)
    clearCookie(res, OAUTH_RT_COOKIE)
    setCookie(res, 'sid', sessionId, {
      maxAge: expiresAt - Date.now(),
    })
    const lfUser = String(username).toLowerCase()
    const isArtist = Boolean(ARTIST_LASTFM_USERNAME && lfUser === ARTIST_LASTFM_USERNAME)
    return res.json({
      ok: true,
      session_id: sessionId,
      user: {
        id: userId,
        lastfm_username: username,
        display_name: displayName,
        is_artist: isArtist,
      },
    })
  } catch (e) {
    // Last.fm often returns "invalid token" until the user taps approve — do not clear oauth_pt here.
    const msg = e instanceof Error ? e.message : String(e)
    return res.json({ ok: false, state: 'pending', detail: msg })
  }
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
      select u.lastfm_username, u.display_name, count(*) as plays
      from plays p
      join users u on u.id = p.user_id
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc, u.lastfm_username asc
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
      select u.lastfm_username, u.display_name, u.email, u.mailing_address, u.shirt_size, u.marketing_opt_in, count(*) as plays
      from plays p
      join users u on u.id = p.user_id
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc, u.lastfm_username asc
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

const SHIRT_SIZES = new Set(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'])

app.get('/api/me/prize-contact', requireUser, (req, res) => {
  const row = db
    .prepare(
      `
      select email, mailing_address, shirt_size
      from users
      where id = ?
    `,
    )
    .get(req.user.id)
  res.json({
    ok: true,
    email: row?.email ?? null,
    mailing_address: row?.mailing_address ?? null,
    shirt_size: row?.shirt_size ?? null,
  })
})

app.get('/api/me/contact-preferences', requireUser, (req, res) => {
  const row = db
    .prepare(
      `
      select email, marketing_opt_in
      from users
      where id = ?
    `,
    )
    .get(req.user.id)
  res.json({
    ok: true,
    email: row?.email ?? null,
    marketing_opt_in: Boolean(row?.marketing_opt_in),
  })
})

app.put('/api/me/contact-preferences', requireUser, (req, res) => {
  const marketing_opt_in = req.body?.marketing_opt_in
  if (typeof marketing_opt_in !== 'boolean') {
    return res.status(400).json({ error: 'invalid_body' })
  }
  if (marketing_opt_in) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email' })
    }
    db.prepare(
      `
      update users
      set email = ?, marketing_opt_in = 1
      where id = ?
    `,
    ).run(email, req.user.id)
  } else {
    db.prepare(
      `
      update users
      set marketing_opt_in = 0
      where id = ?
    `,
    ).run(req.user.id)
  }
  const row = db
    .prepare(
      `
      select email, marketing_opt_in
      from users
      where id = ?
    `,
    )
    .get(req.user.id)
  res.json({
    ok: true,
    email: row?.email ?? null,
    marketing_opt_in: Boolean(row?.marketing_opt_in),
  })
})

app.put('/api/me/prize-contact', requireUser, (req, res) => {
  const c = getChallengeForDisplay(db)
  if (!c || c.status !== 'ended') {
    return res.status(403).json({ error: 'prize_claim_not_open' })
  }
  const challengeId = c.row.id
  const winnerId = getPrizeTieBreakUserId(db, challengeId)
  if (winnerId == null || winnerId !== req.user.id) {
    return res.status(403).json({ error: 'not_challenge_winner' })
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
  const mailingAddress =
    typeof req.body?.mailing_address === 'string' ? req.body.mailing_address.trim() : ''
  const shirtSize =
    typeof req.body?.shirt_size === 'string' ? req.body.shirt_size.trim().toUpperCase() : ''

  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' })
  }
  if (!mailingAddress || mailingAddress.length < 5 || mailingAddress.length > 2000) {
    return res.status(400).json({ error: 'invalid_mailing_address' })
  }
  if (!SHIRT_SIZES.has(shirtSize)) {
    return res.status(400).json({ error: 'invalid_shirt_size' })
  }

  db.prepare(
    `
    update users
    set email = ?, mailing_address = ?, shirt_size = ?
    where id = ?
  `,
  ).run(email, mailingAddress, shirtSize, req.user.id)

  res.json({ ok: true })
})

app.get('/api/me/stats', requireUser, (req, res) => {
  const c = getChallengeForDisplay(db)
  if (!c) {
    return res.json({
      ok: true,
      mine: { plays: 0, rank: null, is_prize_winner: false },
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

  const rankRow = db
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
  const myRank = myCount > 0 ? Number(rankRow?.rank ?? null) : null

  let isPrizeWinner = false
  if (c.status === 'ended' && myCount > 0) {
    const prizeUserId = getPrizeTieBreakUserId(db, challengeId)
    isPrizeWinner = prizeUserId != null && prizeUserId === req.user.id
  }

  res.json({
    ok: true,
    mine: { plays: myCount, rank: myRank, is_prize_winner: isPrizeWinner },
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
    canonicalTrackId: ch.track_id,
    campaignArtist: ch.track_artist || '',
    campaignTrackName: ch.track_name,
    campaignStartMs: ch.starts_at_ms,
    campaignEndMs: ch.ends_at_ms,
  })
}

cron.schedule(INGEST_CRON, () => {
  ingestOnce().catch(() => {})
})

/**
 * Insert a **new** challenge row (new id). Past `plays` stay on old `challenge_id`s so you can sum
 * streams per user across challenges later. Body: { title, trackArtist, trackName, startsAt, endsAt } (ISO 8601).
 */
app.post('/api/admin/challenge', requireUser, (req, res) => {
  if (!req.user.is_artist) return res.status(403).json({ error: 'forbidden' })
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const trackArtist = typeof req.body?.trackArtist === 'string' ? req.body.trackArtist.trim() : ''
  const trackName = typeof req.body?.trackName === 'string' ? req.body.trackName.trim() : ''
  const startsAt = typeof req.body?.startsAt === 'string' ? req.body.startsAt.trim() : ''
  const endsAt = typeof req.body?.endsAt === 'string' ? req.body.endsAt.trim() : ''
  if (!title || !trackArtist || !trackName || !startsAt || !endsAt) {
    return res.status(400).json({ error: 'missing_fields' })
  }
  const startsAtMs = Date.parse(startsAt)
  const endsAtMs = Date.parse(endsAt)
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) {
    return res.status(400).json({ error: 'invalid_window' })
  }
  const id = insertChallenge(db, {
    title,
    trackArtist,
    trackName,
    startsAtMs,
    endsAtMs,
  })
  const row = db.prepare('select * from challenges where id = ?').get(id)
  const now = Date.now()
  let status = 'live'
  if (now < row.starts_at_ms) status = 'upcoming'
  else if (now >= row.ends_at_ms) status = 'ended'
  res.json({
    ok: true,
    challenge_id: id,
    campaign: rowToCampaignPayload(row, status),
  })
})

/** Cross-challenge stream counts for analytics (plays are stored per challenge_id forever). */
app.get('/api/admin/stream-totals', requireUser, (req, res) => {
  if (!req.user.is_artist) return res.status(403).json({ error: 'forbidden' })
  const byUser = db
    .prepare(
      `
      select u.id as user_id, u.lastfm_username, u.display_name, count(*) as total_plays
      from plays p
      join users u on u.id = p.user_id
      group by p.user_id
      order by total_plays desc
    `,
    )
    .all()
  const byChallenge = db
    .prepare(
      `
      select p.challenge_id, c.title, c.starts_at_ms, c.ends_at_ms, count(*) as plays
      from plays p
      join challenges c on c.id = p.challenge_id
      group by p.challenge_id
      order by p.challenge_id desc
    `,
    )
    .all()
  const byChallengeUser = db
    .prepare(
      `
      select p.challenge_id, u.lastfm_username, u.display_name, count(*) as plays
      from plays p
      join users u on u.id = p.user_id
      group by p.challenge_id, p.user_id
      order by p.challenge_id desc, plays desc
    `,
    )
    .all()
  res.json({ ok: true, by_user: byUser, by_challenge: byChallenge, by_challenge_user: byChallengeUser })
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
    if (req.path.startsWith('/api') || req.path === '/health') {
      return next()
    }
    // SPA routes under /auth/* (except real API routes registered above)
    if (req.path.startsWith('/auth') && req.path !== '/auth/finish') {
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


const crypto = require('crypto')

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/'

function assertEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`)
  return value
}

function stripQuotes(s) {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim()
  }
  return t
}

function getConfig() {
  return {
    apiKey: assertEnv('LASTFM_API_KEY', stripQuotes(process.env.LASTFM_API_KEY)),
    apiSecret: assertEnv('LASTFM_API_SECRET', stripQuotes(process.env.LASTFM_API_SECRET)),
  }
}

function signParams(params) {
  const { apiSecret } = getConfig()
  const keys = Object.keys(params)
    .filter((k) => k !== 'api_sig' && k !== 'format')
    .sort()
  let s = ''
  for (const k of keys) {
    const v = params[k]
    if (v == null || v === '') continue
    s += k + String(v)
  }
  return crypto.createHash('md5').update(s + apiSecret).digest('hex')
}

function buildQuery(params) {
  const { apiKey } = getConfig()
  const p = { api_key: apiKey, ...params }
  const api_sig = signParams(p)
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...p, format: 'json', api_sig })) {
    if (v != null && v !== '') out.set(k, String(v))
  }
  return out.toString()
}

async function lastfmGet(extraParams) {
  const qs = buildQuery(extraParams)
  const res = await fetch(`${LASTFM_API}?${qs}`)
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`Last.fm non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (j.error != null) {
    throw new Error(typeof j.message === 'string' ? j.message : String(j.error))
  }
  return j
}

function randomString(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

async function authGetToken() {
  const j = await lastfmGet({ method: 'auth.getToken' })
  const token = j?.token
  if (!token) throw new Error('Last.fm auth.getToken: no token')
  return String(token).trim()
}

/**
 * Redirect browser to Last.fm to approve the app.
 * @param {string} callbackAbsoluteUrl - Full URL Last.fm should send the user to after approval
 *   (e.g. https://your-host/auth/callback). Passed as `cb` so Last.fm uses this exact URL; see
 *   https://www.last.fm/api/authentication — avoids relying only on the dashboard callback matching.
 */
function buildAuthorizeUrl(token, callbackAbsoluteUrl) {
  const { apiKey } = getConfig()
  const q = new URLSearchParams({ api_key: apiKey, token: String(token) })
  if (callbackAbsoluteUrl) {
    q.set('cb', String(callbackAbsoluteUrl).trim())
  }
  return `https://www.last.fm/api/auth/?${q.toString()}`
}

async function authGetSession(token) {
  const j = await lastfmGet({
    method: 'auth.getSession',
    token: String(token),
  })
  const session = j?.session
  if (!session?.key || !session?.name) {
    throw new Error('Last.fm auth.getSession: missing session')
  }
  return {
    sessionKey: String(session.key),
    username: String(session.name),
  }
}

/**
 * @param {{ username: string, sessionKey: string, fromSec?: number, limit?: number, page?: number }} opts
 */
async function userGetRecentTracks(opts) {
  const { username, sessionKey, fromSec = 0, limit = 50, page = 1 } = opts
  const params = {
    method: 'user.getRecentTracks',
    user: username,
    sk: sessionKey,
    limit: String(Math.min(200, Math.max(1, limit))),
    page: String(page),
  }
  if (fromSec > 0) params.from = String(fromSec)
  return lastfmGet(params)
}

/**
 * Normalize for case-insensitive artist/track comparison.
 * @param {string} s
 */
function normalizeMeta(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {unknown} track — Last.fm JSON track object
 */
function trackArtistName(track) {
  const a = track?.artist
  if (typeof a === 'string') return a
  if (a && typeof a === 'object' && '#text' in a) return String(a['#text'] ?? '')
  return ''
}

module.exports = {
  randomString,
  getConfig,
  authGetToken,
  buildAuthorizeUrl,
  authGetSession,
  userGetRecentTracks,
  normalizeMeta,
  trackArtistName,
}

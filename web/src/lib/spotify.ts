const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com'
const SPOTIFY_API = 'https://api.spotify.com'

const STORAGE_KEY = 'spotify_session_v1'
const PKCE_VERIFIER_KEY = 'spotify_pkce_verifier_v1'
const PKCE_STATE_KEY = 'spotify_pkce_state_v1'

export type SpotifySession = {
  access_token: string
  token_type: 'Bearer' | string
  scope?: string
  expires_at: number
  refresh_token?: string
}

function base64UrlEncode(bytes: ArrayBuffer) {
  const bin = String.fromCharCode(...new Uint8Array(bytes))
  const b64 = btoa(bin)
  return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  // URL-safe characters only
  return base64UrlEncode(bytes.buffer).slice(0, length)
}

async function sha256(input: string) {
  const data = new TextEncoder().encode(input)
  return await crypto.subtle.digest('SHA-256', data)
}

function getConfig() {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined
  const redirectUri =
    (import.meta.env.VITE_SPOTIFY_REDIRECT_URI as string | undefined) ??
    `${window.location.origin}/callback`

  return { clientId, redirectUri }
}

export function isSpotifyConfigured() {
  return Boolean(getConfig().clientId)
}

export function getSpotifySession(): SpotifySession | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SpotifySession
  } catch {
    return null
  }
}

function setSpotifySession(session: SpotifySession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSpotifySession() {
  localStorage.removeItem(STORAGE_KEY)
}

export async function startSpotifyLogin() {
  const { clientId, redirectUri } = getConfig()
  if (!clientId) {
    throw new Error('Missing VITE_SPOTIFY_CLIENT_ID')
  }

  const verifier = randomString(64)
  const challenge = base64UrlEncode(await sha256(verifier))
  const state = randomString(24)

  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier)
  sessionStorage.setItem(PKCE_STATE_KEY, state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: [
      'user-read-email',
      'user-read-private',
      'user-top-read',
    ].join(' '),
  })

  window.location.assign(`${SPOTIFY_ACCOUNTS}/authorize?${params.toString()}`)
}

export async function handleSpotifyCallbackIfPresent(): Promise<boolean> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (!code && !error) return false

  if (error) {
    throw new Error(`Spotify auth error: ${error}`)
  }
  if (!code) {
    throw new Error('Missing authorization code')
  }

  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY)
  if (!expectedState || state !== expectedState) {
    throw new Error('Spotify auth state mismatch. Please try again.')
  }

  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY)
  if (!verifier) {
    throw new Error('Missing PKCE verifier. Please try again.')
  }

  const { clientId, redirectUri } = getConfig()
  if (!clientId) {
    throw new Error('Missing VITE_SPOTIFY_CLIENT_ID')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })

  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }

  const json = (await res.json()) as {
    access_token: string
    token_type: string
    scope?: string
    expires_in: number
    refresh_token?: string
  }

  const session: SpotifySession = {
    access_token: json.access_token,
    token_type: json.token_type,
    scope: json.scope,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000 - 60_000,
  }
  setSpotifySession(session)

  sessionStorage.removeItem(PKCE_VERIFIER_KEY)
  sessionStorage.removeItem(PKCE_STATE_KEY)

  // Clean up URL (remove code/state params)
  window.history.replaceState({}, '', url.origin + url.pathname)
  return true
}

async function refreshAccessTokenIfNeeded() {
  const session = getSpotifySession()
  if (!session) throw new Error('Not connected to Spotify.')
  if (Date.now() < session.expires_at) return session

  const { clientId } = getConfig()
  if (!clientId) throw new Error('Missing VITE_SPOTIFY_CLIENT_ID')
  if (!session.refresh_token) throw new Error('Missing refresh token.')

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: session.refresh_token,
  })

  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }

  const json = (await res.json()) as {
    access_token: string
    token_type: string
    scope?: string
    expires_in: number
    refresh_token?: string
  }

  const next: SpotifySession = {
    ...session,
    access_token: json.access_token,
    token_type: json.token_type,
    scope: json.scope ?? session.scope,
    refresh_token: json.refresh_token ?? session.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000 - 60_000,
  }
  setSpotifySession(next)
  return next
}

export async function fetchSpotifyJson(path: string) {
  const session = await refreshAccessTokenIfNeeded()
  const url = path.startsWith('http') ? path : `${SPOTIFY_API}${path}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify API error (${res.status}): ${text}`)
  }

  return await res.json()
}


const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com'
const SPOTIFY_API = 'https://api.spotify.com/v1'

function assertEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`)
  return value
}

function getSpotifyConfig() {
  return {
    clientId: assertEnv('SPOTIFY_CLIENT_ID', process.env.SPOTIFY_CLIENT_ID),
    clientSecret: assertEnv(
      'SPOTIFY_CLIENT_SECRET',
      process.env.SPOTIFY_CLIENT_SECRET,
    ),
    redirectUri: assertEnv(
      'SPOTIFY_REDIRECT_URI',
      process.env.SPOTIFY_REDIRECT_URI,
    ),
  }
}

function randomString(len = 32) {
  return require('crypto').randomBytes(len).toString('hex')
}

function buildAuthorizeUrl({ state }) {
  const { clientId, redirectUri } = getSpotifyConfig()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    scope: [
      'user-read-recently-played',
      'user-read-private',
      'user-read-email',
    ].join(' '),
    show_dialog: 'true',
  })
  return `${SPOTIFY_ACCOUNTS}/authorize?${params.toString()}`
}

async function exchangeCodeForTokens({ code }) {
  const { clientId, clientSecret, redirectUri } = getSpotifyConfig()

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }
  return await res.json()
}

async function refreshAccessToken({ refreshToken }) {
  const { clientId, clientSecret } = getSpotifyConfig()

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }
  return await res.json()
}

async function spotifyGet({ accessToken, pathAndQuery }) {
  const res = await fetch(`${SPOTIFY_API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify API error (${res.status}): ${text}`)
  }
  return await res.json()
}

module.exports = {
  randomString,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  spotifyGet,
}


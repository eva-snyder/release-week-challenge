/**
 * Dev: all API/auth URLs are same-origin (e.g. http://127.0.0.1:5173/api/...).
 * Vite proxies /api, /auth, /health → Express :8787 — no CORS, no fetch to :8787 from the page.
 * Prod: set VITE_BACKEND_ORIGIN to your API origin, or use relative paths if app+API share a host.
 */
const LOCAL_FALLBACK = 'http://127.0.0.1:8787'

function sanitizeProductionBackend(raw: string): string {
  const trimmed = raw.replace(/\/$/, '')
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return LOCAL_FALLBACK
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  if (['5173', '5174', '4173'].includes(port)) {
    return LOCAL_FALLBACK
  }
  return u.origin
}

/** Shown in UI. In dev, the browser never calls :8787 directly for fetch() — Vite proxies. */
export function getBackendOrigin(): string {
  if (import.meta.env.PROD && import.meta.env.VITE_BACKEND_ORIGIN?.trim()) {
    return sanitizeProductionBackend(import.meta.env.VITE_BACKEND_ORIGIN.trim())
  }
  if (typeof window !== 'undefined') {
    if (import.meta.env.PROD) return window.location.origin
    return `${window.location.origin} (Vite → :8787)`
  }
  return LOCAL_FALLBACK
}

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  if (import.meta.env.PROD && import.meta.env.VITE_BACKEND_ORIGIN?.trim()) {
    const base = sanitizeProductionBackend(import.meta.env.VITE_BACKEND_ORIGIN.trim()).replace(
      /\/$/,
      '',
    )
    return `${base}${p}`
  }
  return p
}

const TL_SESSION = 'tl_session_id'

export function getStoredSessionId(): string | null {
  try {
    return sessionStorage.getItem(TL_SESSION)
  } catch {
    return null
  }
}

export function setStoredSessionId(id: string) {
  try {
    sessionStorage.setItem(TL_SESSION, id)
  } catch {
    /* ignore */
  }
}

export function clearStoredSessionId() {
  try {
    sessionStorage.removeItem(TL_SESSION)
  } catch {
    /* ignore */
  }
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiUrl(path)
  const headers = new Headers(init.headers)
  const sid = getStoredSessionId()
  if (sid) headers.set('Authorization', `Bearer ${sid}`)
  return fetch(url, { ...init, credentials: 'include', headers })
}

/**
 * Same-origin /auth/login — Vite proxies to Express, which redirects to Last.fm.
 * @param opts.cacheBust — avoids cached OAuth redirect chains in Chrome.
 */
export function lastfmLoginUrl(opts?: { cacheBust?: boolean }): string {
  const returnTo = window.location.origin
  const q = new URLSearchParams({ return: returnTo })
  if (opts?.cacheBust) q.set('cb', String(Date.now()))
  return `/auth/login?${q.toString()}`
}

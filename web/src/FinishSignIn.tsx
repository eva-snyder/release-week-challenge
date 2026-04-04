import { useCallback, useState } from 'react'

/** Accept full Last.fm auth URL or a raw token string. */
export function extractLastfmTokenFromPastedInput(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const singleLine = t.replace(/\s+/g, '')
  if (/^[A-Za-z0-9_.+-]+$/.test(singleLine) && !singleLine.includes('://') && !singleLine.includes('=')) {
    return singleLine
  }
  try {
    const u = new URL(t.includes('://') ? t : `https://dummy.invalid/?${t}`)
    const tok = u.searchParams.get('token')
    if (tok) return tok
  } catch {
    /* ignore */
  }
  const m = t.match(/(?:^|[?&#])token=([^&\s#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export function FinishSignIn() {
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const go = useCallback(() => {
    const token = extractLastfmTokenFromPastedInput(value)
    if (!token) {
      setErr('Could not find a token. Paste the full Last.fm page URL, or just the token.')
      return
    }
    setErr(null)
    const u = `${window.location.origin}/auth/callback?token=${encodeURIComponent(token)}`
    window.location.replace(u)
  }, [value])

  return (
    <div className="page finish-signin">
      <header className="finish-signin__head">
        <a className="finish-signin__back" href="/">
          ← back to challenge
        </a>
        <h1 className="finish-signin__title">finish last.fm sign-in</h1>
        <p className="body-quiet finish-signin__lede">
          If Last.fm didn’t send you back here automatically, paste the <strong>address bar</strong> from
          the Last.fm tab (the one that contains <code>token=</code>), or paste only the token. Then
          continue — we’ll send you through the same step as a normal redirect.
        </p>
      </header>
      <label className="finish-signin__label" htmlFor="finish-paste">
        Last.fm URL or token
      </label>
      <textarea
        id="finish-paste"
        className="finish-signin__textarea"
        rows={3}
        placeholder="https://www.last.fm/api/auth?api_key=…&token=…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setErr(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go()
        }}
        autoComplete="off"
        spellCheck={false}
      />
      {err ? <p className="finish-signin__err">{err}</p> : null}
      <div className="finish-signin__actions">
        <button type="button" className="btn btn--primary" onClick={go}>
          continue
        </button>
      </div>
    </div>
  )
}

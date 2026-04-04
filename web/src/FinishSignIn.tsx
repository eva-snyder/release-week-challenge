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
      setErr('Could not read that link. Paste the full URL from the Last.fm address bar (or the long string Last.fm shows).')
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
          Use this if you approved Last.fm on another device or browser. After you tap approve, copy the{' '}
          <strong>whole URL</strong> from Last.fm’s address bar (or the “here is the URL” line on their
          confirmation page) and paste it below.
        </p>
      </header>
      <label className="finish-signin__label" htmlFor="finish-paste">
        Link from Last.fm
      </label>
      <textarea
        id="finish-paste"
        className="finish-signin__textarea"
        rows={3}
        placeholder="Paste the full https://… URL from Last.fm"
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

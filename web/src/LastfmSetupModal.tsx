import { useEffect, useMemo } from 'react'
import { LASTFM_JOIN_URL, LASTFM_SPOTIFY_SETTINGS_URL, lastfmLoginUrl } from './authUrl'

type Props = {
  open: boolean
  onClose: () => void
  /** Same as tapping “I have last.fm” — kicks Last.fm session polling when user opens /auth/login from here. */
  onAuthLinkClick?: () => void
}

export function LastfmSetupModal({ open, onClose, onAuthLinkClick }: Props) {
  const linkThisSiteHref = useMemo(() => lastfmLoginUrl({ cacheBust: true }), [open])

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="lf-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="lf-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lf-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lf-modal-title" className="lf-modal__title">
          New to Last.fm?
        </h2>
        <ol className="lf-modal__steps">
          <li>
            <strong>Create Account:</strong> Sign up for a free Last.fm account.{' '}
            <a href={LASTFM_JOIN_URL} target="_blank" rel="noopener noreferrer">
              open sign-up
            </a>
          </li>
          <li>
            <strong>Link Spotify:</strong> Connect Spotify Scrobbling in your Last.fm settings so your streams
            are counted.{' '}
            <a href={LASTFM_SPOTIFY_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
              open Last.fm apps
            </a>
          </li>
          <li>
            <strong>Authorize:</strong> Allow this site to see your stream count.{' '}
            <a
              href={linkThisSiteHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onAuthLinkClick?.()}
            >
              authorize
            </a>
          </li>
        </ol>
        <p className="body-quiet lf-modal__done">
          Done? Switch back to this tab, close this window, and refresh the page to see your plays.
        </p>
        <div className="lf-modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            got it — close
          </button>
        </div>
      </div>
    </div>
  )
}

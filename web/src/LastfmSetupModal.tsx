import { useEffect } from 'react'
import { LASTFM_ACCOUNT_AND_SPOTIFY_SETUP_URL } from './authUrl'

type Props = {
  open: boolean
  onClose: () => void
}

export function LastfmSetupModal({ open, onClose }: Props) {
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

  function openLastfm() {
    window.open(LASTFM_ACCOUNT_AND_SPOTIFY_SETUP_URL, '_blank', 'noopener,noreferrer')
    onClose()
  }

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
          new to last.fm?
        </h2>
        <p className="body-quiet lf-modal__lede">
          Do this on Last.fm first, then come back here and tap sign in with last.fm in the corner.
        </p>
        <ol className="lf-modal__steps">
          <li>Create a Last.fm account — the link opens their sign-up page, then sends you to connect apps.</li>
          <li>Connect Spotify so your listens count as scrobbles (Last.fm will prompt you).</li>
          <li>Verify your email if Last.fm asks — check your inbox for their link.</li>
        </ol>
        <div className="lf-modal__actions">
          <button type="button" className="btn btn--primary" onClick={openLastfm}>
            continue to last.fm
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  )
}

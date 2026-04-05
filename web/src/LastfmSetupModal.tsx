import { useEffect } from 'react'
import { LASTFM_JOIN_URL, LASTFM_SPOTIFY_SETTINGS_URL } from './authUrl'

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
          three steps. last.fm won&apos;t always send you back here automatically — when you&apos;re done with a
          step, <strong>switch back to this tab</strong> or open this site again from your home screen.
        </p>
        <p className="body-quiet lf-modal__hint" role="note">
          if a page doesn&apos;t load (e.g. error 406), use <strong>open in safari or chrome</strong> from the
          browser menu — not instagram or messages&apos; built-in browser.
        </p>
        <ol className="lf-modal__steps">
          <li>
            <strong>Create a Last.fm account.</strong>{' '}
            <a href={LASTFM_JOIN_URL} target="_blank" rel="noopener noreferrer">
              open sign-up
            </a>
          </li>
          <li>
            <strong>Connect Spotify to Last.fm</strong> so your <strong>spotify streams</strong> become
            scrobbles this site can count.{' '}
            <a href={LASTFM_SPOTIFY_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
              open last.fm → apps / spotify
            </a>
          </li>
          <li>
            <strong>Link this challenge site to last.fm</strong> — close this window, then tap{' '}
            <strong>I have last.fm</strong> and approve access. that&apos;s different from logging into last.fm;
            it lets this site read your challenge plays (spotify streams we get from last.fm).
          </li>
        </ol>
        <div className="lf-modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            got it — close
          </button>
        </div>
      </div>
    </div>
  )
}

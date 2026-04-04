const {
  userGetRecentTracks,
  normalizeMeta,
  trackArtistName,
} = require('./lastfm')

/**
 * Pull Last.fm scrobbles for users with session keys; count plays matching campaign artist + track.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {number} opts.challengeId
 * @param {string} opts.canonicalTrackId — stable plays.track_id (e.g. lf:artist|track)
 * @param {string} opts.campaignArtist
 * @param {string} opts.campaignTrackName
 * @param {number} opts.campaignStartMs
 * @param {number} opts.campaignEndMs
 */
async function ingestOnce(opts) {
  const {
    db,
    challengeId,
    canonicalTrackId,
    campaignArtist,
    campaignTrackName,
    campaignStartMs,
    campaignEndMs,
  } = opts

  const now = Date.now()
  if (now < campaignStartMs || now >= campaignEndMs) return

  const wantArtist = normalizeMeta(campaignArtist)
  const wantTrack = normalizeMeta(campaignTrackName)
  if (!wantArtist || !wantTrack) return

  const users = db
    .prepare(
      `
      select u.id as user_id, u.lastfm_username, t.session_key, s.last_after_ms
      from users u
      join tokens t on t.user_id = u.id
      join ingestion_state s on s.user_id = u.id
    `,
    )
    .all()

  for (const u of users) {
    try {
      const afterMs = Number(u.last_after_ms ?? 0)
      const fromSec = Math.max(0, Math.floor(afterMs / 1000))

      const resp = await userGetRecentTracks({
        username: u.lastfm_username,
        sessionKey: u.session_key,
        fromSec,
        limit: 200,
        page: 1,
      })

      const rt = resp?.recenttracks
      let list = rt?.track
      if (list == null) list = []
      if (!Array.isArray(list)) list = [list]

      let maxPlayedAtMs = afterMs

      const insertPlay = db.prepare(
        `insert or ignore into plays (user_id, challenge_id, track_id, played_at, played_at_ms) values (?, ?, ?, ?, ?)`,
      )

      for (const tr of list) {
        if (tr?.['@attr']?.nowplaying === 'true' || tr?.['@attr']?.nowplaying === true) {
          continue
        }
        const date = tr?.date
        const uts = date?.uts != null ? Number(date.uts) : NaN
        if (!Number.isFinite(uts)) continue
        const playedAtMs = uts * 1000
        if (playedAtMs > maxPlayedAtMs) maxPlayedAtMs = playedAtMs

        const art = normalizeMeta(trackArtistName(tr))
        const name = normalizeMeta(tr?.name ?? '')
        if (art !== wantArtist || name !== wantTrack) continue
        if (playedAtMs < campaignStartMs || playedAtMs >= campaignEndMs) continue

        const playedAtIso = new Date(playedAtMs).toISOString()
        insertPlay.run(u.user_id, challengeId, canonicalTrackId, playedAtIso, playedAtMs)
      }

      if (maxPlayedAtMs > afterMs) {
        db.prepare(
          `update ingestion_state set last_after_ms = ?, updated_at = ? where user_id = ?`,
        ).run(maxPlayedAtMs, Date.now(), u.user_id)
      }
    } catch {
      continue
    }
  }
}

module.exports = { ingestOnce }

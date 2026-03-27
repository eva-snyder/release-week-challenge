const { refreshAccessToken, spotifyGet } = require('./spotify')

/**
 * Fetch recently-played from Spotify for every user with tokens + ingestion_state,
 * insert plays for the campaign track within the challenge window, advance cursors.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {number} opts.challengeId
 * @param {string} opts.trackId
 * @param {number} opts.campaignStartMs
 * @param {number} opts.campaignEndMs
 */
async function ingestOnce(opts) {
  const { db, challengeId, trackId, campaignStartMs, campaignEndMs } = opts

  const now = Date.now()
  if (now < campaignStartMs || now >= campaignEndMs) return

  const users = db
    .prepare(
      `
      select u.id as user_id, u.spotify_user_id, t.refresh_token, s.last_after_ms
      from users u
      join tokens t on t.user_id = u.id
      join ingestion_state s on s.user_id = u.id
    `,
    )
    .all()

  for (const u of users) {
    try {
      const tokenJson = await refreshAccessToken({ refreshToken: u.refresh_token })
      const accessToken = tokenJson.access_token
      if (!accessToken) continue

      const after = Number(u.last_after_ms ?? 0)
      const resp = await spotifyGet({
        accessToken,
        pathAndQuery: `/me/player/recently-played?limit=50&after=${after}`,
      })

      const items = Array.isArray(resp.items) ? resp.items : []
      let maxPlayedAtMs = after

      const insertPlay = db.prepare(
        `insert or ignore into plays (user_id, challenge_id, track_id, played_at, played_at_ms) values (?, ?, ?, ?, ?)`,
      )

      for (const it of items) {
        const playedAt = it.played_at
        const playedAtMs = Date.parse(playedAt)
        if (Number.isFinite(playedAtMs) && playedAtMs > maxPlayedAtMs) {
          maxPlayedAtMs = playedAtMs
        }

        const t = it.track
        if (!t?.id) continue
        if (String(t.id) !== String(trackId)) continue
        if (playedAtMs < campaignStartMs || playedAtMs >= campaignEndMs) continue

        insertPlay.run(u.user_id, challengeId, trackId, playedAt, playedAtMs)
      }

      if (maxPlayedAtMs > after) {
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

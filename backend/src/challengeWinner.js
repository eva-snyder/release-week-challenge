const crypto = require('crypto')

/** Wait this long after `ends_at` before picking and storing the winner (allows late scrobbles to ingest). */
const WINNER_RESOLVE_DELAY_MS = 30 * 60 * 1000

/**
 * Top play count wins; ties broken uniformly at random (at resolution time only).
 * @returns {number | null} user id, or null if nobody has plays
 */
function pickRandomWinnerUserId(db, challengeId) {
  const rows = db
    .prepare(
      `
      select p.user_id as user_id, count(*) as plays
      from plays p
      where p.challenge_id = ?
      group by p.user_id
      order by plays desc
    `,
    )
    .all(challengeId)
  if (rows.length === 0) return null
  const maxPlays = Number(rows[0].plays)
  const tied = rows.filter((r) => Number(r.plays) === maxPlays).map((r) => r.user_id)
  if (tied.length === 0) return null
  if (tied.length === 1) return tied[0]
  return tied[crypto.randomInt(0, tied.length)]
}

/**
 * For challenges past `ends_at + WINNER_RESOLVE_DELAY_MS` with no resolution yet, pick winner (or null)
 * and set `winner_resolved_at_ms`. Safe to call on every request.
 * @param {import('better-sqlite3').Database} db
 */
function resolveDueChallengeWinners(db, now = Date.now()) {
  const cutoff = now - WINNER_RESOLVE_DELAY_MS
  const due = db
    .prepare(
      `
      select id from challenges
      where ends_at_ms <= ?
        and winner_resolved_at_ms is null
    `,
    )
    .all(cutoff)

  const upd = db.prepare(
    `
    update challenges
    set winner_user_id = ?, winner_resolved_at_ms = ?
    where id = ? and winner_resolved_at_ms is null
  `,
  )

  const tx = db.transaction(() => {
    for (const row of due) {
      const challengeId = row.id
      const winnerId = pickRandomWinnerUserId(db, challengeId)
      upd.run(winnerId, now, challengeId)
    }
  })
  tx()
}

module.exports = {
  WINNER_RESOLVE_DELAY_MS,
  pickRandomWinnerUserId,
  resolveDueChallengeWinners,
}

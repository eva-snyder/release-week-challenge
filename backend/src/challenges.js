/**
 * @param {import('better-sqlite3').Database} db
 */
function bootstrapChallengeFromEnvIfEmpty(db) {
  const n = Number(db.prepare('select count(*) as c from challenges').get().c ?? 0)
  if (n > 0) return

  const title = process.env.CAMPAIGN_TITLE ?? 'Release challenge'
  const trackId = process.env.CAMPAIGN_TRACK_ID ?? '3n3Ppam7vgaVa1iaRUc9Lp'
  const trackName = process.env.CAMPAIGN_TRACK_NAME ?? 'Your Release Song'
  const starts = Date.parse(process.env.CAMPAIGN_STARTS_AT ?? '2026-05-06T00:00:00Z')
  const ends = Date.parse(process.env.CAMPAIGN_ENDS_AT ?? '2026-05-13T00:00:00Z')
  const now = Date.now()

  db.prepare(
    `
    insert into challenges (title, track_id, track_name, starts_at_ms, ends_at_ms, created_at_ms)
    values (?, ?, ?, ?, ?, ?)
  `,
  ).run(title, trackId, trackName, starts, ends, now)
}

/**
 * Ingest only while the window is live (now inside [start, end)).
 * @param {import('better-sqlite3').Database} db
 */
function getActiveChallengeForIngest(db, now = Date.now()) {
  return db
    .prepare(
      `
      select id, title, track_id, track_name, starts_at_ms, ends_at_ms
      from challenges
      where starts_at_ms <= ? and ends_at_ms > ?
      order by id desc
      limit 1
    `,
    )
    .get(now, now)
}

/**
 * Leaderboard / UI: prefer live challenge; else show the most recent challenge (frozen after end).
 * @returns {{ row: object, status: 'live' | 'ended' | 'upcoming' } | null}
 */
function getChallengeForDisplay(db, now = Date.now()) {
  const active = db
    .prepare(
      `
      select id, title, track_id, track_name, starts_at_ms, ends_at_ms
      from challenges
      where starts_at_ms <= ? and ends_at_ms > ?
      order by id desc
      limit 1
    `,
    )
    .get(now, now)
  if (active) return { row: active, status: 'live' }

  const last = db
    .prepare(
      `
      select id, title, track_id, track_name, starts_at_ms, ends_at_ms
      from challenges
      order by id desc
      limit 1
    `,
    )
    .get()
  if (!last) return null
  if (now < last.starts_at_ms) return { row: last, status: 'upcoming' }
  return { row: last, status: 'ended' }
}

function rowToCampaignPayload(row, status) {
  return {
    id: String(row.id),
    title: row.title,
    trackId: row.track_id,
    trackName: row.track_name,
    startsAt: new Date(row.starts_at_ms).toISOString(),
    endsAt: new Date(row.ends_at_ms).toISOString(),
    startsAtMs: row.starts_at_ms,
    endsAtMs: row.ends_at_ms,
    status,
  }
}

module.exports = {
  bootstrapChallengeFromEnvIfEmpty,
  getActiveChallengeForIngest,
  getChallengeForDisplay,
  rowToCampaignPayload,
}

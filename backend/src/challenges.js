/** Default window when env not set: 2026-03-27 → 2026-04-04 UTC (7 days; `ends` is exclusive in ingest). */
const DEFAULT_CAMPAIGN_STARTS_AT = '2026-03-27T00:00:00Z'
const DEFAULT_CAMPAIGN_ENDS_AT = '2026-04-04T00:00:00Z'

function campaignWindowMsFromEnvOrDefaults() {
  const starts = Date.parse(process.env.CAMPAIGN_STARTS_AT ?? DEFAULT_CAMPAIGN_STARTS_AT)
  const ends = Date.parse(process.env.CAMPAIGN_ENDS_AT ?? DEFAULT_CAMPAIGN_ENDS_AT)
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return null
  return { starts, ends }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function bootstrapChallengeFromEnvIfEmpty(db) {
  const n = Number(db.prepare('select count(*) as c from challenges').get().c ?? 0)
  if (n > 0) return

  const title = process.env.CAMPAIGN_TITLE ?? 'Release challenge'
  const trackId = process.env.CAMPAIGN_TRACK_ID ?? '3n3Ppam7vgaVa1iaRUc9Lp'
  const trackName = process.env.CAMPAIGN_TRACK_NAME ?? 'Your Release Song'
  const w = campaignWindowMsFromEnvOrDefaults()
  if (!w) return
  const now = Date.now()

  db.prepare(
    `
    insert into challenges (title, track_id, track_name, starts_at_ms, ends_at_ms, created_at_ms)
    values (?, ?, ?, ?, ?, ?)
  `,
  ).run(title, trackId, trackName, w.starts, w.ends, now)
}

/**
 * Keeps the latest challenge row aligned with `CAMPAIGN_*` env (or code defaults).
 * Needed when the DB was bootstrapped with older dates but env/code were updated.
 * @param {import('better-sqlite3').Database} db
 */
function syncLatestChallengeWindowFromEnvOrDefaults(db) {
  const w = campaignWindowMsFromEnvOrDefaults()
  if (!w) return
  const row = db.prepare('select id from challenges order by id desc limit 1').get()
  if (!row) return
  db.prepare('update challenges set starts_at_ms = ?, ends_at_ms = ? where id = ?').run(
    w.starts,
    w.ends,
    row.id,
  )
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
  syncLatestChallengeWindowFromEnvOrDefaults,
  getActiveChallengeForIngest,
  getChallengeForDisplay,
  rowToCampaignPayload,
}

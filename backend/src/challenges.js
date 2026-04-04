/**
 * Default window when env not set (~5 days; `ends` is exclusive — live through 2026-03-31 UTC).
 * Override with CAMPAIGN_STARTS_AT / CAMPAIGN_ENDS_AT (e.g. on Railway) anytime.
 */
const DEFAULT_CAMPAIGN_STARTS_AT = '2026-03-27T00:00:00Z'
const DEFAULT_CAMPAIGN_ENDS_AT = '2026-04-05T00:00:00Z'

const { normalizeMeta } = require('./lastfm')

function campaignWindowMsFromEnvOrDefaults() {
  const starts = Date.parse(process.env.CAMPAIGN_STARTS_AT ?? DEFAULT_CAMPAIGN_STARTS_AT)
  const ends = Date.parse(process.env.CAMPAIGN_ENDS_AT ?? DEFAULT_CAMPAIGN_ENDS_AT)
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return null
  return { starts, ends }
}

function canonicalTrackKey(artist, trackName) {
  const a = normalizeMeta(artist)
  const t = normalizeMeta(trackName)
  return `lf:${a}|${t}`
}

function campaignMetadataFromEnvOrDefaults() {
  const artist = process.env.CAMPAIGN_ARTIST ?? 'Eva Snyder'
  const trackName = process.env.CAMPAIGN_TRACK_NAME ?? 'turkeys'
  return {
    title: process.env.CAMPAIGN_TITLE ?? 'Release challenge',
    trackArtist: artist,
    trackName,
    trackId: canonicalTrackKey(artist, trackName),
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function bootstrapChallengeFromEnvIfEmpty(db) {
  const n = Number(db.prepare('select count(*) as c from challenges').get().c ?? 0)
  if (n > 0) return

  const { title, trackId, trackName, trackArtist } = campaignMetadataFromEnvOrDefaults()
  const w = campaignWindowMsFromEnvOrDefaults()
  if (!w) return
  const now = Date.now()

  db.prepare(
    `
    insert into challenges (title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms, created_at_ms)
    values (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(title, trackId, trackName, trackArtist, w.starts, w.ends, now)
}

/**
 * Keeps the latest challenge row aligned with `CAMPAIGN_*` env (or code defaults).
 * @param {import('better-sqlite3').Database} db
 */
function syncLatestChallengeWindowFromEnvOrDefaults(db) {
  const w = campaignWindowMsFromEnvOrDefaults()
  if (!w) return
  const { title, trackId, trackName, trackArtist } = campaignMetadataFromEnvOrDefaults()
  const row = db.prepare('select id from challenges order by id desc limit 1').get()
  if (!row) return
  db.prepare(
    `update challenges set title = ?, track_id = ?, track_name = ?, track_artist = ?, starts_at_ms = ?, ends_at_ms = ? where id = ?`,
  ).run(title, trackId, trackName, trackArtist, w.starts, w.ends, row.id)
}

/**
 * Ingest only while the window is live (now inside [start, end)).
 * @param {import('better-sqlite3').Database} db
 */
function getActiveChallengeForIngest(db, now = Date.now()) {
  return db
    .prepare(
      `
      select id, title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms
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
      select id, title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms
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
      select id, title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms
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
    trackArtist: row.track_artist ?? '',
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
  canonicalTrackKey,
  normalizeMeta,
}

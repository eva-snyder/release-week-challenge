/**
 * Default window when env not set (~5 days; `ends` is exclusive — live through 2026-03-31 UTC).
 * Override with CAMPAIGN_STARTS_AT / CAMPAIGN_ENDS_AT (e.g. on Railway) anytime.
 */
const DEFAULT_CAMPAIGN_STARTS_AT = '2026-03-27T00:00:00Z'
const DEFAULT_CAMPAIGN_ENDS_AT = '2026-04-06T00:00:00Z'

/** Hero Spotify link when CAMPAIGN_TRACK_ID / CAMPAIGN_SPOTIFY_TRACK_ID are unset (e.g. prod env not configured). */
const DEFAULT_SPOTIFY_TRACK_ID = '3aFYGT0C4zbMH6EQ1kdqcf'
const DEFAULT_SPOTIFY_SI = '0744d99d23bf402d'

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
 * Insert a new challenge row (new `id`). Ingest and leaderboards key plays by `challenge_id`, so old
 * campaigns stay queryable alongside new ones. Prefer this over relying only on env sync, which
 * updates the latest row in place and can mix metadata under one id.
 * @param {import('better-sqlite3').Database} db
 * @param {{ title: string, trackArtist: string, trackName: string, startsAtMs: number, endsAtMs: number }} p
 * @returns {number} new challenge id
 */
function insertChallenge(db, p) {
  const { title, trackArtist, trackName, startsAtMs, endsAtMs } = p
  const trackId = canonicalTrackKey(trackArtist, trackName)
  const now = Date.now()
  const r = db
    .prepare(
      `
      insert into challenges (title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms, created_at_ms)
      values (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(title, trackId, trackName, trackArtist, startsAtMs, endsAtMs, now)
  return Number(r.lastInsertRowid)
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
      select id, title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms, winner_user_id, winner_resolved_at_ms
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
      select id, title, track_id, track_name, track_artist, starts_at_ms, ends_at_ms, winner_user_id, winner_resolved_at_ms
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
  const spotifyTrackId =
    String(process.env.CAMPAIGN_SPOTIFY_TRACK_ID ?? process.env.CAMPAIGN_TRACK_ID ?? '').trim() ||
    DEFAULT_SPOTIFY_TRACK_ID
  const spotifyTrackSi =
    String(process.env.CAMPAIGN_SPOTIFY_SI ?? process.env.CAMPAIGN_TRACK_SI ?? '').trim() ||
    DEFAULT_SPOTIFY_SI
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
    /** Spotify track id for open.spotify.com links (from env, not stored per challenge row). */
    spotifyTrackId,
    /** Optional `si` share param appended as ?si=… */
    spotifyTrackSi,
  }
}

module.exports = {
  bootstrapChallengeFromEnvIfEmpty,
  insertChallenge,
  syncLatestChallengeWindowFromEnvOrDefaults,
  getActiveChallengeForIngest,
  getChallengeForDisplay,
  rowToCampaignPayload,
  canonicalTrackKey,
  normalizeMeta,
}

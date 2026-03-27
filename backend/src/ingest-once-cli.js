#!/usr/bin/env node
/**
 * One-off manual ingest (same logic as cron + POST /api/admin/ingest-now).
 * Run from backend dir: npm run ingest-once
 */
require('dotenv').config()

const { openDb, migratePlaysIfNeeded } = require('./db')
const { ingestOnce } = require('./ingest')
const {
  bootstrapChallengeFromEnvIfEmpty,
  syncLatestChallengeWindowFromEnvOrDefaults,
  getActiveChallengeForIngest,
} = require('./challenges')

const DB_PATH = process.env.DB_PATH ?? './data.sqlite'
const db = openDb(DB_PATH)
bootstrapChallengeFromEnvIfEmpty(db)
syncLatestChallengeWindowFromEnvOrDefaults(db)
migratePlaysIfNeeded(db)

const ch = getActiveChallengeForIngest(db)
if (!ch) {
  // eslint-disable-next-line no-console
  console.log('ingest-once: no active challenge window — nothing to pull')
  process.exit(0)
}

ingestOnce({
  db,
  challengeId: ch.id,
  trackId: ch.track_id,
  campaignStartMs: ch.starts_at_ms,
  campaignEndMs: ch.ends_at_ms,
})
  .then(() => {
    // eslint-disable-next-line no-console
    console.log('ingest-once: done')
    process.exit(0)
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('ingest-once:', err)
    process.exit(1)
  })

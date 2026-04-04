/**
 * Aligns with backend INGEST_CRON (default every 15 minutes on a UTC clock).
 * If your cron uses a different timezone or cadence, this alignment may be off.
 */

/** Seconds between burst refreshes after each UTC quarter-hour. */
export const POST_INGEST_BURST_INTERVAL_SEC = 15

/** Total burst window from first refresh (2 minutes). */
export const POST_INGEST_BURST_TOTAL_SEC = 120

/** ms until next UTC quarter-hour (:00, :15, :30, :45). 0 if `now` is exactly on a boundary. */
export function msUntilNextUtcQuarterHourBoundary(now = new Date()): number {
  const t = now.getTime()
  const d = new Date(now)
  d.setUTCMilliseconds(0)

  for (let step = 0; step < 200; step++) {
    const q = Math.floor(d.getUTCMinutes() / 15) * 15
    const boundary = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      q,
      0,
      0,
    )
    if (boundary >= t) {
      return boundary - t
    }
    d.setTime(boundary + 15 * 60 * 1000)
  }
  return 15 * 60 * 1000
}

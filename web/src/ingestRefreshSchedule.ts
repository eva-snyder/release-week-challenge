/**
 * Milliseconds until the next "post-ingest" refresh moment: UTC quarter-hour
 * (:00, :15, :30, :45) + lagMs. Matches default backend INGEST_CRON every 15 minutes on a UTC clock.
 * If your cron uses a different timezone or cadence, this alignment may be off.
 */
export function msUntilNextPostIngestRefresh(now = new Date(), lagMs = 45_000): number {
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
    const refreshAt = boundary + lagMs
    if (refreshAt > t) {
      return refreshAt - t
    }
    d.setTime(boundary + 15 * 60 * 1000)
  }
  return 15 * 60 * 1000
}

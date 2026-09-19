import { useEffect, useState } from 'react'

const DEFAULT_INTERVAL_MS = 30_000

/** A controlled, periodically-updated "now" — every screen that renders a
 * "time ago" label needs this same pattern (a plain `Date.now()` call
 * during render is impure: React may re-invoke a render function without
 * an actual clock tick having occurred, which would desync "time ago"
 * labels within what should be one logical render). Extracted here (UI
 * Step 6) after the identical four-line pattern had been copied into
 * five separate screens. */
export function useNow(intervalMs: number = DEFAULT_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

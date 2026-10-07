// EXP-1 Stage E2 (2026-10-07) — cadence-alignment for the multi-account
// dispatcher (Stage E3). Pure, zero DB; lives under agent-cycle/cycle/
// rather than a not-yet-existing dispatcher function's own directory,
// matching this codebase's established cross-function-import precedent
// (position-monitor already imports agent-cycle/db/row-mappers.ts,
// agent-cycle/broker/accounting.ts, etc. — a reusable module lives where
// it was first needed, not duplicated per caller).
//
// The origin is the UTC epoch, not the tick itself, so every cadence's
// own grid is absolute and shared: a 60-minute account fires at :00, a
// 30-minute account at :00 and :30, a 15-minute account at all four
// quarter-hours — and critically, every cadence's grid points COINCIDE
// at :00, which is therefore the dispatcher's own worst-case tick (every
// account, regardless of cadence, is due) and what its concurrency budget
// must be sized against.
//
// tickIso is expected already floored to the 15-minute grid (the
// dispatcher's own cron cadence) — this function does not floor it
// itself, so a caller passing an unfloored timestamp would get an
// answer scoped to that exact instant, not to "the nearest 15-min slot."
export function isCadenceDue(tickIso: string, cadenceMinutes: number): boolean {
  const tickMs = new Date(tickIso).getTime()
  const cadenceMs = cadenceMinutes * 60_000
  return tickMs % cadenceMs === 0
}

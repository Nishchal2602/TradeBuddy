/** Formatting helpers local to the Home screen — display-only, no
 * business logic. Kept tiny and dependency-free rather than reaching for
 * a formatting library for a handful of calls. */

export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatPct(value: number, { signed = false }: { signed?: boolean } = {}): string {
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function formatRelativeMinutes(targetIso: string, nowMs: number): string {
  const diffMinutes = Math.round((new Date(targetIso).getTime() - nowMs) / 60_000)
  if (diffMinutes <= 0) return 'due now'
  if (diffMinutes < 60) return `~${diffMinutes}m`
  const hours = Math.floor(diffMinutes / 60)
  const minutes = diffMinutes % 60
  return `~${hours}h ${minutes}m`
}

export function formatAgo(iso: string, nowMs: number): string {
  const diffMinutes = Math.round((nowMs - new Date(iso).getTime()) / 60_000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const hours = Math.floor(diffMinutes / 60)
  return `${hours}h ${diffMinutes % 60}m ago`
}

/** Unrealized P&L for one position at a given current price. Necessarily
 * computed here, not read from a persisted value: only the *portfolio*-
 * level unrealized_pnl is ever stored (nav_snapshots) — there is no
 * per-position figure to display instead. Mirrors
 * agent-cycle/broker/accounting.ts's own formula exactly (display-only;
 * not authoritative for anything execution-related, which stays
 * server-side per architecture.md). */
export function unrealizedPnl(direction: 'long' | 'short', entryPrice: number, currentPrice: number, quantity: number): number {
  return direction === 'long' ? (currentPrice - entryPrice) * quantity : (entryPrice - currentPrice) * quantity
}

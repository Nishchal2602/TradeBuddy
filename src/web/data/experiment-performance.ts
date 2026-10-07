import { supabase } from '@/supabase'
import type { ChartPoint } from '../ui/line-chart'

export interface AccountNavSeries {
  portfolioId: string
  name: string
  variantName: string | null
  // ascending (oldest -> newest); realized_pnl_cum + unrealized_pnl, the
  // same honest "immune to capital contributions" series Overview's own
  // chart already uses — no capital-injection marker logic is needed
  // here: these are brand-new test accounts with no prior history to
  // normalize away.
  cumulativePnlSeries: ChartPoint[]
  startingCapital: number
  latestNav: number | null
  latestCumulativePnl: number | null
  latestCapturedAt: string | null
  // the n for this account's own NDisclosure.
  snapshotCount: number
}

const NAV_SNAPSHOT_LIMIT = 20_000

export async function loadExperimentPerformance(
  accounts: { portfolioId: string; name: string; variantName: string | null; startingCapital: number }[],
): Promise<AccountNavSeries[]> {
  if (accounts.length === 0) return []
  const portfolioIds = accounts.map((a) => a.portfolioId)

  // Descending + limit, reversed below per account — the same
  // truncation-safety reasoning overview.ts's own identical query
  // already documents: PostgREST silently caps rows per request
  // regardless of .limit(), so descending guarantees "latest" is always
  // correct even if history is capped.
  const { data, error } = await supabase
    .from('nav_snapshots')
    .select('portfolio_id, nav, unrealized_pnl, realized_pnl_cum, captured_at')
    .in('portfolio_id', portfolioIds)
    .order('captured_at', { ascending: false })
    .limit(NAV_SNAPSHOT_LIMIT)
  if (error) throw new Error(`could not load NAV history: ${error.message}`)

  const rowsByPortfolio = new Map<string, typeof data>()
  for (const row of data ?? []) {
    const list = rowsByPortfolio.get(row.portfolio_id)
    if (list) list.push(row)
    else rowsByPortfolio.set(row.portfolio_id, [row])
  }

  return accounts.map((account) => {
    const rows = [...(rowsByPortfolio.get(account.portfolioId) ?? [])].reverse()
    const cumulativePnlSeries: ChartPoint[] = rows.map((r) => ({
      t: new Date(r.captured_at).getTime(),
      v: Number(r.realized_pnl_cum) + Number(r.unrealized_pnl),
    }))
    const latest = rows[rows.length - 1]
    return {
      portfolioId: account.portfolioId,
      name: account.name,
      variantName: account.variantName,
      cumulativePnlSeries,
      startingCapital: account.startingCapital,
      latestNav: latest ? Number(latest.nav) : null,
      latestCumulativePnl: latest ? Number(latest.realized_pnl_cum) + Number(latest.unrealized_pnl) : null,
      latestCapturedAt: latest ? latest.captured_at : null,
      snapshotCount: rows.length,
    }
  })
}

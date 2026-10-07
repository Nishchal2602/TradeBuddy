// Shared, non-component chart helpers — split out of line-chart.tsx/
// multi-line-chart.tsx so neither file mixes a component export with a
// plain function/constant export (keeps Fast Refresh granular — a
// lint(only-export-components) concern, not a correctness one). The
// single source for ChartPoint/ChartMarker too, so line-chart.tsx can
// import downsample from here without a circular dependency; both types
// are re-exported from line-chart.tsx for every existing caller.

export interface ChartPoint {
  t: number // epoch ms
  v: number
}

export interface ChartMarker {
  t: number
  label: string
}

export function downsample(points: ChartPoint[], maxPoints: number): ChartPoint[] {
  if (points.length <= maxPoints) return points
  const step = points.length / maxPoints
  const result: ChartPoint[] = []
  for (let i = 0; i < maxPoints; i++) {
    const point = points[Math.floor(i * step)]
    if (point) result.push(point)
  }
  const last = points[points.length - 1]
  if (last) result.push(last)
  return result
}

// Categorical series palette — the Experiments performance-overlay chart
// ONLY. Deliberately distinct from --w-pos/--w-neg: a chart line's color
// must never imply a win/loss judgment, only "which account is this."
export const SERIES_PALETTE = ['var(--w-series-1)', 'var(--w-series-2)', 'var(--w-series-3)', 'var(--w-series-4)'] as const

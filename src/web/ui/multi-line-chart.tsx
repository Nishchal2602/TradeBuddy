import { useMemo, useState } from 'react'
import { downsample } from './chart-utils'
import type { ChartPoint, ChartMarker } from './chart-utils'

// WEB-2 (2026-10-08) — a multi-series overlay, generalizing line-chart.tsx's
// own internals. Chosen over a small-multiples grid for the Experiments
// performance-comparison section: these accounts are a deliberately
// single-variable controlled comparison (identical capital/assets/
// cadence, only the strategy config differs), so whether their
// cumulative P&L trajectories DIVERGE over time is the one question this
// chart exists to answer — an overlay answers it directly where small
// multiples would force reconciling N separate axes. Each account's own
// single-series chart remains available for free on its own scoped
// Overview page regardless, so nothing is lost by not also duplicating a
// small-multiples view here.
//
// Unlike LineChart, there is no per-series gradient fill — a 4-way
// overlapping fill reads as mud — and the X/Y domain is computed across
// ALL series combined (shared axes is the entire point of an overlay).

export interface ChartSeries {
  id: string
  label: string
  color: string
  points: ChartPoint[]
}

const WIDTH = 960
const HEIGHT = 220
const PAD_Y = 16
const MAX_POINTS_PER_SERIES = 320

export function MultiSeriesLineChart({
  series,
  markers = [],
  formatValue,
  formatTime,
}: {
  series: ChartSeries[]
  markers?: ChartMarker[]
  formatValue: (v: number) => string
  formatTime: (t: number) => string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const { sampledSeries, scaleX, scaleY, minV, maxV, allTimes } = useMemo(() => {
    const sampledSeries = series.map((s) => ({ ...s, points: downsample(s.points, MAX_POINTS_PER_SERIES) }))
    const allPoints = sampledSeries.flatMap((s) => s.points)
    if (allPoints.length === 0) {
      return { sampledSeries, scaleX: (_t: number) => 0, scaleY: (_v: number) => 0, minV: 0, maxV: 0, allTimes: [] as number[] }
    }
    const times = allPoints.map((p) => p.t)
    const minT = Math.min(...times)
    const maxT = Math.max(...times)
    const values = allPoints.map((p) => p.v)
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const spanV = maxV - minV || 1
    const spanT = maxT - minT || 1

    const scaleX = (t: number) => ((t - minT) / spanT) * WIDTH
    const scaleY = (v: number) => HEIGHT - PAD_Y - ((v - minV) / spanV) * (HEIGHT - PAD_Y * 2)

    // The shared timeline used for hover — the series with the most
    // points (closest to the real tick cadence) sets the step count.
    const allTimes = [...new Set(sampledSeries.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b)

    return { sampledSeries, scaleX, scaleY, minV, maxV, allTimes }
  }, [series])

  const totalPoints = sampledSeries.reduce((sum, s) => sum + s.points.length, 0)
  if (totalPoints < 2) {
    return <div className="wt-body-sm text-w-muted flex h-[220px] items-center justify-center">Not enough data yet for a chart.</div>
  }

  const hoverTime = hoverIdx !== null ? (allTimes[hoverIdx] ?? null) : null

  return (
    <div className="relative">
      <div className="mb-3 flex flex-wrap gap-4">
        {series.map((s) => (
          <div key={s.id} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="wt-label text-w-muted">{s.label}</span>
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[220px] w-full"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const frac = (e.clientX - rect.left) / rect.width
          const idx = Math.round(frac * (allTimes.length - 1))
          setHoverIdx(Math.max(0, Math.min(allTimes.length - 1, idx)))
        }}
      >
        {markers.map((m) => {
          const x = scaleX(m.t)
          if (!Number.isFinite(x)) return null
          return <line key={m.t} x1={x} x2={x} y1={0} y2={HEIGHT} stroke="var(--w-muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
        })}
        {sampledSeries.map((s) => {
          if (s.points.length < 2) return null
          const pathD = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.t).toFixed(1)} ${scaleY(p.v).toFixed(1)}`).join(' ')
          return <path key={s.id} d={pathD} fill="none" stroke={s.color} strokeWidth="1.5" />
        })}
        {hoverTime !== null ? (
          <line x1={scaleX(hoverTime)} x2={scaleX(hoverTime)} y1={0} y2={HEIGHT} stroke="var(--w-text)" strokeWidth="1" opacity="0.25" />
        ) : null}
      </svg>
      <div className="wt-label text-w-faint mt-1 flex justify-between">
        <span>{formatValue(minV)}</span>
        <span>{formatValue(maxV)}</span>
      </div>
      {hoverTime !== null ? (
        <div className="glass absolute top-8 right-0 flex flex-col gap-1 px-3 py-2">
          <div className="wt-label text-w-muted">{formatTime(hoverTime)}</div>
          {sampledSeries.map((s) => {
            const point = s.points.find((p) => p.t === hoverTime)
            if (!point) return null
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="wt-num tabular text-w-text">{formatValue(point.v)}</span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

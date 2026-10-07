import { useMemo, useState } from 'react'
import { downsample } from './chart-utils'
import type { ChartPoint, ChartMarker } from './chart-utils'

export type { ChartPoint, ChartMarker }

// Hand-rolled SVG line chart (WEB-1 plan) — a single path over downsampled
// points, a faint gradient fill, no gridlines, no charting library. The
// design is a thin minimal line; a charting dependency would import far
// more than ~2,000 NAV points over one series ever earns.

const WIDTH = 960
const HEIGHT = 220
const PAD_Y = 16

export function LineChart({
  points,
  markers = [],
  formatValue,
  formatTime,
}: {
  points: ChartPoint[]
  markers?: ChartMarker[]
  formatValue: (v: number) => string
  formatTime: (t: number) => string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const { sampled, pathD, areaD, scaleX, minV, maxV } = useMemo(() => {
    const sampled = downsample(points, 320)
    if (sampled.length === 0) {
      return { sampled, pathD: '', areaD: '', scaleX: (_t: number) => 0, scaleY: (_v: number) => 0, minV: 0, maxV: 0 }
    }
    const minT = sampled[0]!.t
    const maxT = sampled[sampled.length - 1]!.t
    const values = sampled.map((p) => p.v)
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const spanV = maxV - minV || 1
    const spanT = maxT - minT || 1

    const scaleX = (t: number) => ((t - minT) / spanT) * WIDTH
    const scaleY = (v: number) => HEIGHT - PAD_Y - ((v - minV) / spanV) * (HEIGHT - PAD_Y * 2)

    const pathD = sampled.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.t).toFixed(1)} ${scaleY(p.v).toFixed(1)}`).join(' ')
    const areaD = `${pathD} L ${scaleX(sampled[sampled.length - 1]!.t).toFixed(1)} ${HEIGHT} L ${scaleX(sampled[0]!.t).toFixed(1)} ${HEIGHT} Z`

    return { sampled, pathD, areaD, scaleX, scaleY, minV, maxV }
  }, [points])

  if (sampled.length < 2) {
    return <div className="wt-body-sm text-w-muted flex h-[220px] items-center justify-center">Not enough data yet for a chart.</div>
  }

  const hovered = hoverIdx !== null ? sampled[hoverIdx] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[220px] w-full"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const frac = (e.clientX - rect.left) / rect.width
          const idx = Math.round(frac * (sampled.length - 1))
          setHoverIdx(Math.max(0, Math.min(sampled.length - 1, idx)))
        }}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--w-accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--w-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#chart-fill)" />
        <path d={pathD} fill="none" stroke="var(--w-accent)" strokeWidth="1.5" />
        {markers.map((m) => {
          const x = scaleX(m.t)
          if (!Number.isFinite(x)) return null
          return (
            <line
              key={m.t}
              x1={x}
              x2={x}
              y1={0}
              y2={HEIGHT}
              stroke="var(--w-muted)"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.6"
            />
          )
        })}
        {hovered ? (
          <line x1={scaleX(hovered.t)} x2={scaleX(hovered.t)} y1={0} y2={HEIGHT} stroke="var(--w-text)" strokeWidth="1" opacity="0.25" />
        ) : null}
      </svg>
      <div className="wt-label text-w-faint mt-1 flex justify-between">
        <span>{formatValue(minV)}</span>
        <span>{formatValue(maxV)}</span>
      </div>
      {markers.map((m) => (
        <div key={m.t} className="wt-label text-w-muted mt-1">
          <span className="text-w-accent">┊</span> {m.label}
        </div>
      ))}
      {hovered ? (
        <div className="glass absolute top-0 right-0 px-3 py-2">
          <div className="wt-num text-w-text">{formatValue(hovered.v)}</div>
          <div className="wt-label text-w-muted">{formatTime(hovered.t)}</div>
        </div>
      ) : null}
    </div>
  )
}

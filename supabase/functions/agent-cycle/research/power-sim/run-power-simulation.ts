import { createClient } from '@supabase/supabase-js'
import { runOneReplicate } from './replicate.ts'
import type { MeasuredInputs } from './dgp.ts'

// DT-1 (2026-10-09, Order-of-Work step 5) — the power simulation's grid
// sweep (plan §6.7b, S11): runs N replicates per (rhoBar, trueSharpe)
// scenario across the full pre-registered grid (rhoBar amended 2026-10-09
// to include 0.45 as a transparency point; the original {0.5,0.65,0.8}
// and the Sharpe grid including 0.54 are both frozen, untouched here), a
// LOCAL script (CPU-bound, no DB writes -- same reasoning as every other
// heavy research computation in this project: run-golden-replay.ts,
// run-backtest.ts, measure-inputs.ts).
//
// PRIMARY output: the economic-power curve for condition 1 of S6.8's
// three-condition "Supported" verdict (E1's bootstrap CI clears the
// required Sharpe, 0.54) -- this is what A10's 80% threshold is actually
// evaluated against. The full three-clause SECONDARY diagnostic (DSR at
// N=1/N=14, CPCV median-sign-agreement) is also reported in full, for
// continuity, never as a replacement for the primary. The MaxDD veto
// (condition 2 of the "Supported" verdict) is NOT simulated here -- see
// replicate.ts's own header comment for why, stated plainly rather than
// silently omitted.

const SUPABASE_URL = 'https://ymmegosnnywpnyafgnrk.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_Ivy16t3A_t_CDskxYP6O9A_Kemn5ZUJ'
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname)

const RHO_BAR_GRID = [0.45, 0.5, 0.65, 0.8] // 0.45 added 2026-10-09 (transparency amendment); {0.5,0.65,0.8} frozen Stage A
const SHARPE_GRID = [0, 0.3, 0.5, 0.54, 0.8, 1.2] // 0.54 is the frozen A10 hurdle, an explicit grid point
const NUM_REPLICATES_PER_CELL = 400
const BOOTSTRAP_RESAMPLES_PER_REPLICATE = 500 // reduced from the real analysis's 10,000 -- stated computational simplification, see README note below
const REQUIRED_SHARPE = 0.54
const POWER_THRESHOLD = 0.80 // A10, frozen -- this script only ever READS it, never adjusts it
const MATURE_N = 20
const FROM_MONTH = '2018-03'
const TO_MONTH = '2026-09' // inclusive, matching dt1-universe-measurements-2026-10-09.md's own measured window

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function monthsBetween(fromMonth: string, toMonthInclusive: string): string[] {
  const months: string[] = []
  let [y, m] = fromMonth.split('-').map(Number) as [number, number]
  const [toY, toM] = toMonthInclusive.split('-').map(Number) as [number, number]
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

async function loadMeasuredInputs(): Promise<MeasuredInputs> {
  const raw = await Deno.readTextFile(`${SCRIPT_DIR}measured-inputs.json`)
  const parsed = JSON.parse(raw)
  return { tradeMoments: parsed.tradeMoments, perSleeveDailyVolatility: parsed.perSleeveDailyVolatility }
}

async function loadRealNTrajectory(): Promise<{ byMonth: Map<string, number>; byDay: number[] }> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data, error } = await supabase
    .from('research_universe_membership')
    .select('formation_date')
    .eq('universe_version', 'dt1-v3')
    .range(0, 9999)
  if (error) throw new Error(`loadRealNTrajectory: ${JSON.stringify(error)}`)

  const byMonth = new Map<string, number>()
  for (const row of data ?? []) {
    const month = (row.formation_date as string).slice(0, 7)
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1)
  }

  const allMonths = monthsBetween(FROM_MONTH, TO_MONTH)
  for (const m of allMonths) if (!byMonth.has(m)) byMonth.set(m, 0)

  // Build the DAILY trajectory by expanding each month's N over its own
  // calendar day count (28-31), matching the real measured T (3,136 days
  // for this exact window, per dt1-universe-measurements-2026-10-09.md).
  const byDay: number[] = []
  for (const m of allMonths) {
    const [y, mm] = m.split('-').map(Number) as [number, number]
    const daysInMonth = new Date(Date.UTC(y, mm, 0)).getUTCDate()
    const n = byMonth.get(m) ?? 0
    for (let d = 0; d < daysInMonth; d++) byDay.push(n)
  }

  return { byMonth, byDay }
}

interface CellResult {
  rhoBar: number
  trueAnnualizedSharpe: number
  meanE1CiWidth: number
  economicPower: number // PRIMARY: fraction clearing condition 1 (E1 ciLower > 0.54)
  robustnessHoldRate: number | null
  verdictCounts: Record<string, number>
  dsrN1PassRate: number
  dsrN14PassRate: number
  cpcvAgreeRate: number | null
  threeClauseFullPassRateN1: number
  threeClauseFullPassRateN14: number
}

async function main() {
  console.log('Loading measured inputs and real N(t) trajectory...')
  const measuredInputs = await loadMeasuredInputs()
  const { byMonth, byDay } = await loadRealNTrajectory()
  console.log(`  Trade moments: n=${measuredInputs.tradeMoments.n}, sd=${measuredInputs.tradeMoments.sd.toFixed(3)}, skew=${measuredInputs.tradeMoments.skewness.toFixed(3)}`)
  console.log(`  N(t): ${byMonth.size} months, ${byDay.length} days. Mature N (last month): ${byMonth.get(TO_MONTH)}`)

  const tradesPerSleevePerMonth = measuredInputs.tradeMoments.n / 2 / byMonth.size

  const results: CellResult[] = []
  let cellIndex = 0
  const totalCells = RHO_BAR_GRID.length * SHARPE_GRID.length

  for (const rhoBar of RHO_BAR_GRID) {
    for (const trueAnnualizedSharpe of SHARPE_GRID) {
      cellIndex++
      const t0 = performance.now()
      const ciWidths: number[] = []
      const powerFlags: boolean[] = []
      const robustnessFlags: (boolean | null)[] = []
      const verdictCounts: Record<string, number> = {}
      const dsrN1Flags: boolean[] = []
      const dsrN14Flags: boolean[] = []
      const cpcvFlags: (boolean | null)[] = []

      for (let rep = 0; rep < NUM_REPLICATES_PER_CELL; rep++) {
        const rng = mulberry32(cellIndex * 1_000_003 + rep)
        const result = runOneReplicate({
          scenario: { rhoBar, trueAnnualizedSharpe },
          measuredInputs,
          nTrajectoryByDay: byDay,
          nTrajectoryByMonth: byMonth,
          fromMonth: FROM_MONTH,
          toMonth: TO_MONTH,
          tradesPerSleevePerMonth,
          matureN: MATURE_N,
          bootstrapResamples: BOOTSTRAP_RESAMPLES_PER_REPLICATE,
          rng,
        })
        ciWidths.push(result.e1CiUpper - result.e1CiLower)
        powerFlags.push(result.economicPowerCondition1)
        robustnessFlags.push(result.robustnessConditionHolds)
        verdictCounts[result.e2Verdict] = (verdictCounts[result.e2Verdict] ?? 0) + 1
        dsrN1Flags.push(result.dsrN1 > 0.95)
        dsrN14Flags.push(result.dsrN14 > 0.95)
        cpcvFlags.push(result.cpcvMedianSignAgrees)
      }

      const definedRobustness = robustnessFlags.filter((v): v is boolean => v !== null)
      const definedCpcv = cpcvFlags.filter((v): v is boolean => v !== null)

      const cell: CellResult = {
        rhoBar,
        trueAnnualizedSharpe,
        meanE1CiWidth: mean(ciWidths),
        economicPower: mean(powerFlags.map((v) => (v ? 1 : 0))),
        robustnessHoldRate: definedRobustness.length > 0 ? mean(definedRobustness.map((v) => (v ? 1 : 0))) : null,
        verdictCounts,
        dsrN1PassRate: mean(dsrN1Flags.map((v) => (v ? 1 : 0))),
        dsrN14PassRate: mean(dsrN14Flags.map((v) => (v ? 1 : 0))),
        cpcvAgreeRate: definedCpcv.length > 0 ? mean(definedCpcv.map((v) => (v ? 1 : 0))) : null,
        threeClauseFullPassRateN1: mean(dsrN1Flags.map((v, i) => (v && cpcvFlags[i] === true ? 1 : 0))),
        threeClauseFullPassRateN14: mean(dsrN14Flags.map((v, i) => (v && cpcvFlags[i] === true ? 1 : 0))),
      }
      results.push(cell)
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
      console.log(
        `  [${cellIndex}/${totalCells}] rhoBar=${rhoBar}, trueSharpe=${trueAnnualizedSharpe}: power=${(cell.economicPower * 100).toFixed(1)}%, meanCIwidth=${cell.meanE1CiWidth.toFixed(3)} (${elapsed}s)`,
      )
    }
  }

  // S11 gate check: power at Sharpe=0.54, across the full rhoBar grid.
  const s11Cells = results.filter((r) => r.trueAnnualizedSharpe === REQUIRED_SHARPE)
  const s11Pass = s11Cells.map((c) => ({ rhoBar: c.rhoBar, power: c.economicPower, passes: c.economicPower >= POWER_THRESHOLD }))
  const allPass = s11Pass.every((c) => c.passes)
  const allFail = s11Pass.every((c) => !c.passes)
  const fragile = !allPass && !allFail

  const output = {
    runAt: new Date().toISOString(),
    config: {
      rhoBarGrid: RHO_BAR_GRID,
      sharpeGrid: SHARPE_GRID,
      numReplicatesPerCell: NUM_REPLICATES_PER_CELL,
      bootstrapResamplesPerReplicate: BOOTSTRAP_RESAMPLES_PER_REPLICATE,
      requiredSharpe: REQUIRED_SHARPE,
      powerThreshold: POWER_THRESHOLD,
      fromMonth: FROM_MONTH,
      toMonth: TO_MONTH,
      matureN: MATURE_N,
      tradesPerSleevePerMonth,
    },
    s11Gate: { perRhoBar: s11Pass, allPass, allFail, fragile },
    cells: results,
  }

  await Deno.writeTextFile(`${SCRIPT_DIR}power-simulation-results.json`, JSON.stringify(output, null, 2))
  console.log('\nS11 gate (power >= 80% at Sharpe=0.54):')
  for (const c of s11Pass) console.log(`  rhoBar=${c.rhoBar}: power=${(c.power * 100).toFixed(1)}% -> ${c.passes ? 'PASS' : 'FAIL'}`)
  console.log(`  Overall: ${allPass ? 'PASS across the full grid' : allFail ? 'FAIL across the full grid' : 'FRAGILE -- verdict changes across the grid'}`)
  console.log(`\nWritten to ${SCRIPT_DIR}power-simulation-results.json`)
}

if (import.meta.main) {
  await main()
}

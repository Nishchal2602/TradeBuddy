// Manual live diagnostic battery — NOT part of `deno test` (real API
// calls, real quota usage, ~35 calls per run). Run by hand:
//
//   deno run --allow-net --allow-env --allow-write --env-file=.env supabase/functions/agent-cycle/model/jev/jev-tier2-diagnostics.live-check.ts
//
// Plan §6B "Jev continuous-evaluation architecture", Tier 2 — the gate
// between "capture" (P0 items 1-3, done) and any further investment in
// a Jev layer: does this layer carry exploitable information AT ALL,
// tested with ZERO trade outcomes. A layer that fails here should be
// redesigned or removed, not wrapped in champion/challenger
// infrastructure. Four tests, run in the plan's own pre-registered
// order — repeatability MUST run first, because every other test's
// pass/fail threshold is "more than the noise floor repeatability
// measures," not an arbitrary number chosen after the fact:
//
//   1. Repeatability  — one frozen case, N identical calls -> noise floor
//   2. Degeneracy     — a varied fixture matrix -> does ANY fixture
//                        change the answer, by more than noise?
//   3. Discrimination — strong-vs-weak pairs -> correct ordering?
//   4. Feature sensitivity — one-factor-at-a-time pairs, each
//                        pre-registered as (perturbation, expected
//                        inequality, noise band, failure criterion)
//                        BEFORE this script was run, not after seeing
//                        the result — see each PAIR's own comment.
//
// Plus the cheap invariance probes §6B names as the system's
// highest-value diagnostics per API call:
//
//   5. Cross-asset isolation — the single highest-stakes untested
//      assumption in the whole architecture: question.ts puts both
//      assets' news in ONE shared `state` object and relies entirely on
//      TypeSafe's documented "questions are evaluated in parallel and in
//      isolation" property. Never tested until this script.
//   6. Direction flip     — the §5.1a fix actually asks the right question
//   7. News ablation       — the veto responds to EVIDENCE, not the asset name
//   8. Exclusion-list injection — pure commentary must not trigger the veto
//
// Every pass/fail criterion below was written BEFORE this script's first
// run and is never adjusted afterward to make a result look better — if
// a threshold turns out wrong, that is itself a finding to report, not a
// number to quietly edit.
//
// Read-only with respect to trading state: never touches agent_runs,
// positions, trades, agent_decisions, or the broker — pure API calls
// plus a JSON report written to disk.

import { requestPortfolioDecisions } from './provider.ts'
import type { VetoCandidateInput } from '../payload.ts'
import type { EntryOpportunityInput } from './entry-question.ts'

const apiKey = Deno.env.get('TYPESAFE_API_KEY') ?? ''
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set (expected in .env or the environment) — cannot run live diagnostics.')
  Deno.exit(1)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function stddev(xs: number[]): number {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

interface AnswerLike {
  type: string
  noul?: number
  choice?: string
  score?: number
  confidence?: number
  probabilities?: Record<string, number>
}

async function call(vetoCandidates: VetoCandidateInput[], entryOpportunities: EntryOpportunityInput[] = []) {
  const result = await requestPortfolioDecisions(vetoCandidates, [], 10_000, 8_000, 0.2, apiKey, fetch, {}, entryOpportunities)
  // rawResponse.answers is the one place every raw answer (noul/choice/
  // score, with full probabilities) is available regardless of which
  // typed outcome array it also landed in — exactly what a diagnostic
  // needs, since it wants the RAW distribution, not the thresholded value.
  const answers = (result.rawResponse as { answers: Record<string, AnswerLike> }).answers
  return { result, answers }
}

const report: Record<string, unknown> = { runAt: new Date().toISOString() }

// ---------------------------------------------------------------------------
// 1. Repeatability — the noise floor every later test is measured against
// ---------------------------------------------------------------------------

console.log('\n=== 1. REPEATABILITY (noise floor) ===')
const REPEAT_N = 20
const frozenCase: { veto: VetoCandidateInput; entry: EntryOpportunityInput } = {
  veto: { asset: 'BTC', direction: 'long', news: [] },
  entry: {
    asset: 'BTC',
    atrTargetDistancePct: 0.025,
    estimatedRoundTripCostPct: 0.003,
    ret15mPct: 0.4,
    ret30mPct: 0.9,
    ret60mPct: 1.8,
    realizedVol5m: 0.15,
    volumeTrendRatio: 1.8,
    sampledDayHighPct: -4.0,
    sampledDayLowPct: 9.0,
    armId: 'pullback_long',
    direction: 'long',
    bias: 'LONG',
  },
}

const repeatSamples: { noul: number[]; enterProb: number[]; moveScore: number[]; highProb: number[]; failureProbs: Record<string, number[]> } = {
  noul: [],
  enterProb: [],
  moveScore: [],
  highProb: [],
  failureProbs: {},
}
for (let i = 0; i < REPEAT_N; i++) {
  const { answers } = await call([frozenCase.veto], [frozenCase.entry])
  repeatSamples.noul.push(answers.veto_btc!.noul!)
  repeatSamples.enterProb.push(answers.btc_entry_quality!.probabilities!.ENTER ?? 0)
  repeatSamples.moveScore.push(answers.btc_expected_move!.score!)
  repeatSamples.highProb.push(answers.btc_failure_risk!.probabilities!.HIGH ?? 0)
  for (const [mode, p] of Object.entries(answers.btc_failure_mode!.probabilities!)) {
    repeatSamples.failureProbs[mode] = repeatSamples.failureProbs[mode] ?? []
    repeatSamples.failureProbs[mode]!.push(p)
  }
  console.log(`  call ${i + 1}/${REPEAT_N}: noul=${answers.veto_btc!.noul!.toFixed(3)} enter=${(answers.btc_entry_quality!.probabilities!.ENTER ?? 0).toFixed(3)} moveScore=${answers.btc_expected_move!.score!.toFixed(2)} failHigh=${(answers.btc_failure_risk!.probabilities!.HIGH ?? 0).toFixed(3)}`)
}

const noiseFloor = {
  noul: stddev(repeatSamples.noul),
  enterProb: stddev(repeatSamples.enterProb),
  moveScore: stddev(repeatSamples.moveScore),
  highProb: stddev(repeatSamples.highProb),
}
console.log('\n  Noise floor (stddev across 20 identical calls):')
console.log(`    noul:      mean=${mean(repeatSamples.noul).toFixed(3)}  sd=${noiseFloor.noul.toFixed(3)}`)
console.log(`    enterProb: mean=${mean(repeatSamples.enterProb).toFixed(3)}  sd=${noiseFloor.enterProb.toFixed(3)}`)
console.log(`    moveScore: mean=${mean(repeatSamples.moveScore).toFixed(3)}  sd=${noiseFloor.moveScore.toFixed(3)}`)
console.log(`    highProb:  mean=${mean(repeatSamples.highProb).toFixed(3)}  sd=${noiseFloor.highProb.toFixed(3)}`)
report.repeatability = { n: REPEAT_N, samples: repeatSamples, noiseFloor }

// A margin smaller than this is "within noise" for any later comparison
// — 3x the repeatability stddev, a conventional, pre-registered multiple
// chosen before any Section 2-4 result was seen.
const SIGNIFICANT = (sd: number) => Math.max(3 * sd, 0.02)

// ---------------------------------------------------------------------------
// 2+3+4. Degeneracy + Discrimination + Feature sensitivity — one fixture
// matrix, analyzed three ways. 8 fixtures: direction x quality x volume.
// ---------------------------------------------------------------------------

console.log('\n=== 2+3+4. DEGENERACY / DISCRIMINATION / FEATURE SENSITIVITY ===')

function entryFixture(direction: 'long' | 'short', quality: 'strong' | 'weak', volume: 'confirmed' | 'weak'): EntryOpportunityInput {
  const sign = direction === 'long' ? 1 : -1
  const base = quality === 'strong'
    ? { ret15mPct: 0.4 * sign, ret30mPct: 0.9 * sign, ret60mPct: 1.8 * sign, realizedVol5m: 0.15, farFromHigh: -4.0, farFromLow: 9.0 }
    : { ret15mPct: 0.05 * sign, ret30mPct: -0.2 * sign, ret60mPct: 0.1 * sign, realizedVol5m: 0.08, farFromHigh: -0.3, farFromLow: 0.4 }
  const volumeTrendRatio = volume === 'confirmed' ? 1.8 : 0.7
  return {
    asset: 'BTC',
    atrTargetDistancePct: 0.025,
    estimatedRoundTripCostPct: 0.003,
    ret15mPct: base.ret15mPct,
    ret30mPct: base.ret30mPct,
    ret60mPct: base.ret60mPct,
    realizedVol5m: base.realizedVol5m,
    volumeTrendRatio,
    // direction-mirrored: "far from high" matters for a long (room to
    // run up); "far from low" matters for a short (room to fall) — both
    // sent regardless of direction since that's the real production
    // shape, only their INTERPRETATION differs by direction.
    sampledDayHighPct: direction === 'long' ? base.farFromHigh : -base.farFromHigh,
    sampledDayLowPct: direction === 'long' ? base.farFromLow : -base.farFromLow,
    armId: direction === 'long' ? 'pullback_long' : 'pullback_short',
    direction,
    bias: direction === 'long' ? 'LONG' : 'SHORT',
  }
}

const matrix: { label: string; direction: 'long' | 'short'; quality: 'strong' | 'weak'; volume: 'confirmed' | 'weak' }[] = [
  { label: 'long-strong-confirmed', direction: 'long', quality: 'strong', volume: 'confirmed' },
  { label: 'long-strong-weakvol', direction: 'long', quality: 'strong', volume: 'weak' },
  { label: 'long-weak-confirmed', direction: 'long', quality: 'weak', volume: 'confirmed' },
  { label: 'long-weak-weakvol', direction: 'long', quality: 'weak', volume: 'weak' },
  { label: 'short-strong-confirmed', direction: 'short', quality: 'strong', volume: 'confirmed' },
  { label: 'short-strong-weakvol', direction: 'short', quality: 'strong', volume: 'weak' },
  { label: 'short-weak-confirmed', direction: 'short', quality: 'weak', volume: 'confirmed' },
  { label: 'short-weak-weakvol', direction: 'short', quality: 'weak', volume: 'weak' },
]

const matrixResults: Record<string, { enterProb: number; enterChoice: string; moveScore: number; highProb: number; failureMode: string }> = {}
for (const m of matrix) {
  const entry = entryFixture(m.direction, m.quality, m.volume)
  const veto: VetoCandidateInput = { asset: 'BTC', direction: m.direction, news: [] }
  const { answers } = await call([veto], [entry])
  matrixResults[m.label] = {
    enterProb: answers.btc_entry_quality!.probabilities!.ENTER ?? 0,
    enterChoice: answers.btc_entry_quality!.choice!,
    moveScore: answers.btc_expected_move!.score!,
    highProb: answers.btc_failure_risk!.probabilities!.HIGH ?? 0,
    failureMode: answers.btc_failure_mode!.choice!,
  }
  console.log(`  ${m.label}: enter=${matrixResults[m.label]!.enterChoice}(${matrixResults[m.label]!.enterProb.toFixed(3)}) moveScore=${matrixResults[m.label]!.moveScore.toFixed(2)} failRisk=${matrixResults[m.label]!.highProb.toFixed(3)} failMode=${matrixResults[m.label]!.failureMode}`)
}
report.matrix = matrixResults

// --- 2. Degeneracy: does the fixture matrix produce MORE spread than noise alone?
const enterProbs = matrix.map((m) => matrixResults[m.label]!.enterProb)
const enterSpread = Math.max(...enterProbs) - Math.min(...enterProbs)
const degeneracyPass = enterSpread > SIGNIFICANT(noiseFloor.enterProb)
console.log(`\n  Degeneracy (entry_quality ENTER-prob): spread=${enterSpread.toFixed(3)} vs significant-threshold=${SIGNIFICANT(noiseFloor.enterProb).toFixed(3)} -> ${degeneracyPass ? 'PASS (varies beyond noise)' : 'FAIL (degenerate / near-constant)'}`)
report.degeneracy = { enterProbs, spread: enterSpread, threshold: SIGNIFICANT(noiseFloor.enterProb), pass: degeneracyPass }

// --- 3. Discrimination: strong beats weak, holding direction+volume fixed, both directions
function discriminationPair(direction: 'long' | 'short') {
  const strong = matrixResults[`${direction}-strong-confirmed`]!.enterProb
  const weak = matrixResults[`${direction}-weak-confirmed`]!.enterProb
  const diff = strong - weak
  const pass = diff > SIGNIFICANT(noiseFloor.enterProb)
  console.log(`  Discrimination (${direction}): P(ENTER|strong)=${strong.toFixed(3)} vs P(ENTER|weak)=${weak.toFixed(3)}, diff=${diff.toFixed(3)} -> ${pass ? 'PASS' : 'FAIL'}`)
  return { direction, strong, weak, diff, pass }
}
const discriminationLong = discriminationPair('long')
const discriminationShort = discriminationPair('short')
report.discrimination = { long: discriminationLong, short: discriminationShort }

// --- 4. Feature sensitivity: volume, pre-registered expected direction —
// ONLY asserted for the breakout/pullback-style setup where volume
// confirmation is part of the arm's own definition (per the user's own
// correction: monotonicity only where logically entailed, never
// asserted blindly on every output).
function volumeSensitivityPair(direction: 'long' | 'short') {
  const confirmed = matrixResults[`${direction}-strong-confirmed`]!.enterProb
  const weakVol = matrixResults[`${direction}-strong-weakvol`]!.enterProb
  const diff = confirmed - weakVol
  const pass = diff > SIGNIFICANT(noiseFloor.enterProb)
  console.log(`  Feature sensitivity, volume (${direction}): P(ENTER|confirmed-vol)=${confirmed.toFixed(3)} vs P(ENTER|weak-vol)=${weakVol.toFixed(3)}, diff=${diff.toFixed(3)} -> ${pass ? 'PASS (reads volume)' : 'FAIL (ignores volume)'}`)
  return { direction, confirmed, weakVol, diff, pass }
}
const volumeSensitivityLong = volumeSensitivityPair('long')
const volumeSensitivityShort = volumeSensitivityPair('short')
report.featureSensitivityVolume = { long: volumeSensitivityLong, short: volumeSensitivityShort }

// --- Internal coherence check (analysis only, no new calls): ENTER chosen
// but the predicted move is the lowest ("Negligible") level.
const coherenceFlags = matrix.filter((m) => matrixResults[m.label]!.enterChoice === 'ENTER' && matrixResults[m.label]!.moveScore < 0.5)
console.log(`\n  Internal coherence: ${coherenceFlags.length}/${matrix.length} fixtures answered ENTER with a "Negligible" expected move (score < 0.5)${coherenceFlags.length > 0 ? ' — ' + coherenceFlags.map((m) => m.label).join(', ') : ''}`)
report.coherenceFlags = coherenceFlags.map((m) => m.label)

// ---------------------------------------------------------------------------
// 5. Cross-asset isolation — the highest-stakes untested assumption
// ---------------------------------------------------------------------------

console.log('\n=== 5. CROSS-ASSET ISOLATION ===')
const catastrophicNews = [
  { id: 'n-hack', source: 'The Block', headline: 'Major exchange discloses $400M exploit, withdrawals paused', summary: 'The exchange confirmed a smart contract exploit drained a significant share of user funds; withdrawals have been halted pending investigation.', publishedAt: new Date(Date.now() - 1_800_000).toISOString(), ageMinutes: 30 },
]
const ethBaselineAlone = await call([{ asset: 'ETH', direction: 'long', news: [] }])
const ethBaselineNoul = ethBaselineAlone.answers.veto_eth!.noul!

const combined = await call([
  { asset: 'BTC', direction: 'long', news: catastrophicNews },
  { asset: 'ETH', direction: 'long', news: [] },
])
const ethCombinedNoul = combined.answers.veto_eth!.noul!
const btcCombinedNoul = combined.answers.veto_btc!.noul!
const isolationDiff = Math.abs(ethCombinedNoul - ethBaselineNoul)
const isolationPass = isolationDiff <= SIGNIFICANT(noiseFloor.noul)
console.log(`  BTC (catastrophic news, same request): noul=${btcCombinedNoul.toFixed(3)}`)
console.log(`  ETH alone baseline (no news):          noul=${ethBaselineNoul.toFixed(3)}`)
console.log(`  ETH in the SAME request as BTC's news:  noul=${ethCombinedNoul.toFixed(3)}`)
console.log(`  |diff|=${isolationDiff.toFixed(3)} vs significant-threshold=${SIGNIFICANT(noiseFloor.noul).toFixed(3)} -> ${isolationPass ? 'PASS (isolated)' : 'FAIL (BTC news leaked into ETH — HIGH SEVERITY)'}`)
report.crossAssetIsolation = { btcCombinedNoul, ethBaselineNoul, ethCombinedNoul, diff: isolationDiff, threshold: SIGNIFICANT(noiseFloor.noul), pass: isolationPass }

// ---------------------------------------------------------------------------
// 6. Direction flip
// ---------------------------------------------------------------------------

console.log('\n=== 6. DIRECTION FLIP ===')
const longCall = await call([{ asset: 'BTC', direction: 'long', news: catastrophicNews }])
const shortCall = await call([{ asset: 'BTC', direction: 'short', news: catastrophicNews }])
const longNoul = longCall.answers.veto_btc!.noul!
const shortNoul = shortCall.answers.veto_btc!.noul!
const directionFlipPass = longNoul - shortNoul > SIGNIFICANT(noiseFloor.noul)
console.log(`  Same negative news, direction=long:  noul=${longNoul.toFixed(3)} (expect HIGH — this IS a threat to a long)`)
console.log(`  Same negative news, direction=short: noul=${shortNoul.toFixed(3)} (expect LOWER — negative news is not a threat to a short)`)
console.log(`  diff=${(longNoul - shortNoul).toFixed(3)} vs significant-threshold=${SIGNIFICANT(noiseFloor.noul).toFixed(3)} -> ${directionFlipPass ? 'PASS' : 'FAIL (direction-aware veto fix may not be working)'}`)
report.directionFlip = { longNoul, shortNoul, diff: longNoul - shortNoul, threshold: SIGNIFICANT(noiseFloor.noul), pass: directionFlipPass }

// ---------------------------------------------------------------------------
// 7. News ablation
// ---------------------------------------------------------------------------

console.log('\n=== 7. NEWS ABLATION ===')
const materialNoul = longNoul // reuse section 6's long+material-news call
const emptyNewsCall = await call([{ asset: 'BTC', direction: 'long', news: [] }])
const emptyNoul = emptyNewsCall.answers.veto_btc!.noul!
const ablationPass = materialNoul - emptyNoul > SIGNIFICANT(noiseFloor.noul)
console.log(`  Material exogenous news: noul=${materialNoul.toFixed(3)}`)
console.log(`  Empty news ([]):         noul=${emptyNoul.toFixed(3)}`)
console.log(`  diff=${(materialNoul - emptyNoul).toFixed(3)} vs significant-threshold=${SIGNIFICANT(noiseFloor.noul).toFixed(3)} -> ${ablationPass ? 'PASS (responds to evidence)' : 'FAIL (noul not driven by news content)'}`)
report.newsAblation = { materialNoul, emptyNoul, diff: materialNoul - emptyNoul, threshold: SIGNIFICANT(noiseFloor.noul), pass: ablationPass }

// ---------------------------------------------------------------------------
// 8. Exclusion-list injection
// ---------------------------------------------------------------------------

console.log('\n=== 8. EXCLUSION-LIST INJECTION ===')
const commentaryNews = [
  { id: 'n-commentary', source: 'Cointelegraph', headline: 'Bitcoin breaks above $85k as analysts eye continued momentum', summary: 'Technical analysts point to strong volume and a bullish chart pattern following the breakout.', publishedAt: new Date(Date.now() - 3_600_000).toISOString(), ageMinutes: 60 },
]
const commentaryCall = await call([{ asset: 'BTC', direction: 'long', news: commentaryNews }])
const commentaryNoul = commentaryCall.answers.veto_btc!.noul!
const exclusionDiff = Math.abs(commentaryNoul - emptyNoul)
const exclusionPass = exclusionDiff <= SIGNIFICANT(noiseFloor.noul)
console.log(`  Empty news baseline:        noul=${emptyNoul.toFixed(3)}`)
console.log(`  Pure price commentary news: noul=${commentaryNoul.toFixed(3)}`)
console.log(`  |diff|=${exclusionDiff.toFixed(3)} vs significant-threshold=${SIGNIFICANT(noiseFloor.noul).toFixed(3)} -> ${exclusionPass ? 'PASS (commentary correctly excluded)' : 'FAIL (commentary is triggering the veto)'}`)
report.exclusionListInjection = { emptyNoul, commentaryNoul, diff: exclusionDiff, threshold: SIGNIFICANT(noiseFloor.noul), pass: exclusionPass }

// ---------------------------------------------------------------------------
// Final verdict + report
// ---------------------------------------------------------------------------

console.log('\n=== FINAL VERDICT ===')
const verdict = {
  degeneracy: degeneracyPass,
  discriminationLong: discriminationLong.pass,
  discriminationShort: discriminationShort.pass,
  featureSensitivityVolumeLong: volumeSensitivityLong.pass,
  featureSensitivityVolumeShort: volumeSensitivityShort.pass,
  crossAssetIsolation: isolationPass,
  directionFlip: directionFlipPass,
  newsAblation: ablationPass,
  exclusionListInjection: exclusionPass,
}
for (const [k, v] of Object.entries(verdict)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`)
report.verdict = verdict

const reportPath = `context/diagnostics/jev-tier2-signal-test-${new Date().toISOString().slice(0, 10)}.json`
await Deno.mkdir('context/diagnostics', { recursive: true })
await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2))
console.log(`\nFull report written to ${reportPath}`)

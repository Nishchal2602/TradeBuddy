# UI Context

**Scope note (2026-10-04, WEB-1):** everything below this point, through § Icons, describes the Chrome extension's own design system only. A second, separate design system for the new web dashboard (a different app entirely — see `CLAUDE.md`'s "Current V0" additions) is defined in its own section at the end of this file, "Web Dashboard Design System." The two are deliberately different (most notably: the web dashboard uses glassmorphism, which § Visual Principles below explicitly tells the EXTENSION to avoid) and must never be conflated or merged — read the section that matches the app you're working on.

## Theme

Dark only. The extension is a compact, technical trading workspace: near-black base, layered surfaces, restrained borders, dense information hierarchy, and high-contrast semantic states. It should feel analytical and serious rather than like a consumer finance app.

The decision feed is the hero. The interface should make it immediately obvious what the agent decided, why it decided it, and what would invalidate the thesis.

No light mode in V0.

## Colors

Use semantic CSS custom properties everywhere. Components must not hardcode hex values.

| Role | CSS Variable | Value |
|---|---|---|
| Page background | `--bg-base` | `#09090B` |
| Primary surface | `--bg-surface` | `#111113` |
| Elevated surface | `--bg-elevated` | `#18181B` |
| Primary text | `--text-primary` | `#F4F4F5` |
| Secondary text | `--text-secondary` | `#A1A1AA` |
| Muted text | `--text-muted` | `#71717A` |
| Primary accent | `--accent-primary` | `#8B5CF6` |
| Accent subtle | `--accent-subtle` | `#2E1B4D` |
| Border | `--border-default` | `#27272A` |
| Border strong | `--border-strong` | `#3F3F46` |
| Success | `--state-success` | `#22C55E` |
| Success subtle | `--state-success-subtle` | `#0D2A18` |
| Error | `--state-error` | `#EF4444` |
| Error subtle | `--state-error-subtle` | `#2B1111` |
| Warning | `--state-warning` | `#F59E0B` |
| Warning subtle | `--state-warning-subtle` | `#2A1E08` |
| Info | `--state-info` | `#38BDF8` |
| Info subtle | `--state-info-subtle` | `#0C2A3D` |
| Neutral | `--state-neutral` | `#71717A` |
| Neutral subtle | `--state-neutral-subtle` | `#1F1F23` |

Positive/negative colors are semantic state colors only. Do not use green/red decoratively.

Every state has a solid/subtle pair. The subtle variant is the tinted-badge background (paired with the solid variant as its text color) used throughout the Decision Card and Positions vocabulary — e.g. `bg-state-success-subtle text-state-success` for a LONG badge. `--accent-subtle` follows the same pattern for non-semantic accent badges.

## Typography

Three families, one job each (UI Step 1, adapted from the Stitch reference designs — see `progress-tracker.md`'s UI Step 1 entry for the full reconciliation with this file's own color/depth strategy, which was kept as-is). All three are vendored locally as variable woff2 (`@fontsource-variable/*`), not loaded from a CDN — MV3's default CSP blocks remote fonts, and the pre-UI-Step-1 `--font-sans`/`--font-mono` values were never actually loaded (V0 rendered on system-font fallbacks until this step).

| Role | Font | Variable |
|---|---|---|
| Headlines, section titles, asset symbols | Space Grotesk | `--font-display` |
| Body text, reasoning prose, descriptions | Geist | `--font-sans` |
| Numbers, prices, and ALL-CAPS micro-labels | JetBrains Mono | `--font-mono` |

Note the third row: uppercase tracked labels (`NET ASSET VALUE`, `ENTRY`, `STOP LOSS`) are mono, not sans — this is deliberate and is what gives the interface its dense, technical character, not an inconsistency.

Use a strong numeric hierarchy. Prices, percentages, confidence, NAV, and P&L always use the mono font.

### Type scale

Eleven fixed roles, each a single class bundling family + size + weight + line-height + tracking (`src/styles/theme.css`'s `.type-*` classes under `@layer components`) — size and family are never chosen independently. `label-*` classes are uppercase by definition; every other class leaves casing to its content. `data-*`/`label-*` use tabular figures (`font-feature-settings: 'tnum' 1, 'zero' 1`) so live-updating prices don't shift width digit-to-digit.

| Class | Family | Size / line-height | Weight |
|---|---|---|---|
| `.type-headline-lg` | Space Grotesk | 22 / 28 | 700 |
| `.type-headline-md` | Space Grotesk | 18 / 24 | 600 |
| `.type-headline-sm` | Space Grotesk | 15 / 20 | 600 |
| `.type-body-lg` | Geist | 14 / 20 | 400 |
| `.type-body-md` | Geist | 13 / 18 | 400 |
| `.type-body-sm` | Geist | 12 / 16 | 400 |
| `.type-data-lg` | JetBrains Mono | 16 / 20 | 600 |
| `.type-data-md` | JetBrains Mono | 13 / 16 | 500 |
| `.type-data-sm` | JetBrains Mono | 11 / 14 | 500 |
| `.type-label-md` | JetBrains Mono | 11 / 14, uppercase | 600 |
| `.type-label-xs` | JetBrains Mono | 9 / 12, uppercase | 600 |

None of these set `color` — combine with a text-color utility (`.type-label-xs.text-state-error`).

## Border Radius

| Context | Class | Value |
|---|---|---|
| Inline / small UI | `rounded-md` | 4px |
| Cards / panels | `rounded-lg` | 6px |
| Modals / overlays | `rounded-xl` | 8px |

Avoid excessive pill-shaped containers. Pills are reserved for compact status/action labels.

## Spacing

No fixed spacing scale beyond Tailwind's default numeric one — the reference designs' density comes from consistent, disciplined *use* of a few values, not a bespoke scale:

| Context | Typical value |
|---|---|
| Page/screen horizontal padding | `px-3` (12px) |
| Card padding | `p-2.5` (10px) |
| Nested panel padding | `p-1.5` (6px) |
| Micro-tile padding | `p-1` (4px) |
| Inline icon/label gaps | `gap-1` to `gap-1.5` (4-6px) |
| Section stack spacing | `gap-2.5` (10px) |

## Dimensions

| Element | Value |
|---|---|
| Popup frame | 420 × 600px |
| Header height | 56px (`h-14`) |
| Bottom nav height | 56px (`h-14`) |
| Minimum touch target | 44 × 44px |

## Component Library

Use shadcn/ui where it provides a useful primitive, with Tailwind for composition.

Components should be reusable and composable. Prefer existing primitives before creating a new one. Keep generated UI primitives isolated from feature-specific business logic.

Use Lucide React for icons.

## Layout Patterns

### Header

Compact top header (`src/components/shell/app-header.tsx`, UI Step 1) containing only:

- Product/agent identity.
- Agent mode — a static "MANUAL" badge (V0 execution mode, 2026-09-19 — see progress-tracker.md's Architecture Decisions). Not derived from `agent_settings.is_paused`, and not a live/pulsing indicator: nothing about it changes at runtime, so it carries no `StatusDot` pulse (reserved for a genuinely live state).

NAV and total P&L live in the Home screen's Portfolio card instead (UI Step 2) — a 56px header has no room to make either legible at this popup's width alongside identity and mode, and Home is already the first thing the user sees. Home's own Agent card (added with the manual-only execution mode, 2026-09-19) is where "last agent run" and the Run Agent control live — not the header.

### Decision Feed

Primary view. Reverse chronological decision cards.

Each card should visually prioritize:

1. Action: OPEN LONG / OPEN SHORT / HOLD / CLOSE.
2. Asset.
3. Confidence.
4. Primary driver.
5. Short reasons.
6. Stop-loss / take-profit (on an open) — visually distinct from invalidation conditions; one is executable, the other is the human-readable thesis.
7. Invalidation conditions.
8. Timestamp/freshness.
9. Expandable details.

The feed should not resemble a generic chat interface.

### Decision Detail

Item 9 above ("expandable details") is a full-screen push (`src/features/decision-detail/`, UI Step 3), not an inline accordion — the popup's height leaves no room to expand a card in place once the detail content is this rich. No bottom nav on this screen; a back arrow returns to whichever tab was active.

Beyond what the card already shows, the detail screen additionally surfaces:

- Technical evidence — the actual indicator values the model reasoned over (RSI, EMA20/50, MACD histogram, ATR%, volume ratio, distance from the 7-day high/low), not just the reason text derived from them.
- News evidence — every news item available to the model for that asset, not only the ones a reason happened to cite.
- The full risk-gate outcome, unconditionally (the card only surfaces this on rejection/clamp) — effective confidence threshold, risk budget, and both exposure caps, plus the approved size and which cap (if any) bound it.
- Position linkage — if the decision opened, closed, or is tracking a position, that position's current state: live unrealized P&L and SL/TP if still open, or the close reason and realized P&L if closed.
- Metadata: decided-at, model version, prompt version, run id.

### Positions

One card per asset (`src/features/positions/`, UI Step 4), not a table — the popup is too narrow for tabular columns to stay legible at this density. Showing, for whichever asset is currently open:

- Asset, direction (long/short).
- Position size (quantity and cost basis).
- Entry price, current mark, stop-loss / take-profit levels.
- Unrealized P&L.
- Hold duration.
- A link to the decision that opened it.

Invalidation state is deliberately not shown inline here — it lives on the *decision*, not the position, and is one tap away via that link rather than a second query per card just to duplicate what Decision-detail already shows in full.

When an asset is flat, its card shows the current price and, if the asset has any history, its most recently closed position — close reason, realized P&L, and a link to whichever decision is more informative (the one that closed it if agent-initiated, otherwise the one that opened it, since an automatic stop-loss/take-profit/collateral-exhaustion exit has no closing decision of its own).

### Controls

Pause/resume and run-now should be obvious but not visually dominant. Risk controls should communicate that they affect the deterministic risk gate.

**Home's "Run agent" is real, as of V0 execution mode (2026-09-19)** — it's the one functional control action in the extension. It invokes the deployed `agent-cycle` Edge Function directly (`src/features/home/run-agent.ts`, anon key as bearer token; no separate `control` wrapper), runs the full pipeline, and refreshes Home's data on completion. This did **not** require a new privileged write endpoint — invoking an Edge Function is a different trust boundary than a direct table write (RLS is irrelevant to it; the function's own service-role client does the actual mutation).

**Everything in Settings remains presentation only** (`src/features/settings/settings-screen.tsx`, unchanged by the above) — no control Edge Function exists to safely mutate `agent_settings` directly from the extension (the anon key is read-only by RLS design there), so Settings' pause/resume, run-now, and the risk-appetite selector all display real current state correctly but have no functional effect when interacted with. The risk-appetite segmented control specifically is deliberately not click-interactive at all (unlike pause/resume/run-now, which are clickable but inert): letting a click visually highlight a different appetite without persisting it would revert on the next poll and read as a bug, not a preview. Wiring any of these for real requires a new backend endpoint, which remains out of scope.

### States

Explicitly design:

- Loading.
- Empty/no decisions.
- Agent idle, awaiting a manual run (V0 execution mode, 2026-09-19 — there is no scheduled run to be "pending," so this replaces that state).
- Running (a manual invocation in flight).
- Cycle skipped.
- Provider error.
- Stale data.
- Risk rejection.
- No open positions.
- Positive P&L.
- Negative P&L.
- Automatic exit (stop-loss / take-profit / collateral-exhausted) — visually distinct from an agent-decided CLOSE; the position-monitor cycle triggered this, not a decision cycle.

Never hide system failures behind an empty UI.

## Decision Card Language

Use concise, evidence-based labels.

Example:

**OPEN LONG BTC · 74% confidence · NEWS**

Why:
- ETF inflow reporting is strongly positive.
- Price is above EMA20 and EMA50.
- Volume is 1.4× the 20-period average.

Stop-loss: $74,545 (−3.0%) · Take-profit: $84,536 (+10.0%)

Invalidation:
- ETF inflow trend reverses over the next few sessions.
- Price structure breaks below EMA50 on rising volume.

Stop-loss and invalidation are shown as visually distinct — the stop-loss is the executable deterministic risk field; invalidation is the model's human-readable thesis. Do not merge them into one block; conflating them is the failure mode this distinction exists to prevent.

Do not display fabricated explanations. Render only persisted decision reasons and references.

## Visual Principles

- Dense information, generous enough spacing for readability.
- Strong hierarchy, minimal decoration.
- Borders and surface contrast instead of heavy shadows.
- Use color primarily for state.
- Avoid gradients, glassmorphism, excessive animation, and decorative charts in V0.
- No unnecessary illustrations.
- No gamification.
- Animations should communicate state changes, not decoration.
- Keep the extension visually coherent at compact Chrome extension dimensions.

## Icons

Use Lucide React.

- Inline: `h-4 w-4`
- Buttons: `h-4 w-4` or `h-5 w-5`
- Section icons: `h-5 w-5`

Use icons as visual support, never as the only way to communicate meaning.

## Web Dashboard Design System (2026-10-03, WEB-1)

A second, separate UI — a desktop web dashboard at `src/web/` (its own Vite entry, `vite.web.config.ts`, builds to `dist-web/`) — alongside the Chrome extension, which this addition does not touch. Built because the extension (complete 2026-09-19) renders almost nothing shipped since: strategy profiles, the two R metrics, V4's six bias-gated arms, the three Jev advisory layers, occupied-asset shadow candidates, or the 4-asset universe. Scoped and verified in `/Users/nishchal/.claude/plans/pricing-and-model-selection-ethereal-fox.md`'s "WEB-1" section.

**This is a deliberate, scoped departure from the extension's own § Visual Principles above — most notably glassmorphism, which that section explicitly tells the extension to avoid.** The extension's principles are unchanged and still govern the extension; this section is the complete, independent spec for the web dashboard only. User-supplied token list; typography, layout, and page content are this project's own design work on top of it.

### Theme

Dark only, single look (no light-mode toggle). Airy and editorial rather than dense/technical — the opposite density choice from the extension, deliberately: this is a desktop surface with real column width, not a 420px popup.

### Tokens

| Role | Variable | Value |
|---|---|---|
| Background | `--w-bg` | `#070A09` |
| Raised surface (sidebar, table headers) | `--w-bg-raised` | `#0B0F0E` |
| Glass tint | `--w-glass` | `rgba(46, 27, 69, 0.05)` (user-supplied: `#2E1B45` @ 5%) |
| Glass tint, strong (row hover / active nav) | `--w-glass-strong` | `rgba(46, 27, 69, 0.09)` |
| Text | `--w-text` | `#FAFAFA` |
| Muted text | `--w-muted` | `#A3A9AD` |
| Faint (chart axes, disabled) | `--w-faint` | `#4A5158` |
| Border | `--w-border` | `#292F36` |
| Border, soft (inner dividers) | `--w-border-soft` | `rgba(41, 47, 54, 0.55)` |
| Accent / secondary | `--w-accent` | `#E0C709` |
| Accent wash (behind active nav) | `--w-accent-dim` | `rgba(224, 199, 9, 0.14)` |
| Positive P&L | `--w-pos` | `#6FBF8B` (desaturated to sit inside this palette) |
| Negative P&L | `--w-neg` | `#D2726B` |
| Font | `--font-web` | Manrope (`@fontsource-variable/manrope`) |

`--w-pos`/`--w-neg` are the one addition beyond the user's supplied list (the mockups render P&L as plain text). Added under the extension's own still-applicable rule — "positive/negative colors are semantic state colors only, never decorative" — desaturated for this palette, used only on numeric P&L and status dots, never as a fill, always paired with an explicit `+`/`−` sign so color is never the sole signal.

All tokens live in `src/web/styles/web-theme.css`, mapped via `@theme inline` the same way the extension's `theme.css` does — no separate Tailwind config file, same v4-via-plugin approach.

**The two stylesheets are reciprocally scoped so neither's utilities leak into the other's bundle**: the extension's `theme.css` has `@source not "../web"`; the web stylesheet has `@import 'tailwindcss' source(none)` plus an explicit `@source '../**/*.{ts,tsx,html}'` (relative to the CSS file's OWN directory — `src/web/styles/`, not the Vite root; verified live, this is easy to get backwards and fails silently with an empty generated stylesheet, no error). Verified by hash-comparing the extension's `dist/` output with and without `src/web/` present — byte-identical.

### Glass surface

```css
.glass {
  background: var(--w-glass);
  border: 1px solid var(--w-border);
  border-radius: 14px;
  backdrop-filter: blur(16px) saturate(130%);
  box-shadow: inset 0 1px 0 rgba(202, 211, 217, 0.035);
}
```
The inset top highlight is what makes a 5%-opacity tint read as a surface rather than a flat wash. `backdrop-filter` needs visual content behind it — a single fixed, very-low-opacity radial glow sits behind the page (`body::before`) for exactly this reason, and is the only decorative element in the system.

### Typography — one family, eight roles

Deliberately one family (Manrope), unlike the extension's three — this is an editorial surface where weight and size carry hierarchy, not a dense technical one needing a mono-for-numerics convention. Numeric alignment comes from `font-variant-numeric: tabular-nums` (the `.tabular` utility / baked into `.wt-stat`/`.wt-num`), not a font-feature string, so it doesn't depend on Manrope's own feature support.

| Class | Size/line | Weight | Use |
|---|---|---|---|
| `.wt-display` | 34/40 | 300 | Page titles |
| `.wt-stat` | 30/36 | 500 | Big stat values |
| `.wt-title` | 19/26 | 500 | Card titles |
| `.wt-body` | 14/22 | 400 | Prose |
| `.wt-body-sm` | 13/20 | 400 | Table cells, descriptions |
| `.wt-num` | 13/18 | 500 | Table numerics |
| `.wt-label` | 10/14 | 600, +0.14em, uppercase | Breadcrumbs, stat labels, table headers |
| `.wt-nav` / `.wt-nav-active` | 14/20 | 400 / 500 | Sidebar |

### Layout

Sidebar 232px fixed (`.glass-raised`, right border, nav items, the "Paper trading" glass callout, a static identity block at the bottom — no auth, nothing to sign into). Main column `px-12 py-10`, content capped at `max-w-[1120px]`. Page header is always breadcrumb → title → subtitle, with an optional right-aligned action (e.g. the Run Agent control). Stat rows are columns divided by a vertical rule (`divide-x`), not separate boxed tiles. Tables use real `<table>` columns — the extension's "popup is too narrow for tabular columns" constraint does not apply here.

Accent (`--w-accent`) is used sparingly: active nav, the status strip's running dot, card eyebrow labels, the chart line/markers. Never a large fill or a button background on its own (buttons use the accent-dim wash + accent border + accent text, not a solid accent fill).

### Pages

Five: Overview (`#/`), Decisions (`#/decisions`, detail `#/decisions/:id`), Positions & Trades (`#/positions`), AI Judgment (`#/judgment`), Strategy & Settings (`#/strategy`). Routing is a ~50-line hand-rolled hash router (`src/web/router.tsx`) — matching this repo's existing minimalism (hand-rolled data hooks instead of react-query) rather than adding a routing library for five pages.

Content decisions worth preserving, since they came from real data constraints rather than taste:

- **No "Confidence" column anywhere**, unlike the mockups. Every deterministic proposal carries a constant `confidence: 1` (`architecture.md`'s own documented invariant) — a dashboard column for it would render a fake, unvarying 100%.
- **Overview's P&L chart defaults to `realized_pnl_cum + unrealized_pnl`, not raw NAV.** NAV includes capital contributions (e.g. the 2026-10-03 +$10,000 injection) and would show a fake spike; the P&L series is immune to it. A toggle switches to NAV, with contribution markers — detected generically from the series itself (any single-tick cash jump ≥$500, not a hardcoded date), so a future contribution marks itself with zero code change.
- **Decisions distinguishes a genuine "shadow candidate" (`decision_type='candidate' AND risk_status='rejected'`) from an ordinary flat-asset `candidate` row** (`decision_type='candidate'`, any other `risk_status`) — found live while building this page: the first version mislabeled every routine flat-asset HOLD as a "shadow candidate" using `decision_type` alone. `src/web/data/display.ts`'s `isShadowCandidate()` is the one place this check lives.
- **`model_version` renders as its own badge** (`modelCallLabel()` in `display.ts`) distinguishing a real call (`jev-1.13.0`) from `call-failed` (outage) from `not-called` (disabled/no candidate) — the same disambiguation `CLAUDE.md` names as a standing invariant for any analysis of model behavior.
- **AI Judgment leads with its own sample size** (`NDisclosure` — this system's thinnest data, n=2 for the full advisory layer set at build time) and never computes a composite score across the three Jev layers — matching the project's own explicit refusal to invent that policy in code.
- **`price_r` and `position_pnl_r` render as two separate labelled fields everywhere**, never collapsed into one "R" (`CLAUDE.md`: "after an ADD at a worse price they can disagree").
- Three-column risk-control table on Strategy & Settings (profile value / settings ceiling / effective `min()`) rather than one number — this project had a real multi-week bug where those three silently diverged.

### Reuse

`src/supabase.ts`, `src/format.ts`, `src/features/decisions/display.ts`'s label maps (re-exported, not duplicated), `src/features/home/run-agent.ts`'s `invokeAgentCycle()`, `src/hooks/use-now.ts`, and every `src/shared/**` type are reused unmodified. `src/components/ui/*` (the extension's own primitives) are NOT reused — they hardcode the extension's token class names; the web app has its own primitives in `src/web/ui/`.

### WEB-2 addendum (2026-10-08) — portfolio-scoped routing + Experiments section

Scoped and verified in the plan's own "WEB-2" section, after EXP-1's 4 live test accounts began trading and needed a monitoring UI. Two parts, built together.

**Routing — every page is now optionally portfolio-scoped.** A `/p/:portfolioId/...` path-segment prefix, peeled off by `parseHash` before the existing dispatch chain runs unmodified — a bare URL (`#/decisions`) still means the champion, exactly as before; `#/p/<id>/decisions` means that specific account. `hrefFor(path, portfolioId?)`/`navigate(path, portfolioId?)` both gained an optional second parameter. `App.tsx` is keyed by `portfolioId` (`<AppShell key={portfolioId ?? 'champion'}>`) so an account-context fetch never needs a manual "reset to idle" transition inside its own effect — a fresh mount already starts correct. An `AccountContextBar` (new, `shell/account-context-bar.tsx`) renders above every page's content whenever `portfolioId` is set, showing the account's own `name` (NOT `portfolios.label`, which holds the experiment/batch name shared by every account in it, e.g. `exp1-e4-dry-run` — a real naming trap hit once while building this). The sidebar's nav items each declare `scoped: boolean`; every scoped item carries the current account forward via `hrefFor`, so clicking between Overview/Decisions/Positions/etc. inside a test account's own view stays inside it — only the new **Experiments** nav item (placed right after Overview — the two "monitor my accounts" entry points) is always unscoped.

**A closed data-mixing gap**: `decisions.ts`/`judgment.ts` previously had zero portfolio scoping at all and silently blended every account's rows together. Both now resolve `is_test=false` (the champion) when `portfolioId` is absent, matching every other page's own established convention — an explicit, deliberate behavior change to the bare routes' output, not a silent one.

**Strategy & Settings gained an "Account treatment" card** (rendered only when scoped) — a 4-column table (`Setting | Global default | Variant override | Effective for this account`) mirroring the page's own pre-existing 3-column Risk Controls pattern. Built by mirroring (not importing — Vite cannot resolve the Deno-only `supabase/functions/` tree) the backend's own `resolveAccountSettings`/`ResolvedVariant` shape from `cycle/resolve-account-settings.ts`/`db/experiment-account.ts`.

**New top-level section: Experiments** (`#/experiments` list → `#/experiments/:id` detail, mirroring the existing Decisions→DecisionDetail list/detail pattern). The detail page's sections, each built from already-portfolio-scoped queries: accounts (each account name a real `target="_blank"` anchor to `hrefFor('/', portfolioId)` — a genuine new-tab link, not a `DataTable` row-click, specifically because only a real anchor supports ctrl/cmd-click and "open in new tab"), variants/config, a config-diff view (`diffConfigs()` in `data/experiment-detail.ts` — recursively flattens nested fields like `arms`/`directionPolicy`, diff-only by default against a selectable baseline with a "show all fields" expand toggle for full auditability), a multi-series performance overlay (`ui/multi-line-chart.tsx`, new — chosen over a small-multiples grid specifically because these accounts are a deliberately single-variable comparison and divergence-over-time is the one question it needs to answer), decision/trade analysis, failure/reliability analysis, and an in-app-only generated report (no export — explicit decision) that composes already-fetched data with **no composite score, rank, or winner field anywhere**.

**New primitives**: `ui/select.tsx` (lifted from `decisions.tsx`'s own local component once a second consumer appeared), `ui/multi-line-chart.tsx`, `ui/chart-utils.ts` (the non-component `downsample`/`SERIES_PALETTE`/`ChartPoint`/`ChartMarker` exports, split out of `line-chart.tsx` so no file mixes a component export with a plain value export — a Fast Refresh granularity concern). Four new CSS variables, `--w-series-1..4` (`web-theme.css`), a categorical palette anchored on `--w-accent` for series 1, deliberately avoiding the `--w-pos`/`--w-neg` green/red family so a chart line's color can never be misread as implying a win/loss judgment.

**A real, permanent dashboard limitation surfaced on the Failure & Reliability section**: `duplicate_tick`/`already_running` are return-value-only signals from a *failed* `agent_runs` insert (confirmed by reading all three Edge Functions directly) — no row is ever written for either, so neither can ever appear in any `agent_runs`-based breakdown. Stated in the UI itself, not silently absent.

Extension `dist/` output verified byte-identical before and after this entire unit (hash-diffed, per WEB-1's own established verification technique).

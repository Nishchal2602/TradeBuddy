# UI Context

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

Compact top header containing:

- Product/agent identity.
- Agent status.
- NAV.
- Total P&L.
- Next scheduled run.

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

### Positions

Compact table/list showing:

- Asset.
- Direction (long/short).
- Position size.
- Entry price.
- Current price.
- Stop-loss / take-profit levels.
- Unrealized P&L.
- Hold duration.
- Invalidation state.

### Controls

Pause/resume and run-now should be obvious but not visually dominant. Risk controls should communicate that they affect the deterministic risk gate.

### States

Explicitly design:

- Loading.
- Empty/no decisions.
- Agent paused.
- Scheduled run pending.
- Running.
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

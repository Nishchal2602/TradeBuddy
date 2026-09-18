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
| Neutral | `--state-neutral` | `#71717A` |

Positive/negative colors are semantic state colors only. Do not use green/red decoratively.

## Typography

| Role | Font | Variable |
|---|---|---|
| UI text | Inter | `--font-sans` |
| Numbers / data / code | JetBrains Mono | `--font-mono` |

Use a strong numeric hierarchy. Prices, percentages, confidence, NAV, and P&L should use the mono font where appropriate.

## Border Radius

| Context | Class |
|---|---|
| Inline / small UI | `rounded-md` |
| Cards / panels | `rounded-lg` |
| Modals / overlays | `rounded-xl` |

Avoid excessive pill-shaped containers. Pills are reserved for compact status/action labels.

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

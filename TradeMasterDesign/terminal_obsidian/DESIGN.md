---
name: Terminal Obsidian
colors:
  surface: '#111316'
  surface-dim: '#111316'
  surface-bright: '#37393d'
  surface-container-lowest: '#0c0e11'
  surface-container-low: '#1a1c1f'
  surface-container: '#1e2023'
  surface-container-high: '#282a2d'
  surface-container-highest: '#333538'
  on-surface: '#e2e2e6'
  on-surface-variant: '#c1c6d7'
  inverse-surface: '#e2e2e6'
  inverse-on-surface: '#2f3034'
  outline: '#8b90a0'
  outline-variant: '#414755'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e69'
  primary-container: '#4b8eff'
  on-primary-container: '#00285c'
  inverse-primary: '#005bc1'
  secondary: '#bcc7dd'
  on-secondary: '#263142'
  secondary-container: '#3c475a'
  on-secondary-container: '#aab6cc'
  tertiary: '#00e296'
  on-tertiary: '#003822'
  tertiary-container: '#00a56d'
  on-tertiary-container: '#00311d'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a41'
  on-primary-fixed-variant: '#004493'
  secondary-fixed: '#d8e3fa'
  secondary-fixed-dim: '#bcc7dd'
  on-secondary-fixed: '#111c2c'
  on-secondary-fixed-variant: '#3c475a'
  tertiary-fixed: '#4dffb1'
  tertiary-fixed-dim: '#00e296'
  on-tertiary-fixed: '#002112'
  on-tertiary-fixed-variant: '#005233'
  background: '#111316'
  on-background: '#e2e2e6'
  surface-variant: '#333538'
typography:
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 22px
    fontWeight: '700'
    lineHeight: 28px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
  body-lg:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-md:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  data-lg:
    fontFamily: JetBrains Mono
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.02em
  data-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
  data-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.05em
  label-xs:
    fontFamily: JetBrains Mono
    fontSize: 9px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.08em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.5rem
  margin: 0.75rem
  space-xs: 0.25rem
  space-sm: 0.375rem
  space-md: 0.625rem
  space-lg: 0.875rem
  space-xl: 1.25rem
---

## Brand & Style

This design system delivers a high-density, mission-critical trading terminal interface built for rapid browser-extension execution and deep market telemetry. 

The aesthetic marries brutalist precision with modern high-frequency trading software ergonomics. The emotional target is immediate cognitive clarity, computational authority, and calm during high-volatility execution. Structural framing relies on clean 1px hairline delimiters, deep obsidian dark space, and radiant electric cobalt blue feedback signals. Decorative ambient glow is strictly suppressed in favor of zero-latency visual hierarchy, tabular scanning speed, and precise state management.

## Colors

The palette is directly derived from high-contrast terminal hardware and the image swatch:
- **Primary (`#007AFF`)**: Electric cobalt blue. Serves as the primary operational hue, indicating active focus, active tabs, CTA triggers, selected order routes, and execution highlights.
- **Secondary (`#4A5568`)**: Desaturated slate gray. Used for structural framing, inactive tabs, hairline delimiters, subtle dividers, and muted contextual metadata.
- **Tertiary (`#00E699`)**: High-visibility phosphor green. Reserved strictly for long positions, positive delta, filled executions, and live stream telemetry markers (counterbalanced with `#FF3B30` for short positions, negative delta, and margin alerts).
- **Neutral Base (`#121417`)**: Deep graphite-obsidian. Applied as the primary app background, accompanied by surface layering tones:
  - Surface Root: `#0D0E11`
  - Surface Base: `#121417`
  - Surface Raised / Card: `#1A1D23`
  - Surface Interactive / Hover: `#222730`
  - Surface Border / Hairline: `#2B313A`
  - Text Primary: `#F0F4F8`
  - Text Secondary: `#8A96A6`
  - Text Dimmed / Code: `#525D6C`

## Typography

The type system is divided into three distinct functional tiers:
1. **Space Grotesk** anchors primary structure, asset symbols (e.g., `BTC/USD`, `NVDA`), and module titles, offering an authoritative, architectural character.
2. **Geist** governs micro-copy, contextual notifications, and settings, providing balanced, unobtrusive legibility at small sizes.
3. **JetBrains Mono** drives all market telemetry, order-book volumes, pricing matrices, and execution tickers. Numbers must always use tabular figures (`font-feature-settings: 'tnum' on, 'zero' on`) to avoid jitter during real-time streaming updates.

Labels below 11px are uppercase with positive letter spacing (`+0.05em` to `+0.08em`) to guarantee quick perceptual classification across trading panels.

## Layout & Spacing

Because this system is tailored for high-density environments (such as a 380px–440px width Chrome Extension popover or docked multi-column sidebar), spacing is compact and rigorous:
- **Base Grid**: 4px strict baseline unit.
- **Fixed Width Container**: Popover canvas operates at a default of 400px width with an overflow-y auto-scroll boundary limited to 580px max height.
- **Micro-Gutter Strategy**: Order book, metric bars, and depth charts use compressed gutters (`space-xs` and `space-sm`) to maximize visible telemetry per vertical inch.
- **Section Margins**: Outer chrome padding is locked to `0.75rem` (12px), yielding maximum data density without edge clipping against browser shell frames.

## Elevation & Depth

This system intentionally eliminates blurred drop shadows, ambient halos, and diffuse lighting. Depth is structured purely through **Tonal Stacking** and **1px Low-Contrast Hairlines**:

1. **Canvas (Ground)**: `#0D0E11` – the unlit terminal foundation.
2. **Card/Container (Level 1)**: `#121417` bounded by a crisp `1px solid #2B313A` hairline.
3. **Control/Input (Level 2)**: `#1A1D23` inset with `1px solid #363D48`.
4. **Active/Hover Elements (Level 3)**: Background shifts to `#222730` with border snapping to `#007AFF`.
5. **Modal/Flyout Menus**: Flat `#1A1D23` with high-contrast perimeter outline `1px solid #4A5568` and an absolute backdrop dimming mask (`rgba(13, 14, 17, 0.85)`).

## Shapes

The interface embraces a disciplined, squared-off technical geometry:
- Default components (buttons, input fields, metric cards, order book rows) use subtle `0.25rem` (4px) corner radii (`roundedness: 1`).
- Pill shapes are prohibited to avoid wasting horizontal pixel density.
- Precision controls (stepper arrows, segmented buy/sell split selectors, status pills) use crisp 2px–4px radius maximums.
- Hairline borders are always uniform 1px without corner bleeding.

## Components

### Buttons & Quick Execution Bars
- **Primary Execute**: Background `#007AFF`, foreground `#FFFFFF`, font `Space Grotesk` (600), height 36px, `border-radius: 4px`. Hover activates `#1A8CFF`; pressed state triggers `#0066D6`.
- **Buy / Long Action**: Background `#00E699`, foreground `#0B1E16`, bold monospace text.
- **Sell / Short Action**: Background `#FF3B30`, foreground `#FFFFFF`, bold monospace text.
- **Secondary / Ghost**: Transparent fill with `1px solid #2B313A`, text `#8A96A6`. Hover applies border `#007AFF` and text `#F0F4F8`.

### Input Fields & Steppers
- Height: 32px or 36px. Surface `#16191E`, border `1px solid #2B313A`.
- Active focus: Border transforms to `#007AFF` with 0px box shadow (hard hairline change).
- Numeric text rendered in `JetBrains Mono` with fixed trailing asset tickers (`USDT`, `SOL`, `ETH`) pinned in muted text (`#525D6C`).

### Telemetry Cards & Metric Chips
- Surface `#121417`, hairline `#2B313A`.
- PnL Chips: Inline micro-badges with 2px border radius, filled with 10% opacity background of the signal color (`#00E6991A` for gains, `#FF3B301A` for losses) paired with 100% solid colored text.

### Segmented Tabs & Switchers
- Border frame `1px solid #2B313A`, background `#0D0E11`.
- Active Tab: Solid background `#1A1D23` with a top or bottom 2px indicator bar of `#007AFF`.

### Order Book & Telemetry Tables
- Striped alternating lines prohibited; use subtle hover highlight `#1A1D23` across the entire row.
- Depth indicator bars render as horizontal background volume bars using transparent cobalt (`rgba(0, 122, 255, 0.12)`) or transparent green/red fills aligned right-to-left.
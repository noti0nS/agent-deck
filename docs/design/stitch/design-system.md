---
name: Instrument Console
colors:
  surface: '#111317'
  surface-dim: '#111317'
  surface-bright: '#37393d'
  surface-container-lowest: '#0c0e11'
  surface-container-low: '#1a1c1f'
  surface-container: '#1e2023'
  surface-container-high: '#282a2d'
  surface-container-highest: '#333538'
  on-surface: '#e2e2e6'
  on-surface-variant: '#c4c7c9'
  inverse-surface: '#e2e2e6'
  inverse-on-surface: '#2f3034'
  outline: '#8e9194'
  outline-variant: '#44474a'
  surface-tint: '#c4c7ca'
  primary: '#ffffff'
  on-primary: '#2d3133'
  primary-container: '#e0e3e6'
  on-primary-container: '#626567'
  inverse-primary: '#5c5f61'
  secondary: '#c0c7d5'
  on-secondary: '#2a313b'
  secondary-container: '#424955'
  on-secondary-container: '#b2b9c6'
  tertiary: '#ffffff'
  on-tertiary: '#2c313a'
  tertiary-container: '#dee2ef'
  on-tertiary-container: '#60646f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e0e3e6'
  primary-fixed-dim: '#c4c7ca'
  on-primary-fixed: '#191c1e'
  on-primary-fixed-variant: '#44474a'
  secondary-fixed: '#dce3f1'
  secondary-fixed-dim: '#c0c7d5'
  on-secondary-fixed: '#151c26'
  on-secondary-fixed-variant: '#404752'
  tertiary-fixed: '#dee2ef'
  tertiary-fixed-dim: '#c2c6d2'
  on-tertiary-fixed: '#171c24'
  on-tertiary-fixed-variant: '#424751'
  background: '#111317'
  on-background: '#e2e2e6'
  surface-variant: '#333538'
typography:
  display:
    fontFamily: Newsreader
    fontSize: 2.5rem
    fontWeight: '400'
    lineHeight: 3rem
    letterSpacing: -0.02em
  display-mobile:
    fontFamily: Newsreader
    fontSize: 1.75rem
    fontWeight: '400'
    lineHeight: 2.25rem
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Newsreader
    fontSize: 1.75rem
    fontWeight: '400'
    lineHeight: 2.25rem
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Newsreader
    fontSize: 1.375rem
    fontWeight: '400'
    lineHeight: 1.75rem
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Geist
    fontSize: 1.125rem
    fontWeight: '600'
    lineHeight: 1.5rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Geist
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5rem
    letterSpacing: 0em
  body-sm:
    fontFamily: Geist
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
    letterSpacing: 0.005em
  label-code:
    fontFamily: JetBrains Mono
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.25rem
    letterSpacing: -0.01em
  label-meta:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: '500'
    lineHeight: 0.875rem
    letterSpacing: 0.05em
  metric-large:
    fontFamily: JetBrains Mono
    fontSize: 2rem
    fontWeight: '500'
    lineHeight: 2.25rem
    letterSpacing: -0.03em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-tablet: 0.75rem
  gutter-desktop: 1.25rem
  margin: 1rem
  margin-tablet: 1.5rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system establishes an observe-only, glanceable operating surface engineered for peripheral monitoring. Positioned on an auxiliary display, mounted tablet, or desk stand, the interface functions as a dedicated digital gauge rather than an interactive IDE. The emotional posture is disciplined, quiet, and reliable: zero visual clamor, zero artificial neon illumination, and absolute semantic integrity.

Drawing inspiration from mid-century Swiss industrial instruments (Braun, Dieter Rams, metric flight instrumentation) and austere editorial typography, the system balances dense structural telemetry with breathing room. High contrast is reserved strictly for actionable state shifts. Every pixel serves cognitive triage—allowing an engineer deep in thought to confirm fleet health or spot blocking permissions with an unfocused peripheral glance at arm's length.

## Colors

The palette employs rigorous chromatic restraint. Color is never decorative; it is solely an informational vector indicating lifecycle state and attention priority.

- **Background Canvas (`#0D0F12`)**: Deep void obsidian, suppressing backlighting glare on secondary displays.
- **Surface Elevation 1 (`#161A20`)**: Subtly lifted dark graphite for structural lanes and panel divisions.
- **Surface Elevation 2 (`#1B2028`)**: Accentuated surface for focused agent inspection or elevated status blocks.
- **Structural Outlines (`#1F242D`)**: Hairline borders providing tactile separation without heavy visual mass.
- **Primary Text (`#E6E8EB`)**: Warm, desaturated ivory designed to eliminate harsh eye strain caused by pure white against black.
- **Secondary / Meta Text (`#8E95A2`)**: Subdued industrial slate for timestamps, parameters, labels, and baseline metrics.
- **Active State (`#10B981`)**: Calm, balanced emerald designating autonomous agent execution, active token streaming, or ongoing test runs.
- **Pending Attention State (`#F59E0B`)**: Dense warm amber strictly reserved for blocking states: tool approvals, security escalation prompts, or required user input.
- **Fault State (`#EF4444`)**: Deep vermilion indicating unhandled runtime exceptions, failed assertions, or exited processes.
- **Idle / Settled State (`#4B5563`)**: Cool graphite for quiescent, paused, or cleanly exited tasks.

## Typography

The typographic hierarchy juxtaposes classical Swiss editorial authority with ruthless machine-readable telemetry.

- **Newsreader** delivers an intentional editorial cadence for console names, agent identities, and high-level milestones. It strips away the sterile developer tool cliché, framing automated work as structured literature and curated processes.
- **Geist** manages interface scaffolding, summaries, prose status descriptions, and conversational reasoning steps with geometric precision and neutral legibility at distance.
- **JetBrains Mono** powers terminal outputs, execution arguments, token meters, diff paths, git hashes, and timestamps. Always set with tabular lining numerals (`tnum`) to eliminate spatial jitter during active output streaming.

## Layout & Spacing

Layout geometry follows a precision-bracketed modular grid engineered for glanceability. Content never flexes into arbitrary floating states; it is snapped to strict structural coordinates.

- **Primary Canvas**: A fluid column grid (12 columns on desktop/tablet landscape, 4 columns on portrait mobile) structured by precise 1px partition dividers.
- **Arm's Length Ergonomics**: Margins are widened on auxiliary widescreen and tablet formats (`1.5rem` to `2rem`) to frame status registers away from physical display bezels.
- **Density Tiers**: Component internals use disciplined compact spacing (`space-xs` and `space-sm`) for terminal and parameter rows, paired with generous section gaps (`space-lg` and `space-xl`) between distinct autonomous agent tracks.
- **Multi-Agent Tiling**: When multiple agents run concurrently, the canvas divides into independent vertical telemetry columns. Column widths preserve minimum legible line lengths for code inspection while keeping status indicators horizontally aligned.

## Elevation & Depth

This system avoids floating volumetric shadows, colored glows, and blurred transparency layers. Depth is constructed purely through flat tonal layering and precise hairline borders.

- **Base Field**: `#0D0F12` represents the silent console floor.
- **Module Enclosures**: `#161A20` defines bounded agent panes, bounded by a uniform `1px solid #1F242D` rule.
- **Sub-panels & Code Registers**: `#12151B` recessed backgrounds communicate passive telemetry chambers.
- **Blocking Overlays**: In the exceptional event of an interactive confirmation modal, an opaque backdrop scrim (`#0D0F12` at 85% opacity) isolates the modal panel. The panel itself uses a dual stroke: an inner hairline of `#2A323D` enclosed by a crisp `#1F242D` outer boundary. Shadows are completely omitted in favor of structural tonal contrast.

## Shapes

Shapes communicate precision toolcraft. Curvature is kept minimal (`0.25rem` baseline) to maintain crisp, architectural edges evocative of hardware metering decks.

- **Panels & Dividers**: `4px` (`0.25rem`) corner radius for modular containers.
- **Pills & Metas**: `2px` to `4px` corner radius for status tags and code segments. Full pill shapes are forbidden, as they undermine the technical rigor of the interface.
- **Indicators**: State telemetry lights are exact square pips or micro-rectangles, accentuating the mechanical gauge language.

## Components

### Status Rails & Telemetry Gauges
- **Agent Monitor Enclosure**: Structured panel featuring a top header row with the agent name in Newsreader, followed by monospace branch/commit metadata, uptime timers, and active step indices.
- **Status Pip**: A compact 6x6px mechanical square indicator. Emerald (`#10B981`) for working states with a subtle discrete step blink (no glowing trails); Amber (`#F59E0B`) for approval halts; Vermilion (`#EF4444`) for runtime failures; Cool Graphite (`#4B5563`) for dormant threads.

### Telemetry Stream & Terminal View
- Bounded viewport with a sunken `#12151B` background and `#1F242D` perimeter line.
- Text rendered exclusively in `label-code`, using `#8E95A2` for routine command logging, `#E6E8EB` for active stdout, and deliberate semantic highlighting for warnings and errors.
- Tabular numeric execution counters aligned strictly along the right edge.

### Action Confirmation Brackets (Observe-Only Overrides)
- When user attention is required (e.g., shell access authorization), the affected agent card border transitions entirely to `#F59E0B`.
- Action blocks use flat rectangular containers with high-contrast mono labels (`[ AWAITING INPUT: Y / N ]`). Secondary buttons use `#1F242D` backgrounds with `#E6E8EB` text; destructive abort buttons use muted vermilion outlines.

### Chips & Metadata Tags
- Minimalist rectangular metadata tags with 2px borders, `#161A20` background, and `label-meta` typography. Tags display execution parameters, context window consumption, and model signatures (e.g., `CLAUDE-3-7-SONNET`, `OPENCODE-V1`).
- No icon clutter; metadata uses clear textual keys separated by mid-dots or structural pipes.

### Lists & Activity Feeds
- Structured as dense ledger rows separated by hairline `#1F242D` borders.
- Monospace timestamps are left-aligned, followed by event descriptions and duration telemetry right-aligned. Hover states are passive, indicated only by a subtle background shift to `#1B2028`.

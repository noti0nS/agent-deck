# Agent Deck — Design System (`DESIGN.md`)

**Aesthetic Direction:** OpenCode Premium Terminal-Grade Instrument Panel  
**Form Factor:** Tablet-First Always-On Desk Display (Landscape 1024×768 / 1280×800) & Compact Phone Companion (390×844 / 412×915)  
**Mode:** Strictly Dark-Only (`color-scheme: dark`) · Zero-Touch Glanceable · Observe-Only

---

## 1. Design Philosophy & Core Principles

Agent Deck is a **hardware-grade observability deck** for AI coding agents (**OpenCode**, **Claude Code**, **Codex**, **Antigravity / agy**). It combines **OpenCode's signature modern, high-craft developer aesthetic**—obsidian carbon surfaces, recessed terminal wells, razor-sharp 1px specular borders, and monospace telemetry precision—with the ergonomics of a desk instrument panel readable from 2 meters away.

1. **Glanceable Before Interactive (P1):** Primary run state, active tool step, and token burn must be legible at 1–2m without scrolling or hovering.
2. **Furniture, Not a SaaS Dashboard (P2):** Feels like a dedicated hardware telemetry unit from OpenCode. No marketing gradients, no drop-shadow clutter, no nested card soup.
3. **Strict Observe-Only Surface (P5):** Agent Deck never mutates or controls agents. There are **no** Approve, Deny, Stop, or Prompt buttons anywhere in the UI. When an agent is blocked (`waiting`), the card transforms into a high-visibility read-only beacon directing the developer to their terminal.
4. **Honest Telemetry & Freshness (P3, P7):**
   - **Confidence tiers:** `live` (solid rail/dot), `polled` (subtle badge), `inferred` (segmented/dotted status rail and `····` badge).
   - **Cost precision:** Never blend vendor-reported spend with estimated API rates silently. Exact vendor spend renders cleanly (`$2.41`); derived figures always carry an explicit `est.` badge (`$2.41 est.`); `none` omits cost entirely.
5. **Strict Motion Budget (P8):** At most **two animated elements per screen at rest**. Motion encodes liveness, never decoration.

---

## 2. Color Tokens (OpenCode Carbon & Telemetry Palette)

Colour encodes **status** and **source identity**, never arbitrary decoration.

### 2.1 Surface Hierarchy
| Token | Hex / Value | Usage |
|---|---|---|
| `--bg` | `#090A0D` | Deep carbon-obsidian canvas background |
| `--bg-elevated` | `#0D0F14` | Recessed telemetry well, terminal command box, chart canvas |
| `--surface` | `#12151C` | Primary instrument card surface & header bar |
| `--surface-hover` | `#171B24` | Active/pressed touch state & elevated module header |
| `--surface-glass` | `rgba(18, 21, 28, 0.88)` | Bottom thumb-reach navigation dock with `backdrop-filter: blur(12px)` |
| `--hairline` | `#212631` | Primary 1px structural border |
| `--hairline-strong` | `#2E3545` | Highlighted border, active tab frame, badge outline |
| `--specular-top` | `rgba(255, 255, 255, 0.05)` | Subtle 1px top inner highlight on instrument cards |

### 2.2 Typography & Ink Hierarchy
| Token | Hex | Usage |
|---|---|---|
| `--text` | `#ECEDF2` | Primary crisp alabaster ink for titles, active commands, primary numbers |
| `--muted` | `#8B93A6` | Secondary technical slate for labels, inactive tabs, timestamps |
| `--faint` | `#4C5365` | Structural dividers, empty tick slots, decorative glyphs (`⤢`, `·`) |

### 2.3 Semantic Status Accents
| Status | Token | Hex | Visual Treatment |
|---|---|---|---|
| **Running / Active** | `--running` | `#3DDC97` | Phosphor mint rail (`3px`), `● running` badge, slow 3s opacity pulse |
| **Waiting ("Needs You")** | `--waiting` | `#FFB020` | Signal amber rail (`3px`), subtle amber card wash (`rgba(255, 176, 32, 0.04)`), `⚠` pulse |
| **Failed / Error** | `--failed` | `#FF5E5E` | Alert crimson rail (`3px`), `✕ failed` badge, high-burn alarm pill |
| **Compacting** | `--compacting` | `#6BA6FF` | OpenCode electric blue rail (`3px`), `⇄ compacting` |
| **Stalled** | `--stalled` | `#7A8496` | Muted slate rail (`3px`), `◌ stalled` |
| **Done** | `--done` | `rgba(61, 220, 151, 0.4)` | Dimmed mint rail (`3px`), `✓ done` |
| **Idle / Detached** | `--idle` | `#4A5160` | Dormant graphite rail (`3px`), `○ idle` / `⊘ detached` |

### 2.4 Agent Source Badges (6px Dot + Monospace Tag Only)
| Source | Token | Hex |
|---|---|---|
| **OpenCode** | `--opencode` | `#6BA6FF` |
| **Claude Code** | `--claude` | `#D97757` |
| **Codex** | `--codex` | `#E8EBF0` |
| **Antigravity (`agy`)** | `--agy` | `#A78BFA` |
| **PTY Wrapper** | `--pty` | `#38BDF8` |

---

## 3. Typography & Scannable Hierarchy

OpenCode's visual signature relies on the tension between geometric UI sans-serif headers and razor-sharp tabular monospace telemetry.

- **UI Sans (`--font-sans`):** `'Geist'`, `'Inter'`, `system-ui`, `-apple-system`, sans-serif.
  - Used for session titles (`16px–17px`, `font-weight: 500`, tight tracking `-0.01em`) and human-readable descriptions.
- **Technical Monospace (`--font-mono`):** `'JetBrains Mono'`, `'Geist Mono'`, `'Cascadia Mono'`, `'Fira Code'`, `ui-monospace`, monospace with `font-variant-numeric: tabular-nums`.
  - Used for **all** numbers, token counts, costs, elapsed timers, project names, model IDs, file diffs (`+18 −4`), and live tool command lines.
- **Micro-Chrome Labels (`.chrome-label`):**
  - `12px–13px`, uppercase, `letter-spacing: 0.09em`, `font-weight: 600`, colour `--muted`.

---

## 4. Layout, Geometry & Hardware Framing

- **Corner Radius:** Crisp, technical corners (`2px` to `4px` / `rounded-sm` to `rounded`). Never pill-shaped cards or bubbly `16px+` radii.
- **Borders & Hairlines:** `1px solid var(--hairline)` with a subtle top specular edge (`box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.04)`).
- **Status Rail:** Every session card and ambient band has a `3px` (or `4px` in Ambient) flush left status bar. If `confidence === 'inferred'`, the rail uses a repeating segmented linear gradient so inferred state is unmistakable at a glance.
- **Touch Ergonomics:** All interactive targets (cards, view switcher buttons, range toggles, back buttons) enforce a minimum hit target of `48px` height (`min-h-[48px]`), with zero horizontal overflow at `390px`, `412px`, `1024px`, and `1280px`.

---

## 5. Core Views & Component Architecture

### 5.1 Pinned Top Telemetry Strip (Deck Header)
- **Height:** `56px` minimum on tablet; responsive wrap on phone.
- **Left cluster:** OpenCode-style live status LED + Primary Token Counter (`430.0k tok` in bold `20px` tabular mono), separated by recessed hairline dividers from Cost Summary (`$2.41` / `est.`), Active count (`3 active` in mint), and Waiting count (`⚠ 1 waiting` in amber pill).
- **Right cluster:** Live burn-rate telemetry (`tok/min` or high-contrast `🔥 $0.65/min` crimson alarm badge) + subtle desktop settings link (`/settings`).

### 5.2 Run Card (`RunCard.svelte`)
1. **Header Row:** `6px` source dot + source badge (`OPENCODE`) + bold monospace project name (`ProdigyR4Apps`) + optional `UNREAD` mint chip on the left; confidence indicator + tabular elapsed timer (`05:00`) + expand glyph (`⤢`) on the right.
2. **Title Block:** Up to 2 lines of high-contrast session title (`16px` medium `#ECEDF2`), plus optional 1-line dim subtitle/goal.
3. **Terminal "Now" Well:** Recessed `#090A0D` box with `1px` border (`#212631`). Displays status icon + label (`● running`) on the left, active tool pill (`edit`, `bash`) + monospace detail (`src/Mcp/OAuth/PkceFlow.cs`) in the center, and git diff counters (`+18 −4`) on the right.
4. **60-Second Micro-Timeline:** 60 vertical telemetry bars (`1px–2px` gap) encoding the last 60 seconds of activity (`tool` = 14px mint, `waiting` = 12px amber, `error` = 14px crimson, `thinking` = 8px slate, `none` = 3px faint).
5. **Footer Telemetry Bar:** Separated by a `1px` hairline. Left side shows todo step ratio (`1/2 steps`), model badge (`gpt-5.6-luna`), and `in / out` token split. Right side shows honest cost (`$2.41` or `$0.42 est.`), turn count, and relative freshness (`10s ago`).

### 5.3 "Needs You" Waiting State (Read-Only Alert Card)
- Sorts to the very top of the Deck.
- Features a `3px` amber left rail, subtle amber surface tint, pulsing `⚠` icon, and `waiting 0:15` timer.
- Displays the blocked prompt or shell command inside a recessed terminal box with an amber hairline (`border-[#FFB020]/50`).
- **Footer instruction:** `→ answer in the terminal · tap to see context` (never action buttons).

### 5.4 Ambient View (`AmbientView.svelte`)
- Chrome-free, 2× typography scale for 2–3m across-the-room legibility.
- Top hero telemetry matrix: **Today's Tokens**, **API-Equiv / Spend**, **Active Sessions**, and conditional **Needs You** counter.
- Full-width horizontal agent bands with `4px` status rails, `24px` project names, live tool command stream, elapsed time, and total tokens.

### 5.5 Usage View (`UsageView.svelte`)
- Segmented **Today / Last 7 Days** switcher + 4-column hero KPI grid (Tokens + 7d trend badge, Actual Spend, API-Equiv `est. API-rate`, Live Burn Rate `$/min`).
- **7-Day Tokens/Hour Sparkline:** Hand-crafted SVG (`2px` `#3DDC97` stroke with subtle area gradient fill and terminal endpoint dot).
- **2-Column Breakdown:** Stacked `3px` input/output token bars by project (`#6BA6FF` in / `#3DDC97` out) + compact tabular model matrix with pricing table version stamp.
- **High-Burn / Low-File-Delta Sessions:** Clickable audit list of expensive runs with minimal file output.

### 5.6 Ledger View (`LedgerView.svelte`)
- 24-hour horizontal Gantt timeline (`00:00` to `24:00` ruler ticks).
- Each session renders as a precision timeline row with source dot, project name, status-coloured horizontal activity bar positioned over the 24h track, and right-aligned token/cost readout.

### 5.7 Detail View (`DetailView.svelte`)
- Read-only deep inspection with `← Back` button and session metadata header (`ID · confidence`).
- 3-column instrument grid: **Plan & Todos** (with SVG circular progress ring), **Step Timeline** (highlighted `NOW` box + duration-stamped tool history), and **Session Usage & File Edits** (2×2 metric grid + diff chips).
- **Redacted Transcript Tail:** Recessed terminal log viewer with role badges (`USER`, `ASSISTANT`, `TOOL`).

### 5.8 Bottom View Switcher Dock
- Fixed bottom bar (`safe-bottom`), hidden in Ambient mode.
- Uses OpenCode's sleek segmented terminal tab styling with keyboard-style index hints (`01 AMBIENT`, `02 DECK`, `03 USAGE`, `04 LEDGER`), active top/border indicator (`#6BA6FF`), and `≥48px` touch targets.

# Agent Deck - Clean Tablet Dashboard

## Authoritative reference
Stitch project Agent Deck Monitor, projects/7661839418307341010.
Selected screen: Agent Deck Clean Tablet Dashboard (2e2c8a4c42094912ac89ad8f2116f6d5).
Local HTML and screenshot: docs/design/stitch/agent-deck-clean-tablet-dashboard.*.
This selection supersedes the previous OpenCode instrument-panel direction and the alternative Avionics designs.

## Visual language
Dark, quiet, flat dashboard. Background #101214, header #0c0e10, cards #1e2023, inset command areas #0c0e11. Thin #2b2e32 separators; no gradients, glow or ornamental shadows. Corners 2-4px. Use white project headings, muted grey metadata, amber attention rails and emerald running rails. Color must always be paired with text.
Sans-serif UI (Geist/Inter/system fallback), restrained serif secondary descriptors (Newsreader/Georgia fallback), monospace commands and tabular metrics (JetBrains Mono/system fallback). No remote font dependency is required.

## Structure
A compact global header identifies Agent Deck, connection state, active sessions, attention and cost. Settings remain accessible on phones. Below: status tabs All Projects / Needs Attention / Running. The deck is a responsive grid: one column on phones, two on medium tablets, three at wide tablet/desktop widths following the reference breakpoints.
Cards lead with project name and a readable status badge, then agent name and session title, an inset current-task/permission area, optional real todo progress, and duration/token/cost footer. Waiting cards direct the user to answer in the terminal. Cards open session detail.
The gear menu provides source visibility, Ambient, Usage, Ledger, and the full settings page. Detail opens from a project card. The sixth grid tile summarizes observed throughput and tool outcomes. Multiple sessions in a project have a session selector.

## Behavior and data integrity
Observe-only: no approve/deny/stop buttons. Never copy example model names, hostnames, commands, progress percentages, terminal IDs or costs from Stitch into production data. Show unknown values honestly; mark estimated costs. Preserve source visibility preferences, AGY reconciliation, session hierarchy, pairing, history and background models.dev refresh.
Status tabs and source filters compose; counts describe projects after source filtering. Empty selections have an explanatory empty state and can be reversed. Source selection is device-local; Usage historical totals remain global and are labeled accordingly.

## Mobile and accessibility
Document-level vertical scroll; no transformed ancestor for the fixed header. Keep safe-area clearance. Wrap long names and commands, avoid horizontal overflow and nested scroll traps. Controls have at least 48px touch targets, visible keyboard focus, accessible labels and pressed states. Reduced motion is respected. Mobile is a fully usable companion, not a clipped tablet canvas.

## Verification
Check 390x844 and 412x915 phones plus 1024x768 and 1280x800 tablets. Exercise touch scrolling, gear-menu navigation, source persistence, status tabs, empty states and detail navigation. Inspect screenshots and verify built assets through the existing Tailscale address. Do not infer live agent state from mock designs.

## Fidelity correction
The authoritative screen is reproduced with a fixed 56px header, gear menu, inline project status filters, and a grid containing five project cards plus Throughput & Ledger. Two columns from 768px and three from 1280px follow the original HTML. There is no bottom navigation and no source-selector strip on the dashboard. The gear menu holds source visibility, secondary views and the full settings link. Projects group sessions by workspace path; their session selector opens the corresponding context. Observed telemetry replaces illustrative data. The earlier lower navigation and wide cards are superseded.

# Agent Deck — Implementation Plan

A tablet-first **observability deck** for every AI coding agent running on your
machine: **OpenCode, Claude Code, Codex, agy (Antigravity CLI)**. It watches, it
measures, it looks good doing nothing. It is not a command center.

Status: plan / pre-implementation · Author: planning pass 2026-10-23 (rev. 2 —
scope narrowed to monitoring + usage) ·
Companion doc: [`docs/adapter-research.md`](docs/adapter-research.md)

---

## 0. TL;DR

**What you get:** an always-on tablet on your desk that reads like a piece of
hardware — a live instrument panel of every agent session, plus the numbers you
actually want: tokens burned, money spent, turns run, time invested, today and
per project. Each card tells you at a glance what an agent is doing right now and
whether it is stuck or waiting on you. Tap for depth: plan, tool calls, diffs,
transcript tail.

**What it is not:** a remote control. You do not approve permissions, send prompts,
or run commands from the tablet. When something needs you, the tablet *tells* you,
and you go to the terminal where the work actually lives. This is a deliberate
scope cut, not a phase — see §1.3.

**How it works:** one local **collector daemon** on the PC normalises four very
different CLIs into a single event stream; the tablet runs a **SvelteKit PWA**
served over Tailscale HTTPS that holds a reducer against that stream. No cloud, no
credentials leaving the machine, no changes to how you launch your CLIs (except
Claude Code hooks, which are fail-open and reversible).

**The single most important design decision:** the collector is a *sidecar*. It
reads what the CLIs already write and subscribes to what they already expose. It
never owns the session lifecycle. If the monitor is down, your agents behave
exactly as they do today.

**The one thing that makes this project hard:** these four tools have four
different truth models — OpenCode has a real API, Claude Code has no status flag
at all, Codex has a shared daemon marked experimental, and agy has per-conversation
SQLite with an undocumented RPC surface. Roughly 60% of the engineering effort is
adapter work, not UI. The plan front-loads that.

**The one thing that makes this project good:** it is a *display*, so craft is the
product. Motion, typography, colour discipline and restraint are not polish at the
end — they are the feature. §8 treats them as a first-class subsystem.

**Headline effort:** ~5–6 focused weeks to a genuinely useful v1 (M0–M7 in §11), with
a usable single-source version at day 6 and the usage views at day ~22.

---

## 1. Product definition

### 1.1 The job to be done

> "I have four agents working in four terminals on two monitors. I want to glance
> at a tablet and know: what is running, what is stuck, what is waiting on me, and
> what all of this is costing me — without switching windows."

Three jobs, and the weighting has changed from the first draft of this plan:

1. **Observability of usage** — tokens, cost, turns, tool calls, time, per project
   and per model, live and historical. This is the primary product.
2. **Awareness** — is anything blocked on me, stuck, or failed? Read-only signal.
3. **Comprehension** — what is each agent doing, in one line I can read at 2 m?

Control is not a job. Depth (transcripts, diffs) is where you go when a number or
a status makes you curious, not the default surface.

### 1.2 Product principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Glanceable before interactive** | Primary state readable at 2 m. No hover. No scroll needed for the core question. Design for zero-touch. |
| P2 | **The tablet is furniture, not an app** | It turns on, shows the truth, and asks nothing of you. No navigation to learn, no setup to redo, no session to keep alive. |
| P3 | **Never lie about freshness** | Every run carries a confidence level (live event, polled, inferred). Stale state is visibly stale, never silently stale. |
| P4 | **Fail-open sidecar** | A monitor bug must never block, slow, or crash a CLI. Hooks always exit 0. All writes are bounded and timeboxed. |
| P5 | **Observe only** | The app has no write path into any agent. No approve, no prompt, no kill. This is a permanent architectural property, not a v1 restriction. |
| P6 | **Local-only by default** | Tailnet-bound, token-paired. No telemetry, no cloud, no accounts. |
| P7 | **Honest about measurement** | Tokens are measured or absent, never invented. Money is shown only where the tool reports it; otherwise it is an explicit, labelled estimate. Subscriptions make "$" a fiction — see §7.2. |
| P8 | **Craft is the feature** | A monitor that is unpleasant to look at gets turned off. Motion, type and colour are specified, not improvised. |

### 1.3 Non-goals (out of scope, permanently)

- **Any control surface**: approving permissions, denying, sending prompts,
  answering questions, stopping runs, killing processes.
- Being a terminal / running commands yourself.
- Replacing the CLI TUIs, or a chat UI for agents.
- Cloud sync, multi-user, team dashboards.
- Editing agent config, skills, prompts, MCP servers.
- Native mobile app shells: phones get a compact responsive layout of the same
  read-only views, but the tablet stays the primary form factor.

> The reason P5/§1.3 are stated this strongly: a "monitor that can also approve"
> quietly becomes a remote control with a dashboard attached, and then every design
> decision bends toward interaction. Keeping the write path non-existent is what
> makes the visual and ambient design possible. The adapter SPI has no mutation
> methods at all (§5.1) so this cannot drift by accident.

---

## 2. Verified integration surface

Full evidence and raw findings: [`docs/adapter-research.md`](docs/adapter-research.md).
All four CLIs were probed on this machine; nothing below is assumed.

| | OpenCode | Claude Code | Codex | agy |
|---|---|---|---|---|
| Live push channel | ✅ SSE on local HTTP API | ❌ (hooks instead) | ⚠️ app-server JSON-RPC *(experimental)* | ⚠️ remote-control daemon *(opt-in, currently off)* |
| Status flag | ✅ `time_compacting`, session state | ❌ none — must infer | ✅ `task_started`/`task_complete` | ✅ `steps.status` |
| History store | ✅ SQLite, 909 sessions | ✅ JSONL transcripts | ✅ JSONL rollouts | ✅ per-conversation SQLite |
| Tokens + cost | ✅ exact per session, incl. `cost` column | ⚠️ usage in transcript records | ✅ `token_usage_record` | ⚠️ `gen_metadata` (needs decode) |
| Usage granularity | per session + per message parts | per assistant message | per turn + per token record | per step |
| Subagent tree | ✅ `session.parent_id` | ✅ `SubagentStop` hook | ✅ `response_item` | ✅ `parent_references` |
| Waiting-on-you signal | ⚠️ `permission` table + API | ✅ `Notification` hook | ⚠️ `event_msg` | ✅ `steps.permissions` |
| Port / discovery | ✅ `opencode service status` | n/a | ✅ `codex agents` | ⚠️ `remote-control status` |

Note the deliberate absence of a "control" row: nothing in this system can mutate
an agent, so no adapter exposes a mutation capability.

**Consequences baked into the design:**

1. OpenCode is the reference adapter. Build it first, end-to-end, to prove the
   whole pipeline — it has the least ambiguity *and* the best usage data (a real
   `cost` column, exact token counters, per-message parts).
2. Claude Code needs an **ingest shim** because it has no status flag. This is the
   one place the monitor touches the user's config.
3. Codex and agy must be built against **capability detection**, because their
   best channels are experimental/undocumented. Both need a file-based fallback
   that works with zero configuration.
4. Usage fidelity varies enough between sources that it must be modelled
   explicitly (§7.1): per-source precision tiers, never a silently blended total.
5. A **universal PTY wrapper** is the escape hatch for any CLI, any version, and
   any future tool (see §5.6). This is what makes the system extensible.

---

## 3. Architecture

### 3.1 Shape

```
   ┌────────────────────────────── your PC ──────────────────────────────┐
   │                                                                     │
   │  OpenCode        Claude Code        Codex            agy            │
   │  ┌────────┐      ┌──────────┐      ┌────────┐      ┌────────┐       │
   │  │ TUI +  │      │ TUI +    │      │ TUI +  │      │ TUI +  │       │
   │  │ bg svc │      │ hooks    │      │ app-svr│      │ conv DB│       │
   │  └───┬────┘      └────┬─────┘      └───┬────┘      └───┬────┘       │
   │      │ SSE/HTTP       │ UDP 127.0.0.1 │ HTTP/JSONL     │ SQLite RO  │
   │      ▼                ▼               ▼                ▼            │
   │  ┌──────────────────────────────────────────────────────────────┐   │
   │  │                    COLLECTOR  (Node 24)                      │   │
   │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │   │
   │  │  │ opencode │ │ claude   │ │ codex    │ │ agy      │ Adapters│   │
   │  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘         │   │
   │  │       └────────────┴────────────┴────────────┘               │   │
   │  │                        ▼                                     │   │
   │  │              Normalizer ── StatusEngine ── Redactor          │   │
   │  │                        ▼                                     │   │
   │  │           EventBus ── RingBuffer ── SQLite (WAL)             │   │
   │  │                        ▼                                     │   │
   │  │           HTTP + SSE  (:4100)   UDP ingest (:4101)           │   │
   │  └──────────────────────────────────────────────────────────────┘   │
   └──────────────────────────────────┬──────────────────────────────────┘
                                      │  Tailscale HTTPS (tailnet only)
                                      │  token-paired session cookie
                                      ▼
                        ┌──────────────────────────────┐
                        │   TABLET — SvelteKit PWA     │
                        │   reducer · stores · views   │
                        └──────────────────────────────┘
```

### 3.2 Components

| Component | Responsibility | Never does |
|---|---|---|
| **Adapter** | Connect to one CLI, emit `RawEvent`s, report health | Know about UI, other adapters, or the DB |
| **Normalizer** | Map `RawEvent` → normalized `AgentEvent` with stable ids | Interpret status (that's StatusEngine) |
| **StatusEngine** | Own the run state machine + freshness rules | Talk to adapters or IO |
| **Redactor** | Strip secrets/paths-as-secrets from anything persisted or streamed | Mutate source data |
| **Store** | SQLite writes, retention, aggregates | Serve HTTP directly |
| **Transport** | Snapshot, SSE stream, usage queries, pairing token | Hold domain logic |
| **Web app** | Render, reduce, reconnect, cache shell | Poll heavily or compute truth |

The key boundary: **adapters produce events, the StatusEngine produces state.**
Status is never a field an adapter writes, because no CLI reports it consistently.
Concentrating it in one pure, unit-testable module is what makes four
inconsistent sources behave like one product.

### 3.3 Process model

- Collector runs as a **single Node process**, started by `monitor start` or as a
  Windows service / scheduled task for always-on use.
- Adapters run **in-process** as supervised supervisors: each has its own
  reconnect loop, error budget and health status. One adapter crashing must not
  take down others (wrap in try/catch + restart with backoff; isolate the SQLite
  and PTY work off the main loop where it matters).
- The web app is served by the same process (`/` → static build), so there is one
  port and one origin. No CORS, no separate deploy.

### 3.4 Data flow (one tool call, end to end)

```
Claude runs Bash("npm test")
  → PreToolUse hook fires
  → shim sends one UDP datagram: {ev:"PreToolUse", sid, tool:"Bash", input:{command:"npm test"}, ts}
  → collector ingests, normalizes → AgentEvent{tool.started, runId, name:Bash, detail:"npm test"}
  → StatusEngine: run stays `running`, updates currentStep, bumps lastActivityAt
  → EventBus → SQLite insert + SSE broadcast (seq 10432)
  → tablet receives delta, reducer updates card
  → card's "now" line changes to `bash  npm test` and the tick animation continues
```

Latency target: **< 150 ms** from hook fire to card update over the tailnet. That is
achievable with UDP + SSE and no polling.

---

## 4. Domain model

### 4.1 Core entities

```ts
type Source = 'opencode' | 'claude' | 'codex' | 'agy' | 'pty';

type RunStatus =
  | 'starting'          // process/session exists, no turn yet
  | 'running'           // actively working
  | 'waiting'           // blocked on a permission prompt or a question ← highest priority
  | 'compacting'        // context compaction in progress
  | 'stalled'           // was running, no activity > threshold
  | 'idle'              // session open, nothing happening
  | 'done'              // turn complete
  | 'failed'            // error / non-zero exit
  | 'detached';         // process gone without a clean end event

type Confidence = 'live' | 'polled' | 'inferred';

interface AgentRun {
  id: string;                 // stable: `${source}:${nativeId}`
  source: Source;
  nativeId: string;
  parentId?: string;          // subagent tree
  projectPath: string;
  projectName: string;        // basename, disambiguated
  title: string;
  model: string;
  agentMode?: string;         // build / plan / accept-edits / auto
  status: RunStatus;
  confidence: Confidence;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  currentStep?: Step;         // one-line "now"
  todos: Todo[];
  usage: Usage;
  attention?: Attention;      // display-only "needs you" indicator
  children: string[];
  unread: boolean;            // finished/failed since last viewed
}

interface Step {
  label: string;              // 'edit' | 'bash' | 'read' | 'think' | 'web' | 'mcp:name'
  detail: string;             // 'src/api/routes.ts +42 −7'
  startedAt: number;
  tool?: string;
}

interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  costSource: 'tool' | 'estimated' | 'none';  // see §7.2 — never blend silently
  turns: number;
  toolCalls: number;
  activeMs: number;           // wall time actually working, excludes idle
}

// Read-only. The monitor reports that an agent is blocked and why;
// it can never answer on the user's behalf (P5).
interface Attention {
  kind: 'permission' | 'question' | 'error' | 'idle_prompt';
  summary: string;            // 'wants to run: dotnet test --filter …'
  resource?: string;
  projectPath?: string;
  requestedAt: number;
}
```

### 4.2 Event taxonomy

Twelve normalized events. Everything else is UI state.

| Event | Carries | Drives |
|---|---|---|
| `run.started` | run skeleton | card appears (enter animation) |
| `run.updated` | changed metadata fields | title/model/project updates |
| `run.ended` | final usage, outcome | completion state, unread badge |
| `state.changed` | from → to, reason | status rail, sorting, ambient ring |
| `turn.started` / `turn.completed` | turn index | timeline ticks, turn counter |
| `tool.started` / `tool.completed` | name, detail, durationMs, ok | "now" line, step timeline |
| `message.completed` | role, preview (≤400 chars) | detail view tail |
| `file.changed` | path, additions, deletions | diff chip, detail view |
| `todo.updated` | full todo list | progress ring |
| `attention.raised` / `attention.cleared` | Attention object | "needs you" state (read-only) |
| `usage.tick` | token/cost deltas | live counters, burn rate |
| `error.raised` | message, recoverable | red card state |
| `health.changed` | adapter, connected/degraded/off | top-bar warning strip |

Envelope on the wire:

```ts
interface Envelope {
  seq: number;        // monotonic, also the SSE `id:`
  ts: number;
  type: string;
  runId?: string;
  payload: unknown;   // small; big content fetched separately
}
```

Design rule: **envelopes stay under ~2 KB.** Transcripts, diffs and tool output
are never pushed; the card shows a summary and the Detail view requests the body on
demand. This is what keeps a 4-source stream cheap on a tablet.

### 4.3 StatusEngine — the rules

Pure function of `(previous state, events, liveness)`. Deterministic, fully unit
tested, no IO.

**Priority (highest wins):**
```
waiting > failed > stalled > compacting > running > done > idle > detached
```

**Transition rules:**

| Trigger | Transition | Notes |
|---|---|---|
| `attention.raised` | → `waiting` | sticky; survives unrelated events; clears when the CLI resolves it or activity resumes |
| `attention.cleared` | → previous working state | or `done` if the turn had ended |
| `tool.started`, `turn.started`, `message.completed` | → `running` | bump `lastActivityAt` |
| `compact.*` | → `compacting` | explicit clear on next activity |
| `turn.completed` / `Stop` / `task_complete` | → `done` | then `idle` after 90 s if session alive |
| `error.raised` (fatal) | → `failed` | sticky until dismissed in the UI |
| no event for `> 120 s` while `running` and liveness ok | → `stalled` | UI: slate, "quiet 2m" |
| liveness lost (process gone) without end event | → `detached` | UI: "lost contact" |
| liveness lost, then reappears | resume from last known | never fabricate `running` |

**Freshness / confidence:**
- `live` — a real event arrived in the last 60 s.
- `polled` — state comes from a ≤5 s poll (DB mtime, `codex agents`).
- `inferred` — derived only from file mtime / lock presence.

The UI renders `inferred` with a dotted status ring instead of solid. Cheapest
possible honesty.

**Stall thresholds** are per-source (Claude's `Notification` hook fires on idle
prompting, OpenCode's compaction can run 2 min): configurable, defaulting to
120 s warn / 600 s alarm.

---

## 5. Adapters

### 5.1 Adapter SPI

Every adapter implements the same narrow, **read-only** contract. Adding a fifth
CLI must not require touching core, transport or UI.

```ts
interface Adapter {
  readonly source: Source;
  probe(): Promise<Capabilities>;   // what works right now, on this version
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  // Intentionally no mutation methods. This interface cannot approve,
  // prompt or kill anything (P5, §1.3).
}

interface Capabilities {
  liveEvents: boolean;
  usagePrecision: 'exact' | 'derived' | 'partial' | 'none';  // see §7.1
  attention: boolean;          // can it report "blocked on you"
  subagents: boolean;
  notes: string[];             // human-readable, shown in `agent-deck doctor`
}
```

`probe()` runs at startup and emits `health.changed` with the capability set. The
UI **hides data it cannot honestly show** rather than showing a placeholder — e.g.
a source with `usagePrecision: 'none'` renders the card without a cost footer
instead of printing `$0.00`. Capability-driven UI is the only way to survive these
CLIs' changelogs.

### 5.2 OpenCode — reference adapter

Build first, ship first.

| Channel | Use |
|---|---|
| `opencode service status` | discover base URL, re-probe every 30 s |
| `GET {base}/event` (SSE) | live transitions |
| `GET {base}/session` | snapshot + reconciliation |
| `opencode.db` (read-only immutable) | titles, todos, cost/tokens, history, `parent_id` tree |
| `time_compacting` | `compacting` state |

Pseudo-flow:

```
loop:
  url = serviceStatus()            # cheap, cached
  connect SSE url/event
  on event -> normalize -> emit
  every 30s: reconcile session list (catch missed events)
  on disconnect: backoff 1,2,4,8 (cap 30s), mark health degraded
```

Gotchas: the `event` table in SQLite is empty — do **not** build on it. Pending
permissions live in the API, not the `permission` table.

### 5.3 Claude Code — hooks + tailer

Two halves, deliberately.

**Ingest shim.** A tiny binary (`tools/hook-shim`, ~5 MB, ~3 ms startup) that reads
the hook JSON from stdin and fires one UDP datagram at `127.0.0.1:4101`, then
exits 0 unconditionally. UDP because it is fire-and-forget: no timeout, no
retry, no failure mode that can touch the CLI.

Why a binary and not a Node script: hooks fire on **every tool call**. A 60 ms
Node cold start × hundreds of calls per session is a real tax, and it makes the
monitor a plausible cause of "why is Claude slow".

Hooks installed (idempotent, tagged with `_source: "agent-deck"` for clean removal):

```jsonc
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "agent-deck-hook" }] }]
  }
}
```

Onboarding rule: **never write to `~/.claude/settings.json` silently.** `monitor
setup claude` shows a unified diff of exactly what it will add, backs up the
original to `~/.claude/settings.json.bak-<ts>`, and `monitor uninstall` reverses it.
Hooks are the only place this app modifies another tool's config; it must be
boring and reversible.

**Tailer.** Watches `~/.claude/projects/**/*.jsonl` from a persisted byte offset,
parses new lines, and supplies the richness hooks don't provide: `ai-title`,
`last-prompt`, assistant message previews, `file-history-delta`, token counts.
Also detects `--bg` background sessions (they run detached, so the monitor is the
only place you'd see them) via process scan + session files.

### 5.4 Codex — daemon + rollouts

| Channel | Use | Status |
|---|---|---|
| `codex agents` / app-server JSON-RPC | live multi-session state | experimental — capability-gated |
| `~/.codex/sessions/**/rollout-*.jsonl` | `task_started`, `task_complete`, `token_usage_record`, `compacted`, `thread_goal_updated` | stable, primary |
| `notify = [...]` in `config.toml` | turn-end push | opt-in, off by default |

Start with the rollout tailer (works today, zero config, real token data), add the
app-server channel behind capability detection, and treat `codex agents` as the
"is Codex's daemon alive and what does it know" oracle during reconciliation.

Rollouts give the monitor something unique: `thread_goal_updated` is a genuine
one-line statement of intent. Surface it as the card's subtitle — better than
inferred titles.

### 5.5 agy — three tiers, degrade gracefully

1. **DB tier (default, zero config, always works).** Read
   `~/.gemini/antigravity-cli/conversations/<id>.db` read-only. `steps.status` is
   the status machine, `steps.permissions` is the "needs you" signal,
   `parent_references` is the subagent graph, `conversation_summaries.db` is the
   index. Poll mtime every 2 s; only re-read the tail of `steps` when it changes.
2. **Daemon tier (opt-in).** `agy remote-control start` then
   `remote-control status --json` for push-quality state. This changes machine
   state (registers a background daemon), so it is an explicit toggle in setup,
   with a visible indicator that it was enabled by Agent Deck.
3. **Stream tier (wrapper).** If launched via `agent-deck run agy …`, use
   `--output-format stream-json` for perfect fidelity and per-step usage.

**Do not use `presence/*.lock` for liveness** — stale locks from months ago are
present on this machine. Use `steps.status` + DB mtime + process presence.

**Usage work for this adapter is bigger than for the others.** `gen_metadata` and
`executor_metadata` are undocumented protobuf-ish blobs that probably hold token
and timing data. Budget a dedicated decode pass in M5 (see §7.1), and ship the
card without cost if the decode fails. `agentapi get-conversation-metadata` may be
a cheaper route than decoding the blobs — try it first.

### 5.6 Universal PTY wrapper — the extensibility story

`agent-deck run -- <any cli> [args]` launches the CLI in a pseudo-terminal
(`node-pty`), captures ANSI output, and derives turns/tool calls from a
per-tool heuristic profile. Lower fidelity, always available.

This matters for three reasons:
- It covers agy's tier 3 and any CLI without hooks.
- It is the answer to "what about the next tool I start using?" — a new adapter
  can start as a profile, not a project.
- It makes the app defensible when a CLI breaks its own format in a point release.

Ship it late (M7), but design the `Source` union and adapter SPI to accommodate it
from day one so it isn't a rewrite.

---

## 6. Transport & API

### 6.1 Why SSE + POST rather than WebSocket

Tablets sleep, roam Wi-Fi, and switch networks constantly. SSE gives
free auto-reconnect, works through everything, and supports `Last-Event-ID`
replay natively — which is exactly the "wake from sleep, catch up in 200 ms"
behaviour the product needs. The only client→server traffic is pairing, mark-read
and view preferences: a handful of POSTs per hour. WebSocket would buy
bidirectionality we don't need and cost reconnect logic we'd have to write.

### 6.2 Endpoints

```
GET  /api/snapshot                 full state: runs[], aggregates, adapters[], config
                                   ETag + If-None-Match → 304
GET  /api/stream                   SSE. id: = seq. honours Last-Event-ID
GET  /api/runs/:id                 detail (todos, steps, children, usage)
GET  /api/runs/:id/transcript      ?cursor=&limit=  (lazy, paginated)
GET  /api/runs/:id/diff            ?file=

GET  /api/usage/summary            ?from=&to=       totals + burn rate + trend
GET  /api/usage/timeseries         ?from=&to=&bucket=1h|1d&source=&project=&model=
GET  /api/usage/breakdown          ?by=project|model|source|day&from=&to=
GET  /api/usage/runs               paginated historical runs, sortable by cost/tokens/time
GET  /api/health                   adapters + collector + storage

POST /api/pair                     { code } → sets httpOnly cookie
POST /api/prefs                    layout, columns, theme, ambient schedule
```

There is no mutation endpoint for any agent. The only POSTs are pairing, view
preferences, and mark-read — none of which touch a CLI.

Auth: a 32-byte token generated at first run, bound to a `httpOnly; SameSite=Lax`
cookie after pairing. Loopback bypasses pairing (for dev). LAN/Tailnet shows a QR
code in the terminal:

```
$ agent-deck pair
  Scan to open Agent Deck on your tablet
  ██▀▀▀▀▀██ ▄▀ ██▀▀▀▀▀██   https://deck.<tailnet>.ts.net
  ██ ▀██ ██ ▀▀ ██ ▀██ ██   code: 7F2K-9QRT  (expires 5 min)
  ██▄▄▄▄▄██ ▄▄ ██▄▄▄▄▄██
```

All non-loopback access requires HTTPS (see §10.3) — the QR encodes the MagicDNS
name, not an IP, so the bookmark survives DHCP changes.

### 6.3 Reconciliation & replay

- **Ring buffer:** last 5,000 envelopes in memory for `Last-Event-ID` replay.
- **Gap handling:** if the requested `seq` is older than the buffer, respond
  `409` with a `resync` hint → client fetches `/api/snapshot` instead of replaying.
  This is the correct fallback and must be tested (tablet asleep for an hour).
- **Server reconciliation:** each adapter also polls its source every 30 s and
  diffs against in-memory state. Missed events self-heal. Any adapter that only
  pushes and never reconciles will eventually drift.
- **Client reducer** is a pure function `(state, envelope) → state`, shared from
  `packages/core` and unit-tested against the same fixtures the collector uses.
  One reducer, two consumers (server aggregate, client view) — no duplicated
  business rules.

### 6.4 Batching

The collector coalesces envelopes into frames at **10 Hz max**:

```ts
// per frame: `[ [seq,type,runId,payload], ... ]`
```

A busy four-agent setup generates bursts (token ticks, per-tool-call pairs).
Sending each as its own SSE frame makes a weak tablet stutter. Coalescing at
100 ms is invisible to humans and cuts frames by ~10×.

---

## 7. Storage & the usage model

This section is now the centre of the product, not a support detail. Usage is the
thing you'll look at every day, so it gets explicit modelling.

### 7.1 Usage precision tiers

The four tools report usage at very different fidelity, and pretending otherwise
is the fastest way to produce numbers you stop trusting. Every usage value carries
a precision, and the UI renders it accordingly.

| Tier | Meaning | Sources | UI treatment |
|---|---|---|---|
| **exact** | The tool reports tokens *and* a monetary cost | OpenCode (`cost`, `tokens_*`) | plain number |
| **derived** | Real token counts, cost computed from a price table | Codex (`token_usage_record`), Claude (transcript usage) | number + `est.` marker |
| **partial** | Some counters present (e.g. input only, or per-turn granularity) | agy (`gen_metadata`, TBD) | partial numbers, no total |
| **none** | Nothing reliable | any adapter before its decode work lands | footer omitted, never `0` |

Rule: **never sum across precision tiers into one headline number without
labelling it.** The headline for the day is tokens (always measurable), with money
as a secondary figure marked `est.` unless every contributing source is `exact`.
A blended total that is 40% estimated is worse than no total.

### 7.2 Money is a fiction on subscription plans

If you're on Claude Max, ChatGPT Plus/Pro, or a flat-rate OpenCode plan, you are
not billed per token. A computed `$` figure is a *counterfactual*: "what this would
have cost at API rates." That is genuinely interesting, but it is not spend, and
the app must never imply otherwise.

Therefore three separate numbers, never conflated:

1. **Tokens** — the primary metric. Always real, always comparable.
2. **API-equivalent cost** — tokens × a versioned price table, labelled
   `est. API-rate`. Useful for comparing a heavy session against a light one.
3. **Actual spend** — only where a tool reports it (OpenCode's `cost` column).
   Labelled plainly, no estimate.

The price table lives in `packages/pricing` with a version string, a `updatedAt`,
and a settings screen showing both, so a number from last month can explain itself.

### 7.3 Schema

```sql
runs(id PK, source, native_id, parent_id, project_path, project_name, title,
     model, agent_mode, status, confidence, started_at, last_activity_at,
     ended_at, active_ms, meta_json)

events(seq INTEGER PK AUTOINCREMENT, ts, type, run_id, payload_json)

steps(id PK, run_id, label, detail, tool, started_at, ended_at, ok)
todos(run_id, position, content, status)
attention(id PK, run_id, kind, summary, resource, requested_at, cleared_at)

-- usage is the long-term asset: small, permanent, heavily indexed
usage_samples(run_id, source, project, model, ts,
              tokens_in, tokens_out, tokens_reasoning, cache_read, cache_write,
              cost_usd, cost_source, precision)

-- pre-aggregated rollups, written on ingest, never computed on read
agg_hourly(bucket_ts, source, project, model, tokens_in, tokens_out,
           cost_usd, runs, turns, tool_calls, active_ms, PRIMARY KEY(bucket_ts,source,project,model))
agg_daily(days, source, project, model, tokens_in, tokens_out, cost_usd,
          runs, turns, tool_calls, active_ms, PRIMARY KEY(days,source,project,model))

adapters(source PK, capabilities_json, health, last_seen_at, last_error)
settings(key PK, value_json)
```

- **Retention:** raw `events` 14 days (rolling, nightly), `steps` 30 days.
  `usage_samples` is downsampled to 1/minute after 24 h and **kept forever** — it
  is tiny and it is the only thing here with lasting value. Rollups are permanent.
- **Aggregates on write, not on read.** The usage views must be instant with 900+
  imported sessions and years of history. Any `SUM()` executed at request time is
  a bug.
- **Bootstrap import:** on first run, backfill from all four sources so the deck
  isn't empty on day one. Bounded to the last 90 days, run once in a worker, with
  progress in `agent-deck doctor`. Imported rows are tagged `historical` so the
  UI can distinguish live-measured rows from reconstructed ones if fidelity differs.
- **Idempotent ingest:** every sample keys on `(source, native_id, turn, seq)` so a
  re-import or a reconciliation pass cannot double-count. Double-counted cost is
  the one bug that destroys trust in a usage tool permanently.
- Never open the source tools' databases read-write. Ever.

### 7.4 The questions the usage views must answer

Written down because they drive the schema, and because "a stats page" is not a spec:

- How much did I burn today, and is that more or less than my recent average?
- Which project is eating the most tokens this week?
- Which model do I actually use most, and does it correlate with cost?
- What time of day do I work with agents, and how long are sessions?
- Which sessions were expensive *and* produced little (high cost, few file changes)?
- Is any single run burning unusually fast right now? (live burn-rate alarm)

The last one is the only real-time alert the product needs, and it is worth
building: a runaway agent costs real money, and a live `$/min` readout is exactly
what a monitor on your desk is for.

---

## 8. Tablet UX

### 8.1 Physical context drives the design

It sits on a desk, landscape, 1–2 m from your eyes, glanceable while you're doing
something else, touched maybe a few times an hour. That rules out: dense tables,
hover states, small type, scroll-dependent primary info, and light themes.

Design language: **instrument panel, not dashboard.** Deep graphite base, hairline
borders, no drop shadows, no cards-on-cards. One accent colour per source (used
only for the badge and status rail). Type: system UI font for chrome, one mono for
identifiers, tool names and numbers. Numbers are large; labels are small caps.

```
Palette (dark only)
  bg          #0B0D10     surface      #14171C     hairline   #232830
  text        #E8EBF0     muted        #8A93A3     faint      #4A5160
  running     #3DDC97  (mint, slow 3 s pulse)
  waiting     #FFB020  (amber, deliberate pulse — "needs you")
  failed      #FF5E5E
  stalled     #7A8496  (slate, dotted ring)
  done        #3DDC97 at 40% opacity
  opencode    #6BA6FF   claude  #D97757   codex  #E8EBF0   agy  #A78BFA
```

All colour decisions obey one rule: **colour encodes status, never decoration.**
The four source accents appear only in a 6 px badge and nowhere else, so a card
full of amber always means one thing.

### 8.2 Views

Five views, swiped horizontally, each with a single question it answers. The app
**remembers which one you're in** and restores it — a monitor that resets its view
is an annoyance, not a tool.

| View | Question it answers | Default? |
|---|---|---|
| **Ambient** | "What's happening, from across the room?" | after 3 min idle |
| **Deck** | "Is anything stuck, waiting or burning?" | on wake / first open |
| **Usage** | "What am I burning today, this week, per project?" | — |
| **Ledger** | "What did my agents actually do today?" | — |
| **Detail** | "What exactly is this one doing?" | on tap |

**Ambient** — chrome-free, no interaction, no cursor. Layout: one aggregate row
(today's tokens, API-equivalent cost, active count, time saved), then one
horizontal band per agent with source dot, project, one-line "now", elapsed and
tokens. Type at 2× the Deck size. Dotted pattern instead of text where a value is
`inferred`. This is the view the tablet spends 90% of its life in, so it gets the
most design attention — not the least.

**Deck** — 2×2 or 2×3 grid of live run cards (the classic mosaic), with a 56 px
usage strip pinned at the top: `412k tok · $2.41 est. · 3 active · 1 waiting`.
Answers "is anything wrong" in under a second.

**Usage** — the analytics surface, and the reason this app exists. Composed of:
a big today/week toggle; one hero sparkline (tokens/hour over 7 days); stacked
bars by project; a compact table by model; and the live burn-rate readout. No
charts library — hand-drawn SVG with the same hairline language as the cards.

**Ledger** — the day as a Gantt: one row per run across hours, coloured by status,
with token/cost annotations at the right edge. Answers the question nobody's
tooling answers well, and is the most satisfying thing to look at after a long day.

**Detail** — reached by tapping any card or row. Read-only depth: step timeline,
todo list with progress ring, file-edit chips, transcript tail, per-turn usage
table. A back gesture returns to the previous view and restores scroll.

Navigation is therefore: **swipe** between Ambient/Deck/Usage/Ledger, **tap** into
Detail, **back** out. No drawer, no tabs, no menu, no settings icon in the main
chrome. Settings lives on the desktop browser (`/settings`), which is where config
belongs anyway.

### 8.3 Card anatomy

```
┌──────────────────────────────────────────────────────┐
│ ● opencode   ProdigyR4Apps                 12:41  ⤢  │  source dot + project + elapsed
│ Refactor MCP auth middleware                         │  title (2 lines max)
│ ┌──────────────────────────────────────────────────┐ │
│ │ ● running   ⟳ edit  src/Mcp/OAuth/PkceFlow.cs    │ │  status + "now" line
│ │                        +18 −4                  · │ │
│ └──────────────────────────────────────────────────┘ │
│ ▁▂▃▅▂▇▅▃▂▁▁▂▃▅▆▄▂▁▁▂▃▅▄▂▁▁▂   last 60 s activity     │  micro-timeline
│ 3/7 steps  ·  gpt-5.6-luna  ·  412k in / 18k out     │
│ $2.41 est.  ·  14 turns  ·  ⟳ 2 min ago              │
└──────────────────────────────────────────────────────┘
```

- **Status rail:** 3 px left edge, colour = status. Readable peripherally without
  reading text — the most important affordance on the whole screen.
- **"Now" line** is the only monospace content on the card. It's the thing you
  actually read.
- **Micro-timeline:** 60 vertical ticks, 1 per second, height/colour by activity
  type (thinking dim, tool bright, waiting amber). Cheap to render, uniquely
  informative, and it makes "is it alive?" answerable without numbers.
- **Footer numbers** use tabular figures so they don't jitter as they tick, and
  money always carries its precision marker (`est.` / nothing when exact).

### 8.4 The "needs you" state (read-only)

When `attention.raised` arrives, the card does **not** grow buttons. It changes
state and tells you where to go:

```
┌──────────────────────────────────────────────────────┐
│  ⚠  OPENCODE · ProdigyR4Apps               waiting 0:34│
│                                                      │
│     Wants to run a shell command                     │
│     ┌──────────────────────────────────────────────┐ │
│     │ dotnet test --filter PkceFlowTests           │ │
│     └──────────────────────────────────────────────┘ │
│     in  T:\R3\ProdigyR4Apps\ProdigyR4Apps            │
│                                                      │
│     → answer in the terminal · tap to see context    │
└──────────────────────────────────────────────────────┘
```

Rules: amber rail + one visual pulse on entry (no sound, no haptic — this is a
display, and a beep from across the room is a bug, not a feature); the card sorts
to the top of the Deck; the Ambient view adds one line to the aggregate strip
(`1 waiting · 0:34`). Tapping gives context — the tool call, the cwd, the last few
steps — so that when you walk to the keyboard you already know what you're
answering.

If it has been waiting longer than a configurable threshold (default 5 min), the
pulse becomes a slow, low-contrast breathe rather than a bright flash. Persistent
urgency on an always-on screen becomes wallpaper; low-frequency motion stays
legible.

### 8.5 Craft: motion, typography, data display

Because this is a display, these are the load-bearing decisions, not polish.

**Motion** — one job: make liveness legible without noise.

| Element | Behaviour |
|---|---|
| Running pulse | 3 s ease-in-out, opacity only, 4 px dot. Never scale, never glow. |
| Card entry | 180 ms fade + 6 px rise, staggered 40 ms. No bounce, no spring. |
| Number change | 220 ms cross-fade of digits, tabular alignment so width never shifts. |
| Micro-timeline | Ticks appear, never reflow. The strip scrolls by translation, not relayout. |
| View transition | 240 ms slide, 1:1 with the swipe. No zoom, no cross-dissolve. |
| Waiting state | Only the element that needs attention animates. Everything else is still. |

Hard rule: **at most two animated elements per screen at rest.** A monitor with six
pulsing cards is unreadable from 2 m. Motion complexity is budgeted like colour.

**Typography** — three roles, two families:
- *Chrome/labels*: system UI, uppercase 11 px, `letter-spacing: 0.08em`, muted.
- *Reading*: system UI, 15–17 px, for titles and summaries.
- *Data*: one mono, tabular figures, for project names, tool lines, all numbers.
  Never use mono for prose; never use prose face for data.

**Data display** — no chart library, no gridlines, no legends. Sparklines are
2 px strokes on the surface. Bars are 3 px rounded. Every value that could be
misread carries its precision marker inline. The rule: **if a chart needs a
legend, it needs a redesign instead.**

### 8.6 Tablet specifics

- **PWA**, `display: standalone`, `orientation: any`, `theme-color` matching bg,
  maskable icons, splash screens for iPad + Android 8"–11". Requires the HTTPS
  tailnet URL (§10.3) — install, service worker and wake lock all fail silently
  without a secure context.
- **Wake Lock** in Ambient; fall back to CSS dimming if unsupported. On
  visibility-change, re-fetch `/api/snapshot` before resuming the stream (cheap
  insurance against missed frames). If the observed tablet turns out to suspend
  the PWA aggressively, that is the trigger to evaluate the Flutter shell (§10.1)
  rather than to fight the platform.
- **Safe areas** (`env(safe-area-inset-*)`) and no reliance on hover or right-click.
  Hit targets ≥ 48 px; primary actions in a bottom bar within thumb reach.
- **Type floor** 13 px for labels, 15 px minimum for anything you read; primary
  numbers 28–44 px. Respect `prefers-reduced-motion` (kill pulses, keep colour).
- **Burn-in protection** for always-on: pixel-shift the whole layout ±6 px every
  10 min, auto-dim at night (schedule in settings), never a static bright element
  in Ambient.
- **Reconnect UX**: never a spinner over content. A thin hairline at the top goes
  amber ("reconnecting…") and mint on recovery, with the last-known state still
  visible and marked with dotted rings.

### 8.7 Accessibility

Not optional for a large-type glanceable screen: WCAG AA contrast on all text,
status conveyed by **icon + text + colour** (never colour alone — deuteranopia is
common and status colour is the core signal), full keyboard nav for the desktop
browser case, and `aria-live="polite"` used exactly once: when a run enters
`waiting`. Never for streaming numbers, which would turn a screen reader into a
slot machine.

---

## 9. Safety, security, privacy

| Concern | Mitigation |
|---|---|
| **Monitor blocks a CLI** | Hooks are UDP fire-and-forget + always `exit 0`. Shim has a hard 10 ms self-timeout. |
| **Monitor corrupts source data** | All source DBs opened `mode=ro&immutable=1`. No writes, ever. |
| **Secrets in transcripts** | `Redactor` runs before persist and before stream: strips `sk-…`, `ghp_…`, `AKIA…`, bearer tokens, `password=`/`token=` values, `.env` bodies, and absolute paths under known credential dirs (`~/.ssh`, `.aws`, `.codex/auth.json`). Deny-list is config-driven and tested. |
| **Tablet holds credentials** | It holds a scoped session cookie only. No API keys ever reach the client; the collector never exposes tokens/costs of credentials, only session usage. |
| **LAN exposure** | Binds the **tailnet interface only**, never `0.0.0.0` and never plain LAN. HTTPS via `tailscale serve`, so no plaintext credentials on the wire. Token in `httpOnly` cookie, short-lived pairing codes, no CORS wildcard. |
| **Prompt injection from transcript content** | The tablet renders content only; it never feeds agent output back to any agent, and holds no write path (§1.3). Rendering is escaped; markdown is sanitised. |
| **Usage correctness** | Precision tier recorded per sample (§7.1); idempotent ingest keyed on native ids; no blended total across tiers without a label. A wrong number is worse than no number. |
| **Price data** | `packages/pricing` is versioned with an `updatedAt`; every computed figure is labelled `est. API-rate`; only vendor-reported cost is shown as actual spend (§7.2). |

---

## 10. Repo, stack, commands

### 10.1 Client platform: PWA vs Flutter vs React Native

This is the one expensive-to-reverse decision, so it gets an explicit argument.

The critical framing: **the backend decision matters far more than the frontend
one, because every client consumes the same HTTP + SSE API.** Whichever framework
you pick, truth lives in the collector. A client is a reducer plus four views —
that is portable in two weeks, not a rewrite. So pick the client for *iteration
speed and deployment friction now*, not for an imagined future.

| | **PWA (SvelteKit)** | **Flutter** | **React Native** |
|---|---|---|---|
| Iteration loop | save → reload (< 1 s) | rebuild + reinstall (30–90 s) | fast refresh, but slower than web |
| Deploy to tablet | open a URL, add to home screen | iPad needs a Mac + Xcode/TestFlight; Android needs APK sideload | same as Flutter, plus native modules |
| Updates | instant, no store | rebuild + redistribute | rebuild + redistribute |
| SSE / long-lived stream | native `EventSource`, free reconnect | `http` + manual stream parsing, works but manual | similar, plus bridge overhead |
| Screen wake lock | `navigator.wakeLock` — iOS 16.4+, Android Chrome ✅ | `wakelock_plus` ✅ (more reliable) | extra module, thinner support |
| Haptics / sound | Android only; **iOS Safari has no Vibration API** | full haptics on both | full haptics |
| Silent-by-design fit | ✅ (this app makes no alerts) | ✅ | ✅ |
| Background / kiosk mode | none — app must stay foreground | possible (device-owner / kiosk) | possible |
| Rendering an animated dashboard | excellent (CSS/compositor) | excellent (Skia) | good, more work |
| Your existing expertise | high (vega-chat) | **highest** (prodigy_app) | low |
| Stack count | 1 (TS everywhere) | 2 (TS backend + Dart client) | 2 (+ native config) |

**Verdict: PWA for v1.** Three decisive reasons, in order:

1. **The project risk is adapter discovery, not UI.** You will redesign these four
   screens a dozen times once the tablet is on the desk — that's the nature of a
   glanceable display. A sub-second reload loop is worth more than any native
   capability here. Flutter's 60 s rebuild tax applied to a hundred UI tweaks is
   the single most likely reason this project stalls.
2. **Deployment friction can be a hard blocker.** Sideloading to an iPad requires
   a Mac and a signing identity. If the target is an iPad, Flutter may be
   impossible without buying into that pipeline; a URL is not.
3. **The collector already serves HTTP.** Serving the built UI from the same
   origin is free, gives you no-CORS SSE, and means one process and one port.

**The one real PWA cost** is iOS suspending a backgrounded PWA. Mitigation is
architectural and already in the plan (§6.3 `Last-Event-ID` replay + snapshot
resync): it is a desk tablet on a charger, essentially always foreground, and the
reconnect path must exist regardless of framework because Wi-Fi roams.

**Escape hatch, designed in:** the collector's API is client-agnostic from day one
(`packages/protocol` has no DOM or framework dependency). If you later want kiosk
mode, always-on device-owner control, reliable haptics, or an App Store presence,
build a Flutter shell against the same endpoints. That port touches only
`apps/web/src/lib/views` — the adapter pipeline, StatusEngine, storage and
transport are untouched. Choosing PWA does **not** lock out Flutter; choosing
Flutter first would lock you into a slow loop for the entire discovery phase.

> If you already own a Mac and know you want kiosk mode, Flutter is defensible.
> Otherwise PWA first, Flutter shell later if the need actually materialises.

### 10.2 Stack

| Layer | Choice | Why this over alternatives |
|---|---|---|
| Runtime | **Node 24 + TypeScript** | one language across collector and web; best-in-class SQLite/JSONL/SSE libraries; matches your existing Svelte/Node work |
| HTTP | **Fastify** | native SSE, schema validation, low overhead |
| DB | **better-sqlite3** | synchronous, fast, no ORM; WAL; `immutable=1` read-only access to foreign DBs |
| FS watch | **chokidar** (or `fs.watch` + debounce) | Windows-safe recursive watching; must debounce, these dirs are hot |
| PTY | **node-pty** | only mature option; needed for M7 |
| Web | **SvelteKit 5 + Tailwind 4** | you already ship this stack; smallest bundle for a tablet; runes make the reducer ergonomic |
| Validation | **zod** | one schema shared by wire, store and reducer |
| Test | **vitest** + **Playwright** | unit the StatusEngine, adapter parsers and rollups; e2e reconnect, usage views, ambient |
| TLS | **`tailscale serve`** (fallback: `tailscale cert` + Fastify HTTPS) | secure context is *required* for PWA install, service worker and wake lock — see §10.3 |

Explicitly rejected: .NET (no gain for JSONL/SSE glue, doubles the stack), Electron
(it's a PWA on a tablet), a DB server (SQLite is correct at this size), WebSocket
(otherwise fine, but SSE wins on reconnect semantics), React Native (worst of both
worlds here: native friction without the Flutter capability or your expertise).

### 10.3 Access path: Tailscale, and why HTTPS is not optional

Chosen access path: **Tailscale only.** The collector binds to the tailnet
interface (not `0.0.0.0`), so the app is never exposed on café Wi-Fi or to
anything on the LAN that isn't in your tailnet, and it keeps working when you're
away from home.

The non-obvious requirement: **PWAs need a secure context.** Service worker
registration, home-screen install and the Screen Wake Lock API all require
HTTPS (or localhost). An `http://100.x.y.z:4100` URL silently degrades — no
install, no wake lock, and Safari will refuse the service worker. This is exactly
the kind of thing that would look like "the PWA approach doesn't work" when in
fact it's a missing cert.

So the setup path is:

```
tailscale serve --bg 4100          # HTTPS + valid cert + MagicDNS name
# → https://<host>.<tailnet>.ts.net   ← the URL you bookmark on the tablet
```

- Stable MagicDNS hostname = stable bookmark, unaffected by DHCP.
- Cert issuance and renewal handled by Tailscale; no cert management code.
- Fallback if `serve` isn't wanted: `tailscale cert <host>.<tailnet>.ts.net` and
  serve HTTPS directly from Fastify (`monitor tls on`).
- Loopback (`http://127.0.0.1:4100`) remains the dev path and is treated as secure
  by browsers, so development needs no cert at all.

Verify the exact `serve` invocation against your installed version (`tailscale
serve --help`); the port-to-proxy form has changed across releases.

### 10.4 Layout

```
ai-session-monitor/
├─ apps/
│  ├─ collector/          Fastify server, adapters wiring, SSE, pairing
│  │  └─ src/{main,http,stream,pair,adapters,reconcile}.ts
│  └─ web/                SvelteKit PWA
│     └─ src/{routes,lib/{views,components,stores,reducer}}
├─ packages/
│  ├─ core/               domain types, event taxonomy, StatusEngine, reducer
│  ├─ protocol/           zod schemas + wire types
│  └─ redact/             redaction rules + tests
├─ tools/
│  ├─ hook-shim/          small binary (Rust or Go) for Claude hooks
│  └─ doctor/             capability report for `agent-deck doctor`
├─ docs/
│  ├─ adapter-research.md
│  └─ IMPLEMENTATION_PLAN.md
└─ fixtures/              recorded real sessions per source, for tests
```

npm workspaces (consistent with your other repos), no monorepo tooling beyond that.

### 10.5 CLI

```
agent-deck start            start collector (foreground)
agent-deck start --service  install + start as scheduled task / service
agent-deck status           collector + adapters + tablet connections
agent-deck doctor           per-adapter capability matrix + last error
agent-deck probe --source codex --tail 20     print normalized events  ← day-1 tool
agent-deck setup claude     show diff, install hooks (reversible)
agent-deck uninstall        remove hooks, stop service, keep data
agent-deck pair             print QR + code
agent-deck run -- <cli>     PTY wrapper (M7)
agent-deck import           one-shot history backfill
```

`doctor` and `probe` are the two commands that make this project tractable: you
can validate an adapter's fidelity without any UI in the loop.

---

## 11. Milestones

Estimates assume one developer plus agent assistance, in focused days. Each
milestone has an exit criterion that is *observable*, not a checklist.

### M0 · Spike & skeleton — 2 days
Set up workspaces, `packages/core` types, zod protocol, Fastify with
`/api/health` + `/api/snapshot` + `/api/stream` + pairing, SvelteKit shell with
dark tokens, SQLite with schema + migrations, `tailscale serve` wiring so the
tablet gets a secure-context URL from day one.
**Exit:** `agent-deck start` serves a PWA over the tailnet HTTPS URL that shows a
hardcoded run, survives a browser refresh with SSE replay, and passes an
installed-to-home-screen check on the real tablet (service worker registers, no
mixed-content or cert warnings).

### M1 · OpenCode end-to-end — 3 days
Service discovery, SSE ingest, session reconcile, DB enrichment (titles, todos,
cost, tokens, parent_id), StatusEngine v1 with unit tests, fixture recorder.
**Exit:** start real OpenCode work on the PC, open the tablet, see the run appear
in < 1 s, watch the "now" line update per tool call, see status flip to `done`,
and see correct cost. `agent-deck probe --source opencode` replays the same data
assertively.

> This is the go/no-go gate. If the pipeline feels good here, the rest is
> repetition; if it doesn't, no amount of adapter count will save it.

### M2 · Deck + usage plumbing — 3 days
Run cards, sorting (waiting → running → stalled → done), status rail, micro
timeline, usage strip, `usage_samples` + `agg_hourly`/`agg_daily` writes,
idempotent ingest keys, reconnect banner, ETag snapshot, gap→resync, 10 Hz
batching, view persistence.
**Exit:** four simultaneous OpenCode runs render correctly for 8 hours without a
leak; the usage strip total equals the sum of the source's reported counters; a
tablet sleep/wake of 30 min resumes correctly; re-ingesting the same events
produces byte-identical rollups.

### M3 · Claude Code — 4 days
Hook shim binary, idempotent hook install with diff preview + backup, UDP ingest,
JSONL tailer with persisted offsets, reconciliation between hook truth and
transcript truth, `--bg` session detection, usage extraction from transcript
records (precision tier `derived`).
**Exit:** a Claude session, started normally in a terminal, produces an accurate
live card including `ai-title`, turns, tool calls and file edits, with token counts
that reconcile against a hand-summed transcript; `uninstall` restores
`settings.json` byte-for-byte.

### M4 · Codex — 3 days
Rollout tailer (`task_started`/`task_complete`/`token_usage_record`/`compacted`/
`thread_goal_updated`), app-server probe + capability gate, `codex agents`
reconcile oracle, `token_usage_record` → `exact`-token/`derived`-cost mapping.
**Exit:** Codex card shows goal as subtitle, exact tokens, compaction state, and
correctly returns to `idle` after a turn. Cost is labelled `est.` and matches the
price table for the model in use.

### M5 · agy — 4 days
Read-only per-conversation SQLite adapter with mtime polling and incremental
`steps` reads; status from `steps.status`; attention from `steps.permissions`;
subagent graph from `parent_references`; optional remote-control daemon tier.
Plus the **usage decode pass**: try `agentapi get-conversation-metadata` first,
then `gen_metadata`/`executor_metadata`, and drop to `partial`/`none` if neither
yields trustworthy numbers.
**Exit:** agy card tracks a real conversation step-by-step; stale `presence` locks
demonstrably do **not** produce phantom live sessions; the usage cell either shows
a defensible number or is honestly absent — never `0`.

### M6 · Usage & Ledger — 4 days
The Usage view (today/week hero, sparkline, stacked bars by project, model table,
live burn-rate), the Ledger Gantt, first-run history import, and the "expensive
but unproductive" query. Hand-drawn SVG, no chart library.
**Exit:** every question in §7.4 is answerable in two taps or fewer; totals
reconcile with a spot-checked native source; imported history is visually
distinguished from live measurement; the burn-rate readout alarms on a synthetic
runaway session.

### M7 · Ambient & craft — 4 days
Ambient view (the always-on face), wake lock, burn-in pixel shift, night dim,
Detail view with todos/steps/diff/transcript, motion spec implemented to §8.5,
typography pass, reduced-motion and colour-blind verification, real-device
validation on the tablet D4 resolves to plus a second form factor.
**Exit:** leave it on the desk for 48 h in Ambient: screen stays awake, no
burn-in, no stuck spinner, no missed event after a Wi-Fi roam, no battery or
thermal complaint, and a 30-minute background wake resumes via replay rather than
reload. Legible at 2 m in a dim room. — **v1 ships here.**

### M8 · Hardening & extensibility — 3 days
`agent-deck run` PTY wrapper + heuristic profile format, adapter authoring doc,
failure-injection tests (kill a CLI mid-turn, corrupt a JSONL line, unplug the
network, clock skew), perf pass, and a full-surface audit that no mutation path
exists (§1.3).
**Exit:** a fifth CLI is added via a profile file without touching `core`,
`collector` or `web`; the failure-injection suite passes; a grep for HTTP verbs can
prove the collector exposes no write endpoint other than pairing and preferences.

**Total: ~30 focused days.** A usable single-source product exists at day 6; the
usage views land at day ~22; a full four-source, ambient-ready v1 at day ~26.

---

## 12. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Claude Code hooks cost per-call latency | Med | High | Native shim binary + UDP; measure p50/p99 in M3 and publish it in `doctor`; user can disable per-hook |
| R2 | agy's undocumented internals change | High | Med | DB tier is the only required path; everything else capability-gated; parser isolated + fixture-tested |
| R3 | `codex app-server` is experimental | High | Med | Rollout tailer is primary; daemon is an enhancement |
| R4 | OpenCode API shape changes | Med | Med | Reconcile via DB; adapter version-pinned + probed at startup |
| R5 | SQLite locks / WAL contention on foreign DBs | Med | High | `mode=ro&immutable=1`; never hold handles; copy-then-read if a locked read ever occurs |
| R6 | Token/cost numbers disagree across sources | High | High | Precision tiers per sample (§7.1); never blend across tiers without a label; money always marked `est.` unless vendor-reported (§7.2) |
| R7 | Tablet sleep loses events | High | Low | `Last-Event-ID` + ring buffer + gap→snapshot resync |
| R8 | Scope creep back into a command center | Med | High | §1.3 is contractual and structural: the adapter SPI has no mutation methods, and M8 audits that no write endpoint exists |
| R9 | Secret leakage through transcripts | Med | High | Redactor with tests + deny-list; never render `.env` bodies; audit before every release |
| R10 | Windows path/encoding edge cases | Med | Low | UTF-8-with-replacement everywhere; long-path safe; test with cp1252 content (already observed) |
| R11 | Too many sessions → UI noise | Med | Med | Auto-collapse `done` after 2 min, cap Deck at 6, "show all" drawer, group by project |
| R12 | "It says running but nothing is happening" | High | High | The `stalled` state exists specifically for this; confidence markers make inference visible |
| R13 | PWA hits an iOS platform wall (aggressive suspension) | Med | Med | Reconnect + snapshot resync are mandatory anyway; Flutter shell against the same API is the escape hatch (§10.1) |
| R14 | Non-HTTPS origin silently disables install, service worker and wake lock | High | High | `tailscale serve` from M0; the M0 exit criterion explicitly tests secure-context features on the real device |
| R15 | Double-counted usage poisons trust in the whole tool | Med | High | Idempotent keys on `(source, native_id, turn, seq)`; rollups written once; re-import is a no-op; reconciliation diffs rather than adds |
| R16 | An ambient screen becomes wallpaper — real problems stop being noticed | Med | Med | Only elements needing attention animate; waiting state escalates from pulse to slow breathe, not to flash; aggregate strip surfaces counts the eye can catch |

**Kill criteria (be honest with yourself):** if after M1 the latency is > 1 s or
the OpenCode card is unreliable, stop and fix the core pipeline before adding a
second adapter. Four flaky adapters is worse than one excellent one.

---

## 13. Testing & observability

- **Fixtures over mocks.** Record real sessions from each tool once
  (`fixtures/<source>/*.jsonl|.db`) and replay them through adapters in tests.
  These formats are the actual contract; mocking them proves nothing.
- **StatusEngine** gets a table-driven test per transition rule, including
  out-of-order events, duplicate events, and clock skew.
- **Reducer** property test: replaying a recorded event log from initial state
  equals applying the snapshot. This catches the classic "reconnect drift" bug.
- **Failure injection** suite: kill CLI mid-turn, truncate a JSONL line mid-write,
  corrupt a SQLite page, deny socket access, saturate the event bus.
- **Self-metrics** on `/api/health`: events/s, adapter lag ms, DB size, SSE client
  count, dropped frames. If the monitor is slow, it should be the first thing to
  say so.
- **Playwright**: reconnect banner, attention state, ambient idle transition,
  layout persistence, and a 1024×768 + 1280×800 viewport matrix.

---

## 14. Decisions

Settled (2026-10-23):

| # | Decision | Resolution |
|---|---|---|
| D1 | Client framework | **PWA (SvelteKit)**, collector API kept client-agnostic. Flutter shell possible later against the same endpoints. See §10.1. |
| D2 | Access path | **Tailscale over HTTPS** (`tailscale serve`), bound to the tailnet interface. Never `0.0.0.0`. |
| D3 | Scope | **Monitor + usage only. No control surface, ever** — not deferred to a later phase. Enforced structurally (§1.3, §5.1, M8 audit). |

Still open (defaults assumed in this plan; cheap to change now, expensive after M2):

| # | Question | Assumed default |
|---|---|---|
| D4 | Tablet model/size? | iPad or Android 8–11", landscape. PWA covers both; verify on the real device in session 2 of §15. |
| D5 | Do you want the Claude hook install? | Yes, but behind an explicit `setup claude` with diff preview + backup. |
| D6 | Should `agy remote-control` be enabled? | No by default (changes machine state); offered as a toggle in M5. |
| D7 | Always-on display, or on-demand? | Both: Ambient after 3 min idle, instant wake on any activity or new attention state. |
| D8 | Do you want history imported on first run? | Yes, last 30 days, so Ledger/stats aren't empty. |
| D9 | Multi-machine later? | Not in v1, but the collector host is configurable, so it's a config change, not a rewrite. |

---

## 15. Immediate next steps (first 3 sessions)

1. **Session 1 — prove the pipeline and the numbers.** Build only `agent-deck
   probe --source opencode`: connect to `127.0.0.1:49374`, stream for 10 minutes of
   real work, print normalized events, the derived status, *and* the running token
   and cost totals. Cross-check those totals against `opencode.db` by hand. This
   tells you whether both halves of the product are trustworthy before you've
   written a single pixel.
2. **Session 2 — the smallest possible screen.** `/api/snapshot` + one SSE frame
   type + one ugly card + one ugly usage strip. Verify on the actual tablet, on the
   actual desk, at the actual distance, in the actual lighting. Design decisions
   made on a laptop monitor are wrong at 2 m.
3. **Session 3 — the StatusEngine and the rollup.** Table-driven tests for the
   transitions, plus the `usage_samples` → `agg_hourly` path with an idempotency
   test. These two modules are the product's brain; getting them boring and correct
   early is what lets four incompatible CLIs look like one coherent system with one
   trustworthy set of numbers.

---

*A note on sequencing: the usage views (M6) sit after all four adapters because
they are only meaningful with complete history. If, after M2, you find yourself
looking at the usage strip more than the cards, pull M6 forward — the schema and
rollups are already in place from M2, so it is a reorder, not a rewrite. That is
the one milestone boundary in this plan that is genuinely soft.*

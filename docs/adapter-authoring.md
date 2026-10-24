# Adapter Authoring & Heuristic Profile Guide

Agent Deck supports two ways of adding a new AI coding CLI without touching `@agent-deck/core`, the collector transport, or the SvelteKit web app:

1. **Zero-code Heuristic Profile (`fixtures/pty/*.json` or `~/.agent-deck/profiles/*.json`)** for `agent-deck run -- <cli>`.
2. **Full Native Adapter (`apps/collector/src/adapters/<source>.ts`)** implementing the read-only `Adapter` SPI.

---

## 1. Adding a Fifth CLI via Heuristic Profile (Zero Code)

Drop a JSON profile file into the profiles directory:

```json
{
  "name": "cursor-agent",
  "commandMatch": "cursor-agent",
  "modelDefault": "claude-sonnet-4",
  "turnStartRegex": "^\\[turn\\]\\s+(.+)$",
  "toolStartRegex": "^\\[tool:([a-z_]+)\\]\\s+(.+)$",
  "permissionPromptRegex": "^\\[confirm\\]\\s+(.+)\\?$",
  "usageTokensRegex": "^\\[usage\\]\\s+in=([0-9]+)\\s+out=([0-9]+)$"
}
```

When launched via `agent-deck run -- cursor-agent`, the PTY wrapper matches `commandMatch`, strips ANSI escape sequences, and emits normalized `turn.started`, `tool.started`, `attention.raised`, and `usage.tick` events.

---

## 2. Implementing a Native Adapter

Every adapter implements the narrow, **strictly read-only** contract in `apps/collector/src/adapter-spi.ts`:

```ts
export interface Adapter {
  readonly source: Source;
  probe(): Promise<Capabilities>;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  // Intentionally no mutation methods (P5, §1.3).
}
```

### Rules for Adapter Authors

1. **Observe-only (P5):** Never add methods that send prompts, approve permissions, or kill processes.
2. **Read-only foreign DBs (P4):** Always use `withReadonlySqlite(dbPath, fn)` (`mode=ro&immutable=1` + copy-on-lock fallback). Never hold handles open across polls.
3. **Adapters emit events, `StatusEngine` owns state (§3.2):** Emit normalized events (`run.started`, `tool.started`, `attention.raised`, `usage.tick`, etc.) and let `StatusEngine` compute status priorities and timers.
4. **Honest usage precision (§7.1):** Tag every `usage.tick` with its true `precision` (`exact` | `derived` | `partial` | `none`) and `costSource` (`tool` | `estimated` | `none`).

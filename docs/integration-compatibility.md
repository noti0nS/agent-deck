# Integration compatibility and diagnostics

The collector uses observe-only adapters. Capability flags describe the implemented
transport, not the presence of an executable or a directory. `lastPolledAt` records
a poll; `lastEventAt` records source activity. A quiet session is not necessarily a
broken connection. JSONL adapters expose parse-error and ignored-record counters.

## Fixture policy

The existing `fixtures/{codex,claude,opencode,agy}` files are synthetic contract
fixtures, not proof of compatibility with a particular installed CLI release.
Do not label them as captured version-specific sessions.

For each newly supported CLI version, add a sanitized recording and a manifest
with source, exact CLI version, capture date, schema revision, and expected events.
Include approvals, failure, cancellation, compaction, subagents and reconnection.
Replay it through the adapter and assert normalized IDs, statuses, and usage.
Never commit credentials, private prompts, or unsanitized local paths.

`integration-improvements.test.ts` additionally covers daily SQLite catalog caching,
background startup, malformed refresh retention, cursor restart, tool outcome
uncertainty, duplicate Claude hooks, parallel calls, child-first hierarchy and MCP.

## Model catalog

On collector startup, the app immediately uses the last SQLite catalog or bundled
defaults. A non-blocking request to `https://models.dev/api.json?type=all` refreshes
the full provider/model catalog. No UI loading state is introduced. Refresh attempts
are limited to once per rolling 24 hours, including across restarts. An open collector
checks the deadline every minute. Failures retain the previous catalog and record
`models_dev_last_error`; the next attempt is on the following daily interval.

The catalog, successful fetch time, last attempt and error live in the collector's
SQLite `settings` table. Only a validated response replaces the cached catalog.
Provider-qualified model IDs match exactly; unqualified IDs prefer direct OpenAI,
Anthropic or Google entries, or a unique provider. Ambiguous/unknown models have
no estimated cost. Existing historical usage samples are not repriced retroactively.
Snapshot configuration identifies the active price-table version and timestamp.
Codex estimates treat cached input and reasoning output as subsets of total tokens;
Claude's cache counters are separate from its uncached input counter.

## Read-only MCP bridge

Start the collector normally, then configure an MCP client to launch:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/agent-deck/apps/collector/dist/cli.js", "mcp"]
}
```

This optional stdio bridge supports MCP protocol `2025-03-26`, with `list_sessions`,
`pending_attention`, `recent_failures`, and `execution_tree`. It reads the existing
loopback snapshot endpoint, applies redaction, and returns at most 200 recent runs.
It adds no network listener and exposes no commands to approve, prompt or stop agents.
Set `AGENT_DECK_PORT` in the client environment when using a nondefault collector port.
The tree view exposes parent/child IDs, active tools and observed turn counts; it
does not invent native turn IDs when the adapter does not supply them.

Sources: [models.dev API](https://github.com/anomalyco/models.dev#api),
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

# Antigravity usage and cost

Agent Deck reads `conversations/*.db` without modifying AGY or requiring its
remote-control daemon. Native `gen_metadata.data` protobuf records supply the
model and token counters for each generation. Costs use the shared models.dev
catalog and are labelled **estimated API-rate**, not subscription charges.

## Observed schema

Verified against local AGY CLI **1.5.1** on Windows on 2026-11-05. The automated
fixtures are synthetic messages based on that observed layout; they contain no
private prompts or native conversation IDs.

| Protobuf path | Meaning |
| --- | --- |
| `1 → 4 → 2` | Uncached input tokens |
| `1 → 4 → 3` | Total output, including reasoning |
| `1 → 4 → 4 / 5` | Cache-write / cache-read tokens, separate from input |
| `1 → 4 → 9 / 10` | Reasoning / response output |
| `1 → 4 → 11` | Response ID for deduplication |
| `1 → 19 / 21` | Model config ID / readable model name |
| `1 → 9 → 4` | Generation timestamp (`seconds`, `nanos`) |

Root field 4 is shared by multiple generations in observed CLI records; it must
not be used as the response deduplication key. Generation indices are also
independent of step indices. The adapter scans generation records on database
changes instead of filtering them using the step cursor.

Input, cache and reasoning are priced separately. Reasoning is subtracted from
inclusive output before estimating, so it is charged only once. Each generation
uses its own model even when a conversation switches models. AGY effort suffixes
and recognized display names resolve to catalog IDs; opaque placeholders and
models without a rate stay unpriced. Malformed records are skipped rather than
mined for token-looking text.

## Collection and history

- Conversation-level cumulative snapshots prevent duplicate tokens/costs on
  repeated polls, imports and collector restarts.
- A catalog refresh retries unchanged conversations. A cost-only update adds
  the newly available estimate without adding their tokens again.
- Complete, priced counters have `derived` precision. Missing records or rates
  produce `partial` precision; any displayed estimate covers only priced records.
- Usage rollups retain session-snapshot granularity: a historical import is
  attributed to its latest generation timestamp, and the session's current model
  labels its rollup. Cost itself is summed using each generation's model.
- `agent-deck import` loads/refreshes the catalog before importing. After updating,
  restart the collector to price recent sessions; stop it and run the import
  command to backfill older AGY conversations (up to the existing import limit).

Schema research reference:
[CodeBurn Antigravity provider notes](https://github.com/getagentseal/codeburn/blob/main/docs/providers/antigravity.md).
Field paths were cross-checked against native local records; root-field identity
in particular differs from the reference's generation-UUID description.

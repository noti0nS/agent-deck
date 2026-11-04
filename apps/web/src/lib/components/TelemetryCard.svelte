<script lang="ts">
  import Scritto from "@scritto/svelte";
  import { deckStore } from '#lib/stores/deck.svelte.js';
  import { formatTokens } from '#lib/format.js';
  const agg = $derived(deckStore.visibleAggregates);
  const recent = $derived(deckStore.sortedRuns.flatMap(r => (r.recentSteps ?? []).map(step => ({ step, project: r.projectName }))).sort((a,b) => (b.step.endedAt ?? 0) - (a.step.endedAt ?? 0))[0]);
  const activity = $derived(Array.from({length: 7}, (_, i) => deckStore.sortedRuns.reduce((sum, run) => sum + (run.activityTimeline ?? []).slice(i * 8, (i + 1) * 8).filter(t => t !== 'none').length, 0)));
  const max = $derived(Math.max(1, ...activity));
</script>
<button type="button" class="telemetry-card" data-testid="telemetry-card" onclick={() => deckStore.setView('usage')} aria-label="Throughput and Ledger: open usage">
  <div class="session-heading"><h3>Throughput &amp; Ledger</h3><span class="telemetry-tag">Telemetry</span></div>
  <div class="telemetry-value"><strong><Scritto value={formatTokens(agg.burnRateTokensPerMin / 60)} transition={{ duration: 300 }} respectMotionPreference={true} /></strong><span>Tokens / sec <small>observed average</small></span></div>
  <div class="telemetry-bars" aria-label="Observed recent activity">{#each activity as value, i}<span class:latest={i === 6} style="height:{Math.max(3, value / max * 100)}%"></span>{/each}</div>
  <div class="telemetry-recent"><span>{recent ? `Recent: ${recent.step.label}` : 'No completed tools observed'}</span>{#if recent}<span class:failed={recent.step.ok === false}>{recent.step.ok === true ? 'Completed' : recent.step.ok === false ? 'Failed' : 'Outcome unknown'}</span>{/if}</div>
  <div class="session-footer"><span>{agg.hasExactCost ? `Reported: $${agg.todayCostExactUsd.toFixed(2)}` : 'Cost not reported'}</span><span>{agg.hasEstimatedCost ? `$${agg.todayCostEstimatedUsd.toFixed(2)} est.` : `${formatTokens(agg.todayTokensIn + agg.todayTokensOut)} tok today`}</span></div>
</button>

<script lang="ts">
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatTokens, SOURCE_COLORS, STATUS_COLORS, STATUS_ICONS } from '$lib/format';
  import RunCard from '$lib/components/RunCard.svelte';

  const runs = $derived(deckStore.sortedRuns);
  const agg = $derived(deckStore.state.aggregates);
  const prefs = $derived(deckStore.state.prefs);

  // Auto-collapse `done` after 2 min, cap Deck at 6 with "show all" drawer (§12 R11)
  const visibleRuns = $derived.by(() => {
    const filtered = runs.filter((r) => {
      if (deckStore.showAllDone) return true;
      if (r.status === 'done' && deckStore.now - r.lastActivityAt > 120_000) {
        return false;
      }
      return true;
    });
    return deckStore.showAllDone ? filtered : filtered.slice(0, 6);
  });

  const hiddenCount = $derived(Math.max(0, runs.length - visibleRuns.length));

  // Hard rule (§8.5): at most two animated elements per screen at rest.
  const animatedIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const r of visibleRuns) {
      if (r.status === 'waiting' || r.status === 'running') {
        ids.add(r.id);
        if (ids.size >= 2) break;
      }
    }
    return ids;
  });

  // Never blend across precision tiers without a label (§7.1)
  const costSummaryText = $derived.by(() => {
    const parts: string[] = [];
    if (agg.hasExactCost) {
      parts.push(`$${agg.todayCostExactUsd.toFixed(2)}`);
    }
    if (agg.hasEstimatedCost) {
      parts.push(`$${agg.todayCostEstimatedUsd.toFixed(2)} est.`);
    }
    if (parts.length === 0) return 'no cost reported';
    return parts.join(' + ');
  });
</script>

<section class="flex flex-col gap-4" data-testid="deck-view">
  <!-- 56px Usage Strip pinned at top (§8.2) — wraps to two rows on phones -->
  <header
    class="flex min-h-[56px] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-sm border border-[#232830] bg-[#14171C] px-3 py-2 sm:flex-nowrap sm:px-4 sm:py-0"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono-tabular text-[13px] text-[#E8EBF0] sm:gap-x-3 sm:text-[15px]">
      <span class="text-[17px] font-semibold sm:text-[20px]">
        {formatTokens(agg.todayTokensIn + agg.todayTokensOut)} tok
      </span>
      <span class="hidden text-[#4A5160] sm:inline">·</span>
      <span class="text-[#8A93A3]">{costSummaryText}</span>
      <span class="hidden text-[#4A5160] sm:inline">·</span>
      <span class="text-[#3DDC97]">{agg.activeCount} active</span>
      {#if agg.waitingCount > 0}
        <span class="hidden text-[#4A5160] sm:inline">·</span>
        <span class="font-semibold text-[#FFB020]">⚠ {agg.waitingCount} waiting</span>
      {/if}
      {#if agg.stalledCount > 0}
        <span class="hidden text-[#4A5160] sm:inline">·</span>
        <span class="hidden text-[#7A8496] sm:inline">{agg.stalledCount} stalled</span>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-2 sm:gap-3">
      {#if agg.burnRateAlarm}
        <span
          class="px-2 py-1 rounded-sm bg-[#FF5E5E]/15 border border-[#FF5E5E] text-[#FF5E5E] font-mono-tabular text-[12px] sm:px-2.5 sm:text-[13px] font-semibold"
          data-testid="burn-rate-alarm"
        >
          🔥 ${agg.burnRateUsdPerMin.toFixed(2)}/min
        </span>
      {:else if agg.burnRateTokensPerMin > 0}
        <span class="font-mono-tabular text-[12px] text-[#8A93A3] sm:text-[13px]">
          {formatTokens(agg.burnRateTokensPerMin)} tok/min
        </span>
      {/if}
    </div>
  </header>

  <!-- 2x2 or 2x3 Grid of live run cards (§8.2) -->
  {#if visibleRuns.length === 0}
    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-8 sm:p-12 text-center">
      <p class="text-[17px] text-[#E8EBF0] font-medium">No active agent sessions</p>
      <p class="text-[14px] text-[#8A93A3] mt-1">
        Waiting for OpenCode, Claude Code, Codex, or agy sessions on this machine.
      </p>
    </div>
  {:else}
    <div
      class="grid gap-3 sm:gap-4 {prefs.columns === 3 ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}"
    >
      {#each visibleRuns as run (run.id)}
        <RunCard
          {run}
          now={deckStore.now}
          animatePulse={animatedIds.has(run.id)}
          waitingEscalateSeconds={prefs.waitingEscalateSeconds ?? 300}
          onSelect={(id) => deckStore.setView('detail', id)}
        />
      {/each}
    </div>
  {/if}

  {#if hiddenCount > 0 || deckStore.showAllDone}
    <div class="flex justify-center pt-1">
      <button
        type="button"
        onclick={() => (deckStore.showAllDone = !deckStore.showAllDone)}
        class="min-h-[48px] px-5 bg-[#14171C] border border-[#232830] rounded-sm text-[13px] uppercase tracking-wider text-[#8A93A3] hover:text-[#E8EBF0]"
      >
        {deckStore.showAllDone ? 'Collapse finished sessions' : `Show all (${hiddenCount} more)`}
      </button>
    </div>
  {/if}
</section>

<script lang="ts">
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatTokens } from '$lib/format';
  import RunCard from '$lib/components/RunCard.svelte';

  const runs = $derived(deckStore.sortedRuns);
  const agg = $derived(deckStore.visibleAggregates);
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

<section class="flex flex-col gap-3.5 sm:gap-4" data-testid="deck-view">
  <!-- Pinned 56px OpenCode Telemetry Strip (§8.2) — wraps cleanly on phones -->
  <header
    class="bezel-specular flex min-h-[56px] flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded px-3 py-2 sm:flex-nowrap sm:px-4 sm:py-0"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono-tabular text-[13px] text-[#ECEDF2] sm:gap-x-3.5 sm:text-[14px]">
      <!-- OpenCode Brand Identity -->
      <div class="hidden md:flex items-center gap-2 pr-1">
        <span class="text-[#6BA6FF] font-bold text-[13px]">&gt;_</span>
        <span class="chrome-label !text-[#ECEDF2] tracking-widest">AGENT DECK</span>
      </div>
      <span class="hidden md:inline-block h-3.5 w-px bg-[#212631]"></span>

      <!-- Primary Token Counter -->
      <div class="flex items-baseline gap-1.5">
        <span class="chrome-label hidden sm:inline">TODAY</span>
        <span class="text-[16px] font-bold tracking-tight text-[#ECEDF2] sm:text-[19px]">
          {formatTokens(agg.todayTokensIn + agg.todayTokensOut)} tok
        </span>
      </div>

      <span class="hidden text-[#2E3545] sm:inline">|</span>

      <!-- Honest Cost Readout -->
      <span class="text-[#8B93A6] text-[12px] sm:text-[14px]">{costSummaryText}</span>

      <span class="hidden text-[#2E3545] sm:inline">|</span>

      <!-- Active Pill -->
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[#3DDC97]/10 border border-[#3DDC97]/30 text-[11px] sm:text-[12px] font-semibold text-[#3DDC97]">
        <span class="w-1.5 h-1.5 rounded-full bg-[#3DDC97]"></span>
        {agg.activeCount} active
      </span>

      {#if agg.waitingCount > 0}
        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[#FFB020]/15 border border-[#FFB020]/50 text-[11px] sm:text-[12px] font-semibold text-[#FFB020]">
          ⚠ {agg.waitingCount} waiting
        </span>
      {/if}

      {#if agg.stalledCount > 0}
        <span class="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-[#7A8496]/15 border border-[#7A8496]/40 text-[11px] text-[#7A8496]">
          ◌ {agg.stalledCount} stalled
        </span>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-2 sm:gap-3">
      {#if agg.burnRateAlarm}
        <span
          class="px-2 py-0.5 rounded-sm bg-[#FF5E5E]/15 border border-[#FF5E5E] text-[#FF5E5E] font-mono-tabular text-[11px] sm:px-2.5 sm:text-[12px] font-semibold"
          data-testid="burn-rate-alarm"
        >
          🔥 ${agg.burnRateUsdPerMin.toFixed(2)}/min
        </span>
      {:else if agg.burnRateTokensPerMin > 0}
        <span class="well-recessed px-2 py-0.5 rounded-sm font-mono-tabular text-[11px] text-[#8B93A6] sm:text-[12px]">
          ⚡ {formatTokens(agg.burnRateTokensPerMin)} tok/min
        </span>
      {:else}
        <span class="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm well-recessed font-mono-tabular text-[11px] text-[#3DDC97]">
          <span class="w-1.5 h-1.5 rounded-full bg-[#3DDC97]"></span>
          ONLINE
        </span>
      {/if}
    </div>
  </header>

  <!-- 2x2 or 2x3 Grid of live run cards (§8.2) -->
  {#if visibleRuns.length === 0}
    <div class="bezel-specular rounded p-8 sm:p-12 text-center space-y-2">
      <div class="font-mono-tabular text-[13px] text-[#6BA6FF]">&gt;_ STANDBY</div>
      <p class="text-[17px] text-[#ECEDF2] font-semibold">No active agent sessions</p>
      <p class="text-[13px] sm:text-[14px] text-[#8B93A6]">
        Observing OpenCode, Claude Code, Codex, and agy channels on this machine.
      </p>
    </div>
  {:else}
    <div
      class="grid gap-3 sm:gap-3.5 {prefs.columns === 3 ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}"
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
        class="bezel-specular min-h-[48px] px-5 rounded font-mono-tabular text-[12px] font-semibold uppercase tracking-wider text-[#8B93A6] hover:text-[#ECEDF2] hover:border-[#2E3545] transition-colors"
      >
        {deckStore.showAllDone ? 'Collapse finished sessions' : `Show all (${hiddenCount} more)`}
      </button>
    </div>
  {/if}
</section>

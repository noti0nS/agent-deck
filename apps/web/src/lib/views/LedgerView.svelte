<script lang="ts">
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatCost, formatTokens, SOURCE_COLORS, STATUS_COLORS } from '$lib/format';

  const runs = $derived(deckStore.sortedRuns);

  const startOfDay = $derived.by(() => {
    const d = new Date(deckStore.now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });

  const endOfDay = $derived(startOfDay + 86_400_000);

  const todayRuns = $derived(
    runs.filter((r) => r.lastActivityAt >= startOfDay || r.startedAt >= startOfDay)
  );

  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  function barGeometry(startedAt: number, lastActivityAt: number, endedAt?: number) {
    const s = Math.max(startOfDay, startedAt);
    const e = Math.min(endOfDay, Math.max(s + 300_000, endedAt ?? lastActivityAt));
    const leftPct = ((s - startOfDay) / 86_400_000) * 100;
    const widthPct = Math.max(1.5, ((e - s) / 86_400_000) * 100);
    return { leftPct, widthPct };
  }
</script>

<!-- Ledger View (§8.2): the day as a 24h Gantt across hours, coloured by status, with token/cost annotations at right edge -->
<section class="bezel-specular rounded p-3.5 sm:p-4 space-y-4" data-testid="ledger-view">
  <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[#212631] pb-2.5">
    <span class="chrome-label">Today's Session Ledger (24h Gantt)</span>
    <span class="well-recessed px-2 py-0.5 rounded-sm font-mono-tabular text-[11px] text-[#8B93A6] sm:text-[12px]">
      {todayRuns.length} sessions today
    </span>
  </div>

  <!-- Hour ruler: 3-hour ticks on tablets, 6-hour ticks on phones -->
  <div class="hidden grid-cols-12 items-center text-[11px] font-mono-tabular text-[#8B93A6] border-b border-[#212631] pb-2 sm:grid">
    <div class="col-span-3 chrome-label">SESSION</div>
    <div class="col-span-7 flex justify-between px-1">
      {#each hours as h}
        <span>{String(h).padStart(2, '0')}:00</span>
      {/each}
    </div>
    <div class="col-span-2 text-right chrome-label">TOKENS / COST</div>
  </div>
  <div class="flex items-center justify-between text-[10px] font-mono-tabular text-[#8B93A6] border-b border-[#212631] pb-1.5 sm:hidden">
    {#each [0, 6, 12, 18, 24] as h}
      <span>{String(h).padStart(2, '0')}:00</span>
    {/each}
  </div>

  {#if todayRuns.length === 0}
    <p class="text-[13px] text-[#8B93A6] font-mono-tabular py-8 text-center">No sessions recorded today.</p>
  {:else}
    <div class="divide-y divide-[#212631]">
      {#each todayRuns as run (run.id)}
        {@const geom = barGeometry(run.startedAt, run.lastActivityAt, run.endedAt)}
        {@const stColor = STATUS_COLORS[run.status] ?? '#3DDC97'}
        {@const srcColor = SOURCE_COLORS[run.source] ?? '#6BA6FF'}
        {@const cost = formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision)}
        <button
          type="button"
          onclick={() => deckStore.setView('detail', run.id)}
          class="w-full py-2.5 px-1.5 text-left flex flex-col gap-1.5 rounded-sm hover:bg-[#0D0F14] active:bg-[#171B24] transition-colors sm:grid sm:grid-cols-12 sm:items-center sm:gap-2"
        >
          <div class="flex min-w-0 items-center gap-2 sm:col-span-3">
            <span class="w-2 h-2 rounded-full shrink-0" style="background-color: {srcColor};"></span>
            <span class="font-mono-tabular text-[13px] text-[#ECEDF2] font-semibold truncate">
              {run.projectName}
            </span>
            <span class="text-[12px] text-[#8B93A6] truncate">{run.title}</span>
          </div>

          <div class="flex items-center gap-2 sm:contents">
            <div class="relative h-3.5 min-w-0 flex-1 overflow-hidden rounded-[3px] well-recessed sm:col-span-7">
              <div
                class="absolute top-0.5 bottom-0.5 rounded-[2px]"
                style="left: {geom.leftPct}%; width: {geom.widthPct}%; background-color: {stColor};"
              ></div>
            </div>

            <div class="shrink-0 text-right font-mono-tabular text-[12px] text-[#ECEDF2] sm:col-span-2 sm:text-[13px]">
              <span class="font-semibold">{formatTokens(run.usage.tokensIn + run.usage.tokensOut)}</span>
              {#if cost}
                <span class="text-[#8B93A6] ml-1.5">{cost}</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</section>

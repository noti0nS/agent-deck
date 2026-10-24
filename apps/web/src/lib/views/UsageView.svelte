<script lang="ts">
  import { onMount } from 'svelte';
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatTokens } from '$lib/format';
  import type { AgentRun } from '@agent-deck/core';

  let range = $state<'today' | 'week'>('today');
  let summary = $state<{
    tokensIn: number;
    tokensOut: number;
    exactCostUsd: number;
    estimatedCostUsd: number;
    hasExactCost: boolean;
    hasEstimatedCost: boolean;
    runs: number;
    turns: number;
    toolCalls: number;
    activeMs: number;
    recentAvgDailyTokens: number;
    trendVsAvgPct: number;
    burnRateTokensPerMin: number;
    burnRateUsdPerMin: number;
    burnRateAlarm: boolean;
  } | null>(null);

  let timeseries = $state<Array<{ bucketTs: number; tokensIn: number; tokensOut: number; costUsd: number }>>([]);
  let byProject = $state<Array<{ key: string; tokensIn: number; tokensOut: number; exactCostUsd: number; estimatedCostUsd: number; precision: string }>>([]);
  let byModel = $state<Array<{ key: string; tokensIn: number; tokensOut: number; exactCostUsd: number; estimatedCostUsd: number; precision: string; runs: number; turns: number }>>([]);
  let unproductiveRuns = $state<AgentRun[]>([]);

  async function loadUsage() {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const from = range === 'today' ? startOfToday.getTime() : now - 7 * 86_400_000;

    try {
      const [sumRes, tsRes, projRes, modRes, unprodRes] = await Promise.all([
        fetch(`/api/usage/summary?from=${from}&to=${now}`),
        fetch(`/api/usage/timeseries?from=${now - 7 * 86_400_000}&to=${now}&bucket=1h`),
        fetch(`/api/usage/breakdown?by=project&from=${from}&to=${now}`),
        fetch(`/api/usage/breakdown?by=model&from=${from}&to=${now}`),
        fetch(`/api/usage/runs?sortBy=unproductive&limit=5&from=${from}&to=${now}`)
      ]);

      if (sumRes.ok) summary = await sumRes.json();
      if (tsRes.ok) {
        const d = await tsRes.json();
        timeseries = d.series ?? [];
      }
      if (projRes.ok) {
        const d = await projRes.json();
        byProject = d.rows ?? [];
      }
      if (modRes.ok) {
        const d = await modRes.json();
        byModel = d.rows ?? [];
      }
      if (unprodRes.ok) {
        const d = await unprodRes.json();
        unproductiveRuns = d.runs ?? [];
      }
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadUsage();
  });

  function switchRange(next: 'today' | 'week') {
    range = next;
    loadUsage();
  }

  // Hand-drawn 2px SVG sparkline (§8.2, §8.5)
  const sparklinePath = $derived.by(() => {
    if (timeseries.length === 0) return 'M 0 60 L 600 60';
    const maxTok = Math.max(1, ...timeseries.map((b) => b.tokensIn + b.tokensOut));
    const pts = timeseries.map((b, i) => {
      const x = timeseries.length === 1 ? 300 : (i / (timeseries.length - 1)) * 600;
      const y = 64 - ((b.tokensIn + b.tokensOut) / maxTok) * 56;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M ${pts.join(' L ')}`;
  });

  const maxProjectTokens = $derived(
    Math.max(1, ...byProject.map((p) => p.tokensIn + p.tokensOut))
  );

  // Mark the newest sample so a single-bucket window still shows something.
  const sparklineLast = $derived.by(() => {
    if (timeseries.length === 0) return null;
    const maxTok = Math.max(1, ...timeseries.map((b) => b.tokensIn + b.tokensOut));
    const i = timeseries.length - 1;
    const b = timeseries[i];
    const x = timeseries.length === 1 ? 300 : (i / (timeseries.length - 1)) * 600;
    const y = 64 - ((b.tokensIn + b.tokensOut) / maxTok) * 56;
    return { x, y };
  });
</script>

<section class="flex flex-col gap-4" data-testid="usage-view">
  <!-- Header + Today / Week toggle -->
  <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
    <div class="flex items-center gap-2 sm:gap-3">
      <button
        type="button"
        onclick={() => switchRange('today')}
        class="min-h-[48px] px-3 rounded-sm font-medium text-[13px] border sm:px-4 sm:text-[14px] {range === 'today' ? 'bg-[#232830] border-[#6BA6FF] text-[#E8EBF0]' : 'border-[#232830] text-[#8A93A3]'}"
      >
        Today
      </button>
      <button
        type="button"
        onclick={() => switchRange('week')}
        class="min-h-[48px] px-3 rounded-sm font-medium text-[13px] border sm:px-4 sm:text-[14px] {range === 'week' ? 'bg-[#232830] border-[#6BA6FF] text-[#E8EBF0]' : 'border-[#232830] text-[#8A93A3]'}"
      >
        Last 7 Days
      </button>
    </div>

    <div class="grid w-full grid-cols-2 gap-x-3 gap-y-3 font-mono-tabular sm:flex sm:w-auto sm:items-center sm:gap-6">
      <div>
        <div class="chrome-label">Tokens ({range})</div>
        <div class="text-[22px] font-semibold text-[#E8EBF0] sm:text-[28px]">
          {formatTokens((summary?.tokensIn ?? 0) + (summary?.tokensOut ?? 0))}
          {#if summary && summary.trendVsAvgPct !== 0}
            <span class="mt-0.5 block text-[11px] sm:mt-0 sm:ml-1 sm:inline sm:text-[13px] {summary.trendVsAvgPct > 0 ? 'text-[#FFB020]' : 'text-[#3DDC97]'}">
              {summary.trendVsAvgPct > 0 ? `+${summary.trendVsAvgPct}%` : `${summary.trendVsAvgPct}%`} vs 7d avg
            </span>
          {/if}
        </div>
      </div>

      <div>
        <div class="chrome-label">Actual Spend</div>
        <div class="text-[22px] font-semibold text-[#E8EBF0] sm:text-[28px]">
          {summary?.hasExactCost ? `$${summary.exactCostUsd.toFixed(2)}` : '—'}
        </div>
      </div>

      <div>
        <div class="chrome-label">API-Equiv (est. API-rate)</div>
        <div class="text-[22px] font-semibold text-[#8A93A3] sm:text-[28px]">
          {summary?.hasEstimatedCost ? `$${summary.estimatedCostUsd.toFixed(2)} est.` : '—'}
        </div>
      </div>

      <div>
        <div class="chrome-label">Live Burn Rate</div>
        <div class="text-[20px] font-semibold sm:text-[24px] {summary?.burnRateAlarm ? 'text-[#FF5E5E]' : 'text-[#3DDC97]'}">
          ${(summary?.burnRateUsdPerMin ?? 0).toFixed(3)}/min
        </div>
      </div>
    </div>
  </div>

  <!-- 7-day tokens/hour hand-drawn SVG sparkline (§8.2, §8.5) -->
  <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
      <span class="chrome-label">Tokens / Hour (7-Day Sparkline)</span>
      <span class="font-mono-tabular text-[12px] text-[#8A93A3] sm:text-[13px]">
        {timeseries.length} hourly {timeseries.length === 1 ? 'bucket' : 'buckets'}
      </span>
    </div>
    <svg viewBox="0 0 600 70" class="w-full h-16 overflow-visible sm:h-24" role="img" aria-label="Tokens per hour sparkline">
      <path d={sparklinePath} fill="none" stroke="#3DDC97" stroke-width="2" stroke-linecap="round" />
      {#if sparklineLast}
        <circle cx={sparklineLast.x} cy={sparklineLast.y} r="3.5" fill="#3DDC97" />
      {/if}
    </svg>
  </div>

  <!-- Two columns: Stacked Bars by Project + Compact Table by Model -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-4 space-y-3">
      <div class="chrome-label">Usage by Project</div>
      {#if byProject.length === 0}
        <p class="text-[14px] text-[#8A93A3]">No project samples in window.</p>
      {:else}
        {#each byProject as proj}
          {@const total = proj.tokensIn + proj.tokensOut}
          {@const inPct = Math.round((proj.tokensIn / maxProjectTokens) * 100)}
          {@const outPct = Math.round((proj.tokensOut / maxProjectTokens) * 100)}
          <div class="space-y-1">
            <div class="flex items-center justify-between text-[14px] font-mono-tabular">
              <span class="text-[#E8EBF0] truncate">{proj.key}</span>
              <span class="text-[#8A93A3]">
                {formatTokens(total)} tok
                {#if proj.exactCostUsd > 0}
                  · ${proj.exactCostUsd.toFixed(2)}
                {:else if proj.estimatedCostUsd > 0}
                  · ${proj.estimatedCostUsd.toFixed(2)} est.
                {/if}
              </span>
            </div>
            <!-- 3px rounded stacked bar (§8.5) -->
            <div class="w-full h-2 bg-[#0B0D10] rounded-[3px] flex overflow-hidden">
              <div class="bg-[#6BA6FF] h-full" style="width: {inPct}%"></div>
              <div class="bg-[#3DDC97] h-full" style="width: {outPct}%"></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span class="chrome-label">Usage by Model</span>
        <span class="font-mono-tabular text-[11px] text-[#8A93A3] sm:text-[12px]">
          Price table v{deckStore.pricingInfo.version} ({deckStore.pricingInfo.updatedAt})
        </span>
      </div>
      {#if byModel.length === 0}
        <p class="text-[14px] text-[#8A93A3]">No model samples in window.</p>
      {:else}
        <div class="divide-y divide-[#232830] font-mono-tabular text-[13px]">
          {#each byModel as m}
            <div class="py-2 flex items-center justify-between gap-2">
              <div class="truncate">
                <span class="text-[#E8EBF0]">{m.key}</span>
                <span class="text-[#8A93A3] ml-2">{m.turns} turns</span>
              </div>
              <div class="shrink-0 text-right">
                <span class="text-[#E8EBF0]">{formatTokens(m.tokensIn + m.tokensOut)}</span>
                <span class="text-[#8A93A3] ml-2">
                  {#if m.exactCostUsd > 0}
                    ${m.exactCostUsd.toFixed(2)}
                  {:else if m.estimatedCostUsd > 0}
                    ${m.estimatedCostUsd.toFixed(2)} est.
                  {:else}
                    —
                  {/if}
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Expensive & Low-Output Runs (§7.4) -->
  <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-2">
    <div class="chrome-label">High-Burn / Low-File-Delta Sessions</div>
    {#if unproductiveRuns.length === 0}
      <p class="text-[14px] text-[#8A93A3]">No sessions recorded yet.</p>
    {:else}
      <div class="divide-y divide-[#232830] font-mono-tabular text-[12px] sm:text-[13px]">
        {#each unproductiveRuns as r (r.id)}
          <button
            type="button"
            onclick={() => deckStore.setView('detail', r.id)}
            class="w-full py-2 flex items-center justify-between gap-2 text-left hover:bg-[#0B0D10] active:bg-[#0B0D10] px-2 rounded-sm"
          >
            <div class="flex min-w-0 items-center gap-2 truncate">
              <span class="text-[#8A93A3] uppercase">{r.source}</span>
              <span class="text-[#E8EBF0] font-medium">{r.projectName}</span>
              <span class="hidden text-[#8A93A3] truncate sm:inline">{r.title}</span>
              {#if r.historical}
                <span class="hidden text-[11px] px-1.5 py-0.5 border border-[#4A5160] text-[#8A93A3] rounded-sm sm:inline">historical</span>
              {/if}
            </div>
            <div class="shrink-0 flex items-center gap-2 text-[#8A93A3] sm:gap-3">
              <span>{formatTokens(r.usage.tokensIn + r.usage.tokensOut)} tok</span>
              <span>{r.filesChanged?.length ?? 0} files</span>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

<script lang="ts">
  import { onMount } from 'svelte';
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatCost, formatElapsed, formatTokens, SOURCE_COLORS, STATUS_COLORS, STATUS_ICONS } from '$lib/format';

  const run = $derived(deckStore.selectedRun);

  let transcriptLines = $state<Array<{ role: string; text: string; ts?: number }>>([]);
  let diffFiles = $state<Array<{ path: string; additions: number; deletions: number; patch?: string }>>([]);

  async function loadDetailExtras(runId: string) {
    try {
      const [tRes, dRes] = await Promise.all([
        fetch(`/api/runs/${encodeURIComponent(runId)}/transcript?limit=30`),
        fetch(`/api/runs/${encodeURIComponent(runId)}/diff`)
      ]);
      if (tRes.ok) {
        const d = await tRes.json();
        transcriptLines = d.lines ?? [];
      }
      if (dRes.ok) {
        const d = await dRes.json();
        diffFiles = d.files ?? [];
      }
    } catch {
      // ignore
    }
  }

  onMount(() => {
    if (run) {
      loadDetailExtras(run.id);
    }
  });

  const completedTodos = $derived(run ? run.todos.filter((t) => t.status === 'completed').length : 0);
  const totalTodos = $derived(run ? run.todos.length : 0);
  const progressPct = $derived(totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0);
</script>

<!-- Detail View (§8.2): strictly read-only depth: step timeline, todo list with progress ring, file-edit chips, transcript tail, per-turn usage -->
<section class="space-y-4" data-testid="detail-view">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <button
      type="button"
      onclick={() => deckStore.backFromDetail()}
      class="min-h-[48px] px-4 bg-[#14171C] border border-[#232830] rounded-sm text-[14px] text-[#E8EBF0] flex items-center gap-2 active:bg-[#232830]"
    >
      <span>←</span>
      <span>Back</span>
    </button>
    {#if run}
      <span class="min-w-0 font-mono-tabular text-[11px] text-[#8A93A3] truncate sm:text-[13px]">
        ID: {run.id} · confidence: {run.confidence}
      </span>
    {/if}
  </div>

  {#if !run}
    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-8 text-center text-[#8A93A3]">
      Session not found.
    </div>
  {:else}
    {@const stColor = STATUS_COLORS[run.status] ?? '#3DDC97'}
    {@const srcColor = SOURCE_COLORS[run.source] ?? '#6BA6FF'}
    {@const stIcon = STATUS_ICONS[run.status] ?? '●'}
    {@const cost = formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision)}

    <!-- Header Summary -->
    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-2 relative">
      <div class="absolute left-0 top-0 bottom-0 w-[3px]" style="background-color: {stColor};"></div>
      <div class="pl-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full" style="background-color: {srcColor};"></span>
          <span class="chrome-label">{run.source}</span>
          <span class="font-mono-tabular text-[15px] text-[#E8EBF0] font-semibold">{run.projectName}</span>
          <span class="text-[14px] font-medium ml-2" style="color: {stColor};">
            {stIcon} {run.status}
          </span>
        </div>
        <div class="font-mono-tabular text-[12px] text-[#8A93A3] sm:text-[14px]">
          Elapsed {formatElapsed(run.startedAt, deckStore.now, run.endedAt)} · {run.model}
        </div>
      </div>
      <h2 class="pl-2 text-[18px] font-semibold text-[#E8EBF0] sm:text-[20px]">{run.title}</h2>
      {#if run.projectPath}
        <p class="pl-2 font-mono-tabular text-[12px] text-[#8A93A3] break-all sm:text-[13px]">{run.projectPath}</p>
      {/if}
    </div>

    {#if run.attention}
      <div class="bg-[#14171C] border border-[#FFB020] rounded-sm p-3 sm:p-4 space-y-1">
        <div class="chrome-label !text-[#FFB020]">⚠ Blocked on you (read-only)</div>
        <p class="font-mono-tabular text-[15px] text-[#E8EBF0]">{run.attention.summary}</p>
        <p class="text-[13px] text-[#8A93A3]">Go to your terminal to respond.</p>
      </div>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Todos with SVG Progress Ring -->
      <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="chrome-label">Plan & Todos</span>
          <div class="flex items-center gap-2">
            <svg width="24" height="24" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="#232830" stroke-width="3" />
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="#3DDC97"
                stroke-width="3"
                stroke-dasharray="{progressPct}, 100"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="font-mono-tabular text-[13px] text-[#8A93A3]">{completedTodos}/{totalTodos}</span>
          </div>
        </div>
        {#if run.todos.length === 0}
          <p class="text-[14px] text-[#8A93A3]">No todos recorded for this session.</p>
        {:else}
          <ul class="space-y-1.5 text-[14px]">
            {#each run.todos as todo}
              <li class="flex items-start gap-2">
                <span class="font-mono-tabular text-[13px] {todo.status === 'completed' ? 'text-[#3DDC97]' : todo.status === 'in_progress' ? 'text-[#FFB020]' : 'text-[#8A93A3]'}">
                  {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}
                </span>
                <span class="{todo.status === 'completed' ? 'text-[#8A93A3] line-through' : 'text-[#E8EBF0]'}">
                  {todo.content}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Step Timeline -->
      <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-3">
        <span class="chrome-label">Step Timeline ({run.usage.toolCalls} tool calls)</span>
        {#if run.currentStep}
          <div class="bg-[#0B0D10] border border-[#3DDC97]/50 rounded-sm p-2 font-mono-tabular text-[13px]">
            <span class="text-[#3DDC97]">NOW: {run.currentStep.label}</span>
            <span class="text-[#E8EBF0] ml-1.5">{run.currentStep.detail}</span>
          </div>
        {/if}
        {#if !run.recentSteps || run.recentSteps.length === 0}
          <p class="text-[14px] text-[#8A93A3]">No recent steps recorded.</p>
        {:else}
          <div class="space-y-1.5 max-h-64 overflow-y-auto font-mono-tabular text-[13px]">
            {#each run.recentSteps as step}
              <div class="flex items-center justify-between gap-2 py-1 border-b border-[#232830]">
                <div class="min-w-0 truncate">
                  <span class="{step.ok === false ? 'text-[#FF5E5E]' : 'text-[#8A93A3]'}">{step.label}</span>
                  <span class="text-[#E8EBF0] ml-1.5">{step.detail}</span>
                </div>
                {#if step.endedAt && step.startedAt}
                  <span class="text-[#8A93A3] shrink-0">{Math.max(1, Math.round((step.endedAt - step.startedAt) / 1000))}s</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Usage & File Edits -->
      <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-4">
        <div>
          <span class="chrome-label">Session Usage</span>
          <div class="mt-2 grid grid-cols-2 gap-2 font-mono-tabular text-[13px]">
            <div class="bg-[#0B0D10] p-2 rounded-sm">
              <div class="text-[#8A93A3]">Input</div>
              <div class="text-[16px] text-[#E8EBF0]">{formatTokens(run.usage.tokensIn)}</div>
            </div>
            <div class="bg-[#0B0D10] p-2 rounded-sm">
              <div class="text-[#8A93A3]">Output</div>
              <div class="text-[16px] text-[#E8EBF0]">{formatTokens(run.usage.tokensOut)}</div>
            </div>
            <div class="bg-[#0B0D10] p-2 rounded-sm">
              <div class="text-[#8A93A3]">Cost ({run.usage.precision ?? 'none'})</div>
              <div class="text-[16px] text-[#E8EBF0]">{cost ?? '—'}</div>
            </div>
            <div class="bg-[#0B0D10] p-2 rounded-sm">
              <div class="text-[#8A93A3]">Turns / Tools</div>
              <div class="text-[16px] text-[#E8EBF0]">{run.usage.turns} / {run.usage.toolCalls}</div>
            </div>
          </div>
        </div>

        <div>
          <span class="chrome-label">File Edits ({diffFiles.length})</span>
          <div class="mt-2 flex flex-wrap gap-1.5 font-mono-tabular text-[12px]">
            {#each diffFiles as file}
              <span class="max-w-full break-all px-2 py-1 bg-[#0B0D10] border border-[#232830] rounded-sm text-[#E8EBF0]">
                {file.path}
                <span class="text-[#3DDC97] ml-1">+{file.additions}</span>
                <span class="text-[#FF5E5E] ml-0.5">−{file.deletions}</span>
              </span>
            {/each}
          </div>
        </div>
      </div>
    </div>

    <!-- Lazy Transcript Tail -->
    <div class="bg-[#14171C] border border-[#232830] rounded-sm p-3 sm:p-4 space-y-2">
      <span class="chrome-label">Transcript Tail (Redacted)</span>
      {#if transcriptLines.length === 0}
        <p class="text-[14px] text-[#8A93A3]">No transcript messages available.</p>
      {:else}
        <div class="space-y-2 max-h-80 overflow-y-auto">
          {#each transcriptLines as line}
            <div class="bg-[#0B0D10] border border-[#232830] rounded-sm p-2.5 text-[13px] sm:text-[14px]">
              <span class="chrome-label mr-2">{line.role}</span>
              <span class="text-[#E8EBF0] whitespace-pre-wrap break-words">{line.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

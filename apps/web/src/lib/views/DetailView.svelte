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
<section class="space-y-3.5 sm:space-y-4" data-testid="detail-view">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <button
      type="button"
      onclick={() => deckStore.backFromDetail()}
      class="bezel-specular min-h-[48px] px-4 rounded font-mono-tabular text-[13px] font-semibold text-[#ECEDF2] flex items-center gap-2 hover:border-[#2E3545] active:bg-[#171B24] transition-colors"
    >
      <span class="text-[#6BA6FF]">←</span>
      <span>Back</span>
    </button>
    {#if run}
      <span class="min-w-0 well-recessed px-2.5 py-1 rounded-sm font-mono-tabular text-[11px] text-[#8B93A6] truncate sm:text-[12px]">
        ID: <span class="text-[#ECEDF2]">{run.id}</span> · confidence: <span class="text-[#ECEDF2]">{run.confidence}</span>
      </span>
    {/if}
  </div>

  {#if !run}
    <div class="bezel-specular rounded p-8 text-center font-mono-tabular text-[#8B93A6]">
      Session not found.
    </div>
  {:else}
    {@const stColor = STATUS_COLORS[run.status] ?? '#3DDC97'}
    {@const srcColor = SOURCE_COLORS[run.source] ?? '#6BA6FF'}
    {@const stIcon = STATUS_ICONS[run.status] ?? '●'}
    {@const cost = formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision)}

    <!-- Header Summary -->
    <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-2 relative overflow-hidden">
      <div class="absolute left-0 top-0 bottom-0 w-[3px]" style="background-color: {stColor};"></div>
      <div class="pl-2 flex flex-wrap items-center justify-between gap-2 border-b border-[#212631] pb-2">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full" style="background-color: {srcColor};"></span>
          <span class="chrome-label">{run.source}</span>
          <span class="text-[#4C5365]">·</span>
          <span class="font-mono-tabular text-[14px] sm:text-[15px] text-[#ECEDF2] font-bold">{run.projectName}</span>
          <span class="font-mono-tabular text-[13px] font-semibold ml-1.5" style="color: {stColor};">
            {stIcon} {run.status}
          </span>
        </div>
        <div class="font-mono-tabular text-[12px] text-[#8B93A6] sm:text-[13px]">
          Elapsed <span class="text-[#ECEDF2]">{formatElapsed(run.startedAt, deckStore.now, run.endedAt)}</span> · <span class="text-[#ECEDF2]">{run.model}</span>
        </div>
      </div>
      <h2 class="pl-2 text-[17px] font-semibold tracking-tight text-[#ECEDF2] sm:text-[20px]">{run.title}</h2>
      {#if run.projectPath}
        <p class="pl-2 font-mono-tabular text-[12px] text-[#8B93A6] break-all">{run.projectPath}</p>
      {/if}
    </div>

    {#if run.attention}
      <div class="bezel-specular !border-[#FFB020]/60 rounded p-3.5 sm:p-4 space-y-1.5 bg-[linear-gradient(135deg,rgba(255,176,32,0.06)_0%,rgba(18,21,28,0.98)_65%)]">
        <div class="chrome-label !text-[#FFB020]">⚠ Blocked on you (read-only)</div>
        <div class="well-recessed !border-[#FFB020]/40 rounded px-3 py-2 font-mono-tabular text-[14px] text-[#ECEDF2]">
          <span class="text-[#FFB020] mr-1.5">$</span>{run.attention.summary}
        </div>
        <p class="font-mono-tabular text-[12px] text-[#FFB020]">→ Go to your local terminal to respond.</p>
      </div>
    {/if}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3.5 sm:gap-4">
      <!-- Todos with SVG Progress Ring -->
      <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-3">
        <div class="flex items-center justify-between border-b border-[#212631] pb-2">
          <span class="chrome-label">Plan & Todos</span>
          <div class="flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" stroke="#212631" stroke-width="3.5" />
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="#3DDC97"
                stroke-width="3.5"
                stroke-dasharray="{progressPct}, 100"
                transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="font-mono-tabular text-[12px] text-[#ECEDF2] font-semibold">{completedTodos}/{totalTodos}</span>
          </div>
        </div>
        {#if run.todos.length === 0}
          <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No todos recorded for this session.</p>
        {:else}
          <ul class="space-y-1.5 text-[13px] sm:text-[14px]">
            {#each run.todos as todo}
              <li class="well-recessed rounded-sm px-2.5 py-1.5 flex items-start gap-2">
                <span class="font-mono-tabular text-[12px] mt-0.5 {todo.status === 'completed' ? 'text-[#3DDC97]' : todo.status === 'in_progress' ? 'text-[#FFB020]' : 'text-[#8B93A6]'}">
                  {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'}
                </span>
                <span class="{todo.status === 'completed' ? 'text-[#8B93A6] line-through' : 'text-[#ECEDF2]'}">
                  {todo.content}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Step Timeline -->
      <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-3">
        <div class="border-b border-[#212631] pb-2 flex items-center justify-between">
          <span class="chrome-label">Step Timeline</span>
          <span class="font-mono-tabular text-[11px] text-[#8B93A6]">{run.usage.toolCalls} tool calls</span>
        </div>
        {#if run.currentStep}
          <div class="well-recessed !border-[#3DDC97]/50 rounded p-2.5 font-mono-tabular text-[12px] sm:text-[13px]">
            <span class="text-[#3DDC97] font-semibold">NOW · {run.currentStep.label}</span>
            <span class="text-[#ECEDF2] ml-1.5">{run.currentStep.detail}</span>
          </div>
        {/if}
        {#if !run.recentSteps || run.recentSteps.length === 0}
          <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No recent steps recorded.</p>
        {:else}
          <div class="space-y-1.5 max-h-64 overflow-y-auto font-mono-tabular text-[12px] sm:text-[13px]">
            {#each run.recentSteps as step}
              <div class="flex items-center justify-between gap-2 py-1.5 px-2 well-recessed rounded-sm">
                <div class="min-w-0 truncate">
                  <span class="font-semibold {step.ok === false ? 'text-[#FF5E5E]' : 'text-[#6BA6FF]'}">{step.label}</span>
                  <span class="text-[#ECEDF2] ml-1.5">{step.detail}</span>
                </div>
                {#if step.endedAt && step.startedAt}
                  <span class="text-[#8B93A6] shrink-0">{Math.max(1, Math.round((step.endedAt - step.startedAt) / 1000))}s</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Usage & File Edits -->
      <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-4">
        <div>
          <div class="border-b border-[#212631] pb-2">
            <span class="chrome-label">Session Usage</span>
          </div>
          <div class="mt-2.5 grid grid-cols-2 gap-2 font-mono-tabular text-[12px]">
            <div class="well-recessed p-2.5 rounded-sm">
              <div class="text-[#8B93A6] uppercase text-[10px] tracking-wider">Input</div>
              <div class="text-[16px] font-bold text-[#ECEDF2] mt-0.5">{formatTokens(run.usage.tokensIn)}</div>
            </div>
            <div class="well-recessed p-2.5 rounded-sm">
              <div class="text-[#8B93A6] uppercase text-[10px] tracking-wider">Output</div>
              <div class="text-[16px] font-bold text-[#ECEDF2] mt-0.5">{formatTokens(run.usage.tokensOut)}</div>
            </div>
            <div class="well-recessed p-2.5 rounded-sm">
              <div class="text-[#8B93A6] uppercase text-[10px] tracking-wider">Cost ({run.usage.precision ?? 'none'})</div>
              <div class="text-[16px] font-bold text-[#ECEDF2] mt-0.5">{cost ?? '—'}</div>
            </div>
            <div class="well-recessed p-2.5 rounded-sm">
              <div class="text-[#8B93A6] uppercase text-[10px] tracking-wider">Turns / Tools</div>
              <div class="text-[16px] font-bold text-[#ECEDF2] mt-0.5">{run.usage.turns} / {run.usage.toolCalls}</div>
            </div>
          </div>
        </div>

        <div>
          <span class="chrome-label">File Edits ({diffFiles.length})</span>
          <div class="mt-2 flex flex-wrap gap-1.5 font-mono-tabular text-[12px]">
            {#each diffFiles as file}
              <span class="max-w-full break-all px-2 py-1 well-recessed rounded-sm text-[#ECEDF2]">
                {file.path}
                <span class="text-[#3DDC97] font-semibold ml-1">+{file.additions}</span>
                <span class="text-[#FF5E5E] font-semibold ml-0.5">−{file.deletions}</span>
              </span>
            {/each}
          </div>
        </div>
      </div>
    </div>

    <!-- Lazy Transcript Tail -->
    <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-2.5">
      <div class="border-b border-[#212631] pb-2 flex items-center justify-between">
        <span class="chrome-label">Transcript Tail (Redacted)</span>
        <span class="font-mono-tabular text-[11px] text-[#8B93A6]">{transcriptLines.length} entries</span>
      </div>
      {#if transcriptLines.length === 0}
        <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No transcript messages available.</p>
      {:else}
        <div class="space-y-2 max-h-80 overflow-y-auto">
          {#each transcriptLines as line}
            <div class="well-recessed rounded-sm p-2.5 text-[13px] sm:text-[14px]">
              <span class="chrome-label mr-2 px-1.5 py-0.5 rounded-sm bg-[#171B24] border border-[#2E3545] !text-[#6BA6FF]">{line.role}</span>
              <span class="text-[#ECEDF2] whitespace-pre-wrap break-words">{line.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

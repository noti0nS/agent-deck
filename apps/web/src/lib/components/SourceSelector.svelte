<script lang="ts">
  import { deckStore } from '$lib/stores/deck.svelte';
  import type { Source } from '@agent-deck/core';
  const sources: { id: Source; name: string }[] = [
    { id: 'opencode', name: 'OpenCode' }, { id: 'claude', name: 'Claude' },
    { id: 'codex', name: 'Codex' }, { id: 'agy', name: 'Antigravity' }, { id: 'pty', name: 'PTY' }
  ];
</script>

<details class="mb-3 rounded border border-[#212631] bg-[#12151C] px-3">
  <summary class="min-h-12 flex items-center cursor-pointer text-sm">Ferramentas exibidas ({deckStore.visibleSources.length}/5)</summary>
  <fieldset class="flex flex-wrap gap-x-4 pb-2">
    <legend class="sr-only">Ferramentas exibidas</legend>
    {#each sources as source}
      <label class="flex min-h-12 items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={deckStore.visibleSources.includes(source.id)} onchange={() => deckStore.toggleSource(source.id)} />
        {source.name}
      </label>
    {/each}
  </fieldset>
  <p class="pb-3 text-xs text-[#8B93A6]">Filtra sessões neste dispositivo. A coleta e os totais históricos de Usage continuam incluindo todas as ferramentas.</p>
</details>

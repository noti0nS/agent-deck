<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { deckStore } from '$lib/stores/deck.svelte';

  let { children } = $props();

  onMount(() => {
    return deckStore.init();
  });
</script>

<!-- Single aria-live="polite" region used ONLY when a run enters `waiting` (§8.7) -->
<div class="sr-only" aria-live="polite" aria-atomic="true">
  {deckStore.waitingAnnouncement}
</div>

<!-- Reconnect top hairline banner (§8.6): never a spinner over content -->
{#if deckStore.connectionStatus !== 'connected'}
  <div
    class="fixed top-0 left-0 right-0 z-50 h-[3px] transition-colors {deckStore.connectionStatus === 'reconnecting' ? 'bg-[#FFB020]' : 'bg-[#3DDC97]'}"
    data-testid="reconnect-hairline"
  ></div>
  {#if deckStore.connectionStatus === 'reconnecting'}
    <div class="bg-[#0D0F14] border-b border-[#FFB020]/40 px-4 py-1.5 text-[12px] text-[#FFB020] font-mono-tabular flex items-center justify-between">
      <span class="flex items-center gap-2">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-[#FFB020]"></span>
        <span>reconnecting… showing last known state</span>
      </span>
      <span class="text-[#8B93A6]">seq #{deckStore.state.seq}</span>
    </div>
  {/if}
{/if}

<div
  class="min-h-screen transition-opacity duration-500 {deckStore.isNightDimmed && deckStore.activeView === 'ambient' ? 'opacity-65' : 'opacity-100'}"
  style={deckStore.activeView === 'ambient' ? `transform: translate(${deckStore.pixelShift.x}px, ${deckStore.pixelShift.y}px);` : undefined}
>
  {@render children()}
</div>

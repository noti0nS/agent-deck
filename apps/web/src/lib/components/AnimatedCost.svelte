<script lang="ts">
  import { Tween, prefersReducedMotion } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { formatCost } from '#lib/format.js';

  let {
    costUsd,
    costSource,
    precision,
    fallback = '—',
    estBadgeClass = ''
  }: {
    costUsd?: number | null;
    costSource?: 'tool' | 'estimated' | 'none';
    precision?: string;
    fallback?: string;
    estBadgeClass?: string;
  } = $props();

  const isCostValid = $derived(
    precision !== 'none' &&
    costSource !== 'none' &&
    costUsd !== undefined &&
    costUsd !== null
  );

  const tween = Tween.of(() => costUsd ?? 0, {
    duration: () => (prefersReducedMotion.current ? 0 : 400),
    easing: cubicOut
  });

  const display = $derived.by(() => {
    if (!isCostValid) return { main: fallback, isEst: false };
    const str = formatCost(tween.current, costSource, precision);
    if (!str) return { main: fallback, isEst: false };
    if (str.endsWith(' est.')) {
      return { main: str.slice(0, -5), isEst: true };
    }
    return { main: str, isEst: false };
  });
</script>

<span class="font-mono-tabular">{display.main}{#if display.isEst}{#if estBadgeClass}<span class={estBadgeClass}> est.</span>{:else} est.{/if}{/if}</span>

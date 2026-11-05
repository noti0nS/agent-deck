<script lang="ts">
  import { Tween, prefersReducedMotion } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { formatTokens } from '#lib/format.js';

  let { value = 0 }: { value?: number } = $props();

  const tween = Tween.of(() => value ?? 0, {
    duration: () => (prefersReducedMotion.current ? 0 : 400),
    easing: cubicOut
  });
</script>

<span class="font-mono-tabular">{formatTokens(tween.current)}</span>

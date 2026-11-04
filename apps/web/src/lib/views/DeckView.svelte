<script lang="ts">
  import { deckStore } from '#lib/stores/deck.svelte.js';
  import RunCard from '#lib/components/RunCard.svelte';
  import TelemetryCard from '#lib/components/TelemetryCard.svelte';
  import type { AgentRun } from '@agent-deck/core';
  let filter = $state<'all' | 'waiting' | 'running'>('all');
  let selectedSessions = $state<Record<string,string>>({});
  const projects = $derived.by(() => {
    const groups = new Map<string, AgentRun[]>();
    for (const run of deckStore.dashboardSessions) {
      const key = run.projectPath ? run.projectPath.replaceAll('\\','/').replace(/\/$/,'') : `session:${run.id}`;
      groups.set(key, [...(groups.get(key) ?? []), run]);
    }
    return [...groups].map(([key, sessions]) => ({ key, sessions }));
  });
  const running = (r: AgentRun) => ['running','starting','compacting'].includes(r.status);
  const filtered = $derived(projects.filter(p => filter === 'all' || p.sessions.some(r => filter === 'waiting' ? r.status === 'waiting' : running(r))));
  const visible = $derived(deckStore.showAllDone ? filtered : filtered.slice(0, 5));
  const tabs = $derived([
    { id: 'all' as const, label: 'All Projects', count: projects.length },
    { id: 'waiting' as const, label: 'Needs Attention', count: projects.filter(p => p.sessions.some(r => r.status === 'waiting')).length },
    { id: 'running' as const, label: 'Running', count: projects.filter(p => p.sessions.some(running)).length }
  ]);
</script>
<section data-testid="deck-view" class="clean-deck">
  <div class="deck-heading"><div><p class="deck-eyebrow">Workspace overview</p><h1>Projects</h1></div><p>Every session, at a glance.</p></div>
  <div class="deck-toolbar">
    <div class="status-filters" aria-label="Project status">{#each tabs as tab}<button type="button" aria-pressed={filter === tab.id} onclick={() => filter = tab.id} class:chosen={filter === tab.id}>{tab.label} ({tab.count})</button>{/each}</div>
    <span class="sync-label"><span class:connected={deckStore.connectionStatus === 'connected'}></span>{deckStore.connectionStatus === 'connected' ? 'Live session sync' : 'Showing last known state'}</span>
  </div>
  <div class="session-grid">
    {#each visible as project (project.key)}
      {@const candidates = project.sessions.filter(r => filter === 'all' || (filter === 'waiting' ? r.status === 'waiting' : running(r)))}
      {@const run = candidates.find(r => r.id === selectedSessions[project.key]) ?? candidates[0]}
      <article class="project-panel" aria-label={run.projectName}>
        {#if project.sessions.length > 1}<div class="project-sessions"><label>Sessions ({project.sessions.length})<select aria-label={`Session in ${run.projectName}`} value={run.id} onchange={(e) => selectedSessions[project.key] = e.currentTarget.value}>{#each candidates as session}<option value={session.id}>{session.source} · {session.title} · {session.status}</option>{/each}</select></label></div>{/if}
        <RunCard {run} now={deckStore.now} animatePulse={false} waitingEscalateSeconds={300} onSelect={(id) => deckStore.setView('detail', id)} />
      </article>
    {/each}
    <TelemetryCard />
  </div>
  {#if !visible.length}<div class="deck-empty"><h2>No projects to display</h2><p>Choose another status or enable tools in Settings.</p></div>{/if}
  {#if filtered.length > 5}<button class="show-sessions" type="button" onclick={() => deckStore.showAllDone = !deckStore.showAllDone}>{deckStore.showAllDone ? 'Show fewer projects' : `Show all ${filtered.length} projects`}</button>{/if}
</section>

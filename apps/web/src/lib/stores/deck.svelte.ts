import {
  createInitialDeckState,
  computeDeckAggregates,
  type Source,
  getSortedDeckRuns,
  getDashboardSessions,
  reduceWireFrame,
  type AgentRun,
  type DeckPrefs,
  type DeckState,
  type WireFrame
} from '@agent-deck/core';

export type ViewName = 'ambient' | 'deck' | 'usage' | 'ledger' | 'detail';


class DeckClientStore {
  public state = $state<DeckState>(createInitialDeckState());
  public visibleSources = $state<Source[]>(['opencode', 'claude', 'codex', 'agy', 'pty']);
  public toggleSource(source: Source): void {
    this.visibleSources = this.visibleSources.includes(source) ? this.visibleSources.filter(s => s !== source) : [...this.visibleSources, source];
    try { localStorage.setItem('agent_deck_sources', JSON.stringify(this.visibleSources)); } catch {}
    if (this.selectedRunId && !this.visibleSources.includes(this.state.runs[this.selectedRunId]?.source)) this.backFromDetail();
  }
  public get dashboardSessions() { return getDashboardSessions(this.sortedRuns); }
  public get visibleAggregates() {
    const totals = computeDeckAggregates(Object.fromEntries(this.sortedRuns.map(r => [r.id, r])), this.state.prefs.burnRateAlarmUsdPerMin);
    const cards = computeDeckAggregates(Object.fromEntries(this.dashboardSessions.map(r => [r.id, r])), this.state.prefs.burnRateAlarmUsdPerMin);
    return { ...totals, activeCount: cards.activeCount, waitingCount: cards.waitingCount, stalledCount: cards.stalledCount, failedCount: cards.failedCount };
  }
  public activeView = $state<ViewName>('ambient');
  public previousView = $state<ViewName>('deck');
  public selectedRunId = $state<string | null>(null);
  public connectionStatus = $state<'connected' | 'reconnecting' | 'recovered'>('connected');
  public needsPairing = $state<boolean>(false);
  public now = $state<number>(Date.now());
  public pricingInfo = $state<{ version: string; updatedAt: string; tailscaleUrl?: string }>({
    version: '2026.10.1',
    updatedAt: '2026-10-23'
  });
  public pixelShift = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  public isNightDimmed = $state<boolean>(false);
  public showAllDone = $state<boolean>(false);
  public waitingAnnouncement = $state<string>('');

  private eventSource: EventSource | null = null;
  private connectionEpoch = 0;
  public loggingOut = $state(false);
  public logoutError = $state('');
  private lastEtag: string | null = null;
  private lastInteractionAt = Date.now();
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pixelShiftTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLockSentinel: WakeLockSentinel | null = null;
  private knownWaitingIds = new Set<string>();

  public get sortedRuns(): AgentRun[] {
    return getSortedDeckRuns(this.state.runs).filter(run => this.visibleSources.includes(run.source));
  }

  public get selectedRun(): AgentRun | null {
    if (!this.selectedRunId) return null;
    return this.state.runs[this.selectedRunId] ?? null;
  }

  public init(): () => void {
    if (typeof window === 'undefined') return () => {};

    try {
      const saved = JSON.parse(localStorage.getItem('agent_deck_sources') ?? 'null');
      if (Array.isArray(saved)) this.visibleSources = saved.filter((s): s is Source => ['opencode','claude','codex','agy','pty'].includes(s));
    } catch {}

    this.fetchSnapshot().then(() => {
      this.connectStream();
      if (!this.needsPairing && this.activeView === 'ambient') this.requestWakeLock();
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.fetchSnapshot().then(() => {
          if (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED) {
            this.connectStream();
          }
        });
        if (this.activeView === 'ambient') {
          this.requestWakeLock();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onInteract = () => {
      this.lastInteractionAt = Date.now();
    };
    window.addEventListener('pointerdown', onInteract, { passive: true });
    window.addEventListener('keydown', onInteract);

    this.clockTimer = setInterval(() => {
      this.now = Date.now();
      this.checkIdleAndNightSchedule();
    }, 1000);

    // Burn-in pixel shift ±6px every 10 minutes (§8.6)
    this.pixelShiftTimer = setInterval(() => {
      const dx = Math.floor(Math.random() * 13) - 6;
      const dy = Math.floor(Math.random() * 13) - 6;
      this.pixelShift = { x: dx, y: dy };
    }, 10 * 60_000);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
      if (this.clockTimer) clearInterval(this.clockTimer);
      if (this.pixelShiftTimer) clearInterval(this.pixelShiftTimer);
      if (this.eventSource) this.eventSource.close();
      this.releaseWakeLock();
    };
  }

  public setView(view: ViewName, runId?: string): void {
    if (view === 'detail' && runId) {
      if (this.activeView !== 'detail') {
        this.previousView = this.activeView;
      }
      this.selectedRunId = runId;
      this.activeView = 'detail';
      this.markRunRead(runId);
      return;
    }
    this.activeView = view;
    this.lastInteractionAt = Date.now();
    if (view === 'ambient') {
      this.requestWakeLock();
    } else {
      this.releaseWakeLock();
    }
  }

  public backFromDetail(): void {
    this.activeView = this.previousView || 'deck';
    this.selectedRunId = null;
  }

  public async fetchSnapshot(): Promise<void> {
    if (this.loggingOut) return;
    const epoch = this.connectionEpoch;
    try {
      const headers: Record<string, string> = {};
      if (this.lastEtag) {
        headers['If-None-Match'] = this.lastEtag;
      }
      const res = await fetch('/api/snapshot', { headers });
      if (epoch !== this.connectionEpoch) return;
      if (res.status === 401) {
        this.needsPairing = true;
        return;
      }
      if (res.status === 304) {
        return;
      }
      if (!res.ok) return;

      this.needsPairing = false;
      const etag = res.headers.get('ETag');
      if (etag) this.lastEtag = etag;

      const data = await res.json();
      if (epoch !== this.connectionEpoch) return;
      const runsMap: Record<string, AgentRun> = {};
      for (const r of data.runs ?? []) {
        runsMap[r.id] = r;
      }
      const adaptersMap = { ...this.state.adapters };
      for (const a of data.adapters ?? []) {
        adaptersMap[a.source as keyof typeof adaptersMap] = a;
      }

      this.state = {
        seq: data.seq ?? 0,
        runs: runsMap,
        adapters: adaptersMap,
        aggregates: data.aggregates ?? this.state.aggregates,
        prefs: data.config?.prefs ?? this.state.prefs
      };

      if (data.config) {
        this.pricingInfo = {
          version: data.config.pricingVersion ?? '2026.10.1',
          updatedAt: data.config.pricingUpdatedAt ?? '2026-10-23',
          tailscaleUrl: data.config.tailscaleUrl
        };
      }
      this.syncWaitingAnnouncements();
    } catch {
      if (epoch === this.connectionEpoch) this.connectionStatus = 'reconnecting';
    }
  }

  public connectStream(): void {
    if (typeof window === 'undefined' || this.needsPairing || this.loggingOut) return;
    if (this.eventSource) {
      this.eventSource.close();
    }

    const url = `/api/stream?lastEventId=${this.state.seq}`;
    const es = new EventSource(url);
    this.eventSource = es;
    const epoch = this.connectionEpoch;

    es.onopen = () => {
      if (epoch !== this.connectionEpoch) return;
      if (this.connectionStatus === 'reconnecting') {
        this.connectionStatus = 'recovered';
        setTimeout(() => {
          if (this.connectionStatus === 'recovered') {
            this.connectionStatus = 'connected';
          }
        }, 2500);
      } else {
        this.connectionStatus = 'connected';
      }
    };

    es.onmessage = (event) => {
      if (epoch !== this.connectionEpoch) return;
      try {
        const frame = JSON.parse(event.data) as WireFrame;
        const prevWaitingCount = this.visibleAggregates.waitingCount;
        this.state = reduceWireFrame(this.state, frame, Date.now());
        this.syncWaitingAnnouncements();

        // Instant wake from Ambient if a new attention state arrives (§14 D7)
        if (this.activeView === 'ambient' && this.visibleAggregates.waitingCount > prevWaitingCount) {
          this.setView('deck');
        }
      } catch {
        // ignore malformed frame
      }
    };

    es.onerror = async () => {
      if (epoch !== this.connectionEpoch) return;
      this.connectionStatus = 'reconnecting';
      es.close();
      // Check if 409 gap resync is needed by fetching snapshot before reconnecting
      await this.fetchSnapshot();
      setTimeout(() => {
        if (epoch === this.connectionEpoch) this.connectStream();
      }, 1500);
    };
  }

  private syncWaitingAnnouncements(): void {
    for (const run of this.sortedRuns) {
      if (run.status === 'waiting' && !this.knownWaitingIds.has(run.id)) {
        this.knownWaitingIds.add(run.id);
        this.waitingAnnouncement = `${run.source} in ${run.projectName} is waiting on you: ${run.attention?.summary ?? 'attention needed'}`;
      } else if (run.status !== 'waiting' && this.knownWaitingIds.has(run.id)) {
        this.knownWaitingIds.delete(run.id);
      }
    }
  }

  private checkIdleAndNightSchedule(): void {
    const idleSec = (this.now - this.lastInteractionAt) / 1000;
    const targetIdle = this.state.prefs.ambientIdleSeconds ?? 180;
    if (
      !this.needsPairing && this.activeView === 'deck' &&
      idleSec >= targetIdle &&
      this.visibleAggregates.waitingCount === 0
    ) {
      this.setView('ambient');
    }

    const hour = new Date(this.now).getHours();
    const startH = this.state.prefs.nightDimStartHour ?? 22;
    const endH = this.state.prefs.nightDimEndHour ?? 7;
    if (startH > endH) {
      this.isNightDimmed = hour >= startH || hour < endH;
    } else {
      this.isNightDimmed = hour >= startH && hour < endH;
    }
  }

  public async markRunRead(runId: string): Promise<void> {
    try {
      await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markReadRunId: runId })
      });
    } catch {
      // ignore
    }
  }

  public async savePrefs(partial: Partial<DeckPrefs>): Promise<void> {
    const res = await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    });
    if (res.ok) {
      const data = await res.json();
      this.state.prefs = data.prefs;
    }
  }

  public async submitPairCode(code: string): Promise<boolean> {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (res.ok) {
      this.needsPairing = false;
      this.lastEtag = null;
      this.setView('ambient');
      await this.fetchSnapshot();
      this.connectStream();
      return true;
    }
    return false;
  }

  public async logout(): Promise<void> {
    if (this.loggingOut) return;
    this.loggingOut = true;
    this.logoutError = '';
    this.connectionEpoch++;
    this.eventSource?.close();
    this.eventSource = null;
    try {
      const res = await fetch('/api/logout', { method: 'POST' });
      if (!res.ok) throw new Error('Logout failed');
      this.state = createInitialDeckState();
      this.lastEtag = null;
      this.selectedRunId = null;
      this.knownWaitingIds.clear();
      this.waitingAnnouncement = '';
      this.needsPairing = true;
      this.connectionStatus = 'connected';
      await this.releaseWakeLock();
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    } catch {
      this.logoutError = 'Could not log out. Please try again.';
    } finally {
      this.loggingOut = false;
      if (!this.needsPairing) this.connectStream();
    }
  }

  private async requestWakeLock(): Promise<void> {
    if (this.needsPairing || this.loggingOut || this.wakeLockSentinel && !this.wakeLockSentinel.released) return;
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Fallback to CSS dimming handled in Ambient view
      }
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.wakeLockSentinel) {
      try {
        await this.wakeLockSentinel.release();
      } catch {
        // ignore
      }
      this.wakeLockSentinel = null;
    }
  }
}

export const deckStore = new DeckClientStore();

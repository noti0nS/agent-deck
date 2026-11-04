import { PRICE_TABLE, setPriceTable, type ModelPriceRate, type PriceTable } from '@agent-deck/pricing';
import type { CollectorStore } from './store.js';

export const CATALOG_URL = 'https://models.dev/api.json?type=all';
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'models_dev_catalog';
interface Cache { fetchedAt: number; catalog: unknown }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const price = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function catalogPriceTable(catalog: unknown, fetchedAt: number): PriceTable {
  if (!record(catalog)) throw new Error('Invalid models.dev catalog');
  const rates: ModelPriceRate[] = [];
  const aliases = new Map<string, Array<{ provider: string; rate: ModelPriceRate }>>();
  for (const [provider, data] of Object.entries(catalog)) {
    if (!record(data) || !record(data.models)) throw new Error('Invalid models.dev provider');
    for (const [id, model] of Object.entries(data.models)) {
      if (!record(model)) throw new Error('Invalid models.dev model');
      const cost = model.cost;
      if (!record(cost) || !price(cost.input) || !price(cost.output)) continue;
      const rate: ModelPriceRate = { modelPattern: `${provider}/${id}`, inputPer1M: cost.input, outputPer1M: cost.output };
      for (const [field, target] of [['reasoning', 'reasoningPer1M'], ['cache_read', 'cacheReadPer1M'], ['cache_write', 'cacheWritePer1M']] as const) {
        if (cost[field] !== undefined && !price(cost[field])) throw new Error('Invalid models.dev price');
        if (price(cost[field])) rate[target] = cost[field];
      }
      rates.push(rate);
      aliases.set(id, [...(aliases.get(id) ?? []), { provider, rate }]);
    }
  }
  if (!rates.length) throw new Error('models.dev returned no usable prices');
  for (const [id, matches] of aliases) {
    // Prefer direct providers for unqualified CLI model IDs, never an arbitrary reseller.
    const direct = matches.filter(m => ['openai', 'anthropic', 'google'].includes(m.provider));
    const match = direct.length === 1 ? direct[0] : matches.length === 1 ? matches[0] : undefined;
    if (match) rates.push({ ...match.rate, modelPattern: id });
  }
  return { version: `models.dev:${fetchedAt}`, updatedAt: new Date(fetchedAt).toISOString(), rates };
}

export class ModelCatalogSync {
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  constructor(private store: CollectorStore, private fetcher: typeof fetch = fetch, private now = Date.now) {
    const cached = store.getSetting<Cache>(CACHE_KEY);
    setPriceTable(PRICE_TABLE);
    if (cached) {
      try { setPriceTable(catalogPriceTable(cached.catalog, cached.fetchedAt)); }
      catch { /* Invalid cache is replaced on the next successful sync. */ }
    }
  }

  sync(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async refresh(): Promise<void> {
    const now = this.now();
    const lastAttempt = this.store.getSetting<number>('models_dev_last_attempt');
    if (lastAttempt !== undefined && now >= lastAttempt && now - lastAttempt < SYNC_INTERVAL_MS) return;
    this.store.setSetting('models_dev_last_attempt', now);
    try {
      const response = await this.fetcher(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
      const catalog: unknown = await response.json();
      const fetchedAt = this.now();
      const table = catalogPriceTable(catalog, fetchedAt);
      this.store.setSetting<Cache>(CACHE_KEY, { fetchedAt, catalog });
      setPriceTable(table);
      this.store.setSetting('models_dev_last_error', null);
    } catch (error) {
      this.store.setSetting('models_dev_last_error', error instanceof Error ? error.message : String(error));
    }
  }

  start(): void {
    void this.sync();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.sync(); }, 60_000);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}

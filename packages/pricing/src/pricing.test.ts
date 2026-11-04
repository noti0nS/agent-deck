import { describe, expect, it } from 'vitest';
import { estimateApiCostUsd, findModelRate, PRICE_TABLE } from './index.js';

describe('packages/pricing', () => {
  it('exposes versioned price table with updatedAt', () => {
    expect(PRICE_TABLE.version).toBe('2026.10.1');
    expect(PRICE_TABLE.updatedAt).toBe('2026-10-23');
    expect(PRICE_TABLE.rates.length).toBeGreaterThan(5);
  });

  it('matches known model families and computes API-equivalent cost', () => {
    const sonnetRate = findModelRate('anthropic/claude-sonnet-4-20250514');
    expect(sonnetRate!.inputPer1M).toBe(3.0);
    expect(sonnetRate!.outputPer1M).toBe(15.0);

    const cost = estimateApiCostUsd('claude-sonnet-4', {
      tokensIn: 100_000,
      tokensOut: 10_000,
      cacheRead: 50_000
    });
    // 0.1 * 3.0 + 0.01 * 15.0 + 0.05 * 0.3 = 0.30 + 0.15 + 0.015 = 0.465
    expect(cost).toBeCloseTo(0.465, 5);
  });
});

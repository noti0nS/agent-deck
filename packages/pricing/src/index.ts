export interface ModelPriceRate {
  modelPattern: string;
  inputPer1M: number;       // USD per 1M input tokens
  outputPer1M: number;      // USD per 1M output tokens
  reasoningPer1M?: number;  // USD per 1M reasoning tokens
  cacheReadPer1M?: number;  // USD per 1M cached input tokens
  cacheWritePer1M?: number; // USD per 1M cache write tokens
}

export interface PriceTable {
  version: string;
  updatedAt: string;
  rates: ModelPriceRate[];
}

export const PRICE_TABLE: PriceTable = {
  version: '2026.10.1',
  updatedAt: '2026-10-23',
  rates: [
    // Anthropic Claude 4 / 3.7 / 3.5 families
    { modelPattern: 'claude-opus-4', inputPer1M: 15.0, outputPer1M: 75.0, cacheReadPer1M: 1.5, cacheWritePer1M: 18.75 },
    { modelPattern: 'claude-sonnet-4', inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
    { modelPattern: 'claude-3-7-sonnet', inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
    { modelPattern: 'claude-3-5-sonnet', inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
    { modelPattern: 'claude-haiku-4', inputPer1M: 0.8, outputPer1M: 4.0, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0 },
    { modelPattern: 'claude-3-5-haiku', inputPer1M: 0.8, outputPer1M: 4.0, cacheReadPer1M: 0.08, cacheWritePer1M: 1.0 },
    // OpenAI / Codex models
    { modelPattern: 'gpt-5', inputPer1M: 2.5, outputPer1M: 10.0, reasoningPer1M: 10.0, cacheReadPer1M: 0.25 },
    { modelPattern: 'codex-mini', inputPer1M: 1.5, outputPer1M: 6.0, reasoningPer1M: 6.0, cacheReadPer1M: 0.375 },
    { modelPattern: 'o3', inputPer1M: 2.0, outputPer1M: 8.0, reasoningPer1M: 8.0, cacheReadPer1M: 0.5 },
    { modelPattern: 'o4-mini', inputPer1M: 1.1, outputPer1M: 4.4, reasoningPer1M: 4.4, cacheReadPer1M: 0.275 },
    { modelPattern: 'gpt-4.1', inputPer1M: 2.0, outputPer1M: 8.0, cacheReadPer1M: 0.5 },
    { modelPattern: 'gpt-4o', inputPer1M: 2.5, outputPer1M: 10.0, cacheReadPer1M: 1.25 },
    // Google Gemini 4 / 3 / 2.5 families
    { modelPattern: 'gemini-4', inputPer1M: 1.25, outputPer1M: 10.0, reasoningPer1M: 10.0, cacheReadPer1M: 0.31 },
    { modelPattern: 'gemini-3', inputPer1M: 1.25, outputPer1M: 10.0, reasoningPer1M: 10.0, cacheReadPer1M: 0.31 },
    { modelPattern: 'gemini-2.5-pro', inputPer1M: 1.25, outputPer1M: 10.0, reasoningPer1M: 10.0, cacheReadPer1M: 0.31 },
    { modelPattern: 'gemini-2.5-flash', inputPer1M: 0.15, outputPer1M: 0.60, reasoningPer1M: 3.5, cacheReadPer1M: 0.0375 }
  ]
};

let activePriceTable = PRICE_TABLE;
export function setPriceTable(table: PriceTable): void { activePriceTable = table; }
export function getPriceTable(): PriceTable { return activePriceTable; }

export function findModelRate(model: string, table: PriceTable = activePriceTable): ModelPriceRate | undefined {
  const lower = (model || '').toLowerCase();
  const exact = table.rates.find(rate => rate.modelPattern.toLowerCase() === lower);
  if (exact) return exact;
  for (const rate of table.rates) {
    if (table === PRICE_TABLE && lower.includes(rate.modelPattern.toLowerCase())) {
      return rate;
    }
  }
  return undefined;
}

export interface TokenCountInput {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputIncludesCache?: boolean;
  outputIncludesReasoning?: boolean;
}

/**
 * Computes counterfactual API-equivalent cost in USD (`est. API-rate`)
 * from token counts using the versioned price table.
 */
export function estimateApiCostUsd(
  model: string,
  tokens: TokenCountInput,
  table: PriceTable = activePriceTable
): number | undefined {
  const rate = findModelRate(model, table);
  if (!rate) return undefined;
  const input = tokens.tokensIn - (tokens.inputIncludesCache ? (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) : 0);
  const output = tokens.tokensOut - (tokens.outputIncludesReasoning ? tokens.tokensReasoning ?? 0 : 0);
  const inCost = (Math.max(0, input) / 1_000_000) * rate.inputPer1M;
  const outCost = (Math.max(0, output) / 1_000_000) * rate.outputPer1M;
  const reasonCost =
    (Math.max(0, tokens.tokensReasoning ?? 0) / 1_000_000) * (rate.reasoningPer1M ?? rate.outputPer1M);
  const cacheReadCost =
    (Math.max(0, tokens.cacheRead ?? 0) / 1_000_000) * (rate.cacheReadPer1M ?? rate.inputPer1M * 0.1);
  const cacheWriteCost =
    (Math.max(0, tokens.cacheWrite ?? 0) / 1_000_000) * (rate.cacheWritePer1M ?? rate.inputPer1M * 1.25);

  return Number((inCost + outCost + reasonCost + cacheReadCost + cacheWriteCost).toFixed(6));
}

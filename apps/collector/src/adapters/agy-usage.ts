import { estimateApiCostUsd, findModelRate } from '@agent-deck/pricing';

export interface AgyUsage {
  model?: string;
  modelName?: string;
  responseId?: string;
  ts?: number;
  tokensIn: number;
  tokensOut: number; // Response only; reasoning is counted separately.
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

type Field = { number: number; wire: number; value?: bigint; bytes?: Buffer };

/** Bounded protobuf wire reader. Unknown fields are skipped, not interpreted as text. */
function fields(data: Buffer): Field[] {
  let offset = 0;
  const result: Field[] = [];
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new Error('Truncated protobuf varint');
      const byte = data[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        if (value > 0xffffffffffffffffn) throw new Error('Invalid protobuf integer');
        return value;
      }
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < data.length) {
    const tag = Number(varint());
    const number = Math.floor(tag / 8), wire = tag % 8;
    if (number < 1 || number > 536_870_911 || result.length >= 100_000) throw new Error('Invalid protobuf field');
    if (wire === 0) result.push({ number, wire, value: varint() });
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || length > data.length - offset) throw new Error('Invalid protobuf length');
      result.push({ number, wire, bytes: data.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return result;
}

function nested(parent: Field[], number: number): Field[] {
  const field = parent.find(f => f.number === number);
  if (!field) return [];
  if (field.wire !== 2) throw new Error('Invalid protobuf message');
  return fields(field.bytes!);
}

function count(parent: Field[], number: number): number {
  const field = parent.find(f => f.number === number);
  if (!field) return 0; // Proto3 omits zero-valued counters.
  if (field.wire !== 0) throw new Error('Invalid protobuf counter');
  if (field.value! > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe protobuf counter');
  return Number(field.value!);
}

function text(parent: Field[], number: number): string | undefined {
  const field = parent.find(f => f.number === number);
  if (!field || field.wire !== 2 || !field.bytes?.length || field.bytes.length > 256) return undefined;
  const value = field.bytes.toString('utf8');
  return /[\x00-\x1f\x7f\ufffd]/.test(value) ? undefined : value;
}

function output(total: number | undefined, reasoning: number, response: number): number {
  if (total === undefined) return response;
  if (reasoning > total) throw new Error('Invalid reasoning token count');
  return total - reasoning;
}

/** gen_metadata: chatModel #1 -> ModelUsageStats #4. See docs/agy-usage.md. */
export function decodeAgyUsageBlob(blob: Buffer | string | null | undefined): AgyUsage | null {
  if (!blob || Buffer.byteLength(blob) > 16 * 1024 * 1024) return null;
  try {
    const data = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (data.toString('utf8', 0, Math.min(data.length, 32)).trimStart().startsWith('{')) {
      const json = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (typeof json.input_tokens !== 'number' || typeof json.output_tokens !== 'number') return null;
      const read = (key: string): number => {
        const value = json[key] ?? 0;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid JSON token count');
        return value;
      };
      const reasoning = read('thinking_output_tokens');
      return {
        model: typeof json.model === 'string' ? json.model : undefined,
        tokensIn: read('input_tokens'), tokensOut: output(read('output_tokens'), reasoning, 0),
        tokensReasoning: reasoning, cacheRead: read('cache_read_tokens'), cacheWrite: read('cache_write_tokens')
      };
    }
    const root = fields(data);
    const chat = nested(root, 1);
    const usage = nested(chat, 4);
    if (!usage.some(f => [2, 3, 4, 5, 9, 10].includes(f.number))) return null;
    const reasoning = count(usage, 9);
    const timestamp = nested(nested(chat, 9), 4);
    const seconds = count(timestamp, 1), nanos = count(timestamp, 2);
    const ts = seconds * 1000 + Math.floor(nanos / 1_000_000);
    return {
      model: text(chat, 19), modelName: text(chat, 21), responseId: text(usage, 11),
      ts: seconds > 0 && nanos < 1_000_000_000 && Number.isSafeInteger(ts) && ts <= 8.64e15 ? ts : undefined,
      tokensIn: count(usage, 2),
      tokensOut: output(usage.some(f => f.number === 3) ? count(usage, 3) : undefined, reasoning, count(usage, 10)),
      tokensReasoning: reasoning, cacheRead: count(usage, 5), cacheWrite: count(usage, 4)
    };
  } catch { return null; }
}

/** Resolve AGY's effort/config IDs to catalog IDs, without mapping opaque model placeholders. */
export function priceAgyUsage(usage: AgyUsage, fallbackModel?: string): { model: string; cost?: number } {
  const raw = usage.model || fallbackModel || 'unknown';
  const candidates = [raw];
  if (/^claude-/.test(raw)) candidates.push(raw.replace(/-(?:low|medium|high|thinking)$/, ''));
  if (/^gemini-/.test(raw)) candidates.push(raw.replace(/-(?:n|trial|low|medium|high)$/, ''));
  // Older records may expose only a readable model name alongside an opaque config ID.
  const display = usage.modelName?.match(/^(Claude (?:Opus|Sonnet|Haiku)|Gemini) (\d+(?:\.\d+)*)(?: (Pro|Flash(?: Lite)?))?(?: \((?:Low|Medium|High|Thinking)\))?$/i);
  if (display) candidates.push(`${display[1].toLowerCase().replaceAll(' ', '-')}-${display[1].toLowerCase().startsWith('claude') ? display[2].replaceAll('.', '-') : display[2]}${display[3] ? `-${display[3].toLowerCase().replaceAll(' ', '-')}` : ''}`);
  for (const model of candidates) {
    if (findModelRate(model)) return { model, cost: estimateApiCostUsd(model, usage) };
  }
  return { model: raw };
}

import type { Envelope } from '@agent-deck/core';

export class RingBuffer {
  private readonly capacity: number;
  private readonly buffer: Envelope[] = [];

  constructor(capacity = 5000) {
    this.capacity = capacity;
  }

  public push(envelope: Envelope): void {
    this.buffer.push(envelope);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  public getLatestSeq(): number {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].seq : 0;
  }

  public getOldestSeq(): number {
    return this.buffer.length > 0 ? this.buffer[0].seq : 0;
  }

  /**
   * Returns `{ status: 'ok', envelopes }` if `lastEventId` can be replayed without a gap,
   * or `{ status: 'gap' }` if `lastEventId` is older than the ring buffer's oldest entry.
   */
  public getReplaySince(lastEventId: number): { status: 'ok'; envelopes: Envelope[] } | { status: 'gap' } {
    if (this.buffer.length === 0) {
      return lastEventId > 0 ? { status: 'gap' } : { status: 'ok', envelopes: [] };
    }
    const oldest = this.buffer[0].seq;
    const latest = this.buffer[this.buffer.length - 1].seq;

    if (lastEventId >= latest) {
      return { status: 'ok', envelopes: [] };
    }
    if (lastEventId < oldest - 1) {
      return { status: 'gap' };
    }

    const envelopes = this.buffer.filter((e) => e.seq > lastEventId);
    return { status: 'ok', envelopes };
  }

  public size(): number {
    return this.buffer.length;
  }
}

import type {
  AdapterHealth,
  Capabilities,
  EventType,
  Source
} from '@agent-deck/core';

export interface EmitEventInput {
  type: EventType;
  runId?: string;
  payload: unknown;
  ts?: number;
}

export interface AdapterContext {
  emit(event: EmitEventInput): void;
  reportHealth(health: AdapterHealth): void;
  getSetting<T>(key: string): T | undefined;
  setSetting<T>(key: string, value: T): void;
}

/**
 * Strictly read-only Adapter SPI (§5.1).
 * Intentionally has NO mutation methods (cannot approve, prompt, or kill any agent).
 */
export interface Adapter {
  readonly source: Source;
  probe(): Promise<Capabilities>;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
}

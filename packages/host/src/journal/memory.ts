import type { JournalEvent, JournalReadResult, JournalStore } from "@auto-pi-lot/core";

export interface MemoryJournalOptions {
  /** Test hook, called before an event is stored. Throwing simulates a persistence failure. */
  readonly beforeAppend?: (event: JournalEvent) => void;
}

/**
 * In-memory journal store. Events are deep-copied on the way in and out, so a caller can never
 * mutate what was "persisted". It models a durable store for tests; nothing survives the process.
 */
export class MemoryJournalStore implements JournalStore {
  /** Every successful append across all runs, in global order. */
  readonly appended: JournalEvent[] = [];
  readonly #runs = new Map<string, JournalEvent[]>();
  readonly #beforeAppend: ((event: JournalEvent) => void) | undefined;

  constructor(options: MemoryJournalOptions = {}) {
    this.#beforeAppend = options.beforeAppend;
  }

  async append(event: JournalEvent): Promise<void> {
    this.#beforeAppend?.(event);
    const stored = structuredClone(event);
    const log = this.#runs.get(stored.runId);
    if (log === undefined) this.#runs.set(stored.runId, [stored]);
    else log.push(stored);
    this.appended.push(structuredClone(event));
  }

  async read(runId: string): Promise<JournalReadResult> {
    return { events: (this.#runs.get(runId) ?? []).map((event) => structuredClone(event)), tornTail: false };
  }
}

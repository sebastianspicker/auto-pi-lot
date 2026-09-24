import { decide, type Rejection } from "./decide.js";
import type { JournalEvent } from "./events.js";
import { initialState, type RunState } from "./state.js";

export interface ReplayRejection {
  readonly eventId: string;
  readonly rejection: Rejection;
}

export interface ReplayResult {
  readonly state: RunState;
  readonly rejections: readonly ReplayRejection[];
}

/**
 * Folds `decide` over a committed event log. This is the same code path recovery uses to
 * rebuild a run's state: replaying an accepted log never re-derives a different state than
 * the live run that produced it (an invariant the simulation checks every step).
 */
export function replay(events: readonly JournalEvent[], from: RunState = initialState()): ReplayResult {
  let state = from;
  const rejections: ReplayRejection[] = [];
  for (const event of events) {
    const result = decide(state, event);
    state = result.state;
    if (result.rejection !== undefined) rejections.push({ eventId: event.eventId, rejection: result.rejection });
  }
  return { state, rejections };
}

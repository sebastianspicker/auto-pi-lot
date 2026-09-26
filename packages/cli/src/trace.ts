import {
  type Command,
  canonicalJson,
  type DispatchCommand,
  decide,
  type ExecutionState,
  type FailureCategory,
  type GraphSpec,
  initialState,
  type JournalEvent,
  type ResultDisposition,
  type RunPolicy,
  type RunState,
  replay,
} from "@auto-pi-lot/core";

import { demoGraphInput } from "./demo.js";

/** Fixed start of the deterministic clock every scenario's events are stamped with. */
const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

/** One node's state as shown in a trace step, taken after that step applied. */
interface NodeSnapshot {
  readonly execution: ExecutionState;
  readonly disposition: ResultDisposition | null;
  readonly attemptCount: number;
  readonly failureCategory: FailureCategory | null;
  readonly activeAttemptId: string | null;
}

interface StepTrace {
  readonly index: number;
  readonly note: string;
  readonly event: JournalEvent;
  readonly outcome: "applied" | "rejected";
  readonly rejection: { readonly code: string; readonly message: string } | null;
  readonly commands: readonly Command[];
  readonly run: { readonly status: string; readonly permitsInUse: number };
  readonly nodes: Readonly<Record<string, NodeSnapshot>>;
}

interface ScenarioTrace {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly graph: GraphSpec;
  readonly policy: RunPolicy;
  readonly steps: readonly StepTrace[];
  readonly finalStatus: "succeeded" | "failed" | "cancelled";
  readonly replayMatches: boolean;
}

export interface TraceOutput {
  readonly generator: "auto-pi-lot trace";
  readonly formatVersion: 1;
  readonly scenarios: readonly ScenarioTrace[];
}

/**
 * A scripted host action: builds the next event to send through `decide`, using the
 * scenario's own dispatch history for attempt ids and fencing tokens the reducer assigned
 * (an action never hard-codes them). `expect` makes scenario drift fail loudly instead of
 * silently producing a different trace than the one described.
 */
interface Action {
  readonly note: string;
  readonly expect: "applied" | "rejected";
  readonly build: (ctx: ScenarioContext) => JournalEvent;
}

/**
 * Builds deterministic journal events for one scenario (fixed ids, fixed clock) and keeps the
 * list of `dispatch` commands the reducer has emitted so far, so later actions can refer to
 * "the latest dispatch for node X" — or an earlier one, e.g. an attempt that has since been
 * retried — to get its reducer-assigned attempt id and fencing token.
 */
class ScenarioContext {
  private readonly scenarioId: string;
  private readonly runId: string;
  private counter = 0;
  private readonly dispatchesByNode = new Map<string, DispatchCommand[]>();

  constructor(scenarioId: string, runId: string) {
    this.scenarioId = scenarioId;
    this.runId = runId;
  }

  recordCommands(commands: readonly Command[]): void {
    for (const command of commands) {
      if (command.type !== "dispatch") continue;
      const history = this.dispatchesByNode.get(command.nodeId) ?? [];
      this.dispatchesByNode.set(command.nodeId, [...history, command]);
    }
  }

  /** The most recent reducer-assigned dispatch for a node: its current attempt id and fencing token. */
  dispatchFor(nodeId: string): DispatchCommand {
    const history = this.dispatchesByNode.get(nodeId);
    const dispatch = history?.[history.length - 1];
    if (dispatch === undefined) throw new Error(`No dispatch recorded yet for node "${nodeId}"`);
    return dispatch;
  }

  /** The Nth (1-based) dispatch the reducer issued for a node, e.g. an attempt since retried. */
  dispatchNumberFor(nodeId: string, attemptNumber: number): DispatchCommand {
    const dispatch = this.dispatchesByNode.get(nodeId)?.[attemptNumber - 1];
    if (dispatch === undefined) throw new Error(`No dispatch #${attemptNumber} recorded yet for node "${nodeId}"`);
    return dispatch;
  }

  private base() {
    this.counter += 1;
    const at = new Date(BASE_TIME + (this.counter - 1) * 1000).toISOString();
    return { schemaVersion: 1 as const, eventId: `${this.scenarioId}-e${this.counter}`, runId: this.runId, at };
  }

  runStarted(graph: GraphSpec, policy: RunPolicy): JournalEvent {
    return { type: "run_started", ...this.base(), graph, policy };
  }

  attemptDispatched(nodeId: string, attemptId: string, fencingToken: number): JournalEvent {
    return { type: "attempt_dispatched", ...this.base(), nodeId, attemptId, fencingToken };
  }

  resultProposed(attemptId: string, fencingToken: number, proposalDigest = "sha256:proposal"): JournalEvent {
    return { type: "result_proposed", ...this.base(), attemptId, fencingToken, proposalDigest };
  }

  acceptanceDecided(
    nodeId: string,
    attemptId: string,
    decision: "accepted" | "rejected",
    receiptIds: readonly string[],
  ): JournalEvent {
    return { type: "acceptance_decided", ...this.base(), nodeId, attemptId, decision, receiptIds: [...receiptIds] };
  }

  attemptFailed(attemptId: string, fencingToken: number, category: FailureCategory): JournalEvent {
    return { type: "attempt_failed", ...this.base(), attemptId, fencingToken, category };
  }

  cancelRequested(reason: string): JournalEvent {
    return { type: "cancel_requested", ...this.base(), reason };
  }

  attemptStopped(attemptId: string): JournalEvent {
    return { type: "attempt_stopped", ...this.base(), attemptId };
  }
}

function snapshotNodes(state: RunState): Record<string, NodeSnapshot> {
  const nodes: Record<string, NodeSnapshot> = {};
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    nodes[nodeId] = {
      execution: node.execution,
      disposition: node.disposition,
      attemptCount: node.attemptCount,
      failureCategory: node.failureCategory,
      activeAttemptId: node.activeAttemptId,
    };
  }
  return nodes;
}

/**
 * Runs one scripted host scenario through the real `decide` reducer, recording every step
 * (applied or rejected), then checks that `replay` over the applied events reproduces the
 * same live final state.
 */
function runScenario(params: {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly graph: GraphSpec;
  readonly policy: RunPolicy;
  readonly actions: readonly Action[];
}): ScenarioTrace {
  const ctx = new ScenarioContext(params.id, params.graph.runId);
  let state: RunState = initialState();
  const appliedEvents: JournalEvent[] = [];
  const steps: StepTrace[] = [];

  params.actions.forEach((action, index) => {
    const event = action.build(ctx);
    const result = decide(state, event);
    const outcome: "applied" | "rejected" = result.rejection === undefined ? "applied" : "rejected";
    if (outcome !== action.expect) {
      const reason = result.rejection === undefined ? "" : ` (${result.rejection.code}: ${result.rejection.message})`;
      throw new Error(
        `scenario "${params.id}" step ${index} (${event.type}): expected ${action.expect} but got ${outcome}${reason}`,
      );
    }
    if (outcome === "applied") {
      state = result.state;
      appliedEvents.push(event);
      ctx.recordCommands(result.commands);
    }
    steps.push({
      index,
      note: action.note,
      event,
      outcome,
      rejection: result.rejection ?? null,
      commands: result.commands,
      run: { status: state.status, permitsInUse: state.permitsInUse },
      nodes: snapshotNodes(state),
    });
  });

  const status = state.status;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    throw new Error(`scenario "${params.id}" ended at a non-terminal status: ${status}`);
  }

  const replayed = replay(appliedEvents);
  const replayMatches = canonicalJson(replayed.state) === canonicalJson(state);

  return {
    id: params.id,
    title: params.title,
    summary: params.summary,
    graph: params.graph,
    policy: params.policy,
    steps,
    finalStatus: status,
    replayMatches,
  };
}

// ---------------------------------------------------------------------------------------
// Scenario 1: happy-path. implement -> verify (result_ready) -> review (accepted), all the
// way to a succeeded run, using the same graph the `demo` command prints.
// ---------------------------------------------------------------------------------------

function happyPathScenario(): ScenarioTrace {
  const graph = demoGraphInput;
  const policy: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };

  const actions: Action[] = [
    {
      note: "The host starts the run. implement doesn't depend on anything, so the reducer dispatches it straight away.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "The host reports that implement's attempt has started.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "implement proposes a result. verify can start now: it only needs a result from implement, not an accepted one.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "verify's attempt starts. The host hasn't decided yet whether to accept implement's result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.attemptDispatched("verify", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts implement's result and cites a check receipt. review still waits: it needs verify's result to be accepted, not implement's.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", d.attemptId, "accepted", ["check-implement-1"]);
      },
    },
    {
      note: "verify proposes a result. review still waits, because it needs that result accepted.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts verify's result, so the reducer dispatches review.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.acceptanceDecided("verify", d.attemptId, "accepted", ["check-verify-1"]);
      },
    },
    {
      note: "review's attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("review");
        return ctx.attemptDispatched("review", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "review proposes a result. Once the host decides on it, the run is over.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("review");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts review's result. All three tasks are accepted, so the run ends as succeeded.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("review");
        return ctx.acceptanceDecided("review", d.attemptId, "accepted", ["review-review-1"]);
      },
    },
  ];

  return runScenario({
    id: "happy-path",
    title: "Happy path: implement, verify, review",
    summary:
      "Three tasks in a row. verify starts as soon as implement has a result, before anyone has accepted it. review waits until verify's result is accepted.",
    graph,
    policy,
    actions,
  });
}

// ---------------------------------------------------------------------------------------
// Scenario 2: retry-and-fencing. implement's first attempt crashes and its retry is rejected
// once before a third attempt is accepted, exercising fencing tokens against a late result
// from the dead first attempt and a spoofed token on the retry.
// ---------------------------------------------------------------------------------------

const retryGraph: GraphSpec = {
  schemaVersion: 1,
  id: "retry-and-fencing-graph",
  runId: "retry-and-fencing-run",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "implement",
      role: "implementer",
      objective: "Produce the requested patch",
      acceptanceCriteria: ["Patch meets the task contract"],
      limits: { maxTokens: 8000, maxToolCalls: 40 },
    },
    {
      id: "downstream",
      role: "verifier",
      objective: "Consume implement's accepted result",
      acceptanceCriteria: ["Downstream check passes against the accepted candidate"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
  ],
  edges: [{ from: "implement", to: "downstream", condition: "accepted" }],
};

function retryAndFencingScenario(): ScenarioTrace {
  const graph = retryGraph;
  const policy: RunPolicy = { maxConcurrent: 1, maxAttemptsPerNode: 3 };

  const actions: Action[] = [
    {
      note: "The host starts the run with room for one attempt at a time. implement is the only task that can start, so the reducer dispatches its first attempt.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "implement's first attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The first attempt crashes. implement has attempts left, so the reducer schedules a retry with a new attempt ID and a higher fencing token.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptFailed(d.attemptId, d.fencingToken, "worker_crashed");
      },
    },
    {
      note: "The retry starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "A late result arrives from the first attempt, which already crashed. The reducer doesn't mistake it for the retry's result and rejects it as invalid_transition.",
      expect: "rejected",
      build: (ctx) => {
        const first = ctx.dispatchNumberFor("implement", 1);
        return ctx.resultProposed(first.attemptId, first.fencingToken);
      },
    },
    {
      note: "A result for the retry arrives with the wrong fencing token. The reducer rejects it as stale_fencing_token instead of guessing where it came from.",
      expect: "rejected",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.resultProposed(retryAttempt.attemptId, retryAttempt.fencingToken + 1000);
      },
    },
    {
      note: "The retry proposes a result with the right attempt ID and token. Now the host has to decide whether to accept it.",
      expect: "applied",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.resultProposed(retryAttempt.attemptId, retryAttempt.fencingToken);
      },
    },
    {
      note: "The host rejects the retry's result. implement has one attempt left, so the reducer schedules a third.",
      expect: "applied",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", retryAttempt.attemptId, "rejected", []);
      },
    },
    {
      note: "implement's third and last attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The third attempt proposes a result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts implement's result. downstream was waiting for that, so the reducer dispatches it.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", d.attemptId, "accepted", ["check-implement-3"]);
      },
    },
    {
      note: "downstream's attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.attemptDispatched("downstream", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "downstream proposes a result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts downstream's result. Both tasks are accepted, so the run ends as succeeded.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.acceptanceDecided("downstream", d.attemptId, "accepted", ["check-downstream-1"]);
      },
    },
  ];

  return runScenario({
    id: "retry-and-fencing",
    title: "Retry and fencing: a crash, a late result and a wrong token",
    summary:
      "implement's first attempt crashes and the host rejects the second attempt's result, so it takes three tries. Along the way the reducer turns away a late result from the crashed attempt and a result with the wrong fencing token.",
    graph,
    policy,
    actions,
  });
}

// ---------------------------------------------------------------------------------------
// Scenario 3: cancellation. Two independent nodes feed a dependent; the operator cancels
// mid-run while one attempt is still running and the other's acceptance is outstanding.
// ---------------------------------------------------------------------------------------

const cancellationGraph: GraphSpec = {
  schemaVersion: 1,
  id: "cancellation-graph",
  runId: "cancellation-run",
  depth: 0,
  revision: 1,
  nodes: [
    {
      id: "lint",
      role: "verifier",
      objective: "Lint the candidate changes",
      acceptanceCriteria: ["Lint passes with no errors"],
      limits: { maxTokens: 2000, maxToolCalls: 10 },
    },
    {
      id: "test",
      role: "verifier",
      objective: "Run the automated test suite",
      acceptanceCriteria: ["Tests pass against the candidate changes"],
      limits: { maxTokens: 4000, maxToolCalls: 20 },
    },
    {
      id: "package",
      role: "integrator",
      objective: "Package the accepted, verified changes",
      acceptanceCriteria: ["Lint and tests are both accepted before packaging"],
      limits: { maxTokens: 2000, maxToolCalls: 10 },
    },
  ],
  edges: [
    { from: "lint", to: "package", condition: "accepted" },
    { from: "test", to: "package", condition: "accepted" },
  ],
};

function cancellationScenario(): ScenarioTrace {
  const graph = cancellationGraph;
  const policy: RunPolicy = { maxConcurrent: 2, maxAttemptsPerNode: 2 };

  const actions: Action[] = [
    {
      note: "The host starts the run with room for two attempts at a time. lint and test don't depend on anything, so both are dispatched.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "lint's attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.attemptDispatched("lint", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "test's attempt starts.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("test");
        return ctx.attemptDispatched("test", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "lint proposes a result. The host hasn't decided on it yet when the operator cancels.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The operator cancels the run. The reducer tells the host to stop test's attempt and cancels package, which hadn't started. lint's result still needs an answer. Nothing new is dispatched.",
      expect: "applied",
      build: (ctx) => ctx.cancelRequested("operator requested cancellation"),
    },
    {
      note: "test's attempt confirms that it stopped. The run can't finish cancelling yet, because lint's result is still waiting for a decision.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("test");
        return ctx.attemptStopped(d.attemptId);
      },
    },
    {
      note: "The host rejects lint's result. Nothing is running and no decisions are open, so the run ends as cancelled.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.acceptanceDecided("lint", d.attemptId, "rejected", []);
      },
    },
    {
      note: "A decision on lint arrives after the run has already ended. The reducer rejects it as run_terminal and changes nothing.",
      expect: "rejected",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.acceptanceDecided("lint", d.attemptId, "accepted", ["late-check"]);
      },
    },
  ];

  return runScenario({
    id: "cancellation",
    title: "Cancellation: an operator stops the run",
    summary:
      "lint and test are running when the operator cancels. The reducer stops test, cancels package before it starts, and marks the run cancelled only after the host has answered lint's result.",
    graph,
    policy,
    actions,
  });
}

// ---------------------------------------------------------------------------------------

export function buildTrace(): TraceOutput {
  return {
    generator: "auto-pi-lot trace",
    formatVersion: 1,
    scenarios: [happyPathScenario(), retryAndFencingScenario(), cancellationScenario()],
  };
}

/** Prints the trace JSON (2-space indent, trailing newline) for the static viewer to replay. */
export function runTrace(): void {
  console.log(JSON.stringify(buildTrace(), null, 2));
}

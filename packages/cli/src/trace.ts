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
      note: "The host starts the run under the policy above; the reducer immediately reserves and dispatches the only ready node, implement.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "The host persists implement's dispatch intent before launching its worker.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "Implement proposes a result. Verify becomes dispatchable immediately on the result_ready edge, even though implement's disposition is still unverified. That is what a result_ready edge is for.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host dispatches verify's attempt while implement's own acceptance decision is still outstanding.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.attemptDispatched("verify", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host's acceptance gate accepts implement's proposal, citing a check receipt. Review stays blocked: it depends on verify's acceptance, not implement's.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", d.attemptId, "accepted", ["check-implement-1"]);
      },
    },
    {
      note: "Verify proposes its result. Review is not dispatched yet because it needs verify's acceptance, not merely its result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts verify's result. Review, which was waiting on verify's acceptance, is now dispatched.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("verify");
        return ctx.acceptanceDecided("verify", d.attemptId, "accepted", ["check-verify-1"]);
      },
    },
    {
      note: "The host dispatches review's attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("review");
        return ctx.attemptDispatched("review", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "Review proposes its result; only its own acceptance decision remains before the run can finish.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("review");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts review's result. Every node is now accepted, so the run completes with status succeeded.",
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
      "A three-node pipeline runs end to end: verify starts on implement's unverified result, and review waits for verify's acceptance before it starts.",
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
      note: "The host starts the run under maxConcurrent 1; implement is the only ready node and its first attempt dispatches.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "The host dispatches implement's first attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "Implement's first attempt crashes. It has not used its attempt budget yet, so the reducer reserves a retry under a new attempt id and a higher fencing token.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptFailed(d.attemptId, d.fencingToken, "worker_crashed");
      },
    },
    {
      note: "The host dispatches the retry attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "A late result from the crashed first attempt arrives after the retry already started. Attempt ids are never reused, so the reducer rejects it as invalid_transition rather than treating it as the retry's outcome.",
      expect: "rejected",
      build: (ctx) => {
        const first = ctx.dispatchNumberFor("implement", 1);
        return ctx.resultProposed(first.attemptId, first.fencingToken);
      },
    },
    {
      note: "A result for the retry attempt arrives with the wrong fencing token. The reducer rejects it outright with stale_fencing_token instead of guessing which attempt it belongs to.",
      expect: "rejected",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.resultProposed(retryAttempt.attemptId, retryAttempt.fencingToken + 1000);
      },
    },
    {
      note: "The retry proposes its result with the correct attempt id and fencing token; only its acceptance decision remains.",
      expect: "applied",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.resultProposed(retryAttempt.attemptId, retryAttempt.fencingToken);
      },
    },
    {
      note: "The host's acceptance gate rejects the retry's result. Implement still has attempt budget left, so the reducer reserves a third attempt instead of exhausting the node.",
      expect: "applied",
      build: (ctx) => {
        const retryAttempt = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", retryAttempt.attemptId, "rejected", []);
      },
    },
    {
      note: "The host dispatches implement's third and final attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.attemptDispatched("implement", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The third attempt proposes its result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts implement's result. Downstream, which needed implement's acceptance, is now dispatched.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("implement");
        return ctx.acceptanceDecided("implement", d.attemptId, "accepted", ["check-implement-3"]);
      },
    },
    {
      note: "The host dispatches downstream's attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.attemptDispatched("downstream", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "Downstream proposes its result.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host accepts downstream's result. Every node is now accepted, so the run completes with status succeeded.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("downstream");
        return ctx.acceptanceDecided("downstream", d.attemptId, "accepted", ["check-downstream-1"]);
      },
    },
  ];

  return runScenario({
    id: "retry-and-fencing",
    title: "Retry and fencing: a crashed attempt, a stale result, and a rejected retry",
    summary:
      "Implement's first attempt crashes and its retry is rejected once before a third attempt succeeds, exercising the reducer's fencing tokens against a late result from the dead first attempt and a spoofed token on the retry.",
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
      note: "The host starts the run under maxConcurrent 2. Lint and test are two independent root nodes, so both dispatch immediately.",
      expect: "applied",
      build: (ctx) => ctx.runStarted(graph, policy),
    },
    {
      note: "The host dispatches lint's attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.attemptDispatched("lint", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The host dispatches test's attempt.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("test");
        return ctx.attemptDispatched("test", d.attemptId, d.fencingToken);
      },
    },
    {
      note: "Lint proposes a result; its acceptance decision is still outstanding when the operator cancels the run.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.resultProposed(d.attemptId, d.fencingToken);
      },
    },
    {
      note: "The operator requests cancellation. The reducer emits cancel_attempt for the still-running test attempt and cancels the pending package node outright; lint's outstanding acceptance is left to be answered separately. No new dispatch appears.",
      expect: "applied",
      build: (ctx) => ctx.cancelRequested("operator requested cancellation"),
    },
    {
      note: "The running test attempt confirms it stopped. The run stays cancelling because lint's acceptance decision is still outstanding.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("test");
        return ctx.attemptStopped(d.attemptId);
      },
    },
    {
      note: "The host answers lint's outstanding acceptance as rejected. With no permits held and no outstanding acceptance left, the run becomes cancelled.",
      expect: "applied",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.acceptanceDecided("lint", d.attemptId, "rejected", []);
      },
    },
    {
      note: "A late acceptance decision arrives after the run is already terminal; the reducer rejects it as run_terminal without touching state.",
      expect: "rejected",
      build: (ctx) => {
        const d = ctx.dispatchFor("lint");
        return ctx.acceptanceDecided("lint", d.attemptId, "accepted", ["late-check"]);
      },
    },
  ];

  return runScenario({
    id: "cancellation",
    title: "Cancellation: an operator stops a run mid-flight",
    summary:
      "Two independent verification nodes are running when the operator cancels the run; the reducer stops the still-running attempt, drops the pending dependent, and waits for the outstanding acceptance decision before declaring the run cancelled.",
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

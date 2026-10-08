import { z } from "zod";

import type { NodeSpec } from "../graph/spec.js";
import { IdSchema } from "../wire.js";
import type { JournalEvent } from "./events.js";
import { AcceptanceDecisionSchema, type EvidenceRecord } from "./evidence.js";
import type { RejectionRef } from "./state.js";
import { FailureCategorySchema } from "./status.js";

/**
 * Ports are the interfaces through which the host reaches the outside world. `core` defines
 * them and never implements them; effect packages (`@auto-pi-lot/host` first, later worker and
 * storage packages) do. Each port is shaped by what the reducer protocol needs (see
 * docs/architecture.md, "How the host uses the reducer"), not by any particular backend.
 */

/** What a journal read found. */
export interface JournalReadResult {
  readonly events: readonly JournalEvent[];
  /**
   * True when the store ended in a record it could not read in full, for example a line cut
   * short by a crash mid-write. The events before it are complete. The host treats the torn
   * record as never written, which is exactly what the persist-before-act contract allows: no
   * command of that event can have run.
   */
  readonly tornTail: boolean;
}

/**
 * Durable, append-only, per-run event log. `append` resolves only once the event is durable
 * (it survives a process crash); the host persists every accepted event here before it acts on
 * the commands that event produced. Implementations preserve append order per run and never
 * reorder, drop or rewrite a record. A corrupt record anywhere but the tail is an error, never
 * something to skip.
 */
export interface JournalStore {
  append(event: JournalEvent): Promise<void>;
  read(runId: string): Promise<JournalReadResult>;
}

/**
 * Immutable, content-addressed storage for evidence records (decision 0010). `put` is
 * idempotent: a record's id is `identifyEvidence`'s digest of its content, so storing the same
 * record twice is one record. Records are never updated or deleted by the host; an acceptance
 * that was later invalidated is a new record. `listForRun` returns every record of a run in a
 * stable order (by id), which is enough for the gate: a run's evidence is small.
 */
export interface EvidenceStore {
  put(record: EvidenceRecord): Promise<string>;
  get(id: string): Promise<EvidenceRecord | null>;
  listForRun(runId: string): Promise<readonly EvidenceRecord[]>;
}

/**
 * Immutable, content-addressed storage for artifact bytes (check logs, patches). `put` returns
 * the artifact id `sha256:<hex>` of the bytes and is idempotent; `get` returns `null` for an
 * unknown id. Implementations verify the hash on read.
 */
export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Uint8Array | null>;
}

/** What the host hands a worker for one attempt. It carries no acceptance authority. */
export interface WorkerAssignment {
  readonly runId: string;
  readonly graphId: string;
  readonly graphRevision: number;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly fencingToken: number;
  readonly node: NodeSpec;
  /** Producer node ID -> the producer attempt this attempt consumes (decision 0005). */
  readonly consumes: Readonly<Record<string, string>>;
  /** The producers this node verifies: those reached through a `result_ready` edge, in edge order. */
  readonly verifies: readonly string[];
  /** The specs of every producer in `consumes`, so a checker knows the criteria it must judge. */
  readonly producers: readonly NodeSpec[];
  /** The rejection this attempt repairs, with the receipts that caused it. */
  readonly repairOf: RejectionRef | null;
}

/**
 * How a worker's attempt ended, as the worker reports it. The host turns an outcome into the
 * matching journal event (`result_proposed`, `attempt_failed` or `attempt_stopped`), stamped
 * with the host's own event id, time and the assignment's fencing token. A worker never
 * writes the journal and cannot report an acceptance. The host validates outcomes at the port
 * boundary because workers (later model-driven processes) are untrusted.
 */
export const WorkerOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("result"), proposalDigest: IdSchema }),
  z.strictObject({ type: z.literal("failed"), category: FailureCategorySchema }),
  z.strictObject({ type: z.literal("stopped") }),
]);
export type WorkerOutcome = z.infer<typeof WorkerOutcomeSchema>;

/**
 * Runs attempts. The host calls `start` only after the attempt's `attempt_dispatched` event is
 * durable. The worker reports exactly one outcome per assignment through `report`, possibly
 * after `start` has returned; an outcome reported for an attempt the reducer no longer expects
 * is rejected by fencing, so a slow worker cannot overwrite its replacement. `cancel` asks a
 * running attempt to stop; the worker then reports `stopped`, or a result or failure that
 * raced the cancellation. Both calls are no-ops for an attempt the worker does not know.
 */
export interface WorkerPort {
  start(assignment: WorkerAssignment, report: (outcome: WorkerOutcome) => void): void;
  cancel(attemptId: string): void;
}

/** The host's request for an acceptance decision over one proposed result. */
export interface AcceptanceRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly node: NodeSpec;
  /** The digest the worker proposed for this attempt, from its `result_proposed` event. */
  readonly proposalDigest: string;
  /** Producer node ID -> the producer attempt this attempt consumed. */
  readonly consumes: Readonly<Record<string, string>>;
  /** The producers this node verifies (see `WorkerAssignment.verifies`). */
  readonly verifies: readonly string[];
  /** The specs of every producer in `consumes`. */
  readonly producers: readonly NodeSpec[];
  /**
   * Attempt id -> the proposal digest the host journaled for it (`result_proposed`), for every
   * attempt of the run that proposed a result. This is the gate's only trust anchor: a record is
   * evidence only when it is reachable from one of these digests, never because it sits in the
   * store (decision 0010).
   */
  readonly proposalsByAttempt: Readonly<Record<string, string>>;
}

/**
 * An acceptance verdict. An `accepted` verdict must cite at least one receipt (decision 0006).
 * The host validates it at the port boundary because gates (later model-driven processes) are untrusted.
 */
export const AcceptanceVerdictSchema = z
  .strictObject({
    decision: AcceptanceDecisionSchema,
    receiptIds: z.array(IdSchema).max(64),
    /** Why, in the gate's own words; for operators, never for the reducer. */
    reasons: z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
  })
  .superRefine((verdict, ctx) => {
    if (verdict.decision === "accepted" && verdict.receiptIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["receiptIds"],
        message: "An accepted decision requires at least one receipt",
      });
    }
  });
export type AcceptanceVerdict = z.infer<typeof AcceptanceVerdictSchema>;

/**
 * The acceptance gate answers `evaluate_acceptance` commands. The reducer only ever learns a
 * verdict as the `acceptance_decided` event the host writes from it. AP-12 will implement this
 * port over check and review receipts; until then hosts inject a scripted gate.
 */
export interface AcceptanceGate {
  evaluate(request: AcceptanceRequest): Promise<AcceptanceVerdict>;
}

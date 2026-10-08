import {
  type ArtifactStore,
  type CheckProfile,
  digest,
  type EvidenceStore,
  type RunVerificationResult,
  type RunVerifier,
} from "@auto-pi-lot/core";

import { runCheck } from "./check-runner.js";
import { fingerprintWorkspace } from "./workspace.js";

export interface WorkspaceVerifierOptions {
  workspace: string;
  checks: readonly CheckProfile[];
  evidence: EvidenceStore;
  artifacts: ArtifactStore;
  fingerprint?: typeof fingerprintWorkspace;
  runCheck?: typeof runCheck;
  log?: (message: string) => void;
}

/** One final verification per host lifetime; a recovered host reruns unfinished checks. */
export class WorkspaceVerifier implements RunVerifier {
  readonly #options: WorkspaceVerifierOptions;
  readonly #abort = new AbortController();
  #pending: Promise<RunVerificationResult> | undefined;
  #runId: string | undefined;

  constructor(options: WorkspaceVerifierOptions) {
    this.#options = options;
  }

  verify(runId: string): Promise<RunVerificationResult> {
    if (this.#runId !== undefined && this.#runId !== runId) throw new Error("A verifier belongs to one run");
    this.#runId = runId;
    this.#pending ??= this.#verify(runId);
    return this.#pending;
  }

  cancel(): void {
    this.#abort.abort();
  }

  async shutdown(): Promise<void> {
    this.cancel();
    await this.#pending;
  }

  async #verify(runId: string): Promise<RunVerificationResult> {
    const { checks, evidence, artifacts, workspace } = this.#options;
    const fingerprint = this.#options.fingerprint ?? fingerprintWorkspace;
    const execute = this.#options.runCheck ?? runCheck;
    const checkReceiptIds: string[] = [];
    const reasons: string[] = [];
    let sourceDigest: string | undefined;
    try {
      if (!this.#abort.signal.aborted) {
        if (checks.length === 0)
          this.#options.log?.("final verification: no deterministic checks configured; checking source stability only");
        sourceDigest = await fingerprint(workspace);
        for (const profile of checks) {
          if (this.#abort.signal.aborted) break;
          this.#options.log?.(`final check ${profile.id}`);
          const receipt = await execute(profile, {
            runId,
            attemptId: digest({ runId, phase: "final" }),
            workspace,
            sourceDigest,
            artifacts,
            signal: this.#abort.signal,
          });
          await evidence.put(receipt);
          checkReceiptIds.push(receipt.id);
          if (receipt.outcome !== "pass") reasons.push(`${profile.id}: ${receipt.outcome}`);
          if ((await fingerprint(workspace)) !== sourceDigest) {
            reasons.push("Source changed during final checks; the combined tree is not verified");
            break;
          }
        }
        if (reasons.length === 0 && (await fingerprint(workspace)) !== sourceDigest)
          reasons.push("Source changed during final verification");
      }
    } catch (error) {
      reasons.push(
        `Final verification could not complete: ${error instanceof Error ? error.message.slice(0, 1500) : "unknown error"}`,
      );
    }
    const cancelled = this.#abort.signal.aborted;
    if (cancelled) reasons.push("Final verification cancelled");
    return {
      outcome: cancelled ? "cancelled" : reasons.length === 0 ? "passed" : "failed",
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      checkProfileIds: checks.map((profile) => profile.id),
      checkReceiptIds,
      reasons,
    };
  }
}

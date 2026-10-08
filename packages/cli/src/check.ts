import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { CheckReceipt } from "@auto-pi-lot/core";
import { FileArtifactStore } from "@auto-pi-lot/host";
import { fingerprintWorkspace, runCheck } from "@auto-pi-lot/worker";

import { parseFlags } from "./args.js";
import { loadConfig } from "./config.js";
import { acquireRunLocks } from "./lock.js";
import { runtimePaths } from "./paths.js";
import { checkWorkspace } from "./run.js";

export const CHECK_USAGE = "Usage: auto-pi-lot check [--workspace <dir>] [--config <file>] [--profile <id>]";

/** Establish a baseline with the exact check runner used by attempts, without a model or graph. */
export async function runChecks(args: readonly string[]): Promise<number> {
  const parsed = parseFlags(args, { values: ["--workspace", "--config", "--profile"], switches: [] });
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(CHECK_USAGE);
    return 1;
  }
  const { values } = parsed.flags;
  const workspace = resolve(values.get("--workspace") ?? process.cwd());
  const problem = await checkWorkspace(workspace);
  if (problem !== null) {
    console.error(problem);
    return 1;
  }
  const paths = runtimePaths(workspace);
  const loaded = await loadConfig(resolve(values.get("--config") ?? paths.config), true);
  if (!loaded.ok) {
    console.error(loaded.error);
    return 2;
  }
  const profileId = values.get("--profile");
  const profiles = loaded.config.checks.filter((profile) => profileId === undefined || profile.id === profileId);
  if (profiles.length === 0) {
    console.error(
      profileId === undefined
        ? "No check profiles configured; run init or edit auto-pi-lot.json"
        : `Unknown check profile: ${profileId}`,
    );
    return 1;
  }
  if (new Set(loaded.config.checks.map((profile) => profile.id)).size !== loaded.config.checks.length) {
    console.error("Check profile ids must be unique");
    return 1;
  }
  const unlock = await acquireRunLocks([join(workspace, ".auto-pi-lot", "run.lock")], workspace);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const sourceDigest = await fingerprintWorkspace(workspace);
    const artifacts = new FileArtifactStore(paths.artifacts);
    const runId = `check-${randomUUID()}`;
    const receipts: CheckReceipt[] = [];
    let sourceChanged = false;
    for (const profile of profiles) {
      if (controller.signal.aborted) break;
      console.error(`checking ${profile.id}…`);
      const receipt = await runCheck(profile, {
        workspace,
        runId,
        attemptId: runId,
        sourceDigest,
        artifacts,
        signal: controller.signal,
      });
      receipts.push(receipt);
      console.error(`${profile.id}: ${receipt.outcome}`);
      sourceChanged = sourceDigest !== (await fingerprintWorkspace(workspace));
      if (sourceChanged) break;
    }
    sourceChanged ||= sourceDigest !== (await fingerprintWorkspace(workspace));
    const ok = !controller.signal.aborted && !sourceChanged && receipts.every((receipt) => receipt.outcome === "pass");
    console.log(
      JSON.stringify(
        { mode: "check", workspace, ok, cancelled: controller.signal.aborted, sourceDigest, sourceChanged, receipts },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await unlock();
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autoPiLot from "../src/extension.js";

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Records only the members the extension touches; everything else stays unimplemented. */
function createFakeApi() {
  const commands = new Map<string, RegisteredCommand>();
  const api = {
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return { api, commands };
}

test("the extension registers only the /graph status command", () => {
  const { api, commands } = createFakeApi();
  autoPiLot(api);
  assert.deepEqual([...commands.keys()], ["graph"]);
  assert.equal(commands.get("graph")?.description, "Show auto-pi-lot graph mode development status");
});

test("/graph reports that graph execution is unavailable and starts nothing", async () => {
  const { api, commands } = createFakeApi();
  autoPiLot(api);
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
  await commands.get("graph")?.handler("on", ctx);
  assert.deepEqual(notices, [
    {
      message:
        "auto-pi-lot scaffold: graph execution is not available yet. Run npm run demo in the repository to inspect a validated graph.",
      level: "info",
    },
  ]);
});

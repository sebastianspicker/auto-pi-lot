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

test("the extension registers only the /graph usage command", () => {
  const { api, commands } = createFakeApi();
  autoPiLot(api);
  assert.deepEqual([...commands.keys()], ["graph"]);
  assert.equal(commands.get("graph")?.description, "Show how to initialise, run and inspect auto-pi-lot graphs");
});

test("/graph prints the command line usage, says graph mode does not run in Pi yet and starts nothing", async () => {
  const { api, commands } = createFakeApi();
  autoPiLot(api);
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };
  await commands.get("graph")?.handler("on", ctx);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "info");
  const message = notices[0]?.message ?? "";
  assert.match(message, /does not run inside Pi yet/);
  assert.match(message, /auto-pi-lot init/);
  assert.match(message, /auto-pi-lot run --worker pi --graph auto-pi-lot\.plan\.json/);
  assert.match(message, /auto-pi-lot status/);
  assert.match(message, /auto-pi-lot inspect <runId>/);
});

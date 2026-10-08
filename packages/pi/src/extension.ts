import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GRAPH_USAGE = [
  "auto-pi-lot graph mode does not run inside Pi yet; use the auto-pi-lot command line:",
  "  initialise: auto-pi-lot init",
  "  run:        auto-pi-lot run --worker pi --graph auto-pi-lot.plan.json",
  "  inspect:    auto-pi-lot status, then auto-pi-lot inspect <runId>",
].join("\n");

/** Entry point only. `/graph` explains how to use the command line; it starts nothing. */
export default function autoPiLot(pi: ExtensionAPI): void {
  pi.registerCommand("graph", {
    description: "Show how to initialise, run and inspect auto-pi-lot graphs",
    handler: async (_args, ctx) => {
      ctx.ui.notify(GRAPH_USAGE, "info");
    },
  });
}

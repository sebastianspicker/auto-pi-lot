import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Entry point only. Graph mode stays unavailable until the supervisor is implemented. */
export default function autoPiLot(pi: ExtensionAPI): void {
  pi.registerCommand("graph", {
    description: "Show auto-pi-lot graph mode development status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "auto-pi-lot: graph mode is not available in Pi yet. In the repository, npm run demo prints a validated graph and npm run fake-run executes one end to end with stand-in workers; no model is attached.",
        "info",
      );
    },
  });
}

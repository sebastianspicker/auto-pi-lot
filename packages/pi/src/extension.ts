import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Entry point only. Graph mode stays unavailable until the supervisor is implemented. */
export default function autoPiLot(pi: ExtensionAPI): void {
  pi.registerCommand("graph", {
    description: "Show auto-pi-lot graph mode development status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "auto-pi-lot scaffold: graph execution is not available yet. Run npm run demo in the repository to inspect a validated graph.",
        "info",
      );
    },
  });
}

import type { CodingSession } from "@auto-pi-lot/core/session";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";

import { createPiEventMapper } from "./map-event.js";

export type { CodingSession, SessionEvent } from "@auto-pi-lot/core/session";

export type PiSessionOptions = Parameters<typeof createAgentSession>[0];
export type PiSessionFactory = typeof createAgentSession;

/**
 * Explicit factory injection keeps model calls out of imports and deterministic tests.
 * The caller must supply policy-scoped tools/resources before dispatch is implemented.
 */
export async function openPiSession(factory: PiSessionFactory, options: PiSessionOptions): Promise<CodingSession> {
  const { session } = await factory(options);
  return {
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    subscribe: (listener) => {
      // The SDK emits every event to every subscriber, so each subscriber gets its own mapper.
      const map = createPiEventMapper();
      return session.subscribe((event) => {
        for (const mapped of map(event)) {
          try {
            listener(mapped);
          } catch (error) {
            // The SDK calls subscribers without try/catch: a throw here would skip its other
            // listeners and persistence. Surface the consumer bug asynchronously instead.
            queueMicrotask(() => {
              throw error;
            });
          }
        }
      });
    },
  };
}

# @auto-pi-lot/pi

Everything that touches the Pi SDK, pinned to `@earendil-works/pi-coding-agent@0.87.0`.
No other workspace may import the SDK, and this package may import only the provider-neutral
session port from core (`@auto-pi-lot/core/session`), never the run reducer. Biome enforces both.

| Module | Entry point | Responsibility |
| --- | --- | --- |
| `src/session.ts` | `@auto-pi-lot/pi` | `openPiSession`: wraps an injected `createAgentSession` factory as a core `CodingSession` |
| `src/map-event.ts` | internal | `mapPiEvent`: pure, total mapping from SDK events to core `SessionEvent`s |
| `src/extension.ts` | `@auto-pi-lot/pi/extension`, `pi.extensions` | Pi extension: registers `/graph`, which currently reports development status only |

## Session adapter

`openPiSession` takes an injected factory and explicit options; importing the package starts
nothing. Scope tools/resources before using it for autonomous work. Prompt completion is not
task acceptance.

`CodingSession.subscribe` wraps the underlying `AgentSession`'s own event stream and maps each
SDK event to zero or more session events. Token usage comes from an assistant message's or a
compaction summary's `usage` field and is qualified `"reported"` or `"unknown"`; the SDK's
declared `CompactionResult.usage` is genuinely optional, so a missing usage is never reported
as zero. Tool execution start/end map to `tool_call`/`tool_result`. `agent_end` maps to
`settled` (`"completed"`, `"aborted"`, or `"error"`, read from the run's last assistant
message), plus a bounded `error` event when that message's stop reason is `"error"`. An
`agent_end` that will retry has not settled yet and maps to nothing. Unknown SDK event types
are ignored. `"completed"` also covers length/tool-use stop reasons.

## Extension

`/graph` reports that graph execution is not available yet. It does not enable graph mode or
route user tasks. Build first, then either point Pi at the package directory (its
`package.json` `pi.extensions` lists `./dist/extension.js`) or load the file directly:

```sh
pi --extension ./packages/pi/dist/extension.js
```

When the extension gains a supervisor client with its own dependencies, split it into its own
package rather than letting it reach into the session adapter.

# @auto-pi-lot/pi

Everything that touches the Pi SDK, pinned to `@earendil-works/pi-coding-agent@1.0.2`.
No other workspace may import the SDK, and this package may import only the provider-neutral
session port from core (`@auto-pi-lot/core/session`), never the run reducer. Biome enforces both.

| Module | Entry point | Responsibility |
| --- | --- | --- |
| `src/session.ts` | `@auto-pi-lot/pi` | `openPiSession`: wraps an injected `createAgentSession` factory as a core `CodingSession` |
| `src/opener.ts` | `@auto-pi-lot/pi` | `createPiSessionOpener`: pins the model route and opens one closed session per worker request |
| `src/map-event.ts` | internal | `createPiEventMapper`: total mapping from SDK events to core `SessionEvent`s, stateful only for the end of a prompt |
| `src/extension.ts` | `@auto-pi-lot/pi/extension`, `pi.extensions` | Pi extension: registers `/graph`, which prints how to use the command-line tool |

## Session opener

`createPiSessionOpener({ model?, thinkingLevel?, agentDir?, factory?, createRuntime? })`
resolves the model once, up front, from Pi's own credential and model store (`~/.pi/agent`
unless `agentDir` says otherwise): the pinned `provider/id`, or the first model with
credentials, and fails with a clear message when neither exists. It returns a function the
worker calls once per attempt with `{ role, tools, cwd, systemPrompt }`. Each call opens a
closed session: in-memory transcript (nothing is written to Pi's session directory), no
extensions, skills, prompt templates or themes, only the requested built-in tools
(`noTools: "all"` plus the allowlist), the worker's system prompt instead of Pi's, SDK retries
off (a hidden retry is an unaccounted model call), and the repository's own context files
(`AGENTS.md` and the like) applied, as data, only when the request's `loadContextFiles` says so
(the worker says no for checker roles). Credentials never leave Pi's store as configuration,
but Pi's built-in tools accept absolute paths, so a session can read any file the operator can.
The `factory` and `createRuntime` hooks exist so tests never create a real session.

## Session adapter

`openPiSession` takes an injected factory and explicit options; importing the package starts
nothing. Scope tools/resources before using it for autonomous work. Prompt completion is not
task acceptance.

`CodingSession.subscribe` wraps the underlying `AgentSession`'s own event stream and maps each
SDK event to zero or more session events, with one mapper per subscriber. Every completed
assistant message maps to its usage event followed by an `assistant_message` event with the
message's text parts (bounded to `MAX_ASSISTANT_TEXT_LENGTH`, flagged when cut); the worker
reads its report from the last one. Token usage comes from
an assistant message's or a compaction summary's `usage` field and is qualified `"reported"` or
`"unknown"`; the SDK's declared `CompactionResult.usage` is genuinely optional, so a missing usage
is never reported as zero. The all-zero usage on the message the SDK synthesises for a failed or
aborted run is no measurement and is also `"unknown"`. Tool execution start/end map to
`tool_call`/`tool_result`.

`agent_end` can fire several times within one prompt and can announce a retry that never happens,
so it maps to nothing by itself. `settled` is emitted on the SDK's `agent_settled`, once per
prompt, with its reason (`"completed"`, `"aborted"`, or `"error"`) taken from the last `agent_end`'s
last assistant message, plus a bounded `error` event first when that reason is `"error"`. A settle
with no `agent_end`, or after an `agent_end` that meant to retry, is `"aborted"`. Unknown SDK event
types are ignored. `"completed"` also covers length/tool-use stop reasons.

Prompts are sent verbatim with template and command expansion disabled, so task text starting with
`/` never runs an extension command. A listener that throws does not disturb the SDK's event loop
or other listeners; the error is rethrown asynchronously. The SDK rejects `prompt()` while a
previous prompt is still streaming, so callers serialize prompts.

## Extension

`/graph` prints how to initialise, run and inspect a plan with the command-line tool. It does
not run graph mode inside Pi or route user tasks. Build first, then either point Pi at the
package directory (its `package.json` `pi.extensions` lists `./dist/extension.js`) or load the
file directly:

```sh
pi --extension ./packages/pi/dist/extension.js
```

When the extension gains a supervisor client with its own dependencies, split it into its own
package rather than letting it reach into the session adapter.

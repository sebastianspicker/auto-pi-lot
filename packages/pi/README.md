# @auto-pi-lot/pi

Everything that touches the Pi SDK, pinned to `@earendil-works/pi-coding-agent@1.0.2`.
No other workspace may import the SDK, and this package may import only the provider-neutral
session port from core (`@auto-pi-lot/core/session`), never the run reducer. Biome enforces both.

| Module | Entry point | Responsibility |
| --- | --- | --- |
| `src/session.ts` | `@auto-pi-lot/pi` | `openPiSession`: wraps an injected `createAgentSession` factory as a core `CodingSession` |
| `src/opener.ts` | `@auto-pi-lot/pi` | `createPiSessionOpener`: pins the model route and opens one closed session per worker request |
| `src/map-event.ts` | internal | `createPiEventMapper`: total mapping from SDK events to core `SessionEvent`s, stateful only for the end of a prompt |
| `src/extension.ts` | `@auto-pi-lot/pi/extension`, `pi.extensions` | Pi extension: registers `/graph`, which starts, follows, cancels and inspects runs by driving the command-line tool as a child process |

## Session opener

`createPiSessionOpener({ model?, thinkingLevel?, agentDir?, sessionDir?, shellEnv?, factory?, createRuntime? })`
resolves the model once, up front, from Pi's own credential and model store (`~/.pi/agent`
unless `agentDir` says otherwise): the pinned `provider/id`, or the first model with
credentials, and fails with a clear message when neither exists. It returns a function the
worker calls once per attempt with `{ attemptId, role, tools, cwd, systemPrompt }`. Each call opens a
closed session: its transcript is written as `<timestamp>_<attemptId>.jsonl` under `sessionDir`
(characters Pi does not allow in session IDs, such as the `:` of `sha256:<hex>`, become `-`)
when one is given (the CLI passes `.auto-pi-lot/sessions/run-<runId>/`), otherwise kept in memory
(never in Pi's own session directory), no
extensions, skills, prompt templates or themes, only the requested built-in tools
(`noTools: "all"` plus the allowlist; a session whose active tools differ from the allowlist is
disposed and the open fails, because the SDK silently drops names it does not know), the worker's system prompt instead of Pi's, SDK retries
off (a hidden retry is an unaccounted model call), and the repository's own context files
(`AGENTS.md` and the like) applied, as data, only when the request's `loadContextFiles` says so
(the worker says no for checker roles). Credentials never leave Pi's store as configuration,
but Pi's built-in tools accept absolute paths, so a session can read any file the operator can.
With `shellEnv`, Pi's `bash` tool is replaced by the SDK's own bash definition whose spawn hook
passes every command's environment through that function; the CLI passes the check
environment allowlist, so exported provider keys never reach the model's shell.
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

`/graph` drives the auto-pi-lot command-line tool as a child process (`node <cli> ...`, no
shell, Pi's environment, working directory is Pi's). It does not route user tasks. Build first,
then either point Pi at the package directory (its `package.json` `pi.extensions` lists
`./dist/extension.js`) or load the file directly:

```sh
pi --extension <repo>/packages/pi/dist/extension.js
```

| Command | Effect |
| --- | --- |
| `/graph run <plan file> [--run-id <id>]` | Starts `run --worker pi --graph <plan>` in the background. It spends model credit and edits the checkout. Stderr progress shows in a widget (last 8 lines) and a status entry; on exit a one-line summary is shown |
| `/graph resume <runId>` | Starts `run --worker pi --resume <runId>` the same way |
| `/graph cancel` | Sends SIGINT to the active run once, which the CLI treats as a graceful cancel; repeating it (or quitting Pi) sends nothing more, because a second SIGINT would force the CLI to exit and keep its locks |
| `/graph status` | Runs `status` and lists `runId: status`, plus whether this Pi session has a run active |
| `/graph inspect <runId>` | Runs `inspect` and shows the status, each node's disposition, the session directory and the final verification outcome |
| `/graph` or `/graph help` | Shows the usage |

Only one run is active per extension instance; a second `run` or `resume` is refused. Plan
paths and run IDs may not contain spaces, control characters or start with `-`. An active run
receives SIGINT when the Pi session shuts down. The run keeps going if the Pi session that
started it is replaced (`/new`, `/resume`, `/reload`). Its progress and final notice are then
dropped, so use `auto-pi-lot status` to see how it ended. `/graph on`, `off` and `pause` are not available
yet: they need the background supervisor, which is not part of this alpha.

The CLI is found at `$AUTO_PI_LOT_CLI` when set, otherwise at `../../cli/dist/index.js`
relative to the built extension (`packages/cli/dist/index.js` in this repository). When it is
missing, `/graph` says so and starts nothing.

When the extension gains a supervisor client with its own dependencies, split it into its own
package rather than letting it reach into the session adapter.

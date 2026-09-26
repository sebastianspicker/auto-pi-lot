# Design brief: the trace viewer

The trace viewer (`site/`, published to GitHub Pages) is the only page auto-pi-lot has. This
note explains what it shows, who it is for and why it looks the way it does. The code is in
`site/index.html`, `site/style.css` and `site/app.js`.

## What the page shows

auto-pi-lot will run a coding task as a graph of smaller tasks for the Pi coding agent. A
model may suggest a plan or say its work is done; ordinary code checks the plan, schedules
attempts, enforces limits and decides whether a result is accepted.

Only that decision-making core exists today. `auto-pi-lot trace` runs three scripted
scenarios through the real reducer (happy path, retry and fencing, cancellation) and writes
`site/trace.json`. For every event it records what was sent, whether the reducer applied or
rejected it and why, the commands it gave back to the host, and the state of the run and of
every task afterwards. The page only displays that file. It calls no model and works out no
run state of its own.

The most useful parts of a trace are the rejections: a late result from a crashed attempt, a
wrong fencing token, a decision that arrives after the run has ended. They show that the
reducer, not the model, decides what counts. Step 3 of the happy path, where `verify` starts
on a result nobody has accepted yet while `review` keeps waiting, is the other one worth
seeing. Once decision 0005 is implemented, a repair scenario will add a third: a failing
check sends `implement` back and throws out everything that used its old result.

## Who reads it

Mostly engineers deciding whether the project is worth their time. They come from the README
or a link, have used Claude Code, Codex or Pi, and have seen an agent claim "all tests pass"
when they didn't. They know terms like fencing token or idempotency at least by name. They
want to check within a few minutes that the failure handling is real, and they are put off
by hype, vague claims and demos that turn out to be mocked. They live in the terminal, in
`git log`, JSON logs and CI output.

Contributors and the maintainer also use the page to check that a reducer change produces the
trace they expect; the Pages workflow regenerates it on every push to `main`.

Typical visits:

1. Arrive from the README and read the happy path from top to bottom.
2. Switch to retry and fencing and read why the rejected events were rejected.
3. Open a link to one event (`#retry-and-fencing/6`) from an issue or chat, maybe on a phone.
4. Look at the raw event and copy an ID.

## What the page should feel like

Exact, plain and quiet. Every mark stands for something in the data. It says what is built
and what isn't. Colour appears only where it means something. Terms are explained where they
first matter. Tools in this space (LangGraph Studio, Temporal's UI, Inngest, Trigger.dev,
GitHub Actions) get some things right: a status per task over time, a list of events in order,
details for the selected one, raw JSON close by, and dark mode. The page keeps those. It
avoids what agent tools tend to add: dark canvases with glowing status colours, gradients,
cards with shadows, status shown by colour alone, and marketing headlines on top of a tool.

## Why the previous version was replaced

The previous version (a "signal-box panel") looked like many generated pages: off-white
paper, small spaced-out capitals as labels, numbered tabs, a heavy rule over every panel and a
slogan as the headline. Its railway idea existed only in the stylesheet comments. It showed
one step at a time behind a Play button, when readers want to see the whole run. A rejected
event was one row among fourteen that looked almost the same. The node graph took the most
space and said the least, with two or three boxes and an arrow.

## What stays

- Three static files, one `fetch`, no build step, no dependencies.
- The data format (`trace.json` format 1), and the rule that the page only displays it.
- Links to a single event (`#<scenario>/<step>`), following the address when it changes, and
  keyboard use.
- A shape for every task state, so colour is never needed to tell states apart.
- The replay check in the footer.

## Constraints

- GitHub Pages serves `site/` as it is. `trace.json` is generated in CI and not committed.
- Biome lints and formats `site/`, and `npm run check` must pass.
- No web fonts or libraries: system fonts only, so the page loads at once.
- WCAG 2.2 AA, full keyboard use, light and dark schemes. Nothing animates.
- Never suggest that saving state, running workers or calling a model already works. No
  hand-written or made-up traces on the page.
- The README screenshots in `docs/images/` show the viewer and are regenerated with it.

## Assumptions

| Assumption | Why we think so | Confidence |
| --- | --- | --- |
| Most readers are engineers looking at the project from GitHub | The README links the page as its tour; the project is pre-release | High |
| Most visits are on a desktop, but shared links get opened on phones | Links are shared in issues and chats; there is no data either way | Medium |
| Dark mode matters | Developer audience; the page has always had it | High |
| The format and the three scenarios stay as they are until decision 0005 is implemented | `formatVersion: 1`; `trace.ts` asserts the scenarios; 0005 adds fields and a version bump | High |
| Readers may not know what a fencing token is | Mostly systems engineers use the term; the notes explain it where it appears | Medium |
| Fading unchanged cells is display, not working out state | It compares two snapshots the reducer wrote; nothing is scheduled or decided | High |
| Runs stay short enough for one column per event (up to about 30) | Current traces have 8 to 14 events; a repair trace would have about 20; wider tables scroll | Medium |

## The design

The whole run is on one page, laid out like a log with a table above it, much like the output
of the tools these readers already use.

- **The table.** One row per task, then a row for the run and one for the reducer's answer;
  one column per event. A cell that didn't change since the previous event is drawn faint.
  A rejected event is a shaded column of faint cells with a red ✗ in the reducer row, so
  "a rejected event changes nothing" can be seen at a glance.
- **The log.** One line per event: number, time since the start, event type, task, details,
  and the outcome. Attempts are called `implement#2` rather than by their hash, so a late
  result from `implement#1` is easy to spot. The full hashes stay in the raw event. Rejected
  events are always open. Selecting a line or a column opens that event, with the script's
  note, the reducer's answer and commands, and the event as sent.
- **Type.** The system sans-serif for sentences and the system monospace for anything that is
  data. No capitals-as-labels and no display type.
- **Colour.** Black on white, reversed in dark mode, and red only for rejections. The
  selected event gets a pale highlight. Each state has its own glyph: `·` pending, `○` ready,
  `●` running, `◐` result waiting for a decision, `✓` accepted, `✗` rejected, failed or out
  of attempts, `⊘` cancelled. The legend lists only the glyphs a scenario uses.
- **Layout.** One column: header, two short paragraphs with the status, the list of
  scenarios with event and rejection counts, then the facts, the table and the log. On a
  phone the table scrolls sideways on its own and log lines wrap.
- **Left out.** Playback, animation, cards, shadows, gradients, slogans, and anything that
  needs a metaphor explained.

### Decision 0005

Decision 0005 (a failing check repairs the task that produced the result and throws out
whatever used it) is accepted but not built. The page is ready for its states without
guessing at its field names:

- The states `verifying` (`◒`, result waiting for its checks) and `invalidated` (`↺`, result
  thrown out, waiting again) have glyphs. A task that runs out of attempts shares `✗`, and
  the cell's description gives the reason.
- Commands the page doesn't know (such as a dispatch that names the attempt it repairs) are
  shown with their type and fields instead of being dropped. Proper wording follows once the
  fields exist.
- A repair scenario appears only when `auto-pi-lot trace` produces one from the real
  reducer. A hand-written example was used to try out this design and is not published.

## Notes for changing the code

- Colours are variables at the top of `site/style.css`. Glyphs are text in `site/app.js`
  (`ASPECTS`), each with hidden text for screen readers.
- Screen readers hear one short sentence about the selected event, never the raw JSON.
- `←` `→` or `j` `k` move between events, `Home` and `End` jump; `↑` `↓` still scroll the
  page. The selected line and column are scrolled into view.

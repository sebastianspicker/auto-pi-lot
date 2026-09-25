# Design brief: the trace viewer

The trace viewer (`site/`, published to GitHub Pages) is the only visual surface of
auto-pi-lot. This brief records what the redesign is based on and why it looks the way it
does. The code that implements it is `site/index.html`, `site/style.css` and `site/app.js`.

## Product summary

auto-pi-lot is a local harness that runs a coding task as a graph of smaller tasks for the
Pi coding agent. Its rule is *agents propose, the harness decides*: a model may suggest a plan
or report success, and deterministic code validates the plan, schedules attempts, enforces
limits and decides whether a result is accepted.

Only the deterministic core exists today. The viewer replays `site/trace.json`, which
`auto-pi-lot trace` generates by driving the real run reducer with three scripted hosts
(happy path, retry and fencing, cancellation). Each step holds the event sent, whether the
reducer applied or rejected it (with a typed reason), the commands it handed back to the host,
the run status and every node's state. Nothing in the viewer calls a model or computes run
state.

**Moment of value:** the step where the reducer *rejects* something a naive system would have
accepted: the late result from a crashed attempt, the wrong fencing token, the acceptance
decision after the run ended. That is when a visitor understands that the harness, not the
model, is in charge. The happy path's step 3, where `verify` starts on an unaccepted result
while `review` keeps waiting, is the second such moment.

## Audience

**Primary: an experienced TypeScript/backend engineer evaluating the project.** They arrive
from the README, a GitHub link or a post about agent orchestration. They have used Claude
Code, Codex or Pi, have watched an agent report "all tests pass" when they did not, and are
tired of agent frameworks that promise autonomy. They know event sourcing, idempotency and
distributed-systems failure modes (fencing tokens, leases) at least by name.

- **Goals:** decide in a couple of minutes whether this design is serious; check that the
  failure handling is real and not a diagram in a slide deck.
- **Anxieties and distrust:** hype, vague claims, "AI magic", marketing sites for code that
  does not exist yet, demos that are secretly mocked.
- **Daily tools:** terminal, editor, GitHub, `git log`, JSON logs, CI output.
- **What reads as quality to them:** exactness (real IDs, real hashes, real error codes),
  honest status, information density that respects them, keyboard support, a page that loads
  instantly and has no cookie banner.

**Secondary: contributors and the maintainer**, who use the viewer to check that a reducer
change produces the trace they expect (the Pages workflow regenerates it on every push).

## Key journeys

1. Land from the README, understand what a trace is, press Play or step with the arrow keys
   through the happy path.
2. Switch to *Retry and fencing*, find the rejected events, read why they were rejected.
3. Open a deep link (`#retry-and-fencing/6`) shared in an issue or chat, possibly on a phone.
4. Inspect the raw event and the commands for one step, copy an ID.

## Brand traits

| Trait | Not |
| --- | --- |
| Rigorous: every mark on the page corresponds to data | Pedantic: raw JSON as the main interface |
| Candid: says what is built and what is not | Self-deprecating or apologetic |
| Calm: quiet surfaces, colour only where it carries state | Sterile or grey-on-grey |
| Mechanical: deterministic, inspectable, repeatable | Retro-kitsch or cosplay of machinery |
| Exact: real identifiers, typed reasons | Cryptic: jargon without a legend |

## Market observations

Closest alternatives and adjacent tools: LangGraph Studio, Temporal's web UI, Inngest and
Trigger.dev run views, CrewAI and AutoGen dashboards, GitHub Actions run graphs.

- **Category conventions worth honouring:** a node graph with status colours; a chronological
  event list; a detail pane for the selected event; raw JSON one click away; dark mode.
- **Conventions to break:** near-black canvases with neon status glows and purple accents;
  rounded "cards" with drop shadows; status shown only by colour; timelines that hide *why*
  something happened; marketing heroes on top of developer tools. Agent frameworks in
  particular dress up in gradients and sparkles, which is exactly the hype this audience
  distrusts.

## What to keep

- The static, dependency-free architecture: three files, one `fetch`, no build step.
- The data contract (`trace.json` format 1) and the principle that the page only *displays*
  reducer output.
- Hash deep links `#<scenario>/<step>` and arrow-key stepping.
- The seed of the concept: the old stylesheet already called status markers *lamps*.
- The copy's plain, exact tone and the footer's provenance line (replay matches live state).

## Current weaknesses

- On a phone the graph is scaled to about 30%: node text is 5–6 px and unreadable.
- Colour is the only status channel; violet and red/green pairs fail for colour-blind readers.
- The timeline is a strip of 150 px cells that scrolls sideways; rejected events are only a
  red top border, and the node an event concerns is not shown.
- The step panel scrolls away from the graph; long hashes are clipped in the JSON block and
  truncated to 19 characters in commands.
- Tabs wrap into ragged lines because scenario titles are sentences.
- The whole step panel is an `aria-live` region, so screen readers re-read the JSON on
  every step.
- Changing the hash on an open page (back button, pasted link) does nothing.
- Visually generic: default rounded panels, a typeface common to thousands of templates, and
  no idea tying the look to the product.

## Constraints

- GitHub Pages, static files, `site/` uploaded as-is; `trace.json` is generated in CI and
  gitignored.
- `site/app.js` is linted and formatted by Biome (`npm run check` must pass).
- No new runtime dependencies; web fonts only from Google Fonts (OFL).
- WCAG 2.2 AA, full keyboard use, `prefers-reduced-motion`, `prefers-color-scheme`.
- Honesty rule from AGENTS.md: never imply persistence, execution or a model call that does
  not exist.
- README screenshots in `docs/images/` show the viewer and must be regenerated with it.

## Assumptions log

| Assumption | Evidence | Confidence |
| --- | --- | --- |
| Primary visitors are engineers evaluating the project, arriving from GitHub | README links the viewer as the tour; repo is pre-release; vocabulary (fencing, reducer, idempotency) | High |
| Most visits are on desktop, but deep links get opened on phones | Links are shared in issues and chats; no evidence either way on ratio | Medium |
| Dark mode matters | Developer audience; the old site already supported it | High |
| Trace format 1 and its three scenarios stay stable for a while | `formatVersion: 1`; scenarios are asserted with `expect` in `trace.ts` | High |
| Scenario titles follow "Name: description" | All three do; the viewer falls back to the whole title if not | Medium |
| A new visitor does not know what a fencing token is | Only systems engineers use the term; the notes explain it in context | Medium |
| Readers will accept a railway-signalling visual idea without it being explained | The idea is carried by form (lamps, track, register), never by labels or pictures | Medium |
| Showing an edge as "condition met" is display, not state computation | It reads the node snapshot fields the reducer produced; nothing is scheduled or decided | High |
| The number of nodes per scenario stays small (≤ 6) | Current traces have 2–3; the layout still works up to about 4 per rank | Medium |

## Design direction

The organising question: what does *agents propose, the harness decides* look like, in a
form that grew out of the product's own mechanics?

### Direction A: Interlocking (chosen)

**Concept.** A railway signal box. The signaller *requests* a route; the interlocking, a
deterministic machine, *refuses* any request that would be unsafe, whatever the signaller
wants. On single-track lines, only the driver holding the physical token for a section may
enter it: that is a fencing token, invented in the 1870s. Every train is written into the
box's register. auto-pi-lot's reducer is the interlocking, the model is the signaller, the
event journal is the register. The viewer becomes a mimic panel: a flat diagram board with
lamp indicators and track that lights when a route's condition is met, beside a ruled
register of every event.

**Why it fits.** It makes the product's thesis visible without saying it, it is a
pre-digital, fully deterministic safety system (credible to a distrustful engineer), and it
evolves the existing "lamp" vocabulary rather than discarding it.

- **Typography.** Archivo (variable width and weight, OFL). Its width axis plays the role of
  engraved panel lettering: condensed caps for labels, normal width for reading text, a wide
  heavy cut for the wordmark and headline. Spline Sans Mono for every identifier, event type
  and payload: it is clear at small sizes and less familiar than the usual developer monos.
  Scale on a 1.25 ratio from a 16 px base: 12.8 / 14 / 16 / 20 / 25 / 31 / 39 / 49 px.
- **Colour.** Panel enamel (warm off-white) and ink; everything else is a signal aspect with
  one job. Green *clear* = accepted. Yellow *caution* = reserved or running. Red *danger* =
  rejected or failed. Lunar white, the aspect that means "proceed, but not a clear route",
  = result proposed but not yet accepted. Grey = pending or cancelled. No accent colour,
  no brand colour: the ink is the brand. Night panel (dark mode) swaps enamel for charcoal.
- **Lamp glyphs.** Each state also has its own shape, so colour is never the only channel:
  empty ring (pending), ring with centre dot (reserved), solid (running), half-filled
  (result awaiting acceptance), solid with a check notch (accepted), solid with a bar
  (rejected or failed), ring with a slash (cancelled).
- **Layout.** A 12-column grid, dense. The board and the register share the left eight
  columns, the step detail is pinned in the right four so the explanation never scrolls away
  from the diagram. On phones the graph turns vertical (tracks run downward), so node text
  stays at reading size, and the transport controls move to a bar under the thumb.
- **Motion.** Lamps cross-fade between aspects (160 ms), a changed node's frame tightens,
  and that is all. No entrance animations. `prefers-reduced-motion` removes the fades.
- **Signature details.** (1) Track that lights up when its condition is met, so you *see*
  why `verify` may start and `review` may not. (2) The register: every event on a ruled line
  with its relative time, node and verdict; rejected lines carry the typed reason in red.
  (3) Permits drawn as token slots, filled while a worker holds one.
- **Against the category.** Light by default, flat, square-cornered, no glow, no accent
  gradient, no cards: rules and panels instead.
- **Refuses.** Illustrations of trains, levers or signals; skeuomorphic bevels; any railway
  word in the interface copy. The metaphor is structure, not decoration.

### Direction B: Proof sheet

**Concept.** Each trace as a typeset proof: numbered steps as lines of a derivation, the
reducer's verdict as the justification in the right margin, rejections as struck-through
lines with the rule they violate. Rigour as the aesthetic of a mathematics paper.

- **Typography.** Newsreader for text, Newsreader small caps for step labels, IBM Plex Mono
  for terms.
- **Colour.** Paper and ink, one red for struck lines; state shown by typography (roman,
  italic, struck) rather than colour.
- **Layout.** A single reading column with wide margins for marginalia; the graph as a
  small figure that updates beside the current line.
- **Motion.** None beyond scrolling the current line into view.
- **Signature.** Marginal justifications ("by fencing, token 1 < 2"); a QED mark when replay
  matches live state.
- **Against the category.** No dashboard at all.
- **Refuses.** Colour-coded status, panels, controls beyond next and previous.

### Direction C: Flight recorder

**Concept.** The name's pun: an autopilot's flight data recorder. Events on a scrolling
strip chart, node states as instrument annunciators, B612 (the Airbus cockpit typeface) on a
dark display.

- **Typography.** B612 and B612 Mono.
- **Colour.** Dark display, amber/green/red annunciator colours, cyan for selection.
- **Layout.** Full-bleed instrument panel; timeline as a horizontal strip chart.
- **Motion.** Strip chart scrolls continuously during playback.
- **Signature.** Annunciator panel that lights per node.
- **Against the category.** A literal instrument rather than a web dashboard.
- **Refuses.** Light mode as the default.

### Choice

**A, Interlocking.** It is the only direction whose metaphor *is* the product's mechanism
(route request versus interlocking, token block versus fencing token, train register versus
event journal), so it explains the harness instead of decorating it. B is beautiful and
honest, but it hides the graph, which is half of what the traces demonstrate, and asks for
more reading than an evaluating engineer will give. C is built on a pun about autonomy, the
very thing the product constrains, and drifts straight into the dark-display, glowing-status
look this category already overuses.

**What A trades away:** B's typographic quietness (A has more simultaneous elements) and
C's instant "cockpit" drama. It also relies on a metaphor most visitors will never consciously
name, so every element must work without it: lamps are labelled by a legend, tracks by their
condition, the register by column headings.

## Implementation notes

- Tokens live at the top of `site/style.css` (type, space, colour roles for light and dark,
  rules, radii, motion). Lamp glyphs are SVG symbols in `index.html`, shared by the board and
  the legend.
- Functional changes, all small: the page follows `hashchange` (back button and pasted
  links now work on an open page); the graph lays out vertically on narrow screens; the live
  region is limited to the step note and verdict; edges show whether their condition is met;
  commands show full identifiers (middle-truncated, full value in a tooltip and copyable);
  Home and End jump to the first and last step. The data contract is unchanged.

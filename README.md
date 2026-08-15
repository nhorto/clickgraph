# clickgraph

**Walk a running web app headlessly, graph what its controls actually do, and diff that graph on every change.**

No human driving, no screen takeover. An agent building a UI can run this to prove the thing it just built actually works.

An agent-facing companion to [App Atlas](https://github.com/nhorto/App-Atlas). App Atlas maps what the code *says*. This walks what the running app *does* — headlessly, with no human driving and no screen takeover — and reports where the two disagree.

**The customer is the coding agent mid-task.** You set an agent off to build a feature; when it thinks it is done, this walks the app and tells it whether the button it just added actually does anything. That is the tracer bullet: verify one feature vertically, now, instead of waiting for the whole app to be finished.

## Status: working MVP

Deliberately **no LLM in the loop**. The walk is pure Playwright and heuristics, so a run costs nothing per invocation and is fast enough to sit in the inner loop. The AI healer/judge is a later layer, not a prerequisite.

```bash
npm install && npx playwright install chromium && npm run build
npm run fixture &                      # demo app with planted bugs
node dist/cli.js walk http://localhost:4173     # explore, write baseline
node dist/cli.js diff http://localhost:4173     # re-walk, report changes
```

### What a walk reports

```
Findings
  NO EFFECT  button "Export"
             on /orders — no navigation, no state change, no network traffic
  ERROR      button "Save settings"
             on /settings — 500 POST http://localhost:4173/api/save

Not covered
  1 skipped (disabled)
  1 skipped (dangerous)
  1 skipped (external)
  Coverage is heuristic, never exhaustive. Unwalked is not the same as working.
```

### What a diff reports after you add a feature

```
Regressions (1)
  • new control does not work: button "Archive" on /orders → no-effect
    no navigation, no state change, no network traffic

Other changes (2)
  • /orders changed shape: 2 control(s) added
  • new interaction: button "Print invoice" on /orders → network-only
```

Exit codes: `0` no regressions, `1` regressions found or the run proved nothing, `2` usage/runtime error — so an agent or CI can gate on it.

### The fast check

A plain `diff` explores from scratch, which means reloading the page before
nearly every click: on the fixture, 52 re-entries costing 43 of a 72-second run.
`--replay` uses the baseline as a map instead. The baseline records where each
control led, so a control that navigates is a free ride into the next state that
still has work rather than another reload.

```bash
node dist/cli.js diff http://localhost:4173 --replay
```

Same 59 interactions, 12 reloads instead of 52, 42s instead of 71s. The map is
only ever used to plan the route — what each control does *now* is measured
after every action, so an app that has changed re-routes the plan and never
skews the findings.

How much that is worth depends on the app, and the fixture flatters it. Its
eight screens are densely linked and three quarters of its controls navigate, so
almost every exit is a free ride. App Atlas — 40 states, 2,086 controls, a React
Flow SPA where most states share one URL — has far less for a router to exploit.
Held to the same 197 interactions, mean of two interleaved pairs:

| | Wall clock | Interactions | Reloads |
|---|---|---|---|
| Full walk | 289.9s | 197 | 191 |
| `--replay` | **256.3s** | 197 | 160 |

12% off, not the fixture's 41%. That is the number to quote.

Measuring it took two experiments, and the first one alone would have been
misleading in the opposite direction. Left to its own budget the replay is 7%
*slower* — 311.9s against 291.4s — because its floor is the baseline's full edge
count and that is larger than the walk's own ceiling, so it does 38% more work
for its extra time. Neither run is wrong; they answer different questions, and
only the equal-work one answers "should I reach for this".

The other thing the timing settled: cutting reloads by 16% bought 12% of wall
clock, so reloads are no longer the dominant term. Anything further has to come
from somewhere else, which is not what the reload count alone implied.

It buys that by covering less, and says which less. A replay reads the live page
at each state it visits, so a control added to a screen the baseline knew is
still caught; a screen the baseline never knew is walked into, left unopened,
and reported:

```
  1 new screen(s) were reached and not explored — a replay stops at the edge of its baseline.
  Re-walk to cover them: clickgraph walk <url>
```

That run exits 1 with no regressions. Not a failure — a refusal to call a run
clean when the screen you just built is the one it declined to open.

### What an agent reads

`--json` prints a compact verdict rather than the whole graph — an agent that has
to parse thousands of lines to find two broken buttons will either burn its
context or skip the check. `ok` always agrees with the exit code.

```json
{
  "ok": false,
  "verdict": "of 28 interaction(s) walked, 1 errored and 1 produced no observable effect",
  "load": { "healthy": true, "errors": [], "interactiveFound": 12 },
  "findings": [
    { "severity": "error", "control": "button \"Save settings\"", "state": "/settings",
      "detail": "500 POST /api/save" }
  ],
  "coverage": { "states": 6, "walked": 28, "unwalked": 0, "skipped": [] }
}
```

`skill/clickgraph/` is a Claude Code skill that teaches an agent when to walk,
when to diff, and how to read that verdict — including the rules for what it
does *not* prove. Install it with:

```bash
cp -r skill/clickgraph ~/.claude/skills/clickgraph
```

## How it works

1. **Explore.** Breadth-first from the base URL. At each state, enumerate every visible, enabled control, click one, and classify what happened.
2. **Classify.** `navigated` · `state-changed` · `network-only` · `no-effect` · `error`. `no-effect` is the money finding: a control that renders but produces no navigation, no state change, and no network traffic.
3. **Graph.** Nodes are UI states, edges are actions with their observed outcome, written to `.uigraph/graph.json` — a repo artifact that diffs in review like any other file.
4. **Diff.** Re-walk and compare. A control that worked and now does nothing is a regression; a control that never existed and does nothing on arrival is a regression too — that is the tracer bullet firing.

### Two-tier state identity

The hard problem (see [RESEARCH.md](RESEARCH.md)) is deciding whether two screens are "the same state". This is handled in two tiers:

- **identity** = route + headings → decides node id.
- **structure** = identity + every interactive control → detects shape changes.

Keeping structure *out* of the node id is what lets a page gain a button without the screen being reported as a different, unreachable screen. Without this split, every ordinary UI change orphans the graph and the tool cries wolf on its author's own work — the failure mode that killed the previous generation of these tools.

**Known limitation, stated plainly:** two genuinely different screens sharing a route *and* their headings collapse into one node. v1 errs toward under-splitting, because a missed split is quieter than a graph that resets every commit.

## Apps behind a login

A gated app walks its own login form perfectly, and that report looks exactly
like a real one — so a login screen on the entry page is detected, said plainly,
and fails the run. To get past it, sign in once yourself:

```bash
npx clickgraph login http://localhost:5173
```

A browser window opens, you sign in, you press Enter. Your credentials go into
your own browser and nowhere else — the only thing written is the session state
the browser produces, saved to `.uigraph/session.json`. That file holds live
cookies, so it is gitignored and should stay that way.

```bash
npx clickgraph diff http://localhost:5173 --storage-state .uigraph/session.json
```

When the session expires the diff says so — "the entry page now looks like a
login screen" — instead of reporting the entire app as missing.

## Forms

Clicking a form's submit button with its fields empty proves nothing: the
browser refuses the submission and no application code runs. So a form is
reported as skipped, with the reason, rather than as a dead button — otherwise
every signup, login and checkout form in every app comes back broken.

`--fill-forms` fills each form with obviously synthetic values and submits it:

```bash
npx clickgraph walk http://localhost:5173 --fill-forms
```

```
NO EFFECT  button "Send feedback" (form filled: 1 field(s))
           on /feedback — no navigation, no state change, no network traffic
```

Off by default, for the same reason delete buttons go unclicked: a submission
that succeeds writes real data. Every value contains `clickgraph-test`, and
addresses use the reserved `.invalid` domain and the 555-01xx phone block, so
whatever a walk creates is greppable afterwards and can never reach a real
person. A password field is never typed into and stops its whole form — a wrong
password is a failed sign-in attempt, which on a real app means rate limiting or
a locked account.

## Safety

The walker clicks autonomously against a real app, so by default it refuses controls matching destructive patterns (delete, remove, sign out, pay, purchase, deactivate), skips off-origin links, and skips disabled controls. All of them are reported as *skipped with a reason* — never as passing. `--allow-dangerous` overrides, and should only be pointed at a disposable environment.

## Design rules

1. **Discovery first, then baseline.** Run one records what *is*; no spec needed. From then on the oracle is the diff.
2. **Blank over confident falsehood.** Unwalked is labeled unwalked. Coverage is never implied to be exhaustive.
3. **The LLM authors; deterministic code executes.** v1 is entirely deterministic; AI enters later only to heal broken replays and judge redesigned-vs-broken.
4. **The static map is a hint, not ground truth.** App Atlas can seed the walk, but is not required — and where map and walk disagree, that disagreement is itself the report.

## Verify

```bash
./scripts/verify.sh
```

Runs the fixture app through ten scenarios — unchanged (twice, for
determinism), a broken interaction, a new feature with one dead control, the
JSON verdict agreeing with the exit code, an app behind a login screen, a form
that drops its submission beside one that works, `--replay` finding all of the
above while naming the screen it declined to open, a budget-limited baseline
that must not invent regressions, and a screen with no `<form>` on it whose
fields have to be grouped by layout or left alone, and a working zoom beside a
dead button on the same canvas. 56 checks, all passing as of the last commit.

## Tested against real apps

Walked three real codebases, which found bugs the fixture never could. Current results:

| App | Stack | States | Walked | Findings |
|---|---|---|---|---|
| Vite dashboard | React + Tailwind SPA | 32 | 90 (budget) | 0 |
| Marketing site | Next.js App Router | 12 | 82 | 0 |
| App Atlas web | React + React Flow SPA | 40 (budget) | 197 | 1 |

Runs that stop at a budget say so and report what they never reached, rather
than implying they covered everything.

The App Atlas row was stale and said 83 walked and 0 findings; the selector and
`inert` fixes had more than doubled what that walk reaches since it was written.
Of the four findings a current run reports, three were the canvas zoom controls
below — working buttons the fingerprint could not see, now `visual-only`. The
fourth is a real unexplained no-effect and is left standing as one.

Every false positive those runs exposed is now fixed, and each fix is a rule worth keeping:

- **A broken app must not walk clean.** App Atlas's UI was 502ing on every API call; it rendered no buttons, so there was nothing to click, so the report was empty and the exit code was 0. Entry-page health is now recorded and reported first.
- **Not every 4xx is a defect.** An endpoint that answers 404 to mean "this optional thing does not exist" is not a bug when the app handles it. 5xx and uncaught exceptions still fail; a 4xx with *nothing visible happening* still fails, because that silent failure is real.
- **Already-active controls are not dead controls.** A link to the current page, or the tab already selected.
- **Some controls answer to hover, not click.** A dashboard of glossary terms opened tooltips on `pointerenter` while the click handler toggled them shut — sixteen working tiles read as dead. Probing hover requires moving the pointer away first, or you re-hover an element the mouse never left and test nothing.
- **A control that opens a panel does nothing once that panel is open.** Only visible after the walk finishes: the button is recognizable as already-open from the edge that opened it. This also settles the nav-item case — a link to the view you are on is inert whether or not it carries `aria-current`.
- **Controls that answer to typing cannot be verified by clicking.** A `<select>` answers to choosing an option; a text field answers to typing. Clicking either changes nothing, so before this every search box and form field in an app read as a dead control. Selects are now walked by choosing an option they are not already showing. Text fields are only typed into as part of their form.
- **The tool has to be able to find its own controls again.** A third of the controls on a real dashboard could not be resolved by the selector recorded for them seconds earlier, on the same page, with nothing changed — because the name recorded here comes from the DOM and Playwright's comes from the accessible-name algorithm, and the two disagree over decorative content, CSS `text-transform` and `title` attributes. Chasing that algorithm is a losing game; every element now carries a verified structural path to fall back to. On that dashboard it took a walk from 60 interactions to 77, and from 220 seconds to 108.
- **A control hidden from the accessibility tree is hidden from the walk.** An open dialog left the whole page behind it enumerated as clickable, so every one of those controls came back covered by the dialog's own backdrop. `aria-hidden` and `inert` are how an app says that; respecting them took the same dashboard from 24 states to 32.
- **An empty form's submit button is not a dead control.** Clicking it fires native validation, which refuses the submission and changes no DOM — indistinguishable from a button wired to nothing. The browser's own `checkValidity` settles it, and the form is reported as skipped until something fills it in.
- **Most apps do not write the form down, and the same rule still has to hold.** The React pattern is loose inputs and a button bound to a handler, with no `<form>` anywhere — and every one of those buttons declines an empty submit in silence, which is the case above with the browser's answer taken away. Nothing in that DOM says which fields belong to which button, so the grouping is inferred from layout: a field joins a cluster only when exactly one button is in reach of it, and stays skipped when two are, because guessing wrong means typing into fields that do not belong together. What the inference buys is that `--fill-forms` reaches these at all; what it must never do is manufacture a group to type into. Both halves are checked, since a rule that only ever refuses is indistinguishable from a rule that does nothing.
- **A control whose whole effect is geometric is invisible to a fingerprint made of words.** App Atlas's React Flow canvas has Zoom In, Zoom Out and Fit View on it, and all three were reported dead. They work: each rewrites one CSS transform on the viewport — `scale(0.34)` to `scale(0.408)` and back, `scale(0.1)` for fit — and moves not a word of text and not one control, which is everything the fingerprint is made of. Those are now their own outcome, `visual-only`, rather than a `state-changed`: what is known is that the geometry moved, not that anything a user reads is different, and rolling it into the stronger kind would overstate the evidence. The risk in fixing this was always the opposite mistake, so the signal is kept deliberately narrow — scroll position and *inline* transforms, which is how JS-driven pan and zoom is actually written, and pointedly not element rectangles, which move for late layout and unfinished animations and would hide a genuinely dead control behind "something moved". Scroll position has the same shape and is carried the same way. The check also sits *below* the content comparison, so a click that changes what the page says is still a state change whether or not it also moved something. The fixture puts a dead button on the same screen as a working zoom, because the question worth testing is not whether a zoom can be detected but whether detecting it excuses the button next to it.
- **A control a run never reached is not a control that is gone.** App Atlas has 2,086 controls and the default budget walks 200 of them. The baseline sampled one tenth; `--replay`, which reorders traversal by design, sampled a different tenth; and the diff reported the difference between two samples as 87 controls gone and 10 broken on arrival. The app had not changed. Absence from a graph means either "not there" or "never got to it", and a budget is exactly the condition that makes the second common — so where a run stopped short of a screen, the missing controls are now reported as the coverage gap they are. The measured scope, because the guess was wrong: two full walks over the same truncated app came back clean, 0 regressions, on the code that produced the 97. Deterministic traversal samples identically, so a plain `diff` does not trip this on its own — it took reordering to expose it. Whether a change that shifts where the budget falls could trip it too is untested, and the fix covers both because the reasoning does not depend on which run did the reordering.

## Layout

| Path | What |
|---|---|
| `src/act.ts` | exercising one control: safety refusals, selects, forms, hover retry — the rules a walk and a replay must share |
| `src/walker.ts` | breadth-first exploration and budgets |
| `src/replay.ts` | re-checking a known graph, routed to avoid reloads |
| `src/observer.ts` | in-page control extraction, selector derivation, outcome classification |
| `src/fingerprint.ts` | two-tier state identity |
| `src/graph.ts` | save/load and the graph diff |
| `src/report.ts` | human-readable output |
| `fixture/server.js` | demo app with deliberately planted defects |

## Next

See [ROADMAP.md](ROADMAP.md). The short version: the inner loop is now roughly
twice as fast via `--replay`, and what is left of the reloads is the next thing
to cut. Then field clusters outside a `<form>`, the App Atlas pairing, and a
graph viewer. The LLM healer comes last, on purpose: the deterministic core has
to earn trust first.

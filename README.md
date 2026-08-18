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
node dist/cli.js --version                    # identify the running build
```

### What a walk reports

```
Findings
  NO EFFECT  button "Export"
             on /orders — no navigation, no state change, no network traffic
  ERROR      button "Save settings"
             on /settings — 500 POST http://localhost:4173/api/save

Not covered
  3 control(s) discovered but not walked
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

Exit codes: `0` no regressions, `1` regressions found, `2` usage/runtime error — so an agent or CI can gate on it.

### What an agent reads

`--json` prints a compact verdict rather than the whole graph — an agent that has
to parse thousands of lines to find two broken buttons will either burn its
context or skip the check. `ok` always agrees with the exit code.

```json
{
  "ok": false,
  "version": "0.1.0",
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

- **identity** = route + *visible* headings → decides node id.
- **structure** = identity + every interactive control → detects shape changes.

Keeping structure *out* of the node id is what lets a page gain a button without the screen being reported as a different, unreachable screen. Without this split, every ordinary UI change orphans the graph and the tool cries wolf on its author's own work — the failure mode that killed the previous generation of these tools.

**Known limitation, stated plainly:** two genuinely different screens sharing a route *and* their headings collapse into one node. v1 errs toward under-splitting, because a missed split is quieter than a graph that resets every commit.

Only headings the user can actually see are counted. An SPA that keeps every screen mounted and reveals one at a time otherwise hands the same heading list to all of them, which collapses the whole app to a single node and still exits 0 (issue #25). The cost of counting only what is on screen is that a screen with no visible heading is identified by its route alone — accepted, because the remaining tie-breakers are the ones `structure` already carries for the express reason that they move on every ordinary UI edit.

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

### Sessions kept per tab

Playwright's storage state holds cookies and localStorage and nothing else, so
an app that keeps its session in `sessionStorage` — the deliberate choice when a
session must not outlive the tab — used to save an empty file and walk straight
back into its own sign-in form, with `login` reporting success either way.

`login` now saves that third store too, in the same file and labelled by the
store it came from:

```json
{
  "cookies":        [ ... ],
  "origins":        [ { "origin": "...", "localStorage": [ ... ] } ],
  "sessionStorage": [ { "origin": "...", "items": [ { "name": "...", "value": "..." } ] } ]
}
```

A walk replays the `sessionStorage` entries into the browser before its first
navigation, so the app finds its session where it left it. It is restored only
for the origin it was captured from, because that is the only place it means
anything — and if the walk is of a different origin, the walk says so rather
than reporting a sign-in screen it cannot explain. Session files written before
this existed have no `sessionStorage` key and keep working unchanged.

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

### Lookup fields, and the states behind them

Some fields have no reasonable synthetic value. A lookup takes an identifier
the app already knows, so `clickgraph-test` lands on "no such record" — and the
detail view behind it, with every control on it, is never walked. Worse, it is
never *counted*: the walk reports success and a diff reports "No change",
because the state it would compare does not exist in either run.

`--field` declares what to type:

```bash
npx clickgraph walk http://localhost:5173 --fill-forms \
  --field "#order-code=ORD-1042"
```

The selector is matched with the browser's own `Element.matches`, so it means
what it means everywhere else. It is repeatable, and the first declaration that
matches a field wins — list the specific one before the general one.

**A declaration that matches nothing fails the run.** That is the whole point:
the failure this replaces was a walk that quietly went on synthesizing and
reported a clean app.

```
Declared field values never typed (1)
  • --field #renamed-since=ORD-1042
```

**The value is recorded, and a diff inherits it** — for the same reason a fault
is. It is what opens the state, so a diff that dropped it would walk a smaller
app and report every control behind the lookup as missing. Dropping it on
purpose with `--no-fields` says so loudly.

**Declared values are not marked as the walk's own.** They cannot be: the point
is that they look exactly like what a person would type, which is also what
makes them untraceable afterwards, unlike the `clickgraph-test` token. A
declared value for a password field IS typed — the rule was never "do not type
here", it was "do not *guess* here — a guessed password is a failed sign-in
attempt" — so declaring one is a real sign-in attempt against a real account.
A file input stays refused: no string fills one.

**Re-entering the state means re-typing it.** A `fill` edge records the selector
of each field it filled, so returning to a state opened by typing replays the
typing first. Clicking submit again on an empty form lands on the empty-form
branch, which is a different screen with none of the controls the walk came
back for.

## Deterministic app state

Form submissions and other walked controls can change a persistent development
database. Use `--pre` to reset or reseed the app before each run:

```bash
npx clickgraph walk http://localhost:5173 --fill-forms --pre "npm run seed:reset"
npx clickgraph diff http://localhost:5173 --pre "npm run seed:reset"
```

The command runs before the browser opens. A non-zero exit aborts with exit code
2, and the command is recorded in the graph's `WalkConfig` so the baseline says
how it was prepared. Its output goes to stderr, keeping `--json` stdout valid.

`diff` inherits omitted coverage settings such as `--fill-forms`, walk budgets,
settle time, and storage state from its baseline.
Explicit overrides that differ from the baseline produce a prominent warning
and appear in JSON as `configWarnings`. Use `--no-fill-forms` or
`--no-allow-dangerous` to make a safe override explicit.

A recorded `--pre` command and `--allow-dangerous` permission are deliberately
not inherited: loading a graph file must not execute a stored shell command or
authorize destructive clicks. Repeat either explicitly after reviewing it. The
diff warns before walking when the baseline used one and the current invocation
does not.

## Expected route coverage

A walker can only count screens it discovers. If a detail page needs fixture
data that is missing, it otherwise disappears from both the graph and the
coverage denominator. Declare the routes the run is supposed to reach to turn
that silent gap into a failing result:

```text
# routes.txt — one path per line
/
/orders
/orders/:id
/settings
```

```bash
npx clickgraph walk http://localhost:5173 --expect-routes routes.txt
```

Paths are normalized the same way as graph routes, so a discovered
`/orders/1042` satisfies `/orders/:id`. Query strings are ignored, hash routes
are preserved, and blank lines or `#` comments are allowed. This is an
assertion, not a navigation seed: clickgraph still has to reach every route
through the running UI. Missing routes appear under `Not covered`, travel in
JSON as `coverage.unreachedRoutes`, and make both `walk` and `diff` exit 1.

The graph stores both the resolved routes and the manifest path. `diff` re-reads
that inert text file, so adding a route later immediately expands the assertion;
it cannot be frozen out by the old baseline. Pass `--no-expect-routes` to clear
the assertion explicitly. A changed list produces the same
configuration-mismatch warning as other coverage changes. Legacy baselines
that record only a resolved list continue to inherit that list.

## The failure paths

A walk drives an app whose requests all succeed, which makes an entire class of
UI structurally unreachable: error banners, retry buttons, offline and queued
states, and the empty-vs-errored distinction. Not skipped, not unwalked —
invisible. A screen with a fully built error path walks as if it had none.

`--fail-requests` breaks matching requests for the whole walk, so that UI
becomes ordinary walkable state:

```
clickgraph walk http://localhost:3000 --fail-requests "/api/*"          # 500
clickgraph walk http://localhost:3000 --fail-requests "/api/*@503"
clickgraph walk http://localhost:3000 --fail-requests "/api/*@offline"  # dropped
clickgraph walk http://localhost:3000 --fail-requests "POST,PUT /api/*"
```

The method form matters more than it looks: failing *everything* usually leaves
no screen to click, so the useful walks break writes and let reads through.

**Prefer a path over a method when the app has one.** "Writes are POSTs" is not
true everywhere — the first real app this ran against sends its queries over
POST as well, so `POST /api/*` broke the reads, left every screen empty and cut
coverage from 15 states to 9. `--fail-requests "/api/commands/*"` was the walk
that actually proved something.

**The judgment inverts.** Normally a control that produces no observable effect
is the finding. Here, a control that fires a request the walk deliberately broke
and *still* changes nothing on screen swallowed the failure — the user was told
nothing. A control that renders a banner instead is working, and is not
reported. Failures the walk caused are held apart from the app's own in
`injectedFailures`, so a fault run neither condemns itself on load nor buries a
real 500 under a hundred deliberate ones.

Two controls that fire the same request are indistinguishable while it succeeds.
Only breaking it separates them:

```
healthy walk    Sync orders  → network-only     Reload orders → network-only
fault walk      Sync orders  → ERROR: the request failed and nothing visible
                               changed — the failure was swallowed
                Reload orders → showed the user something when the request failed
```

**A fault walk needs its own baseline.** It describes a different app from the
healthy one, so crossing them reports every error screen as missing. `diff`
inherits the baseline's fault automatically — unlike `--pre` and
`--allow-dangerous`, replaying it only makes requests fail, which is strictly
safer than the walk it modifies — and dropping it with `--no-fail-requests`
produces the loudest configuration warning the tool emits.

**Read a fault walk against the healthy one, never alone.** Breaking writes
shrinks the data as the walk goes, so a control that operates on rows the walk
failed to create reads as dead when it is fine — a "Group by" that works on a
populated table has nothing to group once the creates fail. A finding that is
`no-effect` in the fault walk and `state-changed` in the healthy one is about
the missing data, not the control.

What this does *not* catch: an app that renders "Refreshed" after a failed
request. The walk sees that the screen changed, not what it now claims. Telling
a truthful banner from a lying one needs semantics, and this is deliberately
structural.

## Versioned baselines

Every new graph records both the graph-format version and the released
clickgraph version that produced it. `clickgraph --version` (or `-v`) prints the
compiled build; walk and diff JSON include it as `version`. When a diff reads a
legacy baseline with no producer version, or a baseline written by a different
version, it warns that detection changes may be tooling rather than app
regressions. Old graphs remain readable.

In a local checkout, every CLI command also compares `src/` timestamps with the
compiled files it is about to run and warns when `dist/` is stale. `npm run
build` refuses a package/source version mismatch. Released detection changes
still rely on normal semantic-version discipline; provenance is not a hash of
every source edit.

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

Runs the fixture app through eleven scenarios — unchanged (twice, for
determinism), a broken interaction, a new feature with one dead control, the
JSON verdict agreeing with the exit code, an app behind a login screen, a form
that drops its submission beside one that works, pre-walk hooks, baseline
configuration replay, build provenance, declared route coverage, and safely
dismissed browser dialogs. 68 checks,
all passing as of the last commit.

## Tested against real apps

Walked three real codebases, which found bugs the fixture never could. Current results:

| App | Stack | States | Walked | Findings |
|---|---|---|---|---|
| Vite dashboard | React + Tailwind SPA | 32 | 90 (budget) | 0 |
| Marketing site | Next.js App Router | 12 | 82 | 0 |
| App Atlas web | React + React Flow SPA | 40 (budget) | 83 | 0 |

Runs that stop at a budget say so and report what they never reached, rather
than implying they covered everything.

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
- **A form control holding its chosen value is doing its job.** A controlled framework select keeps the choice in the `value` property — no attribute changes, no mutation fires, and the chosen option's text is invisible to the content hash, so every such select read as dead. Value state is now its own effect signal. Inside a form it is benign: the submit is what consumes the choice, and the submit's edge is the proof. Outside a form it stays a finding — a standalone filter that holds the choice while filtering nothing is exactly the planted-defect case.
- **Some effects live in browser chrome, and no snapshot will ever see them.** `window.print()` and a clipboard write have no page-side footprint at all — the sibling of the visual-only case, but looking harder cannot fix it. Shims installed before any page script runs report the invocation instead, which proves the wiring; `print` is swallowed rather than forwarded, because a real print dialog would hang an autonomous walk.
- **A safely declined confirmation is still an observed effect.** Confirm, prompt,
  and alert dialogs are recorded per action and dismissed so an autonomous walk
  never authorizes the guarded branch. The edge says the dialog was raised and
  that its accept branch remains unwalked, instead of calling the control dead.
- **A class on something that is not a control is a state the user can see.** A
  masked PIN entry fills its dots by moving a div from `pin-dot` to
  `pin-dot filled` — no text, no attribute, no rectangle — so all eleven keys of
  a working keypad reported dead at once. Class attributes are now their own
  effect signal, sampled everywhere except on the controls themselves: a click
  lands the pointer and the focus ring on its target, and libraries mirror both
  into class names, so including controls would report an effect for every click
  ever made. The same signal covers step rails, progress bars and a tab
  underline drawn on a div.
- **The walk scrolls to reach a control, and must not take credit for it.**
  Playwright's click auto-scrolls its target, so a reading taken across that
  scroll calls every control below the fold a working scroller — and because the
  visual signal samples viewport-relative rectangles, it was already vouching
  for dead buttons on the strength of the walk's own movement. The scroll now
  happens first and deliberately, and the baseline is re-read from where the
  click will actually land. What is left between the two readings is the action:
  a back-to-top button, a jump link, a carousel arrow moving a strip.

## Layout

| Path | What |
|---|---|
| `src/walker.ts` | breadth-first exploration, budgets, safety rules |
| `src/observer.ts` | in-page control extraction, selector derivation, outcome classification |
| `src/fingerprint.ts` | two-tier state identity |
| `src/graph.ts` | save/load and the graph diff |
| `src/report.ts` | human-readable output |
| `fixture/server.js` | demo app with deliberately planted defects |

## Next

See [ROADMAP.md](ROADMAP.md). The short version: make the inner loop faster —
a walk costs about 2.9s per action on a real app and almost all of it is the app
reloading — then the App Atlas pairing and a graph viewer. The LLM healer comes
last, on purpose: the deterministic core has to earn trust first.

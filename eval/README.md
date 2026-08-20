# eval — measuring clickgraph against real change

The fixture proves the walker handles the cases we already thought of. This
directory measures it against cases nobody planted: real repos, real history,
and deliberately broken apps with known answers. Three tracks, each measuring
a different thing, none a substitute for the others:

| Track | Harness | Measures | Why history/mutation and not the other |
|---|---|---|---|
| 1. History replay | `replay.mjs` | **Specificity** — the noise floor | History is real but unlabeled; almost every merge is a change that did *not* break the UI, so any regression flagged on one is probably noise |
| 2. Mutation | `mutate.mjs` | **Sensitivity** — detection gaps | Planted bugs have known answers, so "caught N of M" is a real number; history can never give you that |
| 3. Live dogfood | (no harness) | The **agent loop** — skill, verdict, UX | An agent building a feature with the skill installed; ROADMAP Phase 1. Tracks 1–2 test detection and never test this |
| 4. Equivalence | `equivalence.mjs` | **Self-consistency** — that a cheaper walk is the same walk | Tracks 1–2 compare clickgraph against an app. This compares clickgraph against itself, which is the only way to buy speed without quietly paying in correctness |

Every run needs a build first: `npm run build` at the repo root.

## Track 1 — history replay (`replay.mjs`)

```bash
node eval/replay.mjs eval/targets/self.json            # clickgraph's own history
node eval/replay.mjs eval/targets/self.json --pairs 3  # quick pass
```

For each of the last N first-parent merge commits of the target repo, the
harness clones the repo into scratch space (`eval/.work/`, never your
checkout), walks the app at the merge's **parent**, then diffs at the
**merge** — the closest replayable analog to "an agent just finished a task,
did the tool cry wolf?".

Each pair lands in `eval/results/replay-<name>-<time>.jsonl` with one of four
outcomes:

- **clean** — diff exit 0. The overwhelmingly common right answer.
- **flagged** — diff reported regressions. Triage each one by reading the
  merge: if the merge really did break/plant something, it is a true positive
  (on the fixture target this is common — planted defects arriving in history
  are supposed to be flagged). Anything else is noise, and **each noise class
  becomes a GitHub issue**, same as the false-positive rules in the README.
- **env-failed** — the target would not install/serve at that commit. Fix the
  target config or accept the gap; it is counted, never silently dropped.
- **tool-failure** — clickgraph itself crashed or printed no verdict. The most
  valuable outcome; file it immediately.

The headline metric is the **flag rate over measured merges** after triage
subtracts the true positives. The goal is a demonstrated-quiet tool: "walked
N real merges, flagged only the ones that deserved it."

### Adding an external target

Copy `eval/targets/self.json`, then vet the candidate **before** spending an
evening on it:

1. **Self-contained.** No external services, no API keys; sqlite or in-memory
   or a bundled backend. If it needs a seeded database, the config's `install`
   / `build` / `env` fields plus a deterministic seed command must cover it.
2. **DOM, not canvas.** The walker reads DOM; an app that draws everything
   into `<canvas>` gives it nothing to hold.
3. **Old commits still run.** Check out a commit from ~6 months back and run
   the install+serve commands by hand. Dependency rot is the practical killer;
   if this fails, pick another repo, don't fight it.
4. **Real surface.** Routes, forms, lists — an app with three buttons measures
   nothing.

Candidate shapes that tend to pass: local-first apps (Actual Budget family),
self-hosted dashboards with a docker/sqlite dev mode, RealWorld ("Conduit")
implementations. Recent history only — last 6–12 months of merges.

Config fields: `name`, `repo` (path/URL; `"."` = this repo), `branch`, `url`,
`serve`, optional `install`, `build`, `env`, `pairs`, `readyTimeoutMs`,
`walkArgs` (e.g. `["--max-actions", "120"]` to cap long walks).

## Track 2 — mutation (`mutate.mjs`)

```bash
node eval/mutate.mjs eval/mutations/fixture.json
node eval/mutate.mjs eval/mutations/fixture.json --only refresh-dead
```

Walks a clean baseline, then applies one mutation at a time — a literal
find/replace that unwires a handler, breaks an endpoint, inerts a link — and
checks that `diff` reports a regression matching `expect.match`. Files are
restored byte-for-byte after each mutation. Exit 0 means every planted bug
was caught; anything else exits 1 so CI can gate on it.

- A **MISSED** mutation is a detection gap with a reproduction attached — file
  it as an issue before touching the code.
- A **STALE** mutation means the target file drifted; update the `find` string.
- Keep mutations *fair*: only break things the README claims clickgraph can
  see. A mutation that changes copy to something **semantically** wrong
  ("Refreshed" → a lie that still reads as English) tests judgment the tool
  does not have; documented blind spots live in the README, not here.

  This rule was drawn one notch too wide, and it cost months. "Does the tool
  judge this copy?" and "does the tool notice this copy changed?" are different
  questions, and excluding the first quietly excluded the second — so no
  mutation ever reworded anything, and nobody found out until a real app
  reworded every cell of a table and `diff` answered **"No change"** (issue
  #48). Noticing is fair game and always was. Judging is not.

- `expect.severity` says which list the finding has to land in. Default
  `"regression"`: the diff must exit 1 and name it. `"info"`: the diff must
  exit **0** and report it under `other` — the tool is right to say the screen
  changed and wrong to call it a defect.

  Both are detection, and a harness that only counts regressions will report
  perfect sensitivity to the only thing it can see. That is exactly how the gap
  above stayed invisible to a file whose entire job is finding gaps.

When an external replay target is vetted, give it a mutation file too —
planted bugs in a real app's DOM are worth more than the same bugs in the
fixture, because real DOM is where the last ten false-positive classes came
from.

## Track 4 — fast-vs-slow equivalence (`equivalence.mjs`)

```bash
node eval/equivalence.mjs --control                 # run this FIRST, see below
node eval/equivalence.mjs                           # slow vs fast
node eval/equivalence.mjs --only kiosk              # one scenario
PORT=4179 node eval/equivalence.mjs                 # move off 4177
```

Walks the same app twice and asserts the two graphs are the same. It exists
for issue #23: the walk re-enters a known state by taking a walked edge back
to it rather than reloading the base URL and replaying every click, and those
two ways of arriving are **only** interchangeable on an app that keeps nothing
in memory a reload would clear. That is not most apps, and it is emphatically
not the apps this tool is for — so the speed-up is worth nothing without a
check that can fail.

What is compared: nodes (id, url, title, structure, control count, recorded
path), edges (from, action, destination, outcome — as a multiset *and* in
order), every skip with its reason and detail, and the coverage totals. What
is excluded: the walk timestamp, and the config that names the mode. Nothing
else, because an equivalence check that narrows its own scope proves whatever
it was narrowed to.

**Run `--control` first.** It runs the *same* configuration on both sides, so
anything it reports is walk nondeterminism rather than a routing bug. That
number is the floor under every other result here: a comparator that cannot
tell two identical runs apart has no standing to testify about two different
ones. A control run that diverges is the thing to fix first.

Scenarios live in `eval/targets/equivalence.json`, and the interesting ones
are chosen for what they can break rather than for coverage:

- **kiosk** — six screens mounted at once and switched in memory. A reload
  loses what a route keeps; if routing is unsound anywhere, it is here.
- **about** — a panel opened by a self-loop, whose controls exist only while
  it is open, so re-entry timing is observable.
- **keypad** — accumulates state in the DOM and in no heading, so the
  fingerprint the arrival check uses cannot see it.
- **tab-app** — walked with a real session replayed, so one scenario has a
  session to lose.
- **whole-app** — the deep walk with `--fill-forms`, which is where the cost
  being traded actually lives.

Each side gets its own freshly started server, so accumulated server state
cannot be mistaken for a routing difference. Exit is non-zero if any scenario
diverges or fails to run.

**Port 4177**, deliberately not the 4173 that `replay.mjs` and
`scripts/verify.sh` both use — those two already kill each other's fixtures,
and this harness runs long enough to be tempting to start alongside one.

## The cadence

- **After any detection change** (walker, observer, fingerprint, graph diff):
  run the fixture mutations. They are the sensitivity regression test.
- **After any change to how the walk moves** (re-entry, routing, budgets, the
  frontier): run equivalence, control first. A change that makes the walk
  cheaper is a change to what it finds until that says otherwise.
- **Before a release / after a big refactor**: run replay on every target.
  Compare the flag rate with the last run's; a rising flag rate is a
  regression in clickgraph even if every individual flag looks defensible.
- **Findings become issues.** A noise class, a missed mutation, or a tool
  crash gets a GitHub issue with the JSONL row pasted in. The result files
  themselves are gitignored scratch; the issues are the durable record.
- **Track 3 keeps running regardless**: the next real UI feature built by an
  agent ends with a clickgraph diff (ROADMAP Phase 1), because no replay can
  tell you whether the *verdict* steers an agent well.

## Unattended runs

Everything is plain Node and writes incrementally to `eval/results/`, so a
run can be left alone and read later:

```bash
npm run build
node eval/mutate.mjs eval/mutations/fixture.json 2>&1 | tee eval/results/mutate.log
node eval/replay.mjs eval/targets/self.json      2>&1 | tee eval/results/replay.log
node eval/equivalence.mjs --control              2>&1 | tee eval/results/control.log
node eval/equivalence.mjs                        2>&1 | tee eval/results/equivalence.log
```

On macOS, prefix the long command with `caffeinate -i` so the machine does
not sleep mid-walk. The summaries at the bottom of each log are the place to
start reading; the `.jsonl` files beside them hold the full record per pair
and per mutation.

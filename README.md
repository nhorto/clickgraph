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

Exit codes: `0` no regressions, `1` regressions found, `2` usage/runtime error — so an agent or CI can gate on it.

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

Runs the fixture app through three scenarios — unchanged (twice, for determinism), a broken interaction, and a new feature with one dead control — and asserts on the output. 14 checks, all passing as of the last commit.

## Tested against real apps

Walked three real codebases, which found bugs the fixture never could. Current results:

| App | Stack | States | Walked | Findings |
|---|---|---|---|---|
| Vite dashboard | React + Tailwind SPA | 15 | 28 | 1 (an active nav item with no `aria-current`) |
| Marketing site | Next.js App Router | 6 | 42 | 0 |
| App Atlas web | React + React Flow SPA | 14 | 26 | 0 |

Every false positive those runs exposed is now fixed, and each fix is a rule worth keeping:

- **A broken app must not walk clean.** App Atlas's UI was 502ing on every API call; it rendered no buttons, so there was nothing to click, so the report was empty and the exit code was 0. Entry-page health is now recorded and reported first.
- **Not every 4xx is a defect.** An endpoint that answers 404 to mean "this optional thing does not exist" is not a bug when the app handles it. 5xx and uncaught exceptions still fail; a 4xx with *nothing visible happening* still fails, because that silent failure is real.
- **Already-active controls are not dead controls.** A link to the current page, or the tab already selected.
- **Some controls answer to hover, not click.** A dashboard of glossary terms opened tooltips on `pointerenter` while the click handler toggled them shut — sixteen working tiles read as dead. Probing hover requires moving the pointer away first, or you re-hover an element the mouse never left and test nothing.

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

- Seed the walk from an App Atlas route map instead of discovering blind, and report static/dynamic disagreement.
- Emit a replayable script per verified edge so the inner loop replays instead of re-walking.
- Form input (v1 only clicks), auth/session support, network mocking for isolation.
- The LLM healer: same-state-redesigned vs. new-state vs. broken, with confidence surfaced.
- Mobile via an adapter (Maestro), once the graph format has settled.

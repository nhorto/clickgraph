---
name: clickgraph
description: Verify a web UI you just built actually works. Walks the running app headlessly, clicks every control, and reports the ones that do nothing or error. Use after building or changing UI, before telling the user the work is done.
---

# clickgraph

You built or changed a UI. This tells you whether it works, without taking over
the screen and without asking the user to click through it.

It drives the running app in a headless browser, clicks every visible control,
and classifies what each one did. The finding that matters most is a control
that renders but produces no navigation, no state change, and no network
traffic — a button wired to nothing.

## When to use this

- After building or changing anything the user clicks. This is the main case:
  you added a button, so prove the button does something.
- Before reporting a UI task complete.
- After a refactor that touched routing, handlers, or component wiring.

Do not use it when nothing user-facing changed, or when there is no running dev
server and starting one would be intrusive.

## Running it

The app must already be running. Never start a dev server the user did not ask
for — check for one first, and if there is none, say so instead of guessing a
port.

First time in a repo, record a baseline:

```bash
npx clickgraph walk http://localhost:5173 --json
```

After that, on every change, diff against it:

```bash
npx clickgraph diff http://localhost:5173 --json
```

`walk` writes `.uigraph/graph.json`. Commit that file — it is the baseline the
diff compares against, and it reviews like any other file in a pull request.

Exit codes: `0` healthy · `1` regressions found, or the app was unhealthy on
load · `2` usage or runtime error.

Useful flags: `--max-actions <n>` and `--max-depth <n>` to bound a big app,
`--settle <ms>` to raise the DOM-quiet period if working controls look dead in
an app that updates late.

## Reading the verdict

`--json` prints a compact object, not the whole graph. Read `ok` and `verdict`
first; they are the answer.

From `walk`:

```json
{
  "ok": false,
  "verdict": "of 28 interaction(s) walked, 1 errored and 1 produced no observable effect",
  "load": { "healthy": true, "errors": [], "interactiveFound": 12 },
  "findings": [
    { "severity": "error", "control": "button \"Save settings\"", "state": "/settings",
      "detail": "500 POST /api/save" },
    { "severity": "no-effect", "control": "button \"Export\"", "state": "/orders",
      "detail": "no navigation, no state change, no network traffic" }
  ],
  "coverage": { "states": 6, "walked": 28, "unwalked": 0, "skipped": [...] }
}
```

From `diff`, read `regressions` — those are actionable now. `other` is context;
a new working control shows up there and is not a problem.

## Rules for acting on it

**`ok: true` with `walked: 0` is not a pass.** It means nothing was exercised.
Check `load.healthy` and `load.interactiveFound` — an app that fails to load
renders no controls, so there is nothing to click and nothing to report. The
verdict string says so; do not translate it into "no issues found".

**Unwalked is not working.** `coverage.unwalked` and `coverage.skipped` are
controls nobody proved anything about. Never describe a run as verifying the
whole UI. If coverage matters to the claim you are about to make, state the
numbers.

**A finding is a lead, not a verdict.** Before reporting a broken control, open
the code for it and confirm. Real causes seen in practice: the control genuinely
answers to hover rather than click; it is a link to the page you are already on;
the request that failed was a 404 the app handles on purpose. The tool already
filters known-benign cases, but it works from the outside and cannot read
intent.

**Destructive controls are skipped, not tested.** Delete, sign out, pay and
similar are refused by default and reported as skipped. Do not report them as
working, and do not reach for `--allow-dangerous` unless the user has said the
environment is disposable.

**Report the finding, not the fix, unless asked.** If the user asked you to
build something, fixing a control you just broke is in scope. Findings in code
you did not touch are worth surfacing, not silently rewriting.

## What it cannot do yet

Clicks and hovers only — it does not type into forms, and it has no
authentication support, so it cannot walk past a login screen. If the app needs
a login, say that rather than reporting a clean walk of the login page.

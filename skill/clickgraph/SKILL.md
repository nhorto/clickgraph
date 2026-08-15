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

Exit codes: `0` healthy · `1` regressions found, or the run proved nothing ·
`2` usage or runtime error.

Useful flags: `--max-actions <n>` and `--max-depth <n>` to bound a big app,
`--settle <ms>` to raise the DOM-quiet period if working controls look dead in
an app that updates late.

## The fast check: `--replay`

A plain `diff` explores the app from scratch every time, which means reloading
the page before nearly every click. `--replay` uses the baseline's map instead —
it knows where each control led, so a control that navigates carries it into the
next screen rather than costing another reload. Same interactions, roughly half
the time.

```bash
npx clickgraph diff http://localhost:5173 --replay --json
```

Use it as the ordinary check while you work. It reads the live page at every
state it visits, so **a control you just added to an existing screen is still
tested** — that is the common case and replay covers it fully.

What it does not do is go looking for screens the baseline never knew. If your
change added a whole new route or a new modal, replay will walk into it, decline
to open it, and tell you so:

```json
{ "ok": false, "regressions": [],
  "verdict": "no regressions; 3 non-breaking change(s) — but 1 new screen(s) were reached and not explored; replay stops at the edge of its baseline, so re-walk to cover them",
  "coverage": { "mode": "replay", "statesUnexplored": 1 } }
```

`ok` is false there with zero regressions on purpose. It is not a failure —
it means the run could not answer the question. Re-walk to take in the new
screen and refresh the baseline:

```bash
npx clickgraph walk http://localhost:5173 --json
```

Then keep replaying. Do not report a replay with `statesUnexplored > 0` as a
pass; the screen you just built is the one it did not open.

## Apps behind a login

If `load.likelyAuthWall` is true, the run describes the login page and nothing
else. `ok` is false for exactly that reason. Do not report it as a pass, and do
not try to sign in yourself — never type credentials into the app.

Tell the user to run this once, sign in themselves in the window that opens, and
press Enter:

```bash
npx clickgraph login http://localhost:5173
```

That saves `.uigraph/session.json`, which holds live cookies. It must stay out of
git — never commit it, paste it, or read its contents. From then on:

```bash
npx clickgraph diff http://localhost:5173 --storage-state .uigraph/session.json
```

A diff whose only regression is "the entry page now looks like a login screen"
means the session expired, not that the app broke. Say so, and ask for a fresh
`login` run rather than chasing it as a bug.

## Forms

A form is only proven by filling it in and submitting it. Clicking its submit
button with the fields empty tests nothing — the browser refuses the submission
and no code runs — so by default forms are reported as skipped, with the reason,
and never as working.

`--fill-forms` fills every field with obviously synthetic values (they all
contain `clickgraph-test`) and submits. That writes real data, so treat it the
way you treat `--allow-dangerous`:

- Use it when the thing you just built **is** a form, against a local dev server
  whose data does not matter.
- Ask the user first for anything shared, staged, or pointed at a real database.
- Never use it to get past a login screen. Password fields are never typed into,
  and a form containing one is skipped whole — a wrong password is a failed
  sign-in attempt, which means rate limiting or a locked account.

```bash
npx clickgraph walk http://localhost:5173 --fill-forms --json
```

A submitted form that comes back `no-effect` is the finding this is for: it
accepted what you typed and did nothing with it. Rows the run created are
greppable by `clickgraph-test`; say so if the user may need to clean them up.

This covers loose fields too — the common React shape of some inputs and a
button with no `<form>` around them. The grouping gets inferred from layout, but
only where it is unambiguous: a field with exactly one button in reach joins it,
and a field with two nearby buttons is left skipped rather than guessed at. So a
control reported `needs-input` on a form-less screen may mean the fields could
not be grouped, not that they were empty — the skip reason says which. If you
built such a screen and want it actually exercised, `--fill-forms` is what
reaches it.

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

**A replay is bounded by its baseline.** `coverage.mode` tells you which kind of
run produced the answer. A clean `replay` means the states the baseline knew
still behave; it says nothing about a screen added since, and
`coverage.statesUnexplored` counts the ones it reached and left shut. Re-walk
before claiming the change is verified.

Each skip carries `examples` explaining what the reason meant, and they are
worth reading rather than counting. `unreachable` in particular covers two very
different things: controls in a panel or drawer the walk never opened, which is
an ordinary coverage gap, and controls covered by something else on the page,
which can mean a dialog was left open — if a whole screen's worth of controls
comes back that way, say so rather than treating the run as complete.

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

It clicks, hovers, chooses from a `<select>`, and — with `--fill-forms` — fills
and submits a form, whether the app declared one or the grouping had to be
inferred from layout. It does not drive anything else: a drag, a canvas, a file
upload, a field whose submit button is ambiguous, or a multi-step wizard that
needs a specific value to advance. Those come back as skipped, which means
untested, not working.

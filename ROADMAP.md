# Roadmap

The ordering principle: **the biggest risk is not a missing feature — it is that
no agent has ever used this mid-task.** The customer is the coding agent that
just built a UI and needs to know whether it works. Every phase either closes
that loop or widens what the loop can reach. Real usage re-ranks everything
below it; that is why dogfooding comes first, not last.

Status marks: `[x]` done · `[ ]` planned. Items move between phases when usage
proves the ordering wrong.

## Phase 1 — into the loop

Make an agent actually use clickgraph while building something, and let the
friction rank the rest of this file.

- [x] `--json` emits a compact machine-readable verdict for `walk` and `diff`
      (the full graph stays in the graph file and `show --json`)
- [x] A Claude Code skill (`skill/SKILL.md`) that teaches an agent when to
      walk, when to diff, and how to read the verdict
- [x] CI on this repo: `scripts/verify.sh` runs on every push
- [x] First dogfooding pass found two false-positive classes the fixture could
      not: a control that opens a panel looks dead once that panel is open
      (which also settles the `aria-current` ambiguity), and a `<select>` can
      never be verified by clicking. Both fixed.
- [ ] Dogfood continuously: the next real UI feature built by an agent ends
      with a clickgraph diff; every friction point becomes a tracked issue
- [x] Measurement harnesses in `eval/` (see eval/README.md): replaying a
      target repo's merge history puts a number on the noise floor — the
      cry-wolf failure mode — because history is real but almost never broken;
      planted mutations with known answers put one on detection, because
      "caught N of M" is only measurable when the bugs are labeled. Findings
      become issues; the run cadence is in the doc.

## Phase 2 — past the login screen

The tool is currently locked out of most real apps at the front door.
Deliberately split in two, because one half is much cheaper than the other:

- [x] Auth via session reuse: `--storage-state <path>` walks signed in, and
      `clickgraph login <url>` captures the session by opening a browser and
      waiting while a human signs in. A login screen on the entry page is
      detected, reported, and fails the run — a gated app used to walk its own
      login form and call it clean.
- [x] Selects are walked by choosing an option the control is not already
      showing, rather than clicked. A real dashboard's filter went from a false
      finding, to an honest skip, to a control proven to work.
- [x] Text fields and textareas are skipped as `needs-input` instead of
      clicked. This was the largest false-positive class left: a click on a
      text field focuses it and changes nothing, so every search box and every
      form field in every app was being reported as a dead control.
- [x] Form flows, which is the feature per-field typing only looks like.
      Filling one field proves almost nothing on its own: an input's value is
      not part of the state fingerprint, so a working field looks inert, and
      the walker resets between actions so a value typed for a later submit is
      gone before the submit happens. `--fill-forms` fills every field and
      clicks the submit as one action, with values that all contain
      `clickgraph-test` so anything the run creates is greppable. Opt-in and
      skipped-with-a-reason by default, like the destructive patterns, because
      a submission that succeeds writes real data.
- [x] Writing it surfaced a false positive nothing had exercised yet: clicking
      the submit button of an *unfilled* form fires native validation, which
      refuses the submission and changes no DOM — identical, from the outside,
      to a button wired to nothing. Every signup, login and checkout form in
      every app was being reported broken. The browser's own `checkValidity`
      answers it, and the form is now reported as skipped until something
      fills it in. This one came from thinking the feature through rather than
      from a real app, which is the first time that has happened.
- [ ] Field clusters that are not inside a `<form>` element — the React
      pattern of some inputs and a handler-bound button. There is no grouping
      to key on, and guessing one wrong means typing into fields that do not
      belong together. Currently skipped, which is honest, and a real gap.
- [ ] Keep walking new real apps; each one so far has found a false-positive
      class the fixture could not (see README).
- [x] `--fail-requests` makes matching requests fail for the whole walk, so
      error banners, retry buttons and offline states stop being structurally
      invisible (issue #15). The judgment inverts: a control that fires a
      failing request and changes nothing swallowed the failure, and that is
      the finding; one that renders a banner is working. The dogfooding app's
      entire error surface — every retry control, and a queue UI that only
      renders when a send fails — had component tests as its only automated
      proof, because no walk could reach any of it.
- [ ] Named scenarios (`--scenario offline`) and a request-interception hook,
      the other two shapes issue #15 sketched. Blanket mode first, because one
      extra walk diffed against its own baseline covers most of the value; a
      second real app should rank these before they get built.

## Phase 3 — a fast inner loop

Speed is the real ceiling, and the first diagnosis of it was wrong.

The 2.9 seconds per action measured on a real dashboard was read as the app
reloading. It was not. 150 of those 220 seconds were thirty controls that could
not be found at all, each one waiting out Playwright's five-second default
before being written off — a tool bug wearing an app's clothes, and an average
per-action figure was exactly the wrong instrument to see it with. Fixing the
selectors and shortening the wait took the same walk to 108 seconds and from 60
interactions to 77; respecting `inert` took it to 32 states and 90 interactions.
What is left is about 1.2 seconds per action, and *now* the reloads are the
biggest remaining term.

- [x] **Found and fixed: the walker could not find its own controls.** See the
      README's list of rules. The lesson worth keeping is the measurement one —
      the per-action average hid a failure mode that had nothing to do with the
      thing it was being used to argue about.

It is this project's own bottleneck too. Adding two routes to the fixture took
one walk from 31 to 49 seconds and `verify.sh` to eight minutes — the suite is
ten walks, and it is the thing standing between an idea and knowing whether the
idea worked.

- [ ] Per-edge replay scripts: `diff` currently re-explores everything.
      Replaying the baseline's known edges deterministically is the cheap
      inner loop; exploration becomes occasional, replay runs on every change.
- [ ] Cut the number of reloads, which is where the time actually goes.
      Ordering the frontier so consecutive actions share a source state, or
      walking several states at once in separate browser contexts. Reaching a
      state by clicking through the running app, rather than reloading into it,
      is the version of this that would help a single-page app.
- [x] **Measured and rejected: entering a state by navigating straight to its
      URL.** The intuition was that replaying a path costs a reload plus every
      click on the way in. Interleaved A/B on a real dashboard: 175.5s replay
      vs 176.4s direct — no gain, marginally worse. Two reasons, both
      instructive. Most of that app's states share a single URL, so the direct
      attempt never matched and every one was wasted work. And where it does
      match, a direct navigation is still a reload — the same cost the replay
      was already paying. Anything that keeps reloading per action cannot win;
      the next attempt has to remove reloads, not reroute them.

## Phase 4 — the pairing and the showpiece

- [ ] Seed the walk from an App Atlas route map instead of discovering blind,
      and report static-vs-dynamic disagreement as its own findings section.
      The static map is a hint, never ground truth — where map and walk
      disagree, the disagreement is the report.
- [ ] Graph visualization: a viewer over `graph.json`, as a separate optional
      package so the CLI stays headless. This serves adoption more than the
      agent customer — it is the demo, not the product.

## Phase 5 — the AI layer (deliberately last)

The deterministic core has to earn trust before an LLM judges anything.

- [ ] The healer/judge: same-state-redesigned vs. new-state vs. broken, with
      confidence surfaced rather than asserted.
- [ ] Mobile via an adapter (Maestro), once the graph format has settled.

## Cross-cutting

- [ ] Publish to npm once the CLI surface stabilizes (likely after Phase 2) —
      that is what actually locks the name.
- [x] Resolved: an active nav item without `aria-current` used to be
      indistinguishable from a dead control. The already-applied rule settles
      it without depending on the app's ARIA hygiene.

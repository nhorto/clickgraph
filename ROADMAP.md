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
- [ ] Form flows, which is the feature per-field typing only looks like.
      Filling one field proves almost nothing on its own: an input's value is
      not part of the state fingerprint, so a working field looks inert, and
      the walker resets between actions so a value typed for a later submit is
      gone before the submit happens. The unit that means something is the
      whole form — fill every field, then click its submit, as one action —
      with values obviously synthetic so anything it creates is traceable.
      Needs the dangerous-pattern treatment: submitting real forms writes real
      data, so it should be opt-in and skipped-with-a-reason by default.
- [ ] Keep walking new real apps; each one so far has found a false-positive
      class the fixture could not (see README).

## Phase 3 — a fast inner loop

Speed is the real ceiling: a walk of a real dashboard costs about 2.9 seconds
per action against 0.6 on the local fixture, and the difference is almost
entirely the app reloading. A bounded 60-action walk takes just under three
minutes; the App Atlas UI ran past ten and still hit its state budget.

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

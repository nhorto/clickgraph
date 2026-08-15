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
- [x] **Field clusters that are not inside a `<form>` element** — the React
      pattern of some inputs and a handler-bound button. There is no grouping to
      key on, so it is inferred from layout, and the shape of the inference is
      the whole design: a field joins a cluster only when exactly one button is
      in reach of it, within six ancestor levels, links not counted. Two buttons
      and it stays skipped exactly as before, because guessing wrong means
      typing into fields that do not belong together, and that is a worse
      failure than not typing at all.

      The part that was not obvious until it was written: this is the empty-form
      false positive again, with the browser's answer removed. `checkValidity`
      is what stops a walk calling an unfilled form's submit button dead, and
      there is no form here to ask — so the fields are read directly, and a
      cluster with an empty one is reported as needing input. That check is
      one-way, like the one it mirrors: unreadable counts as filled, so it can
      hold back a click but never invent a reason to make one.

      Both halves are verified, because a rule that only ever refuses cannot be
      told from a rule that does nothing: the unfilled cluster is skipped with a
      reason rather than called dead, and `--fill-forms` fills the inferred
      cluster and proves its button really works — while the field beside two
      buttons is still never typed into.
- [x] **A control whose whole effect is geometric.** Dogfooding the cluster work
      turned this up without going looking for it: App Atlas's React Flow canvas
      reported Zoom In, Zoom Out and Fit View as dead controls. All three work.
      Each rewrites one CSS transform on the viewport and moves not a word of
      text and not one control — which is everything the fingerprint is built
      from — so the tool's central finding, `no-effect`, was being produced by
      the tool's own blind spot.

      It gets its own outcome kind rather than being folded into
      `state-changed`, because what is known about it is weaker: the geometry
      moved, not the content. The hard part was scope, since the obvious fix
      trades this false positive for its opposite — a signal broad enough to
      catch any movement would let a genuinely dead button hide behind an
      unfinished animation. So it watches scroll position and *inline*
      transforms, which is how JS-driven pan and zoom is actually implemented,
      and specifically not element rectangles. The fixture screen puts a dead
      button beside the working zoom, because that is the half that can regress
      quietly.

- [x] **A control that says "you are here" in CSS.** The last finding left
      standing on App Atlas after the canvas fix was its breadcrumb: a button
      named `@app-atlas/cli`, on the screen whose URL is `app:@app-atlas/cli`,
      marked `class="crumb is-current"` and carrying no ARIA at all. Clicking it
      changes nothing, correctly, and all three existing rules missed it — no
      `aria-current` to read, no href to compare, and the walk arrived by a
      different control so it was never already-applied.

      What makes it worth writing down is the shape of the fix rather than the
      bug. Trusting a class name is trusting the app's private vocabulary, and
      `active` on a genuinely broken button would excuse it — trading this false
      positive straight for its opposite. So the class is only half: the control
      must also name the place the browser is already at. That pairing is the
      same move the canvas fix made, and it is becoming the pattern for this
      whole category — one weak signal is a guess, two independent weak signals
      agreeing is evidence.

- [x] **A select whose only effect is its own value** (issue #5). A controlled
      React `<select>` was reported NO EFFECT on every choice: React writes the
      value as a property, so no attribute mutates and no text is rewritten, and
      the closed control's new text is painted by the browser rather than held
      in the DOM. There is nothing for a snapshot to compare.

      The issue arrived with a suggested fix — treat "the value changed" as a
      working control — and it is wrong in the way this category keeps being
      wrong. The browser sets the value whether or not the app is listening, so
      that rule is just as true of the fixture's region filter, which is a
      planted defect. It would have silenced an existing check, which is how it
      was caught: the cure and the disease are the same sentence.

      The pairing that holds is a consumer. A select inside a form with a submit
      has one by construction, so silence at selection time proves nothing and
      the submit is where the proof lives; a select with nothing to submit it
      has no later moment, so silence is the whole defect. `value-set` is its
      own outcome and deliberately weaker than `state-changed` — the control
      accepted the value, which is not the same as anything having read it.

      The guard is the third case on the fixture screen, and it is the bug a
      controlled select actually has: a handler that never commits means React
      restores the old value, so the control cannot be changed at all. It sits
      in the form like the working one, so form membership had to stay necessary
      without becoming sufficient. The value is read back, and that also fixed a
      report that lied — the finding used to say an option had been `set to` a
      value the control had refused.

- [x] **The same bug, hiding instead of accusing.** Chasing the above turned up
      why `--fill-forms` skipped forms with required selects: it filled them by
      asking for "an option this is not already showing", which is the right
      question for testing a select and the wrong one for filling a form. A walk
      does not reload between actions in one state, so a select still shows what
      the previous action chose, and "something else" comes back around to the
      empty placeholder — the one value that makes the form invalid. The submit
      was then skipped as `needs-input` and never tested.

      Worth its own entry because of how it presented. Every other item here is
      a false finding, which is loud. This one produced a skip, and a skip reads
      as the tool being careful. It affected every form with a required select
      in every app, and it was found by following a different bug.

- [ ] Keep walking new real apps; each one so far has found a false-positive
      class the fixture could not (see README). Five for five now, and the last
      two both arrived while dogfooding an unrelated change rather than from
      going looking. The sixth came from an issue rather than a walk, and its
      suggested fix would have broken an existing check — a report of a false
      positive is evidence that something is wrong, not a diagnosis.

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
idea worked. (The suite is not the thing `--replay` fixes: most of its scenarios
change the app deliberately, and a walk is what they are checking.)

- [x] **Per-edge replay, and the reload cut, turned out to be one item.**
      Replay was planned as the cheap inner loop, and measuring it first showed
      why it could not be: replaying the same edges pays the same reloads, so
      on its own it saves nothing. What it changes is what is *knowable*. On the
      fixture, 52 re-entries cost 43 of a 72-second walk — 60% of the time spent
      returning to a screen the browser had just been on — and a walk cannot
      avoid them, because it does not learn where a control goes until after it
      has clicked it and lost its place. A baseline already knows. So the
      replay is routed: do everything in a state that leaves the page where it
      is, then leave by an edge that lands somewhere with work still waiting,
      which turns the exit into the next arrival. 52 reloads became 12, and 71
      seconds became 42, over the identical 59 interactions.

      Two things this had to not break. The baseline orders the route and
      nothing else — where each control leads *now* is still measured after
      every action, so a changed app re-plans rather than mis-reports. And a
      replay covers less than a walk, which only stays acceptable while it is
      said: a screen the baseline never knew is walked into, left unopened, and
      reported, and that run exits 1 with no regressions rather than claiming a
      pass. Writing that case into the fixture was worth more than the speed —
      without it the fast path would have quietly bought its speed by going
      blind to exactly the screen an agent had just built.

- [x] **The replay reports what a full diff reports, measured at last.** The
      standing caveat was that every app clickgraph had been pointed at walked
      clean, so the two modes were known to cover the same ground and had never
      once been shown to *find* the same things — which is the only property
      anyone actually reaches for the fast path to get.

      App Atlas could not answer it, because after the canvas and breadcrumb
      fixes it reports nothing at all. So the defects were injected from
      outside: a proxy in front of it that stops named controls from reaching
      their handlers on the way through, which leaves the app's own source
      untouched and breaks controls in the shape that matters — still rendered,
      still named, still clickable, and now doing nothing. React's delegation is
      why it has to be done that way; there are no listeners on the elements to
      remove, so a capture-phase listener above the root is what intercepts.

      Ten working edges broken across five states. Both modes returned 14
      regressions and the same 12 distinct findings — the ten broken controls
      and the four states that became unreachable behind them. Zero
      disagreement in either direction, cascade included.

      The only difference was in how they *named* a state: a full walk says
      `on /#overview`, a replay says `on /#overview [Where to start reading]`.
      Not instability — the bracket is a disambiguator that appears when several
      states share a route, and the replay's graph has 128 states against the
      walk's 40, so routes that were unique in one need distinguishing in the
      other. Worth knowing before diffing report text across modes: compare
      findings, not sentences.

- [x] **Dogfooding the replay found something worth more than the replay.**
      Pointed at App Atlas — 2,086 controls, a 200-action budget — and it
      reported 97 regressions against an app that had not changed. The baseline
      walked one tenth of the controls, the replay walked a different tenth, and
      the diff called the difference between two samples 87 controls gone and 10
      broken on arrival.

      The trigger was mine: reordering traversal is exactly what replay does,
      and under a budget the order decides which controls fall inside it. The
      reading underneath it is older — a control absent from a graph means
      either "not there" or "never reached", and the diff only ever read it the
      first way.

      How far that reaches was worth measuring rather than assuming, and the
      guess was wrong. Two full walks over the same truncated app, on the same
      code that produced the 97, came back clean. Deterministic traversal
      samples identically, so plain `diff` does not trip this by itself; it
      took reordering to expose it, and calling it a long-standing bug in
      `diff` would have been a nicer story than the true one. Whether a change
      that shifts where the budget falls could trip it as well is untested. The
      fix sits in the diff regardless, because the reasoning never depended on
      which run did the reordering.

      Fixed in both places: a run that stopped short of a screen reports the
      controls it did not reach as a coverage gap, and the replay's budget now
      has the baseline's own edge count as its floor, so the comparison set is
      whole before anything new is walked.

      Getting the second half right took three tries, and the two failures are
      the instructive part. Raising the floor did nothing at first — a
      `...overrides` spread carried `maxActions: undefined` over the top of it,
      and the only reason regressions had gone to zero was the diff fix
      relabelling the same 87 controls as coverage. Then holding new controls
      back to a second pass did fix coverage, and cost 212 reloads against the
      full walk's 191: a second traversal has no route left to plan, so the
      feature's whole justification went with it. What works is reserving the
      budget rather than reordering the work — new controls get walked while the
      browser is already in the state, but only while what remains still covers
      every baseline edge outstanding.

      The honest number, now that it covers everything: 191 reloads over 197
      interactions for the walk, 169 over 271 for the replay. A third off per
      action, not the fixture's three quarters. The fixture's eight densely
      linked screens make almost every exit a free ride; a 40-state SPA where
      the states share a URL gives a router much less to work with.

- [x] **Timed, and the reload count was overselling it.** Reloads were measured
      on App Atlas and seconds were not, which left the actual question open.
      Two interleaved A/Bs, three pairs and two pairs, every run reproducing
      itself within ~1%.

      Held to the same 197 interactions, the replay takes 256.3s against the
      walk's 289.9s: 12% off, where the fixture had shown 41%. Left to its own
      budget it is 7% *slower* — 311.9s against 291.4s — because its floor is
      the baseline's full edge count, which is larger than the walk's own
      ceiling, so it buys 38% more coverage with the extra time. Both runs are
      honest and they answer different questions; only the equal-work one
      answers whether to reach for the fast path, and running just the first
      would have argued the feature backwards.

      What that changes downstream: 16% fewer reloads bought 12% of wall clock,
      so reloads are no longer the dominant term and the item below can no
      longer assume they are. Whatever is next has to be measured against
      seconds, not against the reload count.

- [ ] What is left of the reloads: 12 on the fixture, one per time the route
      strands itself in a finished state. Ordering states by what links them,
      rather than by path length, is the next cut. Walking several states at
      once in separate browser contexts is the other, and replay is what makes
      it possible — the work list is known up front, so it shards. Both are now
      worth less than the reload counts suggest — see the timing above — so
      whichever is tried first should be timed before it is finished.
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

- [x] Seed the walk from a route map, and report static-vs-dynamic disagreement
      as its own findings section. `--routes` takes an App Atlas `atlas.json` or
      a plain list, sniffed rather than declared, because making an agent
      convert one file into another before it can ask a question ends with the
      question not being asked.

      The design decision that made it work: the map is consulted **after** the
      walk exhausts its own frontier, not before. Seeding first is the obvious
      reading of "seed the walk", and it is the one that produces nothing — every
      declared route becomes trivially reached, and the report has no way to
      separate a page the app links to from a page only its address opens. Run
      last, the same navigation answers the question the section exists for.

      Finding the page is half of it. A screen opened this way goes onto the
      frontier and is walked like any other, which is how the fixture's
      `Export audit log` — a dead button living only on the screen nothing links
      to — became reportable at all.

      Four refusals hold it to what it can prove, and each one is a case the
      fixture puts beside the case that must still be reported: an address is
      matched against the walk's own normalized routes, so `/orders/[id]` and a
      walked `/orders/1042` are one door; a parameterized route that was *not*
      reached is left unopened rather than visited with an invented id, which
      would manufacture a 404 that reads as a missing page; only App Atlas's
      `PAGE` doors are compared, because walking `GET /api/…` in a browser proves
      nothing about a UI; and a map matching nothing at all is reported as a map
      about something else — a hash-routed app, a base path, another repo —
      rather than as an app whose every page is orphaned.

      Nothing here changes the exit code, which is the roadmap's own rule
      applied: a hint that can be stale must not fail a build. The one exception
      is what the walk *observed* rather than what the map claimed — a declared
      address answering with a 5xx or an uncaught exception is the app failing,
      and is reported as an error. A 404 is only the map being wrong.

      Scoped to `walk`. `diff --routes` is refused rather than ignored, for the
      same reason `walk --replay` is: a flag that silently does nothing hands
      back an unchecked run to whoever asked for the check. Whether a diff should
      report a *newly* orphaned page — a link deleted with the feature that used
      it — is a real question this does not answer.
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

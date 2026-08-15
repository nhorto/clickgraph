#!/usr/bin/env bash
# End-to-end check against the fixture app.
#
# Proves the three behaviors the tool exists for:
#   A  an unchanged app produces no findings (no crying wolf)
#   B  a broken interaction is caught as a regression
#   C  a newly added control that does nothing is caught on arrival
#   D  --json says the same thing the report and the exit code say
#   E  an app behind a login screen is not reported as a clean run
#   F  a form is only judged once it has been filled in
#   G  --replay finds what a full diff finds, and says what it did not open
#   H  a baseline that ran out of budget does not invent regressions
#   I  fields grouped by layout, where the app never wrote a form
#
# Usage: ./scripts/verify.sh     (from the repo root, after `npm run build`)
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-4173}
URL="http://localhost:$PORT"
pass=0; fail=0

# The bracket is not cosmetic. `pkill -f` matches whole command lines, so the
# bare pattern also matches any shell whose own command line happens to contain
# it — including the one that invoked this script. Two runs died that way,
# looking exactly like test failures. `[n]ode` matches the real server and can
# never match a command line quoting the pattern itself.
cleanup() { pkill -f "[n]ode fixture/server.js" 2>/dev/null; }
trap cleanup EXIT

start_fixture() {
  cleanup; sleep 0.5
  env "$@" node fixture/server.js >/tmp/clickgraph-fixture.log 2>&1 &
  disown  # keep the shell from announcing the kill on the next restart
  sleep 2
}

check() {
  if [ "$1" = "$2" ]; then echo "  PASS: $3"; pass=$((pass+1));
  else echo "  FAIL: $3 (got $1, want $2)"; fail=$((fail+1)); fi
}

echo "Building baseline against the intact app..."
start_fixture PORT="$PORT"
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet >/tmp/clickgraph-base.txt 2>&1
check "$?" "0" "baseline walk succeeds"
grep -q 'NO EFFECT.*"Export"' /tmp/clickgraph-base.txt; check "$?" "0" "finds the unwired Export button"
grep -q 'ERROR.*"Save settings"' /tmp/clickgraph-base.txt; check "$?" "0" "finds the 500 on Save settings"
grep -q 'NO EFFECT.*"Filter orders by region"' /tmp/clickgraph-base.txt
check "$?" "0" "finds the select whose choice is ignored"
# The working select must not be reported. Clicking a select can never change
# anything, so before it was given a value this one looked exactly as dead.
grep -q '"Filter orders by status"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the select that works"
grep -q '1 skipped (dangerous)' /tmp/clickgraph-base.txt; check "$?" "0" "refuses to click Delete account"
grep -q '1 skipped (external)' /tmp/clickgraph-base.txt; check "$?" "0" "skips the off-origin link"

echo "A: unchanged app, run twice (determinism)"
node dist/cli.js diff "$URL" --quiet >/dev/null 2>&1; check "$?" "0" "run 1 reports no change"
node dist/cli.js diff "$URL" --quiet >/dev/null 2>&1; check "$?" "0" "run 2 reports no change"

echo "B: a working interaction breaks"
start_fixture PORT="$PORT" BREAK=1
node dist/cli.js diff "$URL" --quiet >/tmp/clickgraph-break.txt 2>&1; check "$?" "1" "exits 1"
grep -q 'Order #1042" on /orders was navigated, now no-effect' /tmp/clickgraph-break.txt
check "$?" "0" "catches the link that stopped navigating"
# Match any prior working outcome: what matters is that it worked and now does not.
grep -qE 'Refresh" on /orders was (network-only|state-changed), now no-effect' /tmp/clickgraph-break.txt
check "$?" "0" "catches the button that lost its handler"

echo "C: a new feature ships with one dead control"
start_fixture PORT="$PORT" FEATURE=1
node dist/cli.js diff "$URL" --quiet >/tmp/clickgraph-feat.txt 2>&1; check "$?" "1" "exits 1"
grep -q 'new control does not work: button "Archive"' /tmp/clickgraph-feat.txt
check "$?" "0" "catches the dead new button"
# The working new control must be reported as new, and must not be called broken.
grep -qE 'new interaction: button "Print invoice".*(network-only|state-changed)' /tmp/clickgraph-feat.txt
check "$?" "0" "does not flag the working new button"
grep -q 'Regressions (1)' /tmp/clickgraph-feat.txt
check "$?" "0" "reports exactly one regression, no cascade noise"

echo "D: the JSON verdict agrees with the report"
# An agent reads --json and nothing else, so a verdict that disagrees with the
# exit code is worse than no verdict at all.
node dist/cli.js diff "$URL" --quiet --json >/tmp/clickgraph-feat.json 2>/dev/null
code=$?
node -e '
  const v = require("/tmp/clickgraph-feat.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.ok !== false) fail("ok should be false while a regression stands");
  if (v.regressions.length !== 1) fail(`want 1 regression, got ${v.regressions.length}`);
  if (!/Archive/.test(v.regressions[0].summary)) fail("the dead new button is not the regression");
  if (!v.other.some((c) => /Print invoice/.test(c.summary))) fail("the working new button is missing from other");
  if (typeof v.coverage.walked !== "number") fail("coverage must travel with the verdict");
' 2>/tmp/clickgraph-json-err.txt
check "$?" "0" "diff --json reports the regression and keeps the working control out of it"
check "$code" "1" "diff --json still exits 1"

start_fixture PORT="$PORT"
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-alt.json >/tmp/clickgraph-walk.json 2>/dev/null
node -e '
  const v = require("/tmp/clickgraph-walk.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.ok !== true) fail("a healthy app that walked should be ok");
  // Named rather than counted, so adding a planted defect to the fixture does
  // not falsify a check that is still describing the truth.
  const want = [
    ["error", /Save settings/, "the 500 is not reported as an error"],
    ["no-effect", /Export/, "the unwired button is not reported as no-effect"],
    ["no-effect", /Filter orders by region/, "the ignored select is not reported"],
  ];
  for (const [severity, re, msg] of want) {
    if (!v.findings.some((f) => f.severity === severity && re.test(f.control))) fail(msg);
  }
  if (v.findings.length !== want.length)
    fail(`only the planted defects should be findings, got ${v.findings.length}`);
  if (!v.coverage.skipped.some((s) => s.reason === "dangerous")) fail("skips must survive into JSON");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "walk --json carries both planted defects and the skip reasons"

echo "E: an app behind a login screen"
# The failure this guards against: a gated app walks its own login form
# cleanly, and that report is indistinguishable from a real one.
start_fixture PORT="$PORT" AUTH=1
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-auth.json \
  >/tmp/clickgraph-auth-out.json 2>/dev/null
check "$?" "1" "walking a login screen does not exit 0"
node -e '
  const v = require("/tmp/clickgraph-auth-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.ok !== false) fail("ok must be false when the run never got past the door");
  if (!v.load.likelyAuthWall) fail("the login wall was not detected");
  if (!/login screen/.test(v.verdict)) fail("the verdict does not say it walked a login page");
  // Clicking a text field focuses it and changes nothing, so every form field in
  // every app would otherwise be reported as a dead control.
  if (v.findings.some((f) => /Email|Password/.test(f.control)))
    fail("a text field was reported as a dead control");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "says it walked the login page, and does not call its fields dead"

cat > /tmp/clickgraph-session.json <<'JSON'
{ "cookies": [ { "name": "session", "value": "test-session", "domain": "localhost",
  "path": "/", "expires": -1, "httpOnly": false, "secure": false, "sameSite": "Lax" } ],
  "origins": [] }
JSON
node dist/cli.js walk "$URL" --quiet --json --storage-state /tmp/clickgraph-session.json \
  --out /tmp/clickgraph-auth2.json >/tmp/clickgraph-auth2-out.json 2>/dev/null
check "$?" "0" "a saved session gets past the gate"
node -e '
  const v = require("/tmp/clickgraph-auth2-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.load.likelyAuthWall) fail("still behind the login screen with a session");
  const names = v.findings.map((f) => f.control).join(" ");
  if (!/Export/.test(names) || !/Save settings/.test(names))
    fail(`the planted defects were not found behind the gate: ${names}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "finds both planted defects behind the gate"

node dist/cli.js walk "$URL" --quiet --storage-state /tmp/does-not-exist.json >/dev/null 2>&1
check "$?" "2" "a missing storage-state file is a usage error, not a silent walk"

echo "F: forms, filled and unfilled"
start_fixture PORT="$PORT"
# Default: neither form is submitted, and neither is called broken for it. An
# unfilled form with a required field cannot submit — blaming the button for
# that would report every signup and checkout form in every app as dead.
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-forms-off.json \
  >/tmp/clickgraph-forms-off-out.json 2>/dev/null
check "$?" "0" "a walk with unfilled forms still succeeds"
node -e '
  const v = require("/tmp/clickgraph-forms-off-out.json");
  const g = require("/tmp/clickgraph-forms-off.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const dead = v.findings.map((f) => f.control).join(" ");
  if (/Create account|Send feedback/.test(dead))
    fail(`a form submit was called dead without being filled: ${dead}`);
  const submits = g.coverage.skipped.filter((s) => /refuses to submit/.test(s.detail ?? ""));
  if (submits.length !== 2) fail(`want both forms skipped with a reason, got ${submits.length}`);
  if (g.edges.some((e) => e.action.kind === "fill")) fail("a form was filled without --fill-forms");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "leaves both forms unsubmitted, and says so rather than calling them dead"

# --fill-forms: the working form is proven, and the one that swallows its own
# submission is caught. Nothing but filling it in can tell those two apart.
node dist/cli.js walk "$URL" --quiet --json --fill-forms --out /tmp/clickgraph-forms-on.json \
  >/tmp/clickgraph-forms-on-out.json 2>/dev/null
check "$?" "0" "a walk that fills forms still succeeds"
node -e '
  const v = require("/tmp/clickgraph-forms-on-out.json");
  const g = require("/tmp/clickgraph-forms-on.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!v.findings.some((f) => f.severity === "no-effect" && /Send feedback/.test(f.control)))
    fail("the form that drops its submission was not caught");
  if (v.findings.some((f) => /Create account/.test(f.control)))
    fail("the form that works was reported as broken");
  const signup = g.edges.find((e) => e.action.kind === "fill" && /Create account/.test(e.action.selector.label));
  if (!signup) fail("the signup form was never filled");
  if (signup.outcome.kind === "no-effect") fail("submitting the working form did nothing");
  // Whatever a walk creates must be traceable back to the walk. Values chosen
  // from a selects own options are the apps words, so only typed ones count.
  const typed = signup.action.fill.filter((f) => !/^combobox/.test(f.label));
  if (typed.length === 0) fail("nothing was typed into the signup form");
  if (!typed.every((f) => /clickgraph-test/.test(f.value)))
    fail(`a value was typed that is not obviously synthetic: ${JSON.stringify(typed)}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "catches the form that drops its submission, clears the one that works"

echo "G: replay finds what a full diff finds, and admits what it did not open"
# The bargain --replay makes: it re-checks the states the baseline already knew,
# which is most of the value at a fraction of the reloads, and it never goes
# looking for new ones. That is only acceptable while the second half is said
# out loud, so both halves are checked here.
start_fixture PORT="$PORT"
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet >/dev/null 2>&1
check "$?" "0" "baseline for the replay scenarios"

node dist/cli.js diff "$URL" --replay --quiet --json >/tmp/clickgraph-replay-same.json 2>/dev/null
check "$?" "0" "a replay of an unchanged app reports no change"
node -e '
  const v = require("/tmp/clickgraph-replay-same.json");
  const g = require("./.uigraph/graph.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.coverage.mode !== "replay") fail("the run did not record itself as a replay");
  if (v.coverage.statesUnexplored !== 0) fail("nothing was new, so nothing should be unexplored");
  // The point of replaying rather than walking is to cover the same ground, so
  // a replay that quietly checks less would pass every test above this one.
  if (v.coverage.walked < g.coverage.edgesWalked)
    fail(`replay covered ${v.coverage.walked}, the baseline walked ${g.coverage.edgesWalked}`);
  if (v.coverage.states !== g.coverage.statesFound)
    fail(`replay reached ${v.coverage.states} of ${g.coverage.statesFound} states`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "replay covers the same states and interactions the walk did"

start_fixture PORT="$PORT" BREAK=1
node dist/cli.js diff "$URL" --replay --quiet >/tmp/clickgraph-replay-break.txt 2>&1
check "$?" "1" "a replay of a broken app exits 1"
grep -q 'Order #1042" on /orders was navigated, now no-effect' /tmp/clickgraph-replay-break.txt
check "$?" "0" "replay catches the link that stopped navigating"
grep -qE 'Refresh" on /orders was (network-only|state-changed), now no-effect' /tmp/clickgraph-replay-break.txt
check "$?" "0" "replay catches the button that lost its handler"

start_fixture PORT="$PORT" FEATURE=1
node dist/cli.js diff "$URL" --replay --quiet >/tmp/clickgraph-replay-feat.txt 2>&1
check "$?" "1" "a replay exits 1 on a dead new control"
# A control added to a state the baseline already knew is still walked: replay
# reads the live page, never the baseline's list of controls. Losing this would
# make the fast path blind to exactly the thing the tool is for.
grep -q 'new control does not work: button "Archive"' /tmp/clickgraph-replay-feat.txt
check "$?" "0" "replay catches a dead control added to a known state"
grep -qE 'new interaction: button "Print invoice".*(network-only|state-changed)' /tmp/clickgraph-replay-feat.txt
check "$?" "0" "replay does not flag the working new button"

start_fixture PORT="$PORT" ROUTE=1
node dist/cli.js diff "$URL" --replay --quiet --json >/tmp/clickgraph-replay-route.json 2>/dev/null
check "$?" "1" "a replay that left a screen unopened does not exit 0"
node -e '
  const v = require("/tmp/clickgraph-replay-route.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.coverage.statesUnexplored !== 1) fail(`want 1 unexplored screen, got ${v.coverage.statesUnexplored}`);
  if (v.regressions.length !== 0) fail("an unopened screen is not a regression, and must not be dressed as one");
  if (v.ok !== false) fail("ok must be false while a reached screen sits unopened");
  if (!/not explored/.test(v.verdict)) fail(`the verdict hides the gap: ${v.verdict}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "says which screens it reached and declined to open"

# And the walk it tells you to run does find what the replay could not.
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-route.json \
  >/tmp/clickgraph-route-out.json 2>/dev/null
node -e '
  const v = require("/tmp/clickgraph-route-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!v.findings.some((f) => /Run report/.test(f.control)))
    fail("the walk did not find the dead button on the new screen");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the re-walk it asks for does reach the dead control"

echo "H: a baseline that ran out of budget does not invent regressions"
# Found by pointing this at a real app. 2,086 controls behind a 200-action
# budget: the baseline walked one tenth of them, the replay walked a different
# tenth, and the diff reported the gap between two samples as 87 controls gone
# and 10 born broken. Nothing had changed. A control absent from a run means
# either it is not there or nothing reached it, and only one of those is news.
start_fixture PORT="$PORT"
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet --max-actions 20 --json >/tmp/clickgraph-tight.json 2>/dev/null
check "$?" "0" "a budget-limited baseline still succeeds"
node -e '
  const v = require("/tmp/clickgraph-tight.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!v.coverage.limitHit) fail("the baseline was meant to hit a budget and did not");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the baseline records that it stopped early"

# Same app, unchanged. Every difference here is an artifact of where each run
# happened to stop, so none of it may be reported as breakage.
node dist/cli.js diff "$URL" --replay --quiet --json >/tmp/clickgraph-tight-replay.json 2>/dev/null
node -e '
  const v = require("/tmp/clickgraph-tight-replay.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.regressions.length !== 0)
    fail(`unchanged app, truncated baseline, ${v.regressions.length} regression(s): ` +
      v.regressions.slice(0, 3).map((r) => r.summary).join(" | "));
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "replaying a truncated baseline reports no regressions on an unchanged app"

# The replay must still cover everything the baseline did, or "no regressions"
# would just mean it compared nothing.
node -e '
  const v = require("/tmp/clickgraph-tight-replay.json");
  const b = require("/tmp/clickgraph-tight.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.coverage.walked < b.coverage.walked)
    fail(`replay walked ${v.coverage.walked}, baseline walked ${b.coverage.walked}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and still covers everything the truncated baseline did"

# The gap is still reported — as coverage, which is what it is.
start_fixture PORT="$PORT" BREAK=1
node dist/cli.js diff "$URL" --replay --quiet --max-actions 12 >/tmp/clickgraph-tight-break.txt 2>&1
grep -q 'not reached this run' /tmp/clickgraph-tight-break.txt
check "$?" "0" "says which controls it never reached, instead of calling them gone"
grep -q 'control gone' /tmp/clickgraph-tight-break.txt
check "$?" "1" "and does not call an unreached control gone"

# A replay inherits the switches its baseline was walked with. Without that, a
# --fill-forms baseline replayed by the plain command loses every form submit in
# the app, and controls that never moved get reported as gone. The flags default
# to unset rather than false so that inheriting is possible at all.
start_fixture PORT="$PORT"
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet --fill-forms >/dev/null 2>&1
check "$?" "0" "a --fill-forms baseline for the inheritance check"
node dist/cli.js diff "$URL" --replay --quiet --json >/tmp/clickgraph-inherit.json 2>/dev/null
node -e '
  const v = require("/tmp/clickgraph-inherit.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const gone = v.regressions.filter((r) => /gone|does not work/.test(r.summary));
  if (gone.length !== 0)
    fail(`replay dropped the baselines switches: ${gone.map((r) => r.summary).join(" | ")}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "a replay inherits --fill-forms instead of losing every form submit"

echo "I: fields grouped by layout, where the app never wrote a form"
# CLUSTER=1 adds a screen with no <form> on it: loose inputs and a button wired
# by hand, which is how most React apps write a form. Everything the browser
# answers for a real form it refuses to answer here, so both halves need proving
# — that an unfilled cluster is not called dead, and that a filled one is really
# exercised rather than quietly skipped.
start_fixture PORT="$PORT" CLUSTER=1
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-cluster-off.json \
  >/tmp/clickgraph-cluster-off-out.json 2>/dev/null
check "$?" "0" "a walk of the form-less screen still succeeds"
node -e '
  const v = require("/tmp/clickgraph-cluster-off-out.json");
  const g = require("/tmp/clickgraph-cluster-off.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.findings.some((f) => /Send invite/.test(f.control)))
    fail("the cluster submit was called dead against fields nobody filled in");
  const skip = g.coverage.skipped.find((s) => /Send invite/.test(s.label));
  if (!skip) fail("the cluster submit was neither walked nor skipped with a reason");
  if (skip.reason !== "needs-input") fail(`want needs-input, got ${skip.reason}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "does not call a form-less submit dead when its fields are empty"

# The other card puts two buttons beside one field. Which one the field belongs
# to cannot be read off the page, and guessing means typing into fields that do
# not go together — so no cluster forms, and both buttons stay ordinary controls.
node -e '
  const v = require("/tmp/clickgraph-cluster-off-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.findings.some((f) => /Save note|Clear/.test(f.control)))
    fail("refusing to group the ambiguous card cost a working button its verdict");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "refuses to guess a grouping, without calling the ungrouped buttons dead"

# --fill-forms is what turns "could not tell" into an answer, and it has to reach
# a cluster as readily as a real form or the skip above is just a nicer silence.
node dist/cli.js walk "$URL" --quiet --json --fill-forms --out /tmp/clickgraph-cluster-on.json \
  >/tmp/clickgraph-cluster-on-out.json 2>/dev/null
check "$?" "0" "a walk that fills the form-less screen still succeeds"
node -e '
  const v = require("/tmp/clickgraph-cluster-on-out.json");
  const g = require("/tmp/clickgraph-cluster-on.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const invite = g.edges.find((e) => e.action.kind === "fill" && /Send invite/.test(e.action.selector.label));
  if (!invite) fail("the cluster was never filled and submitted as one action");
  if (invite.outcome.kind === "no-effect")
    fail("the cluster was filled, submitted, and still read as doing nothing");
  if (!invite.action.fill.every((f) => /clickgraph-test/.test(f.value)))
    fail(`a value was typed that is not obviously synthetic: ${JSON.stringify(invite.action.fill)}`);
  if (v.findings.some((f) => /Send invite/.test(f.control)))
    fail("the cluster works once filled, and was reported broken anyway");
  // The ungrouped field must stay untouched even here: --fill-forms asks for
  // forms to be filled, not for every input on the page to be typed into.
  if (g.edges.some((e) => (e.action.fill ?? []).some((f) => /Note/.test(f.label))))
    fail("a field with no unambiguous submit was typed into anyway");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "fills the inferred cluster, proves its button, and leaves the ambiguous field alone"

echo ""
echo "PASSED: $pass   FAILED: $fail"
[ "$fail" -eq 0 ]

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
#   G  a pre-walk command runs, is recorded, and aborts clearly on failure
#   H  diff inherits baseline settings and warns about explicit mismatches
#
# Usage: ./scripts/verify.sh     (from the repo root, after `npm run build`)
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-4173}
URL="http://localhost:$PORT"
pass=0; fail=0
fixture_pid=""

cleanup() {
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
    fixture_pid=""
  fi
}
trap cleanup EXIT

start_fixture() {
  cleanup; sleep 0.5
  env "$@" node fixture/server.js >/tmp/clickgraph-fixture.log 2>&1 &
  fixture_pid=$!
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
# A control whose only effect is visual must not read as a dead one. This is the
# whole of issue #1: zoom moved a transform, changed no text and no control, and
# came back indistinguishable from the unwired Export button beside it.
grep -q '"Zoom In"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the control whose only effect is visual"
# A control whose whole effect is browser chrome must not read as dead either
# (issue #9): window.print and a clipboard write leave no page-side footprint,
# so only the injected shims can vouch for them.
grep -q '"Print order"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the button whose effect is the print dialog"
grep -q '"Copy order link"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the button whose effect is a clipboard write"
# An in-form select with no change handler holds its choice for the submit to
# consume (issue #5). The standalone region select stays a finding above —
# there is no submit coming for it.
grep -q '"Referral source"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the in-form select that holds its choice for the submit"
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

echo "G: pre-walk state reset hook"
PRE_MARKER="/tmp/clickgraph-pre-marker-$$"
PRE_GRAPH="/tmp/clickgraph-pre-graph-$$.json"
PRE_COMMAND="printf hook-output; printf reset > $PRE_MARKER"
rm -f "$PRE_MARKER" "$PRE_GRAPH"
node dist/cli.js walk "$URL" --quiet --json --pre "$PRE_COMMAND" --out "$PRE_GRAPH" \
  >/tmp/clickgraph-pre-out.json 2>/tmp/clickgraph-pre-err.txt
check "$?" "0" "a successful pre-walk command continues into the walk"
test "$(cat "$PRE_MARKER" 2>/dev/null)" = "reset"
check "$?" "0" "the pre-walk command ran before walking"
node -e '
  const graph = require(process.argv[1]);
  if (graph.config.pre !== process.argv[2]) process.exit(1);
' "$PRE_GRAPH" "$PRE_COMMAND"
check "$?" "0" "the graph records the pre-walk command"
node -e 'require("/tmp/clickgraph-pre-out.json")' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "pre-walk stdout stays out of the JSON verdict"

node dist/cli.js walk "$URL" --quiet --pre "exit 7" \
  --out "/tmp/clickgraph-pre-failed-$$.json" >/dev/null 2>/tmp/clickgraph-pre-failed.txt
check "$?" "2" "a failing pre-walk command aborts the walk"
grep -q 'pre-walk command.*failed with exit code 7' /tmp/clickgraph-pre-failed.txt
check "$?" "0" "a failing pre-walk command explains why the walk aborted"

echo "H: diff configuration follows the baseline"
# Reuse the filled-form graph from F. Omitting --fill-forms must inherit it;
# otherwise both submitted form flows vanish and the unchanged app regresses.
node dist/cli.js diff "$URL" --quiet --json --baseline /tmp/clickgraph-forms-on.json \
  >/tmp/clickgraph-config-inherit.json 2>/tmp/clickgraph-config-inherit-err.txt
check "$?" "0" "diff inherits an omitted --fill-forms setting from the baseline"
test ! -s /tmp/clickgraph-config-inherit-err.txt
check "$?" "0" "matching inherited settings produce no warning"

node dist/cli.js diff "$URL" --quiet --json --baseline /tmp/clickgraph-forms-on.json \
  --no-fill-forms --max-depth 1 >/tmp/clickgraph-config-mismatch.json \
  2>/tmp/clickgraph-config-mismatch-err.txt
node -e '
  const v = require("/tmp/clickgraph-config-mismatch.json");
  const warnings = v.configWarnings.join(" ");
  if (!/--fill-forms/.test(warnings) || !/--max-depth/.test(warnings)) process.exit(1);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the JSON verdict names every explicit baseline mismatch"
grep -q 'WARNING: diff walk configuration differs from its baseline' \
  /tmp/clickgraph-config-mismatch-err.txt
check "$?" "0" "human-readable stderr makes a config mismatch prominent"

# A graph is data, even when it records how it was prepared. Loading it must
# never execute its stored command without fresh, explicit consent.
rm -f "$PRE_MARKER"
node dist/cli.js diff "$URL" --quiet --json --baseline "$PRE_GRAPH" --max-actions 0 \
  >/tmp/clickgraph-pre-diff.json 2>/tmp/clickgraph-pre-diff-err.txt
test ! -e "$PRE_MARKER"
check "$?" "0" "diff does not auto-execute a command stored in its baseline"
grep -q 'repeat --pre explicitly.*stored commands are never auto-executed' \
  /tmp/clickgraph-pre-diff-err.txt
check "$?" "0" "diff explains how to reproduce a baseline pre-walk hook safely"

echo ""
echo "PASSED: $pass   FAILED: $fail"
[ "$fail" -eq 0 ]

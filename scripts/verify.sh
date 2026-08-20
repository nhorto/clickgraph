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
#   I  a failure the walk injects reaches UI no healthy walk can see, and
#      separates the control that swallows it from the one that reports it
#   I  CLI, graph, and JSON output identify the clickgraph build that produced them
#   J  declared routes expose screens that fixture state left unreachable
#   K  a safely dismissed confirm dialog is observed, not called a dead control
#   L  a screen CSS is hiding does not lend its headings to the one on screen
#   M  every enumerated control ends as an edge or a skip with a reason
#   N  a class flip on an element that is not a control is a visible effect
#   O  a control whose only effect is scrolling is not a dead control
#   P  a session kept in sessionStorage is saved, replayed, and gets a walk
#      past a sign-in screen no storage state could open
#   Q  a state whose only door is a typed value is walked when one is declared,
#      and a declaration that lands nowhere fails the run instead of passing
#   V  a control the walk's own form fill removes is a skip, not a dead run
#   W  a digits-only field declared with inputmode is filled with digits
#   X  a screen whose every word changed and whose every control did not is
#      reported as changed, and one that only restamps a clock is not
#   Y  a state reached by choosing an option is re-entered by choosing it
#      again, and a path that stops leading there says so
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

echo "I: build version provenance"
PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
test "$(node dist/cli.js --version)" = "clickgraph $PACKAGE_VERSION"
check "$?" "0" "--version prints the compiled clickgraph version"
test "$(node dist/cli.js -v)" = "clickgraph $PACKAGE_VERSION"
check "$?" "0" "-v prints the compiled clickgraph version"
node -e '
  Promise.all([import("./dist/version.js"), import("./dist/build.js")]).then(([
    { CLICKGRAPH_VERSION }, { staleLocalBuildFiles },
  ]) => {
    if (CLICKGRAPH_VERSION !== require("./package.json").version) process.exit(1);
    if (staleLocalBuildFiles().length !== 0) process.exit(1);
  });
'
check "$?" "0" "the compiled version matches package.json and source is not newer than dist"
node -e '
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clickgraph-stale-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "src/example.ts"), "source");
  fs.writeFileSync(path.join(root, "dist/example.js"), "build");
  fs.utimesSync(path.join(root, "dist/example.js"), new Date(0), new Date(0));
  import("./dist/build.js").then(({ staleLocalBuildFiles }) => {
    if (JSON.stringify(staleLocalBuildFiles(root)) !== JSON.stringify(["src/example.ts"]))
      process.exit(1);
  });
'
check "$?" "0" "a local source file newer than dist is detected as a stale build"

echo "Building baseline against the intact app..."
start_fixture PORT="$PORT"
rm -rf .uigraph
node dist/cli.js walk "$URL" --quiet >/tmp/clickgraph-base.txt 2>&1
check "$?" "0" "baseline walk succeeds"
node -e '
  const graph = require("./.uigraph/graph.json");
  if (graph.clickgraphVersion !== require("./package.json").version) process.exit(1);
'
check "$?" "0" "the graph records which clickgraph build produced it"
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
grep -q '"Retire order"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag a control whose confirm dialog was safely dismissed"
node -e '
  const graph = require("./.uigraph/graph.json");
  const edge = graph.edges.find((candidate) => /Retire order/.test(candidate.action.name));
  if (edge?.outcome.kind !== "state-changed") process.exit(1);
  if (!/confirm dialog.*dismissed.*accept branch was not walked/.test(edge.outcome.note ?? ""))
    process.exit(1);
  if (edge.outcome.network.length !== 0) process.exit(1);
'
check "$?" "0" "records the dialog gate while leaving its accept branch unexecuted"
# An in-form select with no change handler holds its choice for the submit to
# consume (issue #5). The standalone region select stays a finding above —
# there is no submit coming for it.
grep -q '"Referral source"' /tmp/clickgraph-base.txt
check "$?" "1" "does not flag the in-form select that holds its choice for the submit"
# A control that only exists after a self-loop used to be walked never and
# counted nowhere (issue #8). Reaching the dead Beep inside the panel that
# "More actions" reveals proves appeared controls are now attempted.
grep -q 'NO EFFECT.*"Beep"' /tmp/clickgraph-base.txt
check "$?" "0" "walks the control that only exists after a self-loop, and finds it dead"
grep -q '1 skipped (dangerous)' /tmp/clickgraph-base.txt; check "$?" "0" "refuses to click Delete account"
grep -q '1 skipped (external)' /tmp/clickgraph-base.txt; check "$?" "0" "skips the off-origin link"

node -e '
  const fs = require("node:fs");
  const graph = require("./.uigraph/graph.json");
  fs.writeFileSync(
    "/tmp/clickgraph-version-mismatch.json",
    JSON.stringify({ ...graph, clickgraphVersion: "0.0.0-test" }),
  );
  delete graph.clickgraphVersion;
  fs.writeFileSync("/tmp/clickgraph-version-legacy.json", JSON.stringify(graph));
'
node dist/cli.js show --json --baseline /tmp/clickgraph-version-legacy.json >/dev/null
check "$?" "0" "a legacy graph without producer provenance remains readable"
node dist/cli.js diff "$URL" --quiet --json --max-actions 0 \
  --baseline /tmp/clickgraph-version-mismatch.json \
  >/tmp/clickgraph-version-diff.json 2>/tmp/clickgraph-version-diff-err.txt
grep -q 'baseline was walked with clickgraph 0.0.0-test' /tmp/clickgraph-version-diff-err.txt
check "$?" "0" "a version mismatch is prominent before the diff walk"
node -e '
  const verdict = require("/tmp/clickgraph-version-diff.json");
  if (verdict.version !== require("./package.json").version) process.exit(1);
  if (verdict.baselineVersion !== "0.0.0-test") process.exit(1);
  if (!/tooling, not app changes/.test(verdict.versionWarning ?? "")) process.exit(1);
'
check "$?" "0" "diff JSON carries both versions and the provenance warning"

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
  if (v.version !== require("./package.json").version) fail("diff verdict has no build version");
  if (v.baselineVersion !== require("./package.json").version) fail("diff lost the baseline build version");
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
  if (v.version !== require("./package.json").version) fail("walk verdict has no build version");
  if (v.ok !== true) fail("a healthy app that walked should be ok");
  // Named rather than counted, so adding a planted defect to the fixture does
  // not falsify a check that is still describing the truth.
  const want = [
    ["error", /Save settings/, "the 500 is not reported as an error"],
    ["no-effect", /Export/, "the unwired button is not reported as no-effect"],
    ["no-effect", /Filter orders by region/, "the ignored select is not reported"],
    ["no-effect", /Beep/, "the control revealed by a self-loop is not reported"],
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
# Default: no form is submitted, and none is called broken for it. An unfilled
# form with a required field cannot submit — blaming the button for that would
# report every signup and checkout form in every app as dead.
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-forms-off.json \
  >/tmp/clickgraph-forms-off-out.json 2>/dev/null
check "$?" "0" "a walk with unfilled forms still succeeds"
node -e '
  const v = require("/tmp/clickgraph-forms-off-out.json");
  const g = require("/tmp/clickgraph-forms-off.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const dead = v.findings.map((f) => f.control).join(" ");
  if (/Create account|Send feedback|Look up/.test(dead))
    fail(`a form submit was called dead without being filled: ${dead}`);
  const submits = g.coverage.skipped.filter((s) => /refuses to submit/.test(s.detail ?? ""));
  // Named, not counted. The fixture grows a form every time the tool grows a
  // feature, and a bare total turns each addition into a failure that is not
  // describing anything untrue — the same lesson the walk --json check above
  // records.
  for (const want of ["Create account", "Send feedback", "Look up"]) {
    if (!submits.some((s) => s.label.includes(want)))
      fail(`${want} was not skipped with a reason: ${JSON.stringify(submits.map((s) => s.label))}`);
  }
  if (g.edges.some((e) => e.action.kind === "fill")) fail("a form was filled without --fill-forms");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "leaves every form unsubmitted, and says so rather than calling them dead"

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

echo "J: expected route coverage"
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/orders" --quiet --json --max-depth 1 \
  --expect-routes fixture/routes.txt --out /tmp/clickgraph-routes-ok.json \
  >/tmp/clickgraph-routes-ok-verdict.json 2>/dev/null
check "$?" "0" "declared routes all count as reached when fixture data exposes them"
node -e '
  const graph = require("/tmp/clickgraph-routes-ok.json");
  const verdict = require("/tmp/clickgraph-routes-ok-verdict.json");
  // Compared against the manifest, not a literal: the fixture gains a route
  // whenever the tool gains a feature, and "7" would make each addition look
  // like a resolution bug.
  const declared = require("node:fs").readFileSync("fixture/routes.txt", "utf8")
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (JSON.stringify(graph.config.expectedRoutes) !== JSON.stringify(declared)) process.exit(1);
  if (graph.coverage.unreachedRoutes.length !== 0) process.exit(1);
  if (verdict.coverage.unreachedRoutes.length !== 0) process.exit(1);
'
check "$?" "0" "graph and JSON record the resolved route expectations"

start_fixture PORT="$PORT" EMPTY=1
node dist/cli.js walk "$URL/orders" --quiet --json --max-depth 1 \
  --expect-routes fixture/routes.txt --out /tmp/clickgraph-routes-missing.json \
  >/tmp/clickgraph-routes-missing-verdict.json 2>/dev/null
check "$?" "1" "an expected route hidden by missing data fails the walk"
node -e '
  const verdict = require("/tmp/clickgraph-routes-missing-verdict.json");
  if (verdict.ok !== false) process.exit(1);
  if (JSON.stringify(verdict.coverage.unreachedRoutes) !== JSON.stringify(["/orders/:id"]))
    process.exit(1);
'
check "$?" "0" "JSON names the exact route that was never reached"
node dist/cli.js show --baseline /tmp/clickgraph-routes-missing.json \
  >/tmp/clickgraph-routes-missing-report.txt
grep -q 'NOT REACHED.*/orders/:id' /tmp/clickgraph-routes-missing-report.txt
check "$?" "0" "the human coverage report makes the missing route prominent"

node dist/cli.js diff "$URL/orders" --quiet --json \
  --baseline /tmp/clickgraph-routes-missing.json \
  >/tmp/clickgraph-routes-missing-diff.json 2>/tmp/clickgraph-routes-missing-diff-err.txt
check "$?" "1" "diff inherits route expectations and keeps an unchanged gap failing"
node -e '
  const verdict = require("/tmp/clickgraph-routes-missing-diff.json");
  const changes = verdict.regressions.length + verdict.fixed.length + verdict.other.length;
  if (changes !== 0 || verdict.coverage.unreachedRoutes[0] !== "/orders/:id") process.exit(1);
'
check "$?" "0" "a no-change diff cannot hide an inherited route gap"
node -e '
  Promise.all([import("./dist/graph.js"), import("./dist/report.js")]).then(([
    { diffGraphs }, { reportDiff },
  ]) => {
    const graph = require("/tmp/clickgraph-routes-missing.json");
    if (!/Expected routes not reached/.test(reportDiff(diffGraphs(graph, graph)))) process.exit(1);
  });
'
check "$?" "0" "the public one-argument diff report cannot hide a route gap"
test ! -s /tmp/clickgraph-routes-missing-diff-err.txt
check "$?" "0" "inherited route expectations do not produce a mismatch warning"

node dist/cli.js diff "$URL/orders" --quiet --json --max-actions 0 \
  --no-expect-routes --baseline /tmp/clickgraph-routes-missing.json \
  >/tmp/clickgraph-routes-cleared.json 2>/tmp/clickgraph-routes-cleared-err.txt
node -e '
  const verdict = require("/tmp/clickgraph-routes-cleared.json");
  if (!verdict.configWarnings.some((warning) => /--expect-routes/.test(warning))) process.exit(1);
'
check "$?" "0" "explicitly clearing route expectations warns about the mismatch"

node -e '
  const fs = require("node:fs");
  const graph = require("/tmp/clickgraph-routes-missing.json");
  const manifest = "/tmp/clickgraph-routes-live.txt";
  fs.writeFileSync(manifest, "/\n/orders\n/orders/:id\n/settings\n/signup\n/feedback\n/about\n");
  graph.config.expectedRoutes = graph.config.expectedRoutes.filter((route) => route !== "/orders/:id");
  graph.config.expectedRoutesFile = manifest;
  graph.coverage.expectedRoutes = graph.config.expectedRoutes;
  graph.coverage.unreachedRoutes = [];
  fs.writeFileSync("/tmp/clickgraph-routes-evolving.json", JSON.stringify(graph));
'
node dist/cli.js diff "$URL/orders" --quiet --json \
  --baseline /tmp/clickgraph-routes-evolving.json \
  >/tmp/clickgraph-routes-evolving-diff.json 2>/tmp/clickgraph-routes-evolving-err.txt
check "$?" "1" "diff re-reads a recorded manifest and catches a newly declared route"
node -e '
  const verdict = require("/tmp/clickgraph-routes-evolving-diff.json");
  if (verdict.coverage.unreachedRoutes[0] !== "/orders/:id") process.exit(1);
  if (!verdict.configWarnings.some((warning) => /route coverage/.test(warning))) process.exit(1);
'
check "$?" "0" "a changed route manifest is visible in coverage and config warnings"

node dist/cli.js walk "$URL" --expect-routes /tmp/does-not-exist-routes.txt \
  >/dev/null 2>/tmp/clickgraph-routes-invalid.txt
check "$?" "2" "a missing expected-routes file is a usage error"

echo "I: fault injection reaches the UI a healthy walk cannot (issue #15)"
# The premise: "Sync orders" swallows its failure and "Reload orders" renders a
# banner. While the API answers they are indistinguishable — both fire one
# request, neither is a finding. Only breaking the request separates them.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL" --quiet --json --out /tmp/clickgraph-fault-base.json \
  >/tmp/clickgraph-fault-healthy.json 2>/dev/null
check "$?" "0" "the healthy walk still succeeds with the error-path controls present"
node -e '
  const v = require("/tmp/clickgraph-fault-healthy.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const names = v.findings.map((f) => f.control).join(" ");
  if (/Sync orders|Reload orders/.test(names))
    fail(`a healthy walk should not be able to tell these apart: ${names}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "neither error-path control is a finding while requests succeed"

node dist/cli.js walk "$URL" --quiet --json --fail-requests "/api/orders@503" \
  --out /tmp/clickgraph-fault-graph.json >/tmp/clickgraph-fault-out.json 2>/dev/null
check "$?" "0" "a fault walk is not condemned for the failures it was asked to cause"
node -e '
  const v = require("/tmp/clickgraph-fault-out.json");
  const g = require("/tmp/clickgraph-fault-graph.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  // The finding the feature exists for.
  const swallowed = v.findings.find((f) => /Sync orders/.test(f.control));
  if (!swallowed) fail("the control that swallows its failure was not caught");
  if (swallowed.severity !== "error") fail(`want severity error, got ${swallowed.severity}`);
  if (!/swallowed/.test(swallowed.detail)) fail(`the detail does not say what went wrong: ${swallowed.detail}`);
  // The control that handles the failure correctly must NOT be reported. A
  // fault mode that flags working error handling is worse than none: every
  // error banner in the app becomes a false positive.
  if (v.findings.some((f) => /Reload orders/.test(f.control)))
    fail("the control that renders an error banner was reported as broken");
  // The app own 500 must survive alongside hundreds of injected ones.
  if (!v.findings.some((f) => /Save settings/.test(f.control)))
    fail("the app real defect was buried among the injected failures");
  if (!v.load.healthy) fail("injected failures must not make the load look unhealthy");
  // A fault walk and a healthy walk describe different apps; the graph has to
  // say which one it is or the two get crossed by accident.
  if (!g.config.fault || g.config.fault.pattern !== "/api/orders") fail("the graph does not record its fault");
  if (g.config.fault.status !== 503) fail("the graph does not record the injected status");
  if (!/failing/.test(v.verdict)) fail(`the verdict does not mention the fault: ${v.verdict}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "catches the swallowed failure, clears the handled one, keeps the real defect"

# Reproducibility: a diff must inherit the fault, or an unchanged app reads as
# regressed everywhere its error UI used to be.
node dist/cli.js diff "$URL" --quiet --json --baseline /tmp/clickgraph-fault-graph.json \
  >/tmp/clickgraph-fault-diff.json 2>/tmp/clickgraph-fault-diff-err.txt
check "$?" "0" "a diff inherits the baseline fault and reports no change"
test ! -s /tmp/clickgraph-fault-diff-err.txt
check "$?" "0" "an inherited fault produces no warning"

node dist/cli.js diff "$URL" --quiet --json --baseline /tmp/clickgraph-fault-graph.json \
  --no-fail-requests >/tmp/clickgraph-fault-cross.json 2>/tmp/clickgraph-fault-cross-err.txt
grep -q 'broken-app baseline' /tmp/clickgraph-fault-cross-err.txt
check "$?" "0" "crossing a healthy walk with a fault baseline is warned about explicitly"

# Method scoping: failing every request usually leaves nothing on screen to
# click, so the useful walks break writes and let reads through.
# Imported the way every other check here does it: a relative specifier
# resolved from the repo root this script cd'd into. An absolute path works on
# exactly one machine, and on a CI runner it fails as "refuses nonsense".
node -e '
  import("./dist/fault.js").then(({ parseFaultSpec }) => {
    const fail = (m) => { console.error(m); process.exit(1); };
    const bare = parseFaultSpec("/api/*");
    if (bare.status !== 500) fail("a bare pattern should default to 500");
    const scoped = parseFaultSpec("POST,PUT /api/*@offline");
    if (scoped.status !== "offline") fail("offline was not parsed");
    if (scoped.methods.join(",") !== "POST,PUT") fail(`methods not parsed: ${scoped.methods}`);
    if (scoped.pattern !== "/api/*") fail(`pattern not parsed: ${scoped.pattern}`);
    for (const bad of ["", "/api/*@200", "/api/*@nope"]) {
      let threw = false;
      try { parseFaultSpec(bad); } catch { threw = true; }
      if (!threw) fail(`${JSON.stringify(bad)} should be rejected, not walked`);
    }
  });
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the fault spec parses methods and status, and refuses nonsense"

echo "L: a screen CSS is hiding does not lend its headings to the one on screen (issue #25)"
# /kiosk is six screens in one document, shown one at a time, and every heading
# in it belongs to a screen the user is not looking at. Read without a
# visibility filter they gave all six screens the same identity: one node, eight
# interactions, no findings, exit 0 — a pass over a flow the walk never got past
# the front door of. The entry screen has no heading of its own, which is what
# left the borrowed ones as the whole of its identity.
#
# The paths below are handed to node as arguments rather than written into the
# assertion, so the check reads the same files the redirects just wrote even
# where the shell and node disagree about where /tmp is.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/kiosk" --quiet --json --out /tmp/clickgraph-kiosk-graph.json \
  >/tmp/clickgraph-kiosk.json 2>/dev/null
check "$?" "0" "the kiosk flow walks with nothing to report"
node -e '
  const [verdictPath, graphPath] = process.argv.slice(1);
  const v = require(verdictPath);
  const g = require(graphPath);
  const fail = (m) => { console.error(m); process.exit(1); };
  const nodes = Object.values(g.nodes);
  if (v.coverage.states !== 6) fail(`the six screens collapsed to ${v.coverage.states}`);
  if (v.coverage.walked !== 11) fail(`want 11 interactions, got ${v.coverage.walked}`);
  // A control on a collapsed screen survives only through the self-loop that
  // revealed it, and is skipped as unreachable once the walk has moved on
  // (issue #8). Three were lost that way here. Screens that are their own nodes
  // carry their own control lists, so nothing is left out of reach.
  if (v.coverage.skipped.length !== 0)
    fail(`nothing here should be out of reach: ${JSON.stringify(v.coverage.skipped)}`);
  // Landmarks exist to say which screen a node is. A node holding two of these
  // headings is holding one that belongs to a screen nobody can see.
  const crowded = nodes.filter((n) => n.fingerprint.landmarks.length > 1);
  if (crowded.length)
    fail(`landmarks from screens that are not showing: ${JSON.stringify(crowded.map((n) => n.fingerprint.landmarks))}`);
  const named = nodes.map((n) => n.fingerprint.landmarks[0] ?? "").sort().join("|");
  const want = ["", "Enter your PIN", "Hello", "Shift reports", "Supervisor menu", "Who are you?"].join("|");
  if (named !== want) fail(`screens are not identified one for one: ${named}`);
' /tmp/clickgraph-kiosk.json /tmp/clickgraph-kiosk-graph.json 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "each screen is its own node, named by the heading the user can see"

# The other half of the trade, and the reason this is a filter and not a richer
# identity. Ana and Bo reach the same PIN screen with different text on it;
# minting two nodes for that would be over-splitting, the failure case A guards
# against for the rest of the app. Identity moves when the screen does, and not
# for anything else that differs between two visits to it.
node -e '
  const [graphPath] = process.argv.slice(1);
  const g = require(graphPath);
  const fail = (m) => { console.error(m); process.exit(1); };
  const nodes = Object.values(g.nodes);
  const who = nodes.find((n) => n.fingerprint.landmarks[0] === "Who are you?");
  if (!who) fail("the name screen was never reached");
  const named = g.edges.filter((e) => e.from === who.id && /^(Ana|Bo)$/.test(e.action.name));
  if (named.length !== 2) fail(`want both name buttons walked, got ${named.length}`);
  if (named[0].to !== named[1].to) fail("one screen reached two ways became two nodes");
  const pin = nodes.find((n) => n.id === named[0].to);
  if (pin?.fingerprint.landmarks[0] !== "Enter your PIN")
    fail(`the names did not lead to the PIN screen: ${JSON.stringify(pin?.fingerprint.landmarks)}`);
' /tmp/clickgraph-kiosk-graph.json 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "two ways onto one screen still reach a single node"

echo "M: every enumerated control is accounted for"
# A tight --max-depth is the cheapest way to leave controls unexpanded: six
# whole screens are discovered and not one of their controls is walked. Before
# issue #19 those controls appeared nowhere in the graph — not an edge, not a
# skip — so coverage quietly shrank its own denominator and a run that never
# touched a screen still read as essentially complete.
#
# The graphs here are written inside the repo rather than under /tmp because
# these checks read back the exact file the walk just wrote and do arithmetic
# on it; a path the shell and node both resolve the same way is the point.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL" --quiet --max-depth 1 --out .uigraph/accounting-depth.json \
  >/tmp/clickgraph-accounting-depth.txt 2>&1
check "$?" "0" "a walk cut short by a depth budget still succeeds"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const { coverage, nodes, edges } = require("./.uigraph/accounting-depth.json");

  // The invariant, as asserted by the walk itself — it is the only party that
  // can see the two correction terms: controls a self-loop revealed after a
  // node froze its list (issue #8), and fields a form submit consumed instead
  // of an edge. An absent gap list is the walk saying its books balanced.
  if (coverage.accountingGaps)
    fail(`the walk found its own books unbalanced: ${JSON.stringify(coverage.accountingGaps)}`);

  // The same claim in the form the artifact can be checked on by anyone:
  // every control that produced no edge carries a reason, so the summary
  // number and the list of reasons cannot drift apart.
  if (coverage.edgesUnwalked !== coverage.skipped.length)
    fail(`edgesUnwalked ${coverage.edgesUnwalked} != ${coverage.skipped.length} skipped entries`);

  // Neither correction can apply to a walk this shallow, so the bare per-node
  // form has to hold exactly. This is the arithmetic issue #19 ran by hand.
  for (const [id, node] of Object.entries(nodes)) {
    const walked = edges.filter((e) => e.from === id).length;
    const skips = coverage.skipped.filter((s) => s.nodeId === id).length;
    if (walked + skips !== node.interactiveCount)
      fail(`${node.fingerprint.route}: ${walked} walked + ${skips} skipped != ${node.interactiveCount} enumerated`);
  }

  // And the regression itself. The states the depth budget refused to expand
  // are the ones that used to be silent, so every control on them must now
  // name a reason and say which budget stopped it.
  const unexpanded = Object.entries(nodes).filter(([id]) => !edges.some((e) => e.from === id));
  if (unexpanded.length < 5) fail(`expected several unexpanded states, got ${unexpanded.length}`);
  for (const [id, node] of unexpanded) {
    const skips = coverage.skipped.filter((s) => s.nodeId === id);
    if (skips.length !== node.interactiveCount)
      fail(`${node.fingerprint.route}: ${node.interactiveCount} control(s), ${skips.length} explained`);
    if (!skips.every((s) => s.reason === "budget" && /maxDepth/.test(s.detail ?? "")))
      fail(`${node.fingerprint.route}: a skip does not say which budget stopped it`);
  }
  if (coverage.edgesUnwalked < 40)
    fail(`edgesUnwalked ${coverage.edgesUnwalked} is too small to be counting whole screens`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "controls on a state a budget never expanded each carry a reason"
grep -q 'skipped (budget)' /tmp/clickgraph-accounting-depth.txt
check "$?" "0" "the human report groups the unexpanded controls under their budget"

# The sharper half of issue #19. maxStates discards the state itself, so its
# controls had no node to be counted against and edgesUnwalked stayed 0: a walk
# that never recorded five screens reported as fully covered.
node dist/cli.js walk "$URL" --quiet --max-states 3 --out .uigraph/accounting-states.json \
  >/dev/null 2>&1
check "$?" "0" "a walk cut short by a state budget still succeeds"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const { coverage, nodes } = require("./.uigraph/accounting-states.json");
  if (coverage.accountingGaps)
    fail(`the walk found its own books unbalanced: ${JSON.stringify(coverage.accountingGaps)}`);
  if (coverage.edgesUnwalked !== coverage.skipped.length)
    fail(`edgesUnwalked ${coverage.edgesUnwalked} != ${coverage.skipped.length} skipped entries`);
  // Controls on screens the budget refused to record name a node deliberately
  // absent from `nodes` — the only trace a graph can carry of a screen it was
  // told not to keep, and better than the nothing that was there before.
  const unrecorded = coverage.skipped.filter((s) => !nodes[s.nodeId]);
  if (unrecorded.length === 0) fail("screens dropped by maxStates left no trace at all");
  if (!unrecorded.every((s) => s.reason === "budget" && /maxStates/.test(s.detail ?? "")))
    fail("a control on an unrecorded screen does not say which budget lost it");
  if (coverage.edgesUnwalked < unrecorded.length)
    fail(`edgesUnwalked ${coverage.edgesUnwalked} leaves out ${unrecorded.length} control(s) on screens never recorded`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "screens dropped by the state budget still name their controls"
echo "N: a class flip on an element that is not a control is an effect (#26)"
# Walked on its own: the keypad fills up as its keys are pressed, so the order
# they are reached in is part of what is being tested.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/keypad" --quiet --out /tmp/clickgraph-keypad.json \
  >/tmp/clickgraph-keypad.txt 2>&1
check "$?" "0" "the keypad walk succeeds"
# All eleven keys work, and every one of them works by moving a dot between
# `pin-dot` and `pin-dot filled` — a class on a div. No text, no attribute the
# element list carries, no rectangle, nothing on body or :root, so every signal
# the snapshot had came back byte-identical and the whole keypad reported dead
# at once (issue #26).
#
# The graph path is passed as an argument rather than written into the script,
# so the reading and the writing agree about where /tmp is on every platform
# this runs on.
node -e '
  const graph = require(process.argv[1]);
  const fail = (m) => { console.error(m); process.exit(1); };
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Back"]) {
    const edge = graph.edges.find((e) => e.action.name === key);
    if (!edge) fail(`key ${key} was never walked`);
    if (edge.outcome.kind !== "state-changed") fail(`key ${key} came back ${edge.outcome.kind}`);
    if (!/changed its class/.test(edge.outcome.note ?? ""))
      fail(`key ${key} does not say what it did: ${edge.outcome.note}`);
  }
' /tmp/clickgraph-keypad.json
check "$?" "0" "every key of the masked PIN keypad is reported as working"
# The guard, which matters more than the fix it guards. A class signal
# sensitive enough to see a dot fill must still leave the unwired control on
# the same screen dead — being too sensitive here does not add noise, it
# deletes the findings the tool exists to produce.
grep -q 'NO EFFECT.*"Forgot your PIN?"' /tmp/clickgraph-keypad.txt
check "$?" "0" "still reports the unwired control beside the keypad as dead"
node -e '
  const graph = require(process.argv[1]);
  const fail = (m) => { console.error(m); process.exit(1); };
  const dead = graph.edges.find((e) => /Forgot your PIN/.test(e.action.name));
  if (!dead) fail("the unwired control was never walked");
  if (dead.outcome.kind !== "no-effect") fail(`the unwired control came back ${dead.outcome.kind}`);
  if (dead.outcome.benign) fail("the unwired control was excused instead of reported");
' /tmp/clickgraph-keypad.json
check "$?" "0" "the unwired keypad control is still a finding, not an excused one"

echo "O: a control whose only effect is scrolling is not a dead control (#22)"
node dist/cli.js walk "$URL/release-notes" --quiet --out /tmp/clickgraph-scroll.json \
  >/tmp/clickgraph-scroll.txt 2>&1
check "$?" "0" "the scrolling walk succeeds"
node -e '
  const graph = require(process.argv[1]);
  const fail = (m) => { console.error(m); process.exit(1); };
  const walked = (name) => {
    const edge = graph.edges.find((e) => new RegExp(name).test(e.action.name));
    if (!edge) fail(`${name} was never walked`);
    return edge;
  };
  const page = walked("Back to top");
  if (page.outcome.kind !== "state-changed") fail(`back to top came back ${page.outcome.kind}`);
  if (!/scrolled the page/.test(page.outcome.note ?? ""))
    fail(`back to top does not say what it did: ${page.outcome.note}`);
  const region = walked("Scroll the notes");
  if (region.outcome.kind !== "state-changed") fail(`the pane scroller came back ${region.outcome.kind}`);
  if (!/scrolled a region/.test(region.outcome.note ?? ""))
    fail(`the pane scroller does not say what it did: ${region.outcome.note}`);
' /tmp/clickgraph-scroll.json
check "$?" "0" "reports the window scroller and the in-element scroller as working"
# The trap, and the reason /release-notes puts 2400px above this control: the
# walk scrolls to reach anything below the fold, so a reading taken across that
# scroll instead of across the click alone vouches for every dead control down
# there. This one came back "changed state — the view changed visually" before
# the fix, on the strength of the walk's own scrolling and nothing else.
grep -q 'NO EFFECT.*"Share release notes"' /tmp/clickgraph-scroll.txt
check "$?" "0" "still reports the dead control below the fold as dead"
node -e '
  const graph = require(process.argv[1]);
  const fail = (m) => { console.error(m); process.exit(1); };
  const dead = graph.edges.find((e) => /Share release notes/.test(e.action.name));
  if (!dead) fail("the dead control below the fold was never walked");
  if (dead.outcome.kind !== "no-effect") fail(`it came back ${dead.outcome.kind}: ${dead.outcome.note}`);
  if (dead.outcome.benign) fail("it was excused instead of reported");
' /tmp/clickgraph-scroll.json
check "$?" "0" "the walk own scroll-into-view is never credited to the control it reached"
echo "P: a session kept in sessionStorage is said out loud, and carried (issue #27)"
# /tab-app holds its whole session in sessionStorage, which Playwright's storage
# state does not carry. `login` blocks on a keypress, so what runs below is
# everything login does AFTER that keypress, against a context signed in by
# script instead of by hand. The keypress itself is the only part no check here
# can stand in for.
start_fixture PORT="$PORT"
# Written beside the graph rather than in a temp dir: this file is the subject
# of the check, one process writes it and another reads it, and .uigraph is
# already gitignored precisely because a session file holds live cookies.
mkdir -p .uigraph
rm -f .uigraph/tab-session.json
CLICKGRAPH_URL="$URL" node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  (async () => {
    const { chromium } = await import("playwright");
    const { saveSignedInSession } = await import("./dist/login.js");
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(process.env.CLICKGRAPH_URL + "/tab-app");
    await page.fill("#tab-email", "walker@example.com");
    await page.fill("#tab-password", "not-read-by-anything");
    await page.click("button[type=submit]");
    await page.waitForSelector("[data-testid=tab-export]");
    const said = [];
    await saveSignedInSession(context, "./.uigraph/tab-session.json", (m) => said.push(m));
    await browser.close();
    const heard = said.join(" | ");
    if (!/Session saved to/.test(heard)) fail("login stopped reporting where it saved: " + heard);
    if (!/NOTE.*sessionStorage/.test(heard))
      fail("login said nothing about the store its session turned out to live in: " + heard);
    if (!/replayed into the walk/.test(heard))
      fail("the note does not say what will happen instead: " + heard);
    // The diagnosis itself, asserted rather than assumed: what Playwright saves
    // for this app is empty, which is why the other half of the file exists.
    const saved = require("./.uigraph/tab-session.json");
    if (saved.cookies.length !== 0 || saved.origins.length !== 0)
      fail("the fixture no longer reproduces the issue: " + JSON.stringify(saved));
    // The file format, and the property the issue asked of it: every entry says
    // which of the three stores it came from.
    if (saved.sessionStorage[0].origin !== process.env.CLICKGRAPH_URL)
      fail("the saved sessionStorage does not name its origin: " + JSON.stringify(saved));
    if (saved.sessionStorage[0].items[0].name !== "acme.tab-session")
      fail("the session key itself was not saved: " + JSON.stringify(saved));
  })().catch((e) => fail(String((e && e.stack) || e)));
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "login saves the sessionStorage half, labelled, and says it had to"

# The other half of being right: an app that keeps a wizard step in
# sessionStorage and its session in a cookie must hear nothing. A warning that
# fires on ordinary sessionStorage use is a warning everyone learns to ignore.
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  import("./dist/session.js").then(({ sessionStorageOnlyOrigins }) => {
    const scratch = [{ origin: "https://app.example.com", items: [{ name: "wizard.step", value: "2" }] }];
    const cookie = (domain) => ({
      cookies: [{ name: "sid", value: "x", domain, path: "/", expires: -1,
        httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [],
    });
    if (sessionStorageOnlyOrigins(cookie("app.example.com"), scratch).length !== 0)
      fail("an app whose session is a cookie was warned about its scratch sessionStorage");
    if (sessionStorageOnlyOrigins(cookie(".example.com"), scratch).length !== 0)
      fail("a parent-domain cookie was not recognised as covering this origin");
    if (sessionStorageOnlyOrigins(cookie("auth.unrelated.test"), scratch).length !== 1)
      fail("a cookie for an unrelated host was counted as this origin session");
    const local = { cookies: [], origins: [
      { origin: "https://app.example.com", localStorage: [{ name: "token", value: "y" }] },
    ] };
    if (sessionStorageOnlyOrigins(local, scratch).length !== 0)
      fail("an app whose session is in localStorage was warned about it anyway");
    if (sessionStorageOnlyOrigins({ cookies: [], origins: [] }, scratch)[0] !== "https://app.example.com")
      fail("an origin with nothing saved but sessionStorage was not reported");
    if (sessionStorageOnlyOrigins({ cookies: [], origins: [] }, []).length !== 0)
      fail("an app with no sessionStorage at all was warned about it");
  });
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "sessionStorage kept beside a real cookie session is not warned about"

# The failure the issue reports, reproduced exactly: the same session with its
# sessionStorage half removed is all the old format could hold.
node -e '
  const fs = require("node:fs");
  const { sessionStorage, ...playwrightHalf } = require("./.uigraph/tab-session.json");
  fs.writeFileSync("./.uigraph/tab-session-legacy.json", JSON.stringify(playwrightHalf));
' 2>>/tmp/clickgraph-json-err.txt
node dist/cli.js walk "$URL/tab-app" --quiet --json \
  --storage-state .uigraph/tab-session-legacy.json --out .uigraph/tab-legacy-graph.json \
  >.uigraph/tab-legacy-out.json 2>/dev/null
check "$?" "1" "a session file holding only what Playwright saves lands back on the sign-in form"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const v = require("./.uigraph/tab-legacy-out.json");
  if (!v.load.likelyAuthWall) fail("the walk got in without the tab session, so it proves nothing");
  if (v.findings.some((f) => /Export workspace/.test(f.control)))
    fail("a control from behind the sign-in form was reached without a session");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "without the third store the walk sees the door and nothing behind it"

# The same walk, the same app, the whole file: the session is replayed before
# the first navigation and the app finds it where it left it.
node dist/cli.js walk "$URL/tab-app" --quiet --json \
  --storage-state .uigraph/tab-session.json --out .uigraph/tab-graph.json \
  >.uigraph/tab-out.json 2>/dev/null
check "$?" "0" "a replayed sessionStorage gets the walk past a tab-scoped sign-in"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const v = require("./.uigraph/tab-out.json");
  if (v.load.likelyAuthWall) fail("still looking at the sign-in form with the session restored");
  if (!v.findings.some((f) => /Export workspace/.test(f.control)))
    fail("the walk did not reach the control that only exists behind the tab session: " +
      JSON.stringify(v.findings.map((f) => f.control)));
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the walk reaches and judges a control that only exists once signed in"

# sessionStorage is per origin, and a session that cannot apply must be said
# out loud rather than turning up later as an unexplained login screen.
node dist/cli.js walk "http://127.0.0.1:$PORT/tab-app" \
  --storage-state .uigraph/tab-session.json --out .uigraph/tab-otherorigin-graph.json \
  >.uigraph/tab-otherorigin-out.txt 2>.uigraph/tab-otherorigin-err.txt
grep -q 'sessionStorage is per origin' .uigraph/tab-otherorigin-err.txt
check "$?" "0" "a session saved for another origin is reported, not silently unused"

# Backward compatibility: a file written before any of this existed has no
# sessionStorage key, and must still read as the session it always was.
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  import("./dist/session.js").then(({ readSessionFile }) => {
    const legacy = readSessionFile("./.uigraph/tab-session-legacy.json");
    if (legacy.sessionStorage.length !== 0) fail("a legacy session file grew a third store");
    const full = readSessionFile("./.uigraph/tab-session.json");
    if (full.sessionStorage[0].items[0].name !== "acme.tab-session")
      fail("the sessionStorage half did not survive the round trip");
    if (JSON.stringify(full.storageState) !== JSON.stringify({ cookies: [], origins: [] }))
      fail("the half handed to Playwright is not a plain storage state: " +
        JSON.stringify(full.storageState));
  });
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "a session file written before this change still reads, and the halves stay apart"
echo "Q: declared field values open a state behind a lookup (issue #20)"
# The premise: /lookup shows a detail panel only when the field holds a code
# the app knows. The walker's own `clickgraph-test` is not one, so the panel —
# and the dead "Void order" on it — is not merely unwalked but absent, and the
# run says so by saying nothing.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/lookup" --quiet --json --fill-forms --max-depth 2 \
  --out /tmp/clickgraph-lookup-blind.json >/tmp/clickgraph-lookup-blind-out.json 2>/dev/null
check "$?" "0" "a walk with no declared value still succeeds"
node -e '
  const v = require("/tmp/clickgraph-lookup-blind-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.findings.some((f) => /Void order/.test(f.control)))
    fail("the dead control behind the lookup was found without a declared value");
  if (!v.ok) fail("a blind walk should still report ok — that is what made this invisible");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "without a declared value the state is absent, and the run reports success"

node dist/cli.js walk "$URL/lookup" --quiet --json --fill-forms --max-depth 2 \
  --field "#order-code=ORD-1042" --out /tmp/clickgraph-lookup.json \
  >/tmp/clickgraph-lookup-out.json 2>/dev/null
check "$?" "0" "a walk that declares the lookup value succeeds"
node -e '
  const v = require("/tmp/clickgraph-lookup-out.json");
  const g = require("/tmp/clickgraph-lookup.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  // The finding the feature exists for.
  if (!v.findings.some((f) => f.severity === "no-effect" && /Void order/.test(f.control)))
    fail("the dead control behind the lookup was not reached");
  // Its working neighbour must not be reported, or every lookup detail view
  // becomes a wall of false positives.
  if (v.findings.some((f) => /Reprint packing slip/.test(f.control)))
    fail("the working control beside it was reported as broken");
  // Reproducibility: the value is what opens the state, so the graph has to
  // record it the way it records a fault.
  if (JSON.stringify(g.config.fields) !== JSON.stringify([{ match: "#order-code", value: "ORD-1042" }]))
    fail(`the graph does not record its declared fields: ${JSON.stringify(g.config.fields)}`);
  if (g.coverage.unusedFields.length !== 0) fail("a value that was typed was reported unused");
  // Re-entering the state means re-typing. Without the selector on the fill
  // entry, replay clicks submit on an empty form and lands somewhere else.
  const typed = g.edges.find((e) => e.action.kind === "fill" && /Look up/.test(e.action.name));
  if (!typed) fail("the lookup form was never filled");
  if (typed.action.fill[0].value !== "ORD-1042") fail("the declared value was not the one typed");
  if (!typed.action.fill[0].selector) fail("the fill entry is not replayable");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "reaches the dead control behind the lookup, clears its working neighbour"

# A declaration that matches nothing is the silent failure this feature was
# built to end: the walk goes on synthesizing and reports success.
node dist/cli.js walk "$URL/lookup" --quiet --json --fill-forms --max-depth 1 \
  --field "#renamed-since=ORD-1042" --out /tmp/clickgraph-lookup-unused.json \
  >/tmp/clickgraph-lookup-unused-out.json 2>/dev/null
check "$?" "1" "a declared value that matches nothing fails the run"
node -e '
  const v = require("/tmp/clickgraph-lookup-unused-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.ok !== false) fail("ok must be false when a declared value never landed");
  if (JSON.stringify(v.coverage.unusedFields) !== JSON.stringify(["#renamed-since=ORD-1042"]))
    fail(`the unused declaration is not named: ${JSON.stringify(v.coverage.unusedFields)}`);
  if (!/never typed/.test(v.verdict)) fail(`the verdict does not say why: ${v.verdict}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "JSON names the declaration that landed nowhere, and says the states were missed"

# A selector the browser cannot parse is a usage error, not a walk that blames
# the app's own field for it. Well-formed as a spec — it splits into selector
# and value cleanly — so this reaches the CSS check rather than the one that
# refuses a malformed --field argument. Those two are separate refusals with
# separate messages, and the loop below covers the other one.
node dist/cli.js walk "$URL/lookup" --quiet --fill-forms --field ":::nope=x" \
  --out /tmp/clickgraph-lookup-bad.json >/dev/null 2>/tmp/clickgraph-lookup-bad-err.txt
check "$?" "2" "an unparseable selector is a usage error"
grep -q 'not valid CSS' /tmp/clickgraph-lookup-bad-err.txt
check "$?" "0" "and it says which selector, before any walking happens"

# Inheritance, for the fault's reason: the value is what opens the state, so a
# diff that dropped it walks a smaller app and calls the difference a defect.
node dist/cli.js diff "$URL/lookup" --quiet --json --fill-forms --max-depth 2 \
  --baseline /tmp/clickgraph-lookup.json >/tmp/clickgraph-lookup-diff.json \
  2>/tmp/clickgraph-lookup-diff-err.txt
check "$?" "0" "diff inherits declared field values and reports no change"
test ! -s /tmp/clickgraph-lookup-diff-err.txt
check "$?" "0" "inherited declarations produce no warning"

node dist/cli.js diff "$URL/lookup" --quiet --json --fill-forms --max-depth 2 --no-fields \
  --baseline /tmp/clickgraph-lookup.json >/tmp/clickgraph-lookup-cross.json \
  2>/tmp/clickgraph-lookup-cross-err.txt
grep -q 'the states they opened will read as missing' /tmp/clickgraph-lookup-cross-err.txt
check "$?" "0" "dropping a baseline's declared values is warned about explicitly"

node -e '
  Promise.all([import("./dist/formfill.js")]).then(([{ parseFieldSpec, refusesFill }]) => {
    const fail = (m) => { console.error(m); process.exit(1); };
    // Neither side owns "=". A value may contain them, and so may the
    // selector — an attribute selector is the ordinary way to name a field.
    // Getting this wrong is silent: the selector matches nothing.
    const eq = parseFieldSpec("#q=a=b");
    if (eq.match !== "#q" || eq.value !== "a=b") fail(`greedy split: ${JSON.stringify(eq)}`);
    for (const [spec, m, v] of [
      ["[data-testid=\"code\"]=ORD-1", "[data-testid=\"code\"]", "ORD-1"],
      ["[data-testid=code]=ORD-1", "[data-testid=code]", "ORD-1"],
      ["input:not([type=hidden])=X", "input:not([type=hidden])", "X"],
    ]) {
      const got = parseFieldSpec(spec);
      if (got.match !== m || got.value !== v)
        fail(`${spec} parsed as ${JSON.stringify(got)}`);
    }
    for (const bad of ["", "=value", "   =v"]) {
      let threw = false;
      try { parseFieldSpec(bad); } catch { threw = true; }
      if (!threw) fail(`${JSON.stringify(bad)} should be rejected`);
    }
    // A declared value clears the password refusal and nothing else: the rule
    // was never "do not type here", it was "do not GUESS here".
    const password = { inputType: "password", tag: "input" };
    if (!refusesFill(password)) fail("an undeclared password field must still stop the form");
    if (refusesFill(password, "hunter2")) fail("a declared password must be typed");
    if (!refusesFill({ inputType: "file", tag: "input" }, "anything"))
      fail("no string fills a file input, declared or not");
  });
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the field spec parses, refuses nonsense, and overrides only the password rule"

echo "R: a form whose submit is disabled until it is filled (issue #34)"
# The premise: /people/new disables "Add person" until every field is
# non-empty, and one of those fields is a password. Filling is what un-disables
# the submit, and reaching the submit is what triggers filling — so a walker
# that skips disabled controls before it fills forms can never open the form
# from either end. Every create-account, invite-user and change-password flow
# in any app is this shape, and the whole of it went missing behind an exit 0.
#
# Walked from the front door rather than from the form: entering directly on a
# page that holds a password field trips the login-wall heuristic, which is a
# separate matter from whether the form can be filled.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL" --quiet --json --fill-forms --max-depth 2 \
  --out /tmp/clickgraph-pwform-blind.json >/tmp/clickgraph-pwform-blind-out.json 2>/dev/null
check "$?" "0" "a walk that declares no field values still succeeds"
node -e '
  const v = require("/tmp/clickgraph-pwform-blind-out.json");
  const g = require("/tmp/clickgraph-pwform-blind.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  const at = (route) => g.coverage.skipped.filter((s) => s.nodeId.startsWith(route));
  // The conservative default is the point: an undeclared password is a
  // credential the walk has no business inventing, so the form is left alone.
  if (g.edges.some((e) => e.action.kind === "fill" && /Add person/.test(e.action.selector.label)))
    fail("a form containing a password was submitted without the password being declared");
  // What changed. The submit used to be filed as a bare `disabled` with no
  // reason, which is how a create-account flow that was never exercised read
  // as a clean sweep.
  const submit = at("/people/new").find((s) => /Add person/.test(s.label));
  if (!submit) fail("the submit was not reported as skipped at all");
  if (!/password field is never typed into/.test(submit.detail ?? ""))
    fail(`the refusal does not name the password as its reason: ${JSON.stringify(submit)}`);
  if (!/3 field\(s\) left unfilled/.test(submit.detail ?? ""))
    fail(`the refusal does not say how much of the form went unwalked: ${JSON.stringify(submit)}`);
  // The fields are still accounted for one by one — that is issue #19 keeping
  // coverage honest, and it must not regress. What changed is what they say:
  // they point back at the form that was turned away, where before the fix
  // they blamed themselves for responding to typing rather than to a click.
  for (const want of ["Name", "Email", "Password"]) {
    const f = at("/people/new").find((s) => s.label === `textbox "${want}"`);
    if (!f) fail(`${want} vanished from coverage instead of being accounted for`);
    if (!/its form was never submitted/.test(f.detail ?? ""))
      fail(`${want} does not point back at its unsubmitted form: ${JSON.stringify(f)}`);
  }
  // The other side of the fix: a form the walk is right to leave shut. It must
  // be filled, re-read, and reported — never clicked while still disabled,
  // which would blame the app for a door the walk could not open.
  const shut = at("/invite").find((s) => /Send invite/.test(s.label));
  if (!shut) fail("the submit that stayed disabled was not reported at all");
  if (!/still disabled after filling/.test(shut.detail ?? ""))
    fail(`the skip does not say the fill was tried first: ${JSON.stringify(shut)}`);
  if (v.findings.some((f) => /Send invite|Add person/.test(f.control)))
    fail("a submit that never became enabled was reported as a dead control");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "refuses both forms with the reason attached, and calls neither one dead"

node dist/cli.js walk "$URL" --quiet --json --fill-forms --max-depth 2 \
  --field '[data-testid="person-name"]=Walked Person' \
  --field '[data-testid="person-email"]=walked@example.com' \
  --field '[data-testid="person-password"]=a-real-password' \
  --field '[data-testid="invite-code"]=ACME-4242' \
  --out /tmp/clickgraph-pwform.json >/tmp/clickgraph-pwform-out.json 2>/dev/null
check "$?" "0" "declaring the values opens both forms the walk had refused"
node -e '
  const g = require("/tmp/clickgraph-pwform.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  // Every one of these came back NEVER TYPED before the fix, failing the run:
  // the escape hatch that exists for exactly this shape could not reach a
  // field inside a form the filler had already declined.
  if (g.coverage.unusedFields.length !== 0)
    fail(`a declared value never landed: ${JSON.stringify(g.coverage.unusedFields)}`);
  // Matched on the role-qualified label, because the nav link to /people/new is
  // called "Add person" too and is legitimately left unexpanded on a deeper
  // state by the depth budget. A bare substring match reads that as the submit
  // having been both walked and skipped.
  const submitted = (label) => {
    const button = `button "${label}"`;
    const e = g.edges.find((x) => x.action.kind === "fill" && x.action.selector.label === button);
    if (!e) fail(`${button} was never filled and submitted`);
    if (e.outcome.kind === "no-effect") fail(`submitting ${button} did nothing`);
    if (g.coverage.skipped.some((s) => s.label === button))
      fail(`${button} was both walked and skipped`);
    return e;
  };
  const person = submitted("Add person");
  submitted("Send invite");
  // The declaration is the consent, and it is the only thing that may put a
  // value in a password field: a synthesized one would be a real sign-in
  // attempt against whatever app the walk was pointed at.
  const pw = person.action.fill.find((f) => /person-password/.test(f.selector?.value ?? ""));
  if (!pw) fail(`the password field was not among those filled: ${JSON.stringify(person.action.fill)}`);
  if (pw.value !== "a-real-password") fail(`the declared password was not the one typed: ${pw.value}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "fills and submits both forms, typing the declared password and no other"
echo "S: a page that merely holds a password field is not a door (issue #36)"
# The failure this guards against is the mirror of E's. E is about a login
# screen being walked as though it were the app; this is about a page inside
# the app being refused as though it were a login screen. The signal that used
# to answer on its own — a visible password field — is on every create-account,
# invite-user and change-password page there is, which made the highest-
# consequence forms in any app the ones that could not be walked at all.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/people/new" --quiet --json --fill-forms --max-depth 1 \
  --field '[data-testid="person-name"]=Walked Person' \
  --field '[data-testid="person-email"]=walked@example.com' \
  --field '[data-testid="person-password"]=a-real-password' \
  --out /tmp/clickgraph-pwpage.json >/tmp/clickgraph-pwpage-out.json 2>/dev/null
check "$?" "0" "a form page holding a password does not fail the run"
node -e '
  const v = require("/tmp/clickgraph-pwpage-out.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (v.load.likelyAuthWall) fail("an add-a-person form was called a login screen");
  if (v.ok !== false && /login screen/.test(v.verdict))
    fail(`the verdict still calls it a door: ${v.verdict}`);
  if (v.ok !== true) fail(`the walk was failed for something else: ${v.verdict}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "walks it as a page in an app, not as the door to one"

# The corroboration must not be a licence to miss a real gate. Both shapes the
# detector exists for have to keep failing: the server-side wall E walks, and
# the in-browser one whose session a storage state cannot carry.
node dist/cli.js walk "$URL/tab-app" --quiet --json --max-depth 1 \
  >/tmp/clickgraph-pwpage-tab.json 2>/dev/null
check "$?" "1" "a gate that only the browser enforces still fails the run"
node -e '
  const v = require("/tmp/clickgraph-pwpage-tab.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!v.load.likelyAuthWall) fail("the in-browser gate stopped being detected");
  if (!/login screen/.test(v.verdict)) fail("the verdict no longer says it walked a door");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "still names the in-browser gate as a login screen"

echo "T: a form the app never wrote down (issue #24)"
# Most apps do not use <form>. The React shape is loose inputs and a button
# bound to a handler, and nothing in that DOM says which fields belong to which
# button — so --fill-forms could reach none of it, and every one of those
# buttons was clicked against empty fields and reported dead. Behind CLUSTER=1
# so the other scenarios keep their contract.
start_fixture PORT="$PORT" CLUSTER=1
node dist/cli.js walk "$URL/team" --quiet --json --max-depth 1 \
  --out /tmp/clickgraph-cluster-off.json >/tmp/clickgraph-cluster-off-out.json 2>/dev/null
check "$?" "0" "a screen with no form on it still walks cleanly"
node -e '
  const v = require("/tmp/clickgraph-cluster-off-out.json");
  const g = require("/tmp/clickgraph-cluster-off.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  // The false positive this exists to remove. Unfilled, the handler declines in
  // silence, which from outside is exactly what a button wired to nothing does.
  if (v.findings.some((f) => /Send invite/.test(f.control)))
    fail("a working button was called dead for declining an empty group");
  const at = g.coverage.skipped.filter((s) => s.nodeId.startsWith("/team"));
  const submit = at.find((s) => /Send invite/.test(s.label));
  if (!submit) fail("the inferred submit was neither walked nor reported");
  if (!/not in a form/.test(submit.detail ?? ""))
    fail(`the skip does not say why it could not tell: ${JSON.stringify(submit)}`);
  // The half that refuses. One field with two buttons beside it cannot be
  // grouped without guessing, and guessing means typing into fields that do not
  // belong together — so it stays skipped exactly as it was before.
  if (!at.some((s) => s.label === `textbox "Note"`))
    fail("the ungroupable field was not left skipped");
  // Refusing to group them must not cost the buttons their walk.
  if (v.findings.some((f) => /Save note|Clear/.test(f.control)))
    fail("a button beside an ungrouped field was reported as dead");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "infers no group where guessing would be wrong, and calls nothing dead for it"

node dist/cli.js walk "$URL/team" --quiet --json --fill-forms --max-depth 1 \
  --out /tmp/clickgraph-cluster-on.json >/tmp/clickgraph-cluster-on-out.json 2>/dev/null
check "$?" "0" "filling a group the app never declared still succeeds"
node -e '
  const v = require("/tmp/clickgraph-cluster-on-out.json");
  const g = require("/tmp/clickgraph-cluster-on.json");
  const fail = (m) => { console.error(m); process.exit(1); };
  // A rule that only ever refuses cannot be told from a rule that does nothing.
  // This is the half that proves the grouping was actually made.
  const sent = g.edges.find((e) => e.action.kind === "fill" && /Send invite/.test(e.action.selector.label));
  if (!sent) fail("the inferred group was never filled");
  if (sent.outcome.kind === "no-effect") fail("the button did nothing once its group was filled");
  const typed = sent.action.fill.map((f) => f.label).sort();
  if (typed.length !== 2) fail(`the group is the wrong size: ${JSON.stringify(typed)}`);
  // The adjacent card must not be dragged in. Typing into fields that belong to
  // a different button is the failure this whole inference is bounded to avoid.
  if (sent.action.fill.some((f) => /Note/.test(f.label)))
    fail(`a field from the neighbouring card was typed into: ${JSON.stringify(typed)}`);
  if (v.findings.some((f) => /Send invite|Save note|Clear/.test(f.control)))
    fail("a working control on the cluster screen was reported as dead");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "groups exactly the fields that belong to it, and proves the button works"


echo "U: re-entering a state by routing costs nothing in what is found (issue #23)"
# The walk returns to a state between every control on it. It used to do that by
# reloading the base URL and replaying the whole path; now it takes a walked edge
# back where the graph knows one. That is only a fair trade if both ways of
# arriving find the same app, and they part company exactly where an app keeps
# something in memory a reload clears — so the graphs are compared here rather
# than assumed. `eval/equivalence.mjs` does this across six apps and takes ten
# minutes; this is the same contract at a size the suite can afford.
#
# Bounded with --max-actions so it stays under two minutes, but not so small
# that no route is ever taken: at 60 the walk gets past the entry page, which is
# where routing first becomes possible at all.
start_fixture PORT="$PORT"
# Deliberately not --json: how the walk re-entered each state is said in the
# progress output, which --json turns off, and that count is what tells these
# checks the feature ran at all. Nothing is lost — every finding is derived from
# the graph, so two identical graphs report identical findings by construction.
node dist/cli.js walk "$URL/" --max-depth 2 --max-actions 60 --settle 250 \
  --no-fast-reentry --out /tmp/clickgraph-reentry-slow.json \
  >/dev/null 2>/tmp/clickgraph-reentry-slow.log
check "$?" "0" "a walk that reloads its way back to every state still walks cleanly"

node dist/cli.js walk "$URL/" --max-depth 2 --max-actions 60 --settle 250 \
  --fast-reentry --out /tmp/clickgraph-reentry-fast.json \
  >/dev/null 2>/tmp/clickgraph-reentry-fast.log
check "$?" "0" "a walk that routes its way back to every state still walks cleanly"

node -e '
  const fs = require("node:fs");
  const fail = (m) => { console.error(m); process.exit(1); };
  const slow = fs.readFileSync("/tmp/clickgraph-reentry-slow.log", "utf8");
  const fast = fs.readFileSync("/tmp/clickgraph-reentry-fast.log", "utf8");
  // The flag has to actually reach the walker. A silently ignored --no-fast-
  // reentry would make every check below compare a run against itself and pass
  // for the emptiest possible reason.
  if (!/all by reloading/.test(slow)) fail("--no-fast-reentry still routed: " + slow.slice(-300));
  const took = fast.match(/(\d+) by a known route/);
  if (!took) fail("the routing walk never said how it re-entered: " + fast.slice(-300));
  // A feature that stops working would otherwise sail through the comparison
  // below, because two identical slow walks agree perfectly.
  if (Number(took[1]) < 1)
    fail("no state was re-entered by a route, so the comparison proves nothing");
  // Every route the graph offered has to arrive where it was aimed. A miss is
  // not a wrong answer — the walk falls back and reloads — but it is clicks
  // spent for nothing, and on this fixture there is no excuse for one.
  if (/tried and missed/.test(fast)) fail("a route missed its target: " + fast.slice(-300));
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the flag is honoured, routes are taken, and every one arrives where it was aimed"

node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const slow = require("/tmp/clickgraph-reentry-slow.json");
  const fast = require("/tmp/clickgraph-reentry-fast.json");
  if (slow.config.fastReentry !== false || fast.config.fastReentry !== true)
    fail("the graphs do not record which way they were walked");
  const edges = (g) => g.edges
    .map((e) => `${e.from}|${e.action.kind}|${e.action.name}|${e.to}|${e.outcome.kind}`).join("\n");
  if (edges(slow) !== edges(fast))
    fail("the two ways of re-entering a state disagree about what the app does");
  const skips = (g) => JSON.stringify(g.coverage.skipped);
  if (skips(slow) !== skips(fast))
    fail("the two ways of re-entering a state disagree about what was skipped");
  const totals = (g) => [g.coverage.statesFound, g.coverage.edgesWalked, g.coverage.edgesUnwalked,
    (g.coverage.accountingGaps ?? []).length].join(",");
  if (totals(slow) !== totals(fast))
    fail(`coverage differs: ${totals(slow)} vs ${totals(fast)}`);
  const nodes = (g) => Object.values(g.nodes)
    .map((n) => `${n.id}|${n.fingerprint.structure}|${n.interactiveCount}`).sort().join("\n");
  if (nodes(slow) !== nodes(fast))
    fail("the two ways of re-entering a state found different screens");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "same states, same edges, same skips, same coverage, whichever way it got there"
echo "V: a control the walk's own fill removes is a skip, not a dead run"
# /dispatch has a submit that is conditionally RENDERED, not merely disabled:
# choosing the empty bay swaps the whole block for a sentence. Filling the form
# drives that select, so the walk removes the very button it was about to
# press. Legitimate app behaviour, and it used to abort the entire run — a
# locator that no longer resolves costs a full actionability timeout and then
# throws, so the process exited 2 having written no graph at all. Losing a
# baseline and a gate over one vanished button is worse than any finding
# (issue #46).
node dist/cli.js walk "$URL/dispatch" --quiet --fill-forms --max-depth 1 \
  --out /tmp/clickgraph-vanishing.json >/tmp/clickgraph-vanishing.txt 2>&1
check "$?" "0" "a submit that the fill removes does not take the run down with it"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const g = require("/tmp/clickgraph-vanishing.json");

  // Exit 0 alone would also be satisfied by swallowing the control silently,
  // which is the other way to get this wrong: the run has to SAY the button
  // went unpressed, in the vocabulary it already uses for a control that is
  // not there.
  const gone = g.coverage.skipped.find((s) => /Dispatch/.test(s.label));
  if (!gone) fail("the vanished submit is missing from skipped[] — it was swallowed, not reported");
  if (gone.reason !== "unreachable")
    fail(`reported as ${gone.reason}, but it is not there at all, so it is unreachable`);

  // "disabled" would be the wrong word and the wrong diagnosis: the button was
  // never disabled, it stopped existing. A reader chasing a disabled submit
  // looks for a validation rule that is not there.
  if (!/took it off the page/.test(gone.detail ?? ""))
    fail(`the detail does not name the cause: ${JSON.stringify(gone.detail)}`);

  // And the walk kept going afterwards rather than limping to the end.
  if (g.coverage.statesFound < 2) fail("the walk stopped at the page that lost its button");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and it is reported as unreachable, with the fill named as the cause"


echo "W: a digits-only field declared with inputmode is filled with digits"
# /tally is a count box and the button it gates, with no form around them. The
# field is type="text" with inputmode="numeric" — what a touch-first app uses,
# because type="number" brings a spinner and scroll-to-change that are wrong
# under a thumb. Reading only `type`, the walk typed a word, the button stayed
# disabled, and it was reported as needing something the walk could not
# supply — when a number was all it wanted (issue #42).
node dist/cli.js walk "$URL/tally" --quiet --fill-forms --max-depth 1 \
  --out /tmp/clickgraph-inputmode.json >/tmp/clickgraph-inputmode.txt 2>&1
check "$?" "0" "a walk of a digits-only cluster succeeds"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const g = require("/tmp/clickgraph-inputmode.json");

  const pressed = g.edges.find((e) => /Record/.test(e.action?.selector?.label ?? ""));
  if (!pressed) {
    const skip = g.coverage.skipped.find((s) => /Record/.test(s.label));
    fail(`the gated button was never pressed: ${skip ? skip.reason + " — " + skip.detail : "not reported at all"}`);
  }
  // Pressed is not enough: a button clicked while still disabled changes
  // nothing and would read as dead. The point is that filling ENABLED it.
  if (pressed.outcome.kind === "no-effect")
    fail("the button was pressed but nothing happened, so the value did not satisfy it");

  // And the value really was digits, not a word that happened to be accepted.
  const typed = (pressed.action.fill ?? []).map((f) => f.value);
  if (!typed.some((v) => /^[0-9]+$/.test(v)))
    fail(`the field was filled with ${JSON.stringify(typed)}, which is not a number`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and the button it gates is pressed, and works"


echo "X: a screen whose every word changed and whose every control did not (issue #48)"
# /inventory is the shape every structural signal agrees is untouched: same
# route, same headings, same controls, same count. Reword every cell of its
# table and `diff` used to answer "No change. Every walked interaction behaves
# as it did in the baseline." — the one sentence that lets a UI change through
# review, said over a screen a reviewer would fail on sight.
start_fixture PORT="$PORT"
node dist/cli.js walk "$URL/inventory" --quiet --max-depth 1 \
  --out /tmp/clickgraph-content-base.json >/tmp/clickgraph-content.txt 2>&1
check "$?" "0" "a walk of the inventory screen succeeds"

# The quiet half FIRST, because it is the half that regresses silently. The
# page stamps a fresh Date.now() into itself on every load, which is what real
# screens do, and a text signal that reports it is one nobody reads by the
# second week. Falsified before being trusted: with the digit normalisation
# taken out of the build, this check reports a text change on an app nobody
# touched — which is the whole reason it comes before the loud one.
node dist/cli.js diff "$URL/inventory" --quiet --max-depth 1 \
  --baseline /tmp/clickgraph-content-base.json --json >/tmp/clickgraph-content-same.json 2>/dev/null
check "$?" "0" "an unchanged screen that restamps itself on every load is not a text change"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const v = require("/tmp/clickgraph-content-same.json");
  if (v.other.length !== 0)
    fail(`the unchanged screen reported ${JSON.stringify(v.other.map((c) => c.summary))}`);
  // And it stayed quiet for the right reason. If both loads landed on the same
  // millisecond the stamp never moved, nothing was normalised, and the check
  // above would pass with the feature deleted.
  if (v.baselineWalkedAt === v.currentWalkedAt)
    fail("both walks share a timestamp, so the volatile stamp may not have differed at all");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and the two loads really did differ, so the silence was earned"

# Now the loud half. Nothing on this page moves except the words.
start_fixture PORT="$PORT" REWORD=1
node dist/cli.js diff "$URL/inventory" --quiet --max-depth 1 \
  --baseline /tmp/clickgraph-content-base.json --json >/tmp/clickgraph-content-reworded.json 2>/dev/null
check "$?" "0" "rewording every cell does not fail the run"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const v = require("/tmp/clickgraph-content-reworded.json");

  const said = v.other.find((c) => c.kind === "changed-content");
  if (!said) {
    fail(`no text change reported. verdict: ${JSON.stringify(v.verdict)}`);
  }
  if (!/inventory/.test(said.summary))
    fail(`the finding does not name the screen: ${JSON.stringify(said.summary)}`);

  // Reported as shape would be the wrong diagnosis and the wrong repair: a
  // reader told controls changed goes looking for a control that did not move.
  if (v.other.some((c) => c.kind === "changed-state"))
    fail("the rewording was reported as a shape change, and no control changed shape");

  // Info, not regression, and deliberately so: adding or removing a CONTROL is
  // not a regression here, so changing a word cannot be. What was broken was
  // the silence, not the exit code.
  if (v.regressions.length !== 0)
    fail(`a copy change failed the run: ${JSON.stringify(v.regressions)}`);
  if (v.ok !== true) fail("ok went false over a text change");

  // The verdict line is what an agent reads, and "no change" is the sentence
  // this whole scenario exists to stop it from getting.
  if (/no change/i.test(v.verdict))
    fail(`the verdict still says nothing happened: ${JSON.stringify(v.verdict)}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and it is reported as a text change, on the right screen, without failing the gate"

# A baseline written before this existed carries no content hash, and the only
# honest answer from one is silence. Reporting a text change against a baseline
# that never measured text would flag every state of every older graph on the
# first run after upgrading — the #37 rule, applied to a different signal.
start_fixture PORT="$PORT"
node -e '
  const fs = require("fs");
  const g = JSON.parse(fs.readFileSync("/tmp/clickgraph-content-base.json", "utf8"));
  for (const n of Object.values(g.nodes)) delete n.fingerprint.content;
  fs.writeFileSync("/tmp/clickgraph-content-old.json", JSON.stringify(g));
'
node dist/cli.js diff "$URL/inventory" --quiet --max-depth 1 \
  --baseline /tmp/clickgraph-content-old.json --json >/tmp/clickgraph-content-oldbase.json 2>/dev/null
check "$?" "0" "a baseline that predates the content hash still diffs"
node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const v = require("/tmp/clickgraph-content-oldbase.json");
  if (v.other.some((c) => c.kind === "changed-content"))
    fail("a baseline that never measured text was read as proof the text changed");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and says nothing about text it never measured"


echo "Y: a state whose only door is a chosen option (issue #43)"
# /depot is the one shape that puts a `select` step into a state PATH: choosing
# a bay opens a screen. Every step of a path used to be replayed by clicking,
# which is right for a click and silently wrong for a select — it opens the
# list, chooses nothing, and succeeds. The walk went back to a state it had
# reached by filtering, arrived on the unfiltered screen, and nothing compared
# where it landed against where it was sent.
start_fixture PORT="$PORT"
# Not --json: how each state was re-entered is said in the progress output, and
# that count is what proves the replay ran at all.
node dist/cli.js walk "$URL/depot" --max-depth 2 --out /tmp/clickgraph-depot.json \
  >/dev/null 2>/tmp/clickgraph-depot.log
check "$?" "0" "a walk of a state behind a chosen option succeeds"
node -e '
  const fs = require("node:fs");
  const fail = (m) => { console.error(m); process.exit(1); };
  const log = fs.readFileSync("/tmp/clickgraph-depot.log", "utf8");
  const g = require("/tmp/clickgraph-depot.json");

  // FIRST, that a re-entry happened at all — and this check exists because the
  // first version of this fixture did not force one. Its buttons left the
  // screen shape alone, the walk never had to travel back, and the run was
  // byte-identical with the bug present and absent. A scenario that cannot
  // fail against the bug it names is worse than no scenario.
  const back = log.match(/re-entered states (\d+) time\(s\)/);
  if (!back) fail("the walk never re-entered a state, so no path was ever replayed");
  if (Number(back[1]) < 1) fail("no re-entry happened: " + log.slice(-300));
  if (/landed on a different screen/.test(log))
    fail("a replay missed the state it was aimed at: " + log.slice(-300));

  // The dead control sits SECOND on the bay screen, so reaching it costs a
  // re-entry. Replayed wrong, it is not on the page at all and comes back as a
  // skip that blames the app — "not on the page when the walk came back" — for
  // a control that never went anywhere.
  const dead = g.edges.find((e) => /Print manifest/.test(e.action?.selector?.label ?? ""));
  if (!dead) {
    const skip = (g.coverage.skipped ?? []).find((s) => /Print manifest/.test(s.label));
    fail(`the dead control behind the re-entry was never walked: ${skip ? skip.reason + " — " + skip.detail : "not reported at all"}`);
  }
  if (dead.outcome.kind !== "no-effect")
    fail(`the dead control came back ${dead.outcome.kind}, so the walk was not on the bay screen`);

  // And it is filed against the bay screen, not against the state the walk
  // would have been looking at if the replay had chosen nothing.
  const on = g.nodes[dead.from];
  if (!on || !(on.fingerprint.landmarks ?? []).some((l) => /Bay A/.test(l)))
    fail(`the finding is attributed to ${dead.from}, which is not the bay screen`);

  if ((g.coverage.skipped ?? []).length !== 0)
    fail(`controls were skipped: ${JSON.stringify(g.coverage.skipped)}`);
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "the control behind the re-entry is reached, and filed against the right state"

node -e '
  const fail = (m) => { console.error(m); process.exit(1); };
  const g = require("/tmp/clickgraph-depot.json");
  const step = Object.values(g.nodes).flatMap((n) => n.path).find((a) => a.kind === "select");
  if (!step) fail("no select step landed in any path, so this route tests nothing");
  // The label is what a report says; the value is what re-selects it, and they
  // are different strings. Recording only the label is what left replay with
  // nothing to work from and a click as its fallback.
  if (step.option === undefined)
    fail(`the select step recorded only the label ${JSON.stringify(step.value)} and no option value`);
  if (step.option === step.value)
    fail("the label and the value on this fixture option match, so this proves nothing");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and the select step is recorded with the option value, not only its label"

# The other half, and the larger one: a path that stops leading where it led.
# DRIFT reassigns the bay once one has been chosen, so discovery succeeds and
# every re-entry afterwards lands somewhere else. Nothing about this is
# detectable from inside the replay — the steps are all found and all performed
# — which is why arrival has to be checked rather than assumed.
start_fixture PORT="$PORT" DRIFT=1
node dist/cli.js walk "$URL/depot" --max-depth 2 --out /tmp/clickgraph-depot-drift.json \
  >/dev/null 2>/tmp/clickgraph-depot-drift.log
check "$?" "0" "a walk whose path stops leading where it led still finishes"
node -e '
  const fs = require("node:fs");
  const fail = (m) => { console.error(m); process.exit(1); };
  const log = fs.readFileSync("/tmp/clickgraph-depot-drift.log", "utf8");
  const g = require("/tmp/clickgraph-depot-drift.json");

  // The state was found. If discovery itself failed there is nothing for a
  // re-entry to miss, and the rest of this check would pass over an app the
  // walk never got into.
  const bay = Object.values(g.nodes)
    .find((n) => (n.fingerprint.landmarks ?? []).some((l) => /Bay A/.test(l)));
  if (!bay) fail("the bay screen was never discovered, so no replay had a target to miss");

  if (!/landed on a different screen/.test(log))
    fail("the walk replayed its way onto another screen and said nothing: " + log.slice(-400));

  // Said as incompleteness, not as findings. Reporting the bay screen controls
  // as dead here would be the actual damage: real observations of a screen the
  // browser was never on.
  const stranded = (g.coverage.skipped ?? []).filter((s) => s.reason === "not-reached");
  if (stranded.length === 0) fail("nothing was reported as unreached");
  if (!stranded.every((s) => /landed on/.test(s.detail ?? "")))
    fail(`a skip does not say where the replay went: ${JSON.stringify(stranded)}`);
  if (g.edges.some((e) => e.from === bay.id))
    fail("an edge was recorded on the bay screen, which the walk never got back to");
' 2>>/tmp/clickgraph-json-err.txt
check "$?" "0" "and its controls are reported unreached, never as findings against a state it never re-entered"


echo ""
echo "PASSED: $pass   FAILED: $fail"
[ "$fail" -eq 0 ]

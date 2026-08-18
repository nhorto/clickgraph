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
#   L  a state whose only door is a typed value is walked when one is declared,
#      and a declaration that lands nowhere fails the run instead of passing
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

echo "L: declared field values open a state behind a lookup (issue #20)"
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

echo ""
echo "PASSED: $pass   FAILED: $fail"
[ "$fail" -eq 0 ]

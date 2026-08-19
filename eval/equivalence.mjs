#!/usr/bin/env node
/**
 * Fast-vs-slow equivalence: does re-entering states by routing through the
 * known graph find the same graph as reloading from the base URL?
 *
 * Issue #23 makes the walk cheaper by taking a known edge back to a state
 * instead of reloading and replaying the whole path to it. That trade is only
 * sound if the two ways of arriving are interchangeable, and they are not
 * interchangeable in general: they diverge exactly where an app keeps
 * something in memory that a fresh load drops — which is the kind of app this
 * tool exists for. So the speed-up is worth nothing without a check that both
 * routes find the same graph on the same app, and that check has to be able to
 * fail.
 *
 * Two modes:
 *
 *   --control   run the SAME configuration twice. Any difference reported here
 *               is walk nondeterminism, not a routing bug — and it puts a
 *               floor under everything else, because a comparator that cannot
 *               tell two identical runs apart is the only one whose verdict on
 *               fast-vs-slow means anything. Run this first.
 *
 *   (default)   run --no-fast-reentry against --fast-reentry and compare.
 *
 * Every scenario gets a freshly started server on both sides, so accumulated
 * server state cannot be mistaken for a routing difference.
 *
 * Port: 4177 by default, deliberately NOT the 4173 that scripts/verify.sh and
 * eval/replay.mjs both use — those kill each other's fixtures, and this one
 * runs long enough to be tempting to start alongside them. Override with PORT.
 *
 * Usage:
 *   node eval/equivalence.mjs [targets.json] [--control] [--only <id>]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  ensureDir, evalDir, killTree, repoRoot, requireCli,
  resultsDir, runCli, runStep, startServer, timestamp, waitReady,
} from './lib.mjs';

const argv = process.argv.slice(2);
const control = argv.includes('--control');
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--only');
const targetsPath = resolvePath(positional[0] ?? join(evalDir, 'targets', 'equivalence.json'));
const PORT = process.env.PORT ?? '4177';

requireCli();
ensureDir(resultsDir);

const target = JSON.parse(readFileSync(targetsPath, 'utf8'));
const cwd = resolvePath(repoRoot, target.cwd ?? '.');
const scenarios = target.scenarios.filter((s) => !only || s.id === only);
if (scenarios.length === 0) {
  console.error(`error: no scenario matched ${only}`);
  process.exit(2);
}

const outPath = join(resultsDir, `equivalence-${target.name}-${timestamp()}.jsonl`);
writeFileSync(outPath, '');
const record = (row) => appendFileSync(outPath, JSON.stringify(row) + '\n');

/* ------------------------------------------------------------------ *
 * Canonical forms
 *
 * What is compared is what a reader of the report would act on. What is
 * excluded is excluded because it MUST differ between the two runs and says
 * nothing about the app: the timestamp, and the config that names the mode.
 * Nothing else is excluded — an equivalence check that quietly narrows its own
 * scope proves whatever it was narrowed to.
 * ------------------------------------------------------------------ */

const actionOf = (a) =>
  [a.kind, a.role, a.name, a.value ?? '', (a.fill ?? []).map((f) => `${f.label}=${f.value}`).join(',')]
    .join('|');

const canon = {
  nodes: (g) =>
    Object.values(g.nodes)
      .map((n) => [
        n.id, n.url, n.title, n.fingerprint.structure,
        `controls=${n.interactiveCount}`,
        `path=${n.path.map(actionOf).join(' > ')}`,
      ].join('  '))
      .sort(),
  edges: (g) => g.edges.map((e) => `${e.from} --[${actionOf(e.action)}]--> ${e.to} = ${e.outcome.kind}`),
  skipped: (g) =>
    (g.coverage.skipped ?? [])
      .map((s) => `${s.nodeId}  ${s.label}  ${s.reason}  ${s.detail ?? ''}`)
      .sort(),
  totals: (g) => [
    `statesFound=${g.coverage.statesFound}`,
    `edgesWalked=${g.coverage.edgesWalked}`,
    `edgesUnwalked=${g.coverage.edgesUnwalked}`,
    `limitHit=${g.coverage.limitHit}`,
    `accountingGaps=${(g.coverage.accountingGaps ?? []).length}`,
    `unusedFields=${(g.coverage.unusedFields ?? []).length}`,
    `unreachedRoutes=${(g.coverage.unreachedRoutes ?? []).length}`,
    `loadErrors=${g.load.consoleErrors.length + g.load.httpErrors.length}`,
    `likelyAuthWall=${g.load.likelyAuthWall}`,
  ],
};

/** Multiset difference, so a duplicated edge is a difference and not a wash. */
function diffLists(a, b) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const out = [];
  for (const [k, n] of ca) {
    const m = cb.get(k) ?? 0;
    if (n > m) out.push({ side: 'A-only', item: k, times: n - m });
  }
  for (const [k, m] of cb) {
    const n = ca.get(k) ?? 0;
    if (m > n) out.push({ side: 'B-only', item: k, times: m - n });
  }
  return out;
}

function compare(a, b) {
  const findings = [];
  for (const key of ['nodes', 'edges', 'skipped', 'totals']) {
    const differences = diffLists(canon[key](a), canon[key](b));
    if (differences.length > 0) findings.push({ key, differences });
  }
  // Edge ORDER is compared separately from edge content. A walk that finds the
  // same edges in a different order is a much smaller thing than one that finds
  // different edges, and folding them together would hide that.
  const ea = canon.edges(a), eb = canon.edges(b);
  if (findings.every((f) => f.key !== 'edges') && ea.join('\n') !== eb.join('\n')) {
    const at = ea.findIndex((x, i) => x !== eb[i]);
    findings.push({
      key: 'edge-order',
      differences: [{ side: 'order', item: `first divergence at index ${at}: A=${ea[at]} / B=${eb[at]}`, times: 1 }],
    });
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Run one side of one scenario, against its own fresh server.
 * ------------------------------------------------------------------ */
async function runSide(scenario, label, extraArgs) {
  const server = startServer(
    target.serve, cwd,
    { PORT, ...(target.env ?? {}), ...(scenario.env ?? {}) },
  );
  try {
    const base = `http://localhost:${PORT}`;
    if (!(await waitReady(base, target.readyTimeoutMs ?? 15_000))) {
      return { error: `server did not come up on ${PORT}: ${server.output().slice(-400)}` };
    }
    // A scenario that needs a signed-in session builds one against this very
    // server, on both sides, rather than sharing one file between them: a
    // session minted once and reused is a difference between the two runs, and
    // this harness exists to have no such differences that it did not intend.
    if (scenario.setup) {
      const prep = runStep(scenario.setup, cwd, { PORT, CLICKGRAPH_URL: base });
      if (!prep.ok) {
        return { error: `setup failed (exit ${prep.status}): ${(prep.stderr || prep.stdout).slice(-400)}` };
      }
    }
    const graphPath = join(resultsDir, `.equiv-${scenario.id}-${label}.json`);
    const url = base + (scenario.path ?? '/');
    const started = Date.now();
    const run = runCli(
      ['walk', url, '--json', '--quiet', '--out', graphPath,
       ...(target.walkArgs ?? []), ...(scenario.walkArgs ?? []), ...extraArgs],
      { cwd },
    );
    const seconds = (Date.now() - started) / 1000;
    let graph = null;
    try { graph = JSON.parse(readFileSync(graphPath, 'utf8')); } catch { /* reported below */ }
    if (!graph) {
      return { error: `no graph written (exit ${run.status}): ${(run.stderr || run.stdout).slice(-400)}` };
    }
    return { graph, seconds, status: run.status, verdict: run.verdict?.verdict ?? null };
  } finally {
    killTree(server.child);
  }
}

/* ------------------------------------------------------------------ */

const modeA = control ? ['--no-fast-reentry'] : ['--no-fast-reentry'];
const modeB = control ? ['--no-fast-reentry'] : ['--fast-reentry'];
const nameA = control ? 'slow-1' : 'slow';
const nameB = control ? 'slow-2' : 'fast';

console.log(
  control
    ? `control run: ${nameA} vs ${nameB} (identical configuration) — any difference is walk nondeterminism`
    : `equivalence: ${nameA} (${modeA.join(' ')}) vs ${nameB} (${modeB.join(' ')})`,
);
console.log(`target ${target.name}, ${scenarios.length} scenario(s), port ${PORT}\n`);
record({ kind: 'run', target: target.name, control, modeA, modeB, port: PORT, scenarios: scenarios.length });

let equivalent = 0, divergent = 0, failed = 0;

for (const [i, scenario] of scenarios.entries()) {
  const tag = `[${i + 1}/${scenarios.length}] ${scenario.id}`;
  console.log(`${tag} ${scenario.description ?? scenario.path ?? '/'}`);

  const a = await runSide(scenario, nameA, modeA);
  if (a.error) {
    console.log(`  ${nameA}: FAILED TO RUN — ${a.error}\n`);
    record({ kind: 'scenario', id: scenario.id, result: 'run-failed', side: nameA, error: a.error });
    failed++;
    continue;
  }
  const b = await runSide(scenario, nameB, modeB);
  if (b.error) {
    console.log(`  ${nameB}: FAILED TO RUN — ${b.error}\n`);
    record({ kind: 'scenario', id: scenario.id, result: 'run-failed', side: nameB, error: b.error });
    failed++;
    continue;
  }

  const speed = a.seconds > 0 ? `${(a.seconds / b.seconds).toFixed(2)}x` : 'n/a';
  console.log(
    `  ${nameA}: ${a.seconds.toFixed(1)}s exit ${a.status}   ` +
    `${nameB}: ${b.seconds.toFixed(1)}s exit ${b.status}   (${speed})`,
  );

  const findings = compare(a.graph, b.graph);
  if (findings.length === 0) {
    console.log('  EQUIVALENT — same nodes, same edges, same skips, same totals\n');
    equivalent++;
  } else {
    const total = findings.reduce((n, f) => n + f.differences.length, 0);
    console.log(`  DIVERGENT — ${total} difference(s):`);
    for (const f of findings) {
      console.log(`    ${f.key}: ${f.differences.length}`);
      for (const d of f.differences.slice(0, 6)) {
        console.log(`      ${d.side === 'A-only' ? nameA : d.side === 'B-only' ? nameB : d.side}: ${d.item}`);
      }
      if (f.differences.length > 6) console.log(`      … ${f.differences.length - 6} more (see ${outPath})`);
    }
    console.log('');
    divergent++;
  }
  record({
    kind: 'scenario', id: scenario.id, path: scenario.path ?? '/',
    result: findings.length === 0 ? 'equivalent' : 'divergent',
    secondsA: a.seconds, secondsB: b.seconds, statusA: a.status, statusB: b.status,
    verdictA: a.verdict, verdictB: b.verdict, findings,
  });
}

console.log('================================================================');
console.log(`${control ? 'control' : 'equivalence'} of ${target.name}: ${scenarios.length} scenario(s)`);
console.log(`  equivalent   ${equivalent}`);
console.log(`  divergent    ${divergent}`);
console.log(`  failed       ${failed}`);
if (control && divergent > 0) {
  console.log('');
  console.log('A control run that diverges means the walk is not deterministic on this app.');
  console.log('Fix that first: until it holds, a fast-vs-slow difference cannot be attributed.');
}
console.log(`\nfull record: ${outPath}`);
record({ kind: 'summary', equivalent, divergent, failed });

process.exit(divergent > 0 || failed > 0 ? 1 : 0);

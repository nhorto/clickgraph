/**
 * Track 2 — the mutation harness. Sensitivity, measured.
 *
 * History replay (replay.mjs) can only measure noise, because history is
 * unlabeled. Here the labels are manufactured: take a runnable app, walk a
 * clean baseline, then apply one known breakage at a time — a handler
 * unwired, an endpoint gone — and check that `clickgraph diff` reports it.
 * "Caught N of M planted bugs" is a real sensitivity number, and every miss
 * is a concrete detection gap with a reproduction attached.
 *
 * Usage:
 *   node eval/mutate.mjs eval/mutations/fixture.json [--only <id>]
 *
 * Mutations are literal find/replace edits so they read at a glance and fail
 * loudly when the target file drifts (a mutation whose `find` no longer
 * matches is reported as stale, never silently skipped). Files are restored
 * byte-for-byte after every mutation, pass or fail — and after a run that was
 * KILLED mid-mutation, which the `finally` alone cannot do and which silently
 * corrupted the next run's baseline twice before it was handled.
 *
 * `expect.severity` says which list the finding belongs in — 'regression' by
 * default, or 'info' for a change the tool is right to report and wrong to
 * fail the build over. Both are detection; only one is a defect.
 *
 * Exit code: 0 all mutations caught, 1 any missed, 2 harness/setup error.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ensureDir, evalDir, killTree, repoRoot, requireCli, resultsDir, runCli,
  runStep, startServer, timestamp, waitReady,
} from './lib.mjs';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

const configPath = process.argv[2];
if (!configPath) fail('usage: node eval/mutate.mjs <mutations.json> [--only <id>]');
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));

const {
  name, url, serve,
  cwd = '.',
  build = null,
  env = {},
  readyTimeoutMs = 15_000,
  walkArgs = [],
  mutations = [],
} = config;
if (!name || !url || !serve) fail('mutations config needs at least name, url, serve');
if (mutations.length === 0) fail('no mutations defined');

/**
 * The mutation currently applied to disk, so it can be undone by something
 * other than the `finally` below.
 *
 * That `finally` is not enough, and the gap is not theoretical — it corrupted
 * two runs in one afternoon. A mutation is a live edit to a real checkout, and
 * `finally` does not run when the process dies of a signal. Kill a run mid
 * mutation and the edit stays applied; the NEXT run then walks its "clean"
 * baseline against an app that is already broken, and nothing announces it.
 * That is the worst shape a harness bug can take — the run completes, prints a
 * tally, and every number in it is measured against the wrong baseline.
 *
 * The marker is a file rather than a variable because SIGKILL and a pulled
 * plug cannot be trapped at all, so recovery has to survive the process, not
 * just its exit path.
 */
const inflightPath = join(evalDir, '.work', `inflight-${name}.json`);

function markInflight(filePath, original) {
  ensureDir(join(evalDir, '.work'));
  writeFileSync(inflightPath, JSON.stringify({ file: filePath, original }));
}
function clearInflight() {
  if (existsSync(inflightPath)) rmSync(inflightPath);
}

// Recover from a previous run that was killed while a mutation was applied.
if (existsSync(inflightPath)) {
  try {
    const held = JSON.parse(readFileSync(inflightPath, 'utf8'));
    writeFileSync(held.file, held.original);
    console.log(`recovered: a previous run was killed with a mutation still applied to`);
    console.log(`  ${held.file}`);
    console.log(`  it has been restored, so this run's baseline is the real app again\n`);
  } catch (err) {
    fail(`found ${inflightPath} but could not restore from it: ${err.message}`);
  }
  clearInflight();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (existsSync(inflightPath)) {
      const held = JSON.parse(readFileSync(inflightPath, 'utf8'));
      writeFileSync(held.file, held.original);
      clearInflight();
      console.log(`\ninterrupted — restored ${held.file}`);
    }
    process.exit(130);
  });
}

const onlyFlag = process.argv.indexOf('--only');
const only = onlyFlag !== -1 ? process.argv[onlyFlag + 1] : null;
const selected = only ? mutations.filter((m) => m.id === only) : mutations;
if (selected.length === 0) fail(`no mutation with id ${JSON.stringify(only)}`);

requireCli();
const appDir = resolve(repoRoot, cwd);

async function serveAnd(cliArgs) {
  const server = startServer(serve, appDir, env);
  try {
    if (!(await waitReady(url, readyTimeoutMs))) {
      return { failed: `server never answered at ${url}: ${server.output().trim().slice(-400)}` };
    }
    return runCli(cliArgs);
  } finally {
    killTree(server.child);
  }
}

function rebuild() {
  if (!build) return null;
  const res = runStep(build, appDir, env);
  return res.ok ? null : `build failed (exit ${res.status}): ${(res.stderr || '').trim().slice(-400)}`;
}

// ------------------------------------------------------------- the baseline
const workDir = ensureDir(join(evalDir, '.work', `mutate-${name}`));
const graphPath = join(workDir, 'baseline.json');
rmSync(graphPath, { force: true });

console.log(`walking clean baseline of ${name} …`);
{
  const reason = rebuild();
  if (reason) fail(reason);
}
const baseline = await serveAnd(['walk', url, '--json', '--quiet', '--out', graphPath, ...walkArgs]);
if (baseline.failed) fail(baseline.failed);
if (!existsSync(graphPath)) {
  fail(`baseline walk wrote no graph (exit ${baseline.status}): ${(baseline.stderr || '').trim().slice(-400)}`);
}
console.log(`  ${baseline.verdict?.verdict ?? `exit ${baseline.status}`}`);

// ------------------------------------------------------------ the mutations
ensureDir(resultsDir);
const outPath = join(resultsDir, `mutate-${name}-${timestamp()}.jsonl`);
const rows = [];
const record = (row) => {
  rows.push(row);
  appendFileSync(outPath, JSON.stringify(row) + '\n');
};

for (const [i, m] of selected.entries()) {
  const started = Date.now();
  console.log(`\n[${i + 1}/${selected.length}] ${m.id} — ${m.description}`);
  const filePath = resolve(appDir, m.file);
  const original = readFileSync(filePath, 'utf8');

  if (!original.includes(m.find)) {
    console.log(`  STALE: \`find\` string no longer present in ${m.file} — update the mutation`);
    record({ id: m.id, outcome: 'stale', durationMs: Date.now() - started });
    continue;
  }

  try {
    markInflight(filePath, original);
    writeFileSync(filePath, original.split(m.find).join(m.replace));
    const reason = rebuild();
    if (reason) {
      console.log(`  env-failed: ${reason}`);
      record({ id: m.id, outcome: 'env-failed', reason, durationMs: Date.now() - started });
      continue;
    }
    const diff = await serveAnd(['diff', url, '--json', '--quiet', '--out', graphPath, ...walkArgs]);
    if (diff.failed || !diff.verdict) {
      const reason = diff.failed ?? `diff printed no JSON (exit ${diff.status})`;
      console.log(`  TOOL FAILURE: ${reason}`);
      record({
        id: m.id, outcome: 'tool-failure', reason,
        stderr: (diff.stderr || '').trim().slice(-2000), durationMs: Date.now() - started,
      });
      continue;
    }

    // `expect.severity` decides which list a planted bug is supposed to land
    // in, and the default stays 'regression' so every existing mutation reads
    // as it always did.
    //
    // It exists because the harness could previously only ask "did this fail
    // the build?", and that is a narrower question than "did the tool report
    // it". A whole class of true detection — a screen reported as changed
    // without the change being called a defect — was invisible to the number
    // this file prints, which is why the README's own fairness rule quietly
    // excluded text mutations and why nobody noticed for months that a
    // reworded table came back "No change" (issue #48). A sensitivity harness
    // that can only see regressions will always report perfect sensitivity to
    // the things it can see.
    const severity = m.expect?.severity ?? 'regression';
    const reported = severity === 'info'
      ? (diff.verdict.other ?? [])
      : (diff.verdict.regressions ?? []);
    const matcher = m.expect?.match ? new RegExp(m.expect.match, 'i') : null;
    const matched = matcher
      ? reported.filter((r) => matcher.test(`${r.summary} ${r.detail ?? ''}`))
      : reported;
    // An 'info' mutation must NOT fail the run — being reported without being
    // called a defect is the whole of what it claims, and an exit 1 would mean
    // something else broke and took the credit.
    const exitAsExpected = severity === 'info' ? diff.status === 0 : diff.status === 1;
    const caught = exitAsExpected && matched.length > 0;

    if (caught) {
      console.log(`  CAUGHT: ${matched[0].summary}`);
    } else if (reported.length > 0) {
      console.log(`  MISSED the planted bug, but flagged something else:`);
      for (const r of reported) console.log(`    - ${r.summary}`);
    } else {
      console.log(`  MISSED: diff exit ${diff.status} — ${diff.verdict.verdict}`);
    }
    record({
      id: m.id,
      outcome: caught ? 'caught' : 'missed',
      expectedSeverity: severity,
      exit: diff.status,
      verdict: diff.verdict.verdict,
      regressions: diff.verdict.regressions ?? [],
      other: diff.verdict.other ?? [],
      matchedExpectation: matched.map((r) => r.summary),
      durationMs: Date.now() - started,
    });
  } finally {
    writeFileSync(filePath, original);
    clearInflight();
  }
}
// Leave the app the way we found it even for the build artifacts.
rebuild();

// -------------------------------------------------------------- the summary
const caught = rows.filter((r) => r.outcome === 'caught');
const missed = rows.filter((r) => r.outcome === 'missed');
const broken = rows.filter((r) => !['caught', 'missed'].includes(r.outcome));

console.log(`\n${'='.repeat(64)}`);
console.log(`mutations on ${name}: caught ${caught.length} of ${caught.length + missed.length} planted bug(s)` +
  (broken.length ? `, ${broken.length} not measured (stale/env/tool)` : ''));
for (const r of missed) console.log(`  MISSED  ${r.id} — this is a detection gap; file it as an issue`);
for (const r of broken) console.log(`  ${r.outcome.toUpperCase()}  ${r.id}`);
console.log(`\nfull record: ${outPath}`);

process.exit(missed.length > 0 || broken.length > 0 ? 1 : 0);

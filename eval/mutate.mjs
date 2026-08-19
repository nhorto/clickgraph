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
 * byte-for-byte after every mutation, pass or fail.
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

    const regressions = diff.verdict.regressions ?? [];
    const matcher = m.expect?.match ? new RegExp(m.expect.match, 'i') : null;
    const matched = matcher
      ? regressions.filter((r) => matcher.test(`${r.summary} ${r.detail ?? ''}`))
      : regressions;
    const caught = diff.status === 1 && matched.length > 0;

    if (caught) {
      console.log(`  CAUGHT: ${matched[0].summary}`);
    } else if (regressions.length > 0) {
      console.log(`  MISSED the planted bug, but flagged something else:`);
      for (const r of regressions) console.log(`    - ${r.summary}`);
    } else {
      console.log(`  MISSED: diff exit ${diff.status} — ${diff.verdict.verdict}`);
    }
    record({
      id: m.id,
      outcome: caught ? 'caught' : 'missed',
      exit: diff.status,
      verdict: diff.verdict.verdict,
      regressions,
      matchedExpectation: matched.map((r) => r.summary),
      durationMs: Date.now() - started,
    });
  } finally {
    writeFileSync(filePath, original);
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

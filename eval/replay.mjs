/**
 * Track 1 — the history-replay noise harness.
 *
 * Replays a repo's recent merge history as if an agent had just landed each
 * change: walk the app at the merge's first parent, then diff at the merge
 * itself. A healthy repo's history is overwhelmingly made of changes that did
 * NOT break the UI, so what this measures is clickgraph's noise floor — how
 * often it cries regression on ordinary change, and whether state identity
 * survives real refactors. That is the failure mode that kills tools like
 * this, and this harness puts a number on it.
 *
 * What it does not measure: missed bugs. History is unlabeled; sensitivity
 * comes from mutate.mjs, where the bugs are planted and known.
 *
 * Usage:
 *   node eval/replay.mjs eval/targets/self.json [--pairs N]
 *
 * Every pair is recorded to eval/results/replay-<name>-<time>.jsonl, one JSON
 * object per line, and a human summary is printed at the end. A pair whose
 * environment failed (server never came up, install failed) is recorded as
 * env-failed, never silently dropped — a replay that skips the awkward commits
 * would report a noise floor it did not actually measure.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ensureDir, evalDir, git, killTree, repoRoot, requireCli, resultsDir, runCli,
  runStep, startServer, timestamp, waitReady,
} from './lib.mjs';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

const configPath = process.argv[2];
if (!configPath) fail('usage: node eval/replay.mjs <target.json> [--pairs N]');
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));

let pairsWanted = config.pairs ?? 8;
const pairsFlag = process.argv.indexOf('--pairs');
if (pairsFlag !== -1) pairsWanted = Number(process.argv[pairsFlag + 1]);
if (!Number.isInteger(pairsWanted) || pairsWanted < 1) fail('--pairs needs a positive integer');

const {
  name, url, serve,
  branch = 'main',
  install = null,
  build = null,
  env = {},
  readyTimeoutMs = 30_000,
  walkArgs = [],
} = config;
if (!name || !url || !serve) fail('target config needs at least name, url, serve');

requireCli();

// ---------------------------------------------------------------- the clone
// Always a scratch clone, never the caller's checkout: the harness force-
// checkouts commits and cleans the tree, and it must be free to do that
// without eating anyone's work in progress.
const workDir = ensureDir(join(evalDir, '.work', name));
const clone = join(workDir, 'repo');
const source = config.repo === '.' || config.repo === undefined ? repoRoot : config.repo;
if (!existsSync(clone)) {
  console.log(`cloning ${source} …`);
  git(['clone', '--quiet', source, clone]);
} else {
  try { git(['fetch', '--all', '--quiet'], clone); } catch { /* local source, nothing to fetch */ }
}

// The branch may only exist as origin/<branch> in a fresh clone.
let branchRef = branch;
try { git(['rev-parse', '--verify', '--quiet', branchRef], clone); }
catch { branchRef = `origin/${branch}`; git(['rev-parse', '--verify', '--quiet', branchRef], clone); }

// A clone copies the source's branches, not its remote-tracking refs. Cloning
// a checkout whose own `main` is behind its remote therefore measures the
// history that checkout happens to hold, which is a strict subset of the real
// one — and the shortfall biases the result in the reassuring direction, since
// fewer merges walked means fewer chances to flag and a smaller denominator
// under the flag rate. Prefer what the source's remote knows over what its
// working checkout does, and pull that in by SHA so no network is needed
// (issue #37).
let sourceHead = null;
try { sourceHead = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], source); }
catch { /* the source tracks no remote for this branch; its own is the best there is */ }
if (sourceHead) {
  const cloneHead = git(['rev-parse', branchRef], clone);
  if (cloneHead !== sourceHead) {
    const ahead = git(['rev-list', '--count', `${cloneHead}..${sourceHead}`], source);
    console.log(
      `note: ${source} has ${branch} checked out ${ahead} commit(s) behind its origin — ` +
      `replaying what the remote knows (${sourceHead.slice(0, 8)}), not the local branch`,
    );
    git(['fetch', '--quiet', source, `refs/remotes/origin/${branch}:refs/remotes/source/${branch}`], clone);
    branchRef = `refs/remotes/source/${branch}`;
  }
}

const mergeLog = git(
  ['log', '--merges', '--first-parent', '-n', String(pairsWanted), '--format=%H %s', branchRef],
  clone,
);
const merges = mergeLog.split('\n').filter(Boolean).map((line) => {
  const space = line.indexOf(' ');
  return { sha: line.slice(0, space), subject: line.slice(space + 1) };
}).reverse(); // oldest first, so the printed log reads like history

if (merges.length === 0) fail(`no merge commits found on ${branchRef}`);
// Repeated in the summary block below. A shortfall printed only here scrolls
// away behind an hour of per-pair output, and the number it qualifies — the
// flag rate — is read off the summary.
const shortfall = merges.length < pairsWanted
  ? `only ${merges.length} of the ${pairsWanted} merge(s) asked for exist on ${branchRef}`
  : null;
if (shortfall) console.log(`note: ${shortfall}`);
console.log(
  `replaying ${merges.length} merge(s) from ${branchRef} @ ${git(['rev-parse', branchRef], clone).slice(0, 8)}`,
);

const checkoutAt = (sha) => {
  git(['checkout', '--force', '--detach', sha], clone);
  // -fd but not -x: generated files go, node_modules and caches stay, so a
  // configured install step is cheap on the second and later checkouts.
  git(['clean', '-fd'], clone);
};

/** install/build for the current checkout; returns null on success, reason on failure. */
function prepare(sha) {
  for (const [label, command] of [['install', install], ['build', build]]) {
    if (!command) continue;
    const res = runStep(command, clone, env);
    if (!res.ok) {
      return `${label} failed at ${sha.slice(0, 8)} (exit ${res.status}): ${
        (res.stderr || res.stdout || '').trim().slice(-400)}`;
    }
  }
  return null;
}

/** Serve the current checkout and run one CLI command against it. */
async function serveAnd(cliArgs) {
  const server = startServer(serve, clone, env);
  try {
    if (!(await waitReady(url, readyTimeoutMs))) {
      return { failed: `server never answered at ${url}: ${server.output().trim().slice(-400)}` };
    }
    return runCli(cliArgs);
  } finally {
    killTree(server.child);
  }
}

// ------------------------------------------------------------------ the run
const graphsDir = ensureDir(join(workDir, 'graphs'));
ensureDir(resultsDir);
const outPath = join(resultsDir, `replay-${name}-${timestamp()}.jsonl`);
// What was actually replayed, written before any pair runs. A result file that
// records only its pairs cannot be checked afterwards for whether it covered
// the history it claims to (issue #37).
appendFileSync(outPath, JSON.stringify({
  kind: 'run', target: name, branch, branchRef,
  head: git(['rev-parse', branchRef], clone),
  mergesFound: merges.length, pairsWanted, shortfall,
}) + '\n');
const rows = [];

const record = (row) => {
  rows.push(row);
  appendFileSync(outPath, JSON.stringify(row) + '\n');
};

for (const [i, merge] of merges.entries()) {
  const started = Date.now();
  const parent = git(['rev-parse', `${merge.sha}^1`], clone);
  const label = `[${i + 1}/${merges.length}] ${merge.sha.slice(0, 8)} ${merge.subject}`;
  console.log(`\n${label}`);

  const base = {
    pair: i + 1, merge: merge.sha, parent, subject: merge.subject,
  };
  const graphPath = join(graphsDir, `${parent.slice(0, 12)}.json`);
  rmSync(graphPath, { force: true });

  // --- baseline at the parent
  checkoutAt(parent);
  let reason = prepare(parent);
  let walk = null;
  if (!reason) {
    walk = await serveAnd(['walk', url, '--json', '--quiet', '--out', graphPath, ...walkArgs]);
    if (walk.failed) reason = walk.failed;
    else if (!existsSync(graphPath)) {
      reason = `walk wrote no graph (exit ${walk.status}): ${(walk.stderr || '').trim().slice(-400)}`;
    }
  }
  if (reason) {
    console.log(`  env-failed: ${reason}`);
    record({ ...base, outcome: 'env-failed', reason, durationMs: Date.now() - started });
    continue;
  }
  const w = walk.verdict;
  console.log(`  walk @ parent: exit ${walk.status} — ${w?.verdict ?? 'no verdict printed'}`);

  // --- diff at the merge
  checkoutAt(merge.sha);
  reason = prepare(merge.sha);
  let diff = null;
  if (!reason) {
    diff = await serveAnd(['diff', url, '--json', '--quiet', '--out', graphPath, ...walkArgs]);
    if (diff.failed) reason = diff.failed;
  }
  if (reason) {
    console.log(`  env-failed: ${reason}`);
    record({ ...base, outcome: 'env-failed', reason, durationMs: Date.now() - started });
    continue;
  }

  const d = diff.verdict;
  if (!d) {
    // The CLI crashed or printed garbage — that is a clickgraph robustness
    // finding in its own right, and the most valuable kind this harness emits.
    console.log(`  TOOL FAILURE: diff exit ${diff.status}, no JSON verdict`);
    record({
      ...base, outcome: 'tool-failure', exit: diff.status,
      stderr: (diff.stderr || '').trim().slice(-2000), durationMs: Date.now() - started,
    });
    continue;
  }

  const outcome = d.ok ? 'clean' : 'flagged';
  console.log(`  diff @ merge:  exit ${diff.status} — ${d.verdict}`);
  record({
    ...base,
    outcome,
    exit: diff.status,
    verdict: d.verdict,
    regressions: d.regressions,
    fixed: d.fixed,
    other: d.other,
    configWarnings: d.configWarnings,
    walk: {
      exit: walk.status,
      states: w?.coverage?.states,
      walked: w?.coverage?.walked,
      findings: w?.findings?.length,
    },
    coverage: { states: d.coverage?.states, walked: d.coverage?.walked },
    durationMs: Date.now() - started,
  });
}

// -------------------------------------------------------------- the summary
const by = (outcome) => rows.filter((r) => r.outcome === outcome);
const clean = by('clean');
const flagged = by('flagged');
const envFailed = by('env-failed');
const toolFailed = by('tool-failure');
const measured = clean.length + flagged.length;

console.log(`\n${'='.repeat(64)}`);
console.log(`replay of ${name}: ${merges.length} merge pair(s)`);
console.log(`  measured     ${measured}  (${clean.length} clean, ${flagged.length} flagged)`);
console.log(`  env-failed   ${envFailed.length}`);
console.log(`  tool-failure ${toolFailed.length}`);
if (measured > 0) {
  console.log(`  flag rate    ${(100 * flagged.length / measured).toFixed(0)}% of measured merges`);
}
// Next to the rate it qualifies, not an hour above it.
if (shortfall) console.log(`  incomplete   ${shortfall}`);
if (flagged.length > 0) {
  console.log(`\nFlagged merges — triage each one (a merge that really did break`);
  console.log(`something is a true positive; anything else is noise to fix):`);
  for (const r of flagged) {
    console.log(`  • ${r.merge.slice(0, 8)} ${r.subject}`);
    for (const reg of r.regressions ?? []) console.log(`      - [${reg.kind}] ${reg.summary}`);
  }
}
if (toolFailed.length > 0) {
  console.log(`\nTool failures (clickgraph itself broke — file these as issues):`);
  for (const r of toolFailed) console.log(`  • ${r.merge.slice(0, 8)} ${r.subject} (exit ${r.exit})`);
}
if (envFailed.length > 0) {
  console.log(`\nEnv failures (the target would not run — fix the target config):`);
  for (const r of envFailed) console.log(`  • ${r.merge.slice(0, 8)} ${r.reason.split('\n')[0]}`);
}
console.log(`\nfull record: ${outPath}`);

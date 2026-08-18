import type { GraphDiff, UIGraph, OutcomeKind } from './types.js';
import { actionLabel, nodeLabel } from './graph.js';
import { clickgraphVersionWarning } from './version.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  navigated: 'navigated',
  'state-changed': 'changed state',
  'network-only': 'network only',
  'no-effect': 'NO EFFECT',
  error: 'ERROR',
};

export function reportWalk(graph: UIGraph): string {
  const lines: string[] = [];
  const { coverage } = graph;

  lines.push('');
  lines.push(c.bold(`Walked ${graph.baseUrl}`));
  lines.push(
    c.dim(`  ${coverage.statesFound} states · ${coverage.edgesWalked} interactions exercised`),
  );

  // The entry page's own health comes first. A walk of a broken app finds no
  // controls and would otherwise print a reassuring empty report.
  const load = graph.load;
  if (load && (load.httpErrors.length > 0 || load.consoleErrors.length > 0)) {
    lines.push('');
    lines.push(c.red(c.bold('The page reported errors as it loaded')));
    for (const err of load.httpErrors.slice(0, 5)) lines.push(`  ${c.red('•')} ${err}`);
    for (const err of load.consoleErrors.slice(0, 5)) lines.push(`  ${c.red('•')} ${err}`);
    const extra = load.httpErrors.length + load.consoleErrors.length - 10;
    if (extra > 0) lines.push(c.dim(`  … and ${extra} more`));
    lines.push(c.dim('  Anything below was walked against an app that is already unhealthy.'));
  }
  // A gated app that walks its own login form has covered none of the thing
  // under test, and its report otherwise looks like any other clean run.
  if (load && load.likelyAuthWall) {
    lines.push('');
    lines.push(c.yellow(c.bold('The entry page looks like a login screen')));
    lines.push(
      c.dim('  Everything below describes the login page, not the app behind it.'),
    );
    lines.push(
      c.dim('  Sign in once and save the session, then pass --storage-state <path>.'),
    );
  }
  if (load && load.interactiveFound === 0) {
    lines.push('');
    lines.push(c.yellow(c.bold('No interactive controls found on the entry page')));
    lines.push(
      c.dim('  Nothing could be walked. The app may have failed to load, may need'),
    );
    lines.push(
      c.dim('  authentication, or may render its UI only after data arrives.'),
    );
  }

  const byKind = new Map<OutcomeKind, number>();
  for (const edge of graph.edges) {
    byKind.set(edge.outcome.kind, (byKind.get(edge.outcome.kind) ?? 0) + 1);
  }

  lines.push('');
  lines.push(c.bold('States'));
  const routeCounts = new Map<string, number>();
  for (const node of Object.values(graph.nodes)) {
    routeCounts.set(node.fingerprint.route, (routeCounts.get(node.fingerprint.route) ?? 0) + 1);
  }
  for (const node of Object.values(graph.nodes)) {
    const depth = node.path.length === 0 ? 'entry' : `${node.path.length} click(s) deep`;
    // Several distinct states can share a route (a modal over a page). Show the
    // landmark that separates them so the list is not a row of identical paths.
    const shared = (routeCounts.get(node.fingerprint.route) ?? 0) > 1;
    const landmark = shared && node.fingerprint.landmarks.length
      ? ` [${node.fingerprint.landmarks[node.fingerprint.landmarks.length - 1]}]`
      : '';
    lines.push(
      `  ${c.cyan(node.fingerprint.route + landmark)} ${c.dim(`— ${node.title} (${depth})`)}`,
    );
  }

  const problems = graph.edges.filter(
    (e) => (e.outcome.kind === 'no-effect' || e.outcome.kind === 'error') && !e.outcome.benign,
  );
  const benign = graph.edges.filter((e) => e.outcome.benign).length;
  if (problems.length > 0) {
    lines.push('');
    lines.push(c.bold('Findings'));
    for (const edge of problems) {
      const tag = edge.outcome.kind === 'error' ? c.red('ERROR') : c.yellow('NO EFFECT');
      lines.push(`  ${tag}  ${actionLabel(edge.action)}`);
      lines.push(
        c.dim(`         on ${nodeLabel(graph, edge.from)} — ${edge.outcome.note ?? ''}`),
      );
    }
  }

  lines.push('');
  lines.push(c.bold('Outcomes'));
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(3)}  ${OUTCOME_LABEL[kind]}`);
  }
  if (benign > 0) {
    lines.push(
      c.dim(`  (${benign} are controls that were already active — a link to the`),
    );
    lines.push(c.dim('   current page, or the tab already selected)'));
  }

  // Coverage honesty: always state what was NOT covered, never imply totality.
  lines.push('');
  lines.push(c.bold('Not covered'));
  const expectedRoutes = coverage.expectedRoutes ?? [];
  const unreachedRoutes = coverage.unreachedRoutes ?? [];
  const unusedFields = coverage.unusedFields ?? [];
  if (expectedRoutes.length > 0) {
    lines.push(
      `  Expected routes: ${expectedRoutes.length - unreachedRoutes.length}/${expectedRoutes.length} reached`,
    );
    for (const route of unreachedRoutes) lines.push(c.red(`  NOT REACHED  ${route}`));
  }
  for (const spec of unusedFields) {
    lines.push(c.red(`  NEVER TYPED  --field ${spec}`));
  }
  if (coverage.edgesWalked === 0) {
    // Never let "no controls found" read as "everything passed".
    lines.push(c.yellow('  nothing was walked — this run proves nothing about the app'));
  } else if (
    coverage.edgesUnwalked === 0 && coverage.skipped.length === 0 &&
    unreachedRoutes.length === 0 && unusedFields.length === 0
  ) {
    lines.push(c.dim('  nothing — every control found was exercised'));
  } else {
    if (coverage.edgesUnwalked > 0) {
      lines.push(`  ${coverage.edgesUnwalked} control(s) discovered but not walked`);
    }
    const byReason = new Map<string, number>();
    for (const s of coverage.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      lines.push(`  ${count} skipped (${reason})`);
      // The three reasons that mean "the walk ran out" rather than "the walker
      // declined" are the ones a reader can act on by re-running with a bigger
      // budget — but only if they are told which budget, and "N skipped
      // (budget)" on its own does not (issue #19).
      if (reason === 'budget' || reason === 'not-reached' || reason === 'frontier-exhausted') {
        const example = coverage.skipped.find((s) => s.reason === reason && s.detail);
        if (example?.detail) lines.push(c.dim(`      e.g. ${example.detail}`));
      }
    }
  }
  // A coverage figure that does not add up is worse than a bad one, because it
  // is a figure a reader would trust. Said where the coverage claim is made.
  const accountingGaps = coverage.accountingGaps ?? [];
  if (accountingGaps.length > 0) {
    lines.push(
      c.red(`  ${accountingGaps.length} state(s) whose controls do not add up — this is a ` +
        'clickgraph bug, and the counts above are unreliable:'),
    );
    for (const gap of accountingGaps.slice(0, 5)) lines.push(c.red(`    ${gap.detail}`));
    if (accountingGaps.length > 5) {
      lines.push(c.dim(`    … and ${accountingGaps.length - 5} more`));
    }
  }
  if (coverage.limitHit) {
    lines.push(c.yellow(`  walk stopped early at budget: ${coverage.limitHit}`));
  }
  lines.push(
    c.dim('  Coverage is heuristic, never exhaustive. Unwalked is not the same as working.'),
  );
  lines.push('');

  return lines.join('\n');
}

export function reportDiff(
  diff: GraphDiff,
  current?: UIGraph,
  options: { showVersionWarning?: boolean } = {},
): string {
  const lines: string[] = [];
  const regressions = diff.changes.filter((ch) => ch.severity === 'regression');
  const progressions = diff.changes.filter((ch) => ch.severity === 'progression');
  const info = diff.changes.filter((ch) => ch.severity === 'info');

  lines.push('');
  lines.push(c.bold('Graph diff'));
  lines.push(c.dim(`  baseline ${diff.baselineWalkedAt}`));
  lines.push(c.dim(`  current  ${diff.currentWalkedAt}`));
  lines.push('');

  const producerWarning = clickgraphVersionWarning(
    diff.baselineClickgraphVersion,
    diff.currentClickgraphVersion,
  );
  if (producerWarning && options.showVersionWarning !== false) {
    lines.push(c.yellow(c.bold('Tool version note')));
    lines.push(`  ${producerWarning}`);
    lines.push('');
  }

  const unreachedRoutes = current?.coverage.unreachedRoutes ?? diff.currentUnreachedRoutes ?? [];
  const unusedFields = current?.coverage.unusedFields ?? diff.currentUnusedFields ?? [];

  if (diff.changes.length === 0 && unreachedRoutes.length === 0 && unusedFields.length === 0) {
    lines.push(c.green('  No change. Every walked interaction behaves as it did in the baseline.'));
    lines.push('');
    return lines.join('\n');
  }

  if (diff.changes.length === 0) {
    lines.push(c.dim('  No interaction changes from the baseline.'));
    lines.push('');
  }

  const section = (title: string, items: typeof diff.changes, color: (s: string) => string) => {
    if (items.length === 0) return;
    lines.push(color(c.bold(title)));
    for (const ch of items) {
      lines.push(`  ${color('•')} ${ch.summary}`);
      if (ch.detail) lines.push(c.dim(`    ${ch.detail}`));
    }
    lines.push('');
  };

  section(`Regressions (${regressions.length})`, regressions, c.red);
  section(`Fixed (${progressions.length})`, progressions, c.green);
  section(`Other changes (${info.length})`, info, c.cyan);

  if (unreachedRoutes.length > 0) {
    lines.push(c.red(c.bold(`Expected routes not reached (${unreachedRoutes.length})`)));
    for (const route of unreachedRoutes) lines.push(`  ${c.red('•')} ${route}`);
    lines.push('');
  }

  // "No change" from a walk whose declared values never landed describes an app
  // this run did not actually open. Reported beside the route gap, and for the
  // same reason: a gap that only shows up as silence is the one that misleads.
  if (unusedFields.length > 0) {
    lines.push(c.red(c.bold(`Declared field values never typed (${unusedFields.length})`)));
    for (const spec of unusedFields) lines.push(`  ${c.red('•')} --field ${spec}`);
    lines.push('');
  }

  return lines.join('\n');
}

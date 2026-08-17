/**
 * The machine-readable answer.
 *
 * The graph file is the full record; this is what an agent reads to decide
 * whether the thing it just built works. It is deliberately small — an agent
 * that has to parse a 4000-line graph to find two broken buttons will either
 * burn its context or skip the check.
 *
 * Two rules carried from the report: `ok` means the same thing as the exit
 * code, never something softer; and coverage travels with the verdict, because
 * "no findings" is only meaningful next to how much was actually walked.
 */

import type { GraphDiff, UIGraph } from './types.js';
import { actionLabel, nodeLabel } from './graph.js';
import { faultSpec } from './fault.js';
import { clickgraphVersionWarning } from './version.js';

export interface VerdictFinding {
  severity: 'error' | 'no-effect';
  control: string;
  state: string;
  detail: string;
}

export interface VerdictCoverage {
  states: number;
  walked: number;
  unwalked: number;
  /**
   * Grouped by reason, with an example or two of what the reason meant. A bare
   * "40 skipped (unreachable)" gives an agent no way to tell a closed drawer
   * from a broken tool, and those call for opposite responses.
   */
  skipped: { reason: string; count: number; examples: string[] }[];
  limitHit: string | null;
  expectedRoutes: string[];
  unreachedRoutes: string[];
  /** Coverage is heuristic. Restated here so a JSON consumer cannot miss it. */
  note: string;
}

export interface WalkVerdict {
  tool: 'clickgraph';
  version: string;
  command: 'walk';
  url: string;
  walkedAt: string;
  ok: boolean;
  verdict: string;
  load: {
    healthy: boolean;
    errors: string[];
    interactiveFound: number;
    /** True means the run describes a login page, not the app behind it. */
    likelyAuthWall: boolean;
  };
  findings: VerdictFinding[];
  coverage: VerdictCoverage;
  graphPath: string;
}

export interface DiffVerdict {
  tool: 'clickgraph';
  version: string;
  baselineVersion: string | null;
  versionWarning: string | null;
  command: 'diff';
  url: string;
  baselineWalkedAt: string;
  currentWalkedAt: string;
  ok: boolean;
  verdict: string;
  regressions: { kind: string; summary: string; detail?: string }[];
  fixed: { kind: string; summary: string }[];
  other: { kind: string; summary: string; detail?: string }[];
  /** Baseline settings that the caller explicitly chose not to reproduce. */
  configWarnings: string[];
  coverage: VerdictCoverage;
}

const COVERAGE_NOTE =
  'Coverage is heuristic, never exhaustive. Unwalked is not the same as working.';

function coverageOf(graph: UIGraph): VerdictCoverage {
  const byReason = new Map<string, { count: number; examples: Set<string> }>();
  for (const s of graph.coverage.skipped) {
    const entry = byReason.get(s.reason) ?? { count: 0, examples: new Set<string>() };
    entry.count++;
    if (s.detail) entry.examples.add(s.detail);
    byReason.set(s.reason, entry);
  }
  return {
    states: graph.coverage.statesFound,
    walked: graph.coverage.edgesWalked,
    unwalked: graph.coverage.edgesUnwalked,
    skipped: [...byReason].map(([reason, { count, examples }]) => ({
      reason,
      count,
      examples: [...examples].slice(0, 2),
    })),
    limitHit: graph.coverage.limitHit,
    expectedRoutes: graph.coverage.expectedRoutes ?? [],
    unreachedRoutes: graph.coverage.unreachedRoutes ?? [],
    note: COVERAGE_NOTE,
  };
}

/**
 * Server errors and uncaught exceptions on load make a baseline untrustworthy.
 * An incidental 404 does not — same severity rule the walk itself applies.
 */
export function loadIsHealthy(graph: UIGraph): boolean {
  const load = graph.load;
  if (!load) return true;
  return (
    !load.httpErrors.some((e) => /^5\d\d /.test(e)) && load.consoleErrors.length === 0
  );
}

export function walkVerdict(graph: UIGraph, graphPath: string): WalkVerdict {
  const healthy = loadIsHealthy(graph);
  const nothingWalked = graph.coverage.edgesWalked === 0;
  /** Named in every verdict sentence a fault run can produce, not just the clean one. */
  const fault = graph.config?.fault ? faultSpec(graph.config.fault) : undefined;
  const unreachedRoutes = graph.coverage.unreachedRoutes ?? [];

  const findings: VerdictFinding[] = graph.edges
    .filter(
      (e) => (e.outcome.kind === 'no-effect' || e.outcome.kind === 'error') && !e.outcome.benign,
    )
    .map((e) => ({
      severity: e.outcome.kind === 'error' ? ('error' as const) : ('no-effect' as const),
      control: actionLabel(e.action),
      state: nodeLabel(graph, e.from),
      detail: e.outcome.note ?? '',
    }));

  const load = graph.load ?? { consoleErrors: [], httpErrors: [], interactiveFound: 0 };

  // The verdict sentence exists so an agent that reads nothing else still gets
  // the truth. It must never say "clean" when the walk proved nothing.
  let verdict: string;
  if (!healthy) {
    verdict = `the app reported errors as it loaded — anything below was walked against an app that is already unhealthy`;
  } else if (load.likelyAuthWall) {
    // Said before any count of what passed. A gated app walks its login form
    // cleanly, and that report is indistinguishable from a real one.
    verdict =
      'the entry page looks like a login screen — this run describes the login page, not the app behind it (sign in once, save the session, and pass --storage-state)';
  } else if (nothingWalked) {
    verdict =
      'nothing was walked — this run proves nothing about the app (it may have failed to load, or may need authentication)';
  } else if (unreachedRoutes.length > 0) {
    verdict = `${unreachedRoutes.length} expected route(s) were not reached: ${unreachedRoutes.join(', ')}`;
  } else if (findings.length === 0) {
    // Under fault injection "all produced an observable effect" would be a
    // true sentence that answers the wrong question. What the run proves is
    // that nothing failed silently, and the verdict has to say so or an agent
    // reads it as an ordinary clean walk of a healthy app.
    verdict = fault
      ? `${graph.coverage.edgesWalked} interaction(s) across ${graph.coverage.statesFound} state(s) ` +
        `were walked with ${fault} failing, and every one of them showed ` +
        'the user something — no failure was swallowed'
      : `${graph.coverage.edgesWalked} interaction(s) across ${graph.coverage.statesFound} state(s) all produced an observable effect`;
  } else {
    const errors = findings.filter((f) => f.severity === 'error').length;
    const dead = findings.length - errors;
    const parts = [
      errors > 0 ? `${errors} errored` : '',
      dead > 0 ? `${dead} produced no observable effect` : '',
    ].filter(Boolean);
    // The fault has to be named here too, not only when the run comes back
    // clean. "2 errored" on a fault walk is unreadable on its own: an agent
    // cannot tell an app that broke from an app the walk broke on purpose,
    // and those call for opposite responses.
    verdict = fault
      ? `of ${graph.coverage.edgesWalked} interaction(s) walked with ${fault} failing, ` +
        `${parts.join(' and ')} — an error here means the app showed the user nothing ` +
        'when the request failed'
      : `of ${graph.coverage.edgesWalked} interaction(s) walked, ${parts.join(' and ')}`;
  }

  return {
    tool: 'clickgraph',
    version: graph.clickgraphVersion ?? 'unknown',
    command: 'walk',
    url: graph.baseUrl,
    walkedAt: graph.walkedAt,
    // A walk that never got past the login screen proved nothing about the app,
    // which is the same failure as a walk that exercised nothing at all.
    ok: healthy && !nothingWalked && !load.likelyAuthWall && unreachedRoutes.length === 0,
    verdict,
    load: {
      healthy,
      errors: [...load.httpErrors, ...load.consoleErrors],
      interactiveFound: load.interactiveFound,
      likelyAuthWall: Boolean(load.likelyAuthWall),
    },
    findings,
    coverage: coverageOf(graph),
    graphPath,
  };
}

export function diffVerdict(
  diff: GraphDiff,
  current: UIGraph,
  configWarnings: string[] = [],
): DiffVerdict {
  const pick = (severity: string) => diff.changes.filter((ch) => ch.severity === severity);
  const regressions = pick('regression');
  const fixed = pick('progression');
  const other = pick('info');

  let verdict: string;
  const unreachedRoutes = current.coverage.unreachedRoutes ?? [];
  if (regressions.length > 0) {
    verdict = `${regressions.length} regression(s): ${regressions[0].summary}${
      regressions.length > 1 ? ` (and ${regressions.length - 1} more)` : ''
    }`;
  } else if (unreachedRoutes.length > 0) {
    verdict = `${unreachedRoutes.length} expected route(s) were not reached: ${unreachedRoutes.join(', ')}`;
  } else if (diff.changes.length === 0) {
    verdict = 'no change — every walked interaction behaves as it did in the baseline';
  } else {
    verdict = `no regressions; ${diff.changes.length} non-breaking change(s)`;
  }

  return {
    tool: 'clickgraph',
    version: diff.currentClickgraphVersion ?? 'unknown',
    baselineVersion: diff.baselineClickgraphVersion ?? null,
    versionWarning: clickgraphVersionWarning(
      diff.baselineClickgraphVersion,
      diff.currentClickgraphVersion,
    ),
    command: 'diff',
    url: current.baseUrl,
    baselineWalkedAt: diff.baselineWalkedAt,
    currentWalkedAt: diff.currentWalkedAt,
    ok: regressions.length === 0 && unreachedRoutes.length === 0,
    verdict,
    regressions: regressions.map((ch) => ({
      kind: ch.kind,
      summary: ch.summary,
      detail: ch.detail,
    })),
    fixed: fixed.map((ch) => ({ kind: ch.kind, summary: ch.summary })),
    other: other.map((ch) => ({ kind: ch.kind, summary: ch.summary, detail: ch.detail })),
    configWarnings,
    coverage: coverageOf(current),
  };
}

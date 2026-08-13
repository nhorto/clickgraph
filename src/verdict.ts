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
import { nodeLabel } from './graph.js';

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
  skipped: { reason: string; count: number }[];
  limitHit: string | null;
  /** Coverage is heuristic. Restated here so a JSON consumer cannot miss it. */
  note: string;
}

export interface WalkVerdict {
  tool: 'clickgraph';
  command: 'walk';
  url: string;
  walkedAt: string;
  ok: boolean;
  verdict: string;
  load: { healthy: boolean; errors: string[]; interactiveFound: number };
  findings: VerdictFinding[];
  coverage: VerdictCoverage;
  graphPath: string;
}

export interface DiffVerdict {
  tool: 'clickgraph';
  command: 'diff';
  url: string;
  baselineWalkedAt: string;
  currentWalkedAt: string;
  ok: boolean;
  verdict: string;
  regressions: { kind: string; summary: string; detail?: string }[];
  fixed: { kind: string; summary: string }[];
  other: { kind: string; summary: string; detail?: string }[];
  coverage: VerdictCoverage;
}

const COVERAGE_NOTE =
  'Coverage is heuristic, never exhaustive. Unwalked is not the same as working.';

function coverageOf(graph: UIGraph): VerdictCoverage {
  const byReason = new Map<string, number>();
  for (const s of graph.coverage.skipped) {
    byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  }
  return {
    states: graph.coverage.statesFound,
    walked: graph.coverage.edgesWalked,
    unwalked: graph.coverage.edgesUnwalked,
    skipped: [...byReason].map(([reason, count]) => ({ reason, count })),
    limitHit: graph.coverage.limitHit,
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

  const findings: VerdictFinding[] = graph.edges
    .filter(
      (e) => (e.outcome.kind === 'no-effect' || e.outcome.kind === 'error') && !e.outcome.benign,
    )
    .map((e) => ({
      severity: e.outcome.kind === 'error' ? ('error' as const) : ('no-effect' as const),
      control: e.action.selector.label,
      state: nodeLabel(graph, e.from),
      detail: e.outcome.note ?? '',
    }));

  const load = graph.load ?? { consoleErrors: [], httpErrors: [], interactiveFound: 0 };

  // The verdict sentence exists so an agent that reads nothing else still gets
  // the truth. It must never say "clean" when the walk proved nothing.
  let verdict: string;
  if (!healthy) {
    verdict = `the app reported errors as it loaded — anything below was walked against an app that is already unhealthy`;
  } else if (nothingWalked) {
    verdict =
      'nothing was walked — this run proves nothing about the app (it may have failed to load, or may need authentication)';
  } else if (findings.length === 0) {
    verdict = `${graph.coverage.edgesWalked} interaction(s) across ${graph.coverage.statesFound} state(s) all produced an observable effect`;
  } else {
    const errors = findings.filter((f) => f.severity === 'error').length;
    const dead = findings.length - errors;
    const parts = [
      errors > 0 ? `${errors} errored` : '',
      dead > 0 ? `${dead} produced no observable effect` : '',
    ].filter(Boolean);
    verdict = `of ${graph.coverage.edgesWalked} interaction(s) walked, ${parts.join(' and ')}`;
  }

  return {
    tool: 'clickgraph',
    command: 'walk',
    url: graph.baseUrl,
    walkedAt: graph.walkedAt,
    ok: healthy && !nothingWalked,
    verdict,
    load: {
      healthy,
      errors: [...load.httpErrors, ...load.consoleErrors],
      interactiveFound: load.interactiveFound,
    },
    findings,
    coverage: coverageOf(graph),
    graphPath,
  };
}

export function diffVerdict(diff: GraphDiff, current: UIGraph): DiffVerdict {
  const pick = (severity: string) => diff.changes.filter((ch) => ch.severity === severity);
  const regressions = pick('regression');
  const fixed = pick('progression');
  const other = pick('info');

  let verdict: string;
  if (regressions.length > 0) {
    verdict = `${regressions.length} regression(s): ${regressions[0].summary}${
      regressions.length > 1 ? ` (and ${regressions.length - 1} more)` : ''
    }`;
  } else if (diff.changes.length === 0) {
    verdict = 'no change — every walked interaction behaves as it did in the baseline';
  } else {
    verdict = `no regressions; ${diff.changes.length} non-breaking change(s)`;
  }

  return {
    tool: 'clickgraph',
    command: 'diff',
    url: current.baseUrl,
    baselineWalkedAt: diff.baselineWalkedAt,
    currentWalkedAt: diff.currentWalkedAt,
    ok: regressions.length === 0,
    verdict,
    regressions: regressions.map((ch) => ({
      kind: ch.kind,
      summary: ch.summary,
      detail: ch.detail,
    })),
    fixed: fixed.map((ch) => ({ kind: ch.kind, summary: ch.summary })),
    other: other.map((ch) => ({ kind: ch.kind, summary: ch.summary, detail: ch.detail })),
    coverage: coverageOf(current),
  };
}

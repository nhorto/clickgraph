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

import type { GraphDiff, RouteCheck, UIGraph } from './types.js';
import { actionLabel, nodeLabel } from './graph.js';

export interface VerdictFinding {
  severity: 'error' | 'no-effect';
  control: string;
  state: string;
  detail: string;
}

/**
 * The static map's side of the story, kept apart from `findings`.
 *
 * `findings` are controls the walk exercised and watched fail. These are two
 * artifacts disagreeing, where either one can be the wrong one — a different
 * kind of claim, and rolling them together would let a stale routes file
 * inflate the count of things wrong with the app.
 */
export interface VerdictRoutes {
  origin: string;
  declared: number;
  /** Declared addresses the walk reached by clicking. Map and app agree. */
  walked: number;
  /** They load, and nothing the walk clicked led to them. */
  urlOnly: RouteCheck[];
  /** Declared and not there. The map may be the stale one. */
  absent: RouteCheck[];
  /** Declared, there, and erroring. The only one of these that is about the app alone. */
  errored: RouteCheck[];
  /** Never opened — parameterized, or out of budget. */
  unchecked: number;
  /** Reached and never declared. A fact about the map. */
  undeclared: string[];
  /**
   * Not one declared address matched anything walked, so the map is probably
   * about something else and every row above is doubtful.
   *
   * A field rather than only a sentence in `note`, because the text report
   * withholds those rows entirely in this case and the two surfaces have to say
   * the same thing. A consumer that reads prose to decide whether to trust data
   * is one that will eventually not read it.
   */
  mapLooksUnrelated: boolean;
  note: string;
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
  /**
   * Whether the run explored or replayed a known graph. An agent deciding
   * whether to trust a clean result needs this: a replay only ever visits the
   * states its baseline already knew.
   */
  mode: 'walk' | 'replay';
  /**
   * Screens a replay reached and did not open. Anything behind one of these is
   * untested — this is the number that says a clean replay is not a clean app.
   */
  statesUnexplored: number;
  /** Reloads spent returning to a state already visited. Where the time goes. */
  reentries: number;
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
  load: {
    healthy: boolean;
    errors: string[];
    interactiveFound: number;
    /** True means the run describes a login page, not the app behind it. */
    likelyAuthWall: boolean;
  };
  findings: VerdictFinding[];
  coverage: VerdictCoverage;
  /** Present only when the run was given a route map to check itself against. */
  routes?: VerdictRoutes;
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

const ROUTES_NOTE =
  'The route map is a hint from the source, not ground truth. A disagreement means ' +
  'one of the two is out of date, and this run cannot say which.';

function routesOf(graph: UIGraph): VerdictRoutes | undefined {
  const report = graph.routes;
  if (!report) return undefined;
  const of = (status: RouteCheck['status']) => report.checks.filter((c) => c.status === status);
  return {
    origin: report.origin,
    declared: report.declared,
    walked: of('walked').length,
    urlOnly: of('url-only'),
    absent: of('absent'),
    errored: of('errored'),
    unchecked: of('unchecked').length,
    undeclared: report.undeclared,
    mapLooksUnrelated: report.mapLooksUnrelated,
    note: report.mapLooksUnrelated
      ? 'Nothing in this map matched anything the walk reached, so the map most likely ' +
        'describes different addresses than the browser sees — a hash-routed app, a base ' +
        'path, or another repository. Treat every row below as doubtful.'
      : ROUTES_NOTE,
  };
}

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
    mode: graph.coverage.mode ?? 'walk',
    statesUnexplored: graph.coverage.statesUnexplored ?? 0,
    reentries: graph.coverage.reentries ?? 0,
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
      control: actionLabel(e.action, e.outcome),
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

  // The map's disagreement is appended to the sentence for the same reason the
  // replay's unexplored screens are: a page nothing links to is invisible in
  // every count above, and an agent that reads only the verdict would be told
  // the app is fine by a run that never opened one of its screens.
  const routeReport = graph.routes;
  if (routeReport && !routeReport.mapLooksUnrelated) {
    const count = (status: string) => routeReport.checks.filter((c) => c.status === status).length;
    const parts = [
      count('errored') > 0 ? `${count('errored')} errored on arrival` : '',
      count('url-only') > 0 ? `${count('url-only')} that nothing walked leads to` : '',
      count('absent') > 0 ? `${count('absent')} that did not open` : '',
    ].filter(Boolean);
    if (parts.length > 0) {
      verdict += `; of ${routeReport.declared} declared route(s), ${parts.join(', ')}`;
    }
  } else if (routeReport?.mapLooksUnrelated) {
    verdict +=
      `; the route map at ${routeReport.origin} matched nothing this walk reached, so it ` +
      'describes different addresses than the browser sees — nothing was concluded from it';
  }

  return {
    tool: 'clickgraph',
    command: 'walk',
    url: graph.baseUrl,
    walkedAt: graph.walkedAt,
    // A walk that never got past the login screen proved nothing about the app,
    // which is the same failure as a walk that exercised nothing at all.
    ok: healthy && !nothingWalked && !load.likelyAuthWall,
    verdict,
    load: {
      healthy,
      errors: [...load.httpErrors, ...load.consoleErrors],
      interactiveFound: load.interactiveFound,
      likelyAuthWall: Boolean(load.likelyAuthWall),
    },
    findings,
    coverage: coverageOf(graph),
    routes: routesOf(graph),
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

  // A replay is bounded by the baseline it replays, and a clean one says
  // nothing about a screen that baseline never knew. Appended to the verdict
  // rather than left in the coverage block, because the verdict sentence is
  // what an agent reads when it reads only one thing.
  const unexplored = current.coverage.statesUnexplored ?? 0;
  if (unexplored > 0) {
    verdict +=
      ` — but ${unexplored} new screen(s) were reached and not explored; ` +
      'replay stops at the edge of its baseline, so re-walk to cover them';
  }

  return {
    tool: 'clickgraph',
    command: 'diff',
    url: current.baseUrl,
    baselineWalkedAt: diff.baselineWalkedAt,
    currentWalkedAt: diff.currentWalkedAt,
    // An unexplored screen is not a regression, and it is not a pass either.
    // Exiting 0 here is the failure mode that matters most: an agent adds a
    // feature on a new page, replays, is told nothing is broken, and the dead
    // button it just shipped is on the one screen the run declined to open.
    // A walk already exits 1 when it proves nothing; this is the same case.
    ok: regressions.length === 0 && unexplored === 0,
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Action, Change, GraphDiff, UIEdge, UIGraph, OutcomeKind } from './types.js';
import { normalizeText } from './fingerprint.js';

export const DEFAULT_GRAPH_PATH = '.uigraph/graph.json';

export function saveGraph(graph: UIGraph, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

export function loadGraph(path: string): UIGraph | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as UIGraph;
}

/**
 * Identify a control by its source state plus its role and name, rather than by
 * selector. Selector strategy can change between runs for reasons that have
 * nothing to do with behavior; role+name is stable within a given state, and if
 * the name itself changes the source node's fingerprint changes with it.
 *
 * Shared with the replay, which has to recognize a control on the live page as
 * the one a baseline edge describes. Both sides matching on the same key is
 * what keeps "this control changed" and "this control is new" from disagreeing.
 */
export function controlKey(nodeId: string, role: string, name: string): string {
  return `${nodeId}::${role}|${normalizeText(name)}`;
}

/** The same key, read off an edge that has already been walked. */
function edgeKey(edge: UIEdge): string {
  return controlKey(edge.from, edge.action.role, edge.action.name);
}

const WORKING: OutcomeKind[] = ['navigated', 'state-changed', 'network-only'];
const BROKEN_KINDS: OutcomeKind[] = ['no-effect', 'error'];

/** Benign outcomes are expected behavior and must never read as a defect. */
const isBroken = (edge: UIEdge) =>
  BROKEN_KINDS.includes(edge.outcome.kind) && !edge.outcome.benign;
const isWorking = (edge: UIEdge) => WORKING.includes(edge.outcome.kind);

/**
 * A route alone does not identify a state — a modal over a page shares its
 * parent's route. Append the distinguishing landmark so findings can be traced
 * back to the exact state they came from.
 */
export function nodeLabel(graph: UIGraph, nodeId: string): string {
  const node = graph.nodes[nodeId];
  if (!node) return nodeId.split('#')[0];
  const sameRoute = Object.values(graph.nodes)
    .filter((n) => n.fingerprint.route === node.fingerprint.route).length > 1;
  const landmarks = node.fingerprint.landmarks;
  if (sameRoute && landmarks.length > 0) {
    return `${node.fingerprint.route} [${landmarks[landmarks.length - 1]}]`;
  }
  return node.fingerprint.route;
}

/**
 * The control, plus what was actually done to it when a bare click would
 * misdescribe the test. A submit button reported as doing nothing means one
 * thing if the form behind it was filled in and quite another if it was not, and
 * the label is the only place a reader finds out which.
 */
export function actionLabel(action: Action): string {
  if (action.kind === 'fill') {
    return `${action.selector.label} (form filled: ${action.fill?.length ?? 0} field(s))`;
  }
  if (action.kind === 'select' && action.value) {
    return `${action.selector.label} set to "${action.value}"`;
  }
  return action.selector.label;
}

function describe(edge: UIEdge, graph: UIGraph): string {
  return `${actionLabel(edge.action)} on ${nodeLabel(graph, edge.from)}`;
}

export function diffGraphs(baseline: UIGraph, current: UIGraph): GraphDiff {
  const changes: Change[] = [];

  // --- entry-page health ---
  // Errors that appear on load are a regression even if every control still
  // works, and they are the reason a walk can otherwise come back empty.
  const baseLoad = baseline.load ?? { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const currLoad = current.load ?? { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const newLoadErrors = [
    ...currLoad.httpErrors.filter((e) => !baseLoad.httpErrors.includes(e)),
    ...currLoad.consoleErrors.filter((e) => !baseLoad.consoleErrors.includes(e)),
  ];
  if (newLoadErrors.length > 0) {
    changes.push({
      kind: 'broken-edge',
      severity: 'regression',
      summary: `the page now errors as it loads (${newLoadErrors.length} new error(s))`,
      detail: newLoadErrors.slice(0, 3).join(' · '),
    });
  }
  // A run that used to reach the app and now lands on a login screen has not
  // found a UI bug — it has lost its session, and every finding below it would
  // be about the login page. Say that instead of reporting the whole app gone.
  if (!baseLoad.likelyAuthWall && currLoad.likelyAuthWall) {
    changes.push({
      kind: 'missing-state',
      severity: 'regression',
      summary: 'the entry page now looks like a login screen',
      detail:
        'the saved session may have expired, or the app started requiring auth — re-save it before trusting anything else in this diff',
    });
  }
  if (baseLoad.interactiveFound > 0 && currLoad.interactiveFound === 0) {
    changes.push({
      kind: 'missing-state',
      severity: 'regression',
      summary: 'the entry page now renders no interactive controls at all',
      detail: `baseline found ${baseLoad.interactiveFound}`,
    });
  }

  // --- states ---
  for (const id of Object.keys(current.nodes)) {
    const base = baseline.nodes[id];
    if (!base) {
      changes.push({
        kind: 'new-state',
        severity: 'info',
        summary: `new state reachable: ${current.nodes[id].fingerprint.route}`,
        detail: current.nodes[id].title,
      });
    } else if (base.fingerprint.structure !== current.nodes[id].fingerprint.structure) {
      // Same screen, different shape — a control was added or removed. Report
      // it as a change, not as one screen vanishing and another appearing.
      const delta = current.nodes[id].interactiveCount - base.interactiveCount;
      const wording = delta === 0
        ? 'controls changed'
        : `${Math.abs(delta)} control(s) ${delta > 0 ? 'added' : 'removed'}`;
      changes.push({
        kind: 'changed-state',
        severity: 'info',
        summary: `${nodeLabel(current, id)} changed shape: ${wording}`,
      });
    }
  }
  // Keep a handle on each missing-state change so the controls stranded inside
  // it can be folded into it rather than reported as separate regressions.
  const missingStates = new Map<string, Change>();
  for (const id of Object.keys(baseline.nodes)) {
    if (!current.nodes[id]) {
      const change: Change = {
        kind: 'missing-state',
        severity: 'regression',
        summary: `state no longer reachable: ${baseline.nodes[id].fingerprint.route}`,
        detail: `was reached via ${baseline.nodes[id].path.length} action(s); either the screen changed shape or the path into it broke`,
      };
      missingStates.set(id, change);
      changes.push(change);
    }
  }

  // --- edges ---
  const baseEdges = new Map(baseline.edges.map((e) => [edgeKey(e), e]));
  const currEdges = new Map(current.edges.map((e) => [edgeKey(e), e]));

  for (const [key, curr] of currEdges) {
    const base = baseEdges.get(key);
    if (!base) {
      // The tracer-bullet case: a control that did not exist before and does
      // nothing now is the freshly built thing being broken on arrival. That is
      // the finding this tool exists to deliver, so it fails the run.
      const bornBroken = isBroken(curr);
      changes.push({
        kind: 'new-edge',
        severity: bornBroken ? 'regression' : 'info',
        summary: bornBroken
          ? `new control does not work: ${describe(curr, current)} → ${curr.outcome.kind}`
          : `new interaction: ${describe(curr, current)} → ${curr.outcome.kind}`,
        detail: bornBroken ? curr.outcome.note : undefined,
      });
      continue;
    }

    const wasWorking = isWorking(base);
    const nowBroken = isBroken(curr);
    const wasBroken = isBroken(base);
    const nowWorking = isWorking(curr);

    if (wasWorking && nowBroken) {
      changes.push({
        kind: 'broken-edge',
        severity: 'regression',
        summary: `${describe(curr, current)} was ${base.outcome.kind}, now ${curr.outcome.kind}`,
        detail: curr.outcome.note,
      });
    } else if (wasBroken && nowWorking) {
      changes.push({
        kind: 'fixed-edge',
        severity: 'progression',
        summary: `${describe(curr, current)} was ${base.outcome.kind}, now ${curr.outcome.kind}`,
      });
    } else if (base.outcome.kind !== curr.outcome.kind) {
      changes.push({
        kind: 'changed-edge',
        severity: 'info',
        summary: `${describe(curr, current)} changed: ${base.outcome.kind} → ${curr.outcome.kind}`,
      });
    } else if (base.to !== curr.to && curr.outcome.kind === 'navigated') {
      changes.push({
        kind: 'changed-edge',
        severity: 'info',
        summary: `${describe(curr, current)} now leads somewhere else`,
        detail: `was ${base.to ? nodeLabel(baseline, base.to) : 'unknown'}, now ${
          curr.to ? nodeLabel(current, curr.to) : 'unknown'
        } — intentional, or a mis-wired route?`,
      });
    }
  }

  // A control inside a state that is itself unreachable is not an independent
  // finding — it is a symptom of the broken path in. Reporting each one
  // separately buries the single root cause under its own fallout.
  const stranded = new Map<string, number>();
  for (const [key, base] of baseEdges) {
    if (currEdges.has(key)) continue;
    if (missingStates.has(base.from)) {
      stranded.set(base.from, (stranded.get(base.from) ?? 0) + 1);
      continue;
    }
    changes.push({
      kind: 'missing-edge',
      severity: 'regression',
      summary: `control gone: ${describe(base, baseline)}`,
      detail: 'it was walked in the baseline and is not present now',
    });
  }
  for (const [id, count] of stranded) {
    const change = missingStates.get(id)!;
    change.detail += ` — ${count} control(s) inside it are unreachable as a result`;
  }

  return {
    baselineWalkedAt: baseline.walkedAt,
    currentWalkedAt: current.walkedAt,
    changes,
  };
}

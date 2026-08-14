/**
 * Re-check an app against a graph it has already produced.
 *
 * A walk has to discover where it is going, so it can only ever move one way:
 * click something, look at where it landed, and reload to get back. Measured on
 * the fixture, 52 of those re-entries cost 43 of a 72-second walk — 60% of the
 * time spent returning to a screen the browser had just been on.
 *
 * A replay is handed the map. That is the only thing that makes the cost
 * avoidable: the baseline records where each edge led, so a control that
 * navigates is not just a thing to test but a free ride into the next screen
 * that still has work waiting. The route is planned around that — do everything
 * in a state that leaves the page where it is, then leave by an edge that lands
 * somewhere with something left to do.
 *
 * Two rules this must not break, both of them the project's own:
 *
 * The baseline is a hint, never ground truth. Where an edge *led* is used to
 * order the work; where it *leads now* is measured, every time, by capturing
 * the page after the action. An app that has changed re-routes the plan, it
 * does not corrupt the findings.
 *
 * A replay covers less than a walk, and must say so. It visits the states the
 * baseline knew and stops there — a screen reachable only through a newly added
 * one is recorded as unexplored, never as clean.
 */
import type {
  Action, ElementDescriptor, LoadHealth, SkippedElement, UIEdge, UIGraph, UINode, WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { ActionWatch, captureState, type PageSnapshot } from './observer.js';
import {
  attempt, looksLikeAuthWall, markAlreadyApplied, openSession, screen, submittableForms,
} from './act.js';
import { controlKey } from './graph.js';
import { resolveConfig } from './walker.js';

export interface ReplayOptions extends Partial<WalkConfig> {
  onProgress?: (message: string) => void;
}

/** A baseline state, and what is left to do in it. */
interface StateWork {
  node: UINode;
  /**
   * The baseline's own edges, still to re-check. null until the state has been
   * arrived at — what is on the screen now is read from the page, not from the
   * baseline, so a control the baseline never saw is still tested.
   */
  queue: ElementDescriptor[] | null;
  /**
   * Controls here that the baseline has no edge for.
   *
   * Kept apart from the queue above because they are not part of the comparison
   * and must never crowd it out. On a truncated baseline most of these are not
   * new at all — they are the controls it ran out of budget before reaching —
   * and walking them first left 47 baseline edges unchecked on a 2,086-control
   * app in order to walk 72 controls nobody had asked about.
   */
  fresh: ElementDescriptor[];
  /** Every control on the screen, which form filling needs to find siblings. */
  elements: ElementDescriptor[];
  /** The shape seen on arrival, so a page reused without a reload is the same page. */
  structure: string | null;
  /** The state could not be reached. Nothing inside it can be judged. */
  lost: boolean;
}

const hasBaselineWork = (w: StateWork) => !w.lost && (w.queue === null || w.queue.length > 0);

export async function replay(
  baseUrl: string,
  baseline: UIGraph,
  options: ReplayOptions = {},
): Promise<UIGraph> {
  const { onProgress, ...overrides } = options;
  // Inherit the baseline's own switches. Replaying with --fill-forms off against
  // a baseline that had it on would report every form submit in the app as a
  // control that has gone missing — a difference in how the two runs were
  // invoked, dressed up as a change in the app.
  //
  // Spread the caller's options first, with the keys they did not set removed.
  // Ordering matters: a plain `...overrides` carries `maxActions: undefined`
  // for every run that did not pass the flag, and that undefined silently
  // erased the floor computed below — the replay went on sampling a different
  // 197 controls of 2,086 and the only reason it stopped reporting breakage
  // was the diff learning to call it coverage.
  const asked = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<WalkConfig>;

  const needed = baseline.edges.length;
  const config = resolveConfig(baseUrl, {
    allowDangerous: baseline.config?.allowDangerous,
    fillForms: baseline.config?.fillForms,
    settleMs: baseline.config?.settleMs,
    ...asked,
    // A diff only compares like with like if the replay can reach every edge
    // the baseline recorded, so the baseline's own edge count is the floor,
    // with room on top for controls that are genuinely new. Someone who asks
    // for a short run still gets one; the coverage report says what it cost.
    maxActions:
      asked.maxActions ??
      Math.max(baseline.config?.maxActions ?? 0, needed + Math.ceil(needed / 4) + 25),
  });
  const log = onProgress ?? (() => {});

  const nodes: Record<string, UINode> = {};
  const edges: UIEdge[] = [];
  let load: LoadHealth = { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const skipped: SkippedElement[] = [];
  let unwalked = 0;
  let statesUnexplored = 0;
  let limitHit: string | null = null;
  let actionsUsed = 0;
  let reentries = 0;

  // Where each baseline edge led. Used only to order the route — never to
  // decide what an edge does now.
  const led = new Map<string, string | null>();
  for (const edge of baseline.edges) {
    led.set(controlKey(edge.from, edge.action.role, edge.action.name), edge.to);
  }

  const work = new Map<string, StateWork>();
  for (const node of Object.values(baseline.nodes)) {
    work.set(node.id, {
      node, queue: null, fresh: [], elements: [], structure: null, lost: false,
    });
  }

  /** How many baseline edges each state holds, before any of it is enumerated. */
  const owedByState = new Map<string, number>();
  for (const edge of baseline.edges) {
    owedByState.set(edge.from, (owedByState.get(edge.from) ?? 0) + 1);
  }

  const session = await openSession(baseUrl, config);
  const { page } = session;

  /** Where the browser is now, or null when that is no longer known. */
  let at: PageSnapshot | null = null;

  /**
   * Baseline edges still owed, across every state — counted from the baseline
   * for states not yet enumerated, and from what is left of the queue for the
   * rest.
   */
  function baselineOwed(): number {
    let owed = 0;
    for (const w of work.values()) {
      if (w.lost) continue;
      owed += w.queue === null ? (owedByState.get(w.node.id) ?? 0) : w.queue.length;
    }
    return owed;
  }

  /**
   * Is there budget to spare on a control the baseline knows nothing about?
   *
   * This is the whole of the protection, and it belongs here rather than in the
   * traversal order. Walking new controls first was what let a budget drain
   * into work outside the comparison; walking them in a separate second pass
   * fixed that and cost more reloads than the full walk it exists to beat,
   * because a second traversal has no route left to plan. Reserving the budget
   * instead keeps both: everything in a state gets done while the browser is
   * sitting in it, and a baseline edge somewhere else can never be crowded out.
   */
  const roomToSpare = () => config.maxActions - actionsUsed > baselineOwed();

  const hasWork = (w: StateWork) =>
    hasBaselineWork(w) || (!w.lost && w.fresh.length > 0 && roomToSpare());

  /** Can this state be worked on without a reload? */
  const seated = (w: StateWork) =>
    at !== null &&
    at.nodeId === w.node.id &&
    (w.structure === null || at.fingerprint.structure === w.structure);

  /**
   * Where to work next.
   *
   * Staying put is always cheapest, so the screen already on the page wins
   * whenever it has anything left. Otherwise take the state whose path is
   * shortest, because that path is what a re-entry has to click through.
   */
  function pickState(): StateWork | null {
    if (at) {
      const here = work.get(at.nodeId);
      if (here && hasWork(here) && seated(here)) return here;
    }
    let best: StateWork | null = null;
    for (const w of work.values()) {
      if (!hasWork(w)) continue;
      if (!best || w.node.path.length < best.node.path.length) best = w;
    }
    return best;
  }

  /**
   * Which control to exercise next, out of what is left in this state.
   *
   * The whole saving lives here. A control that leaves the page where it is
   * costs nothing extra, so all of those go first and this state never has to
   * be returned to for them. What is left all moves the browser somewhere, and
   * each one but the last will cost a re-entry — so the last one out should be
   * the edge that lands somewhere with work still waiting, which turns the exit
   * into the arrival.
   */
  function pickControl(w: StateWork): ElementDescriptor {
    const queue = w.queue!;
    let mover: number | null = null;
    for (let i = 0; i < queue.length; i++) {
      const el = queue[i];
      const key = controlKey(w.node.id, el.role, el.name);
      // A baseline edge that leaves the page where it is. Free, and doing it
      // now means this state never has to be returned to for it.
      if (led.get(key) === null) return queue.splice(i, 1)[0];
      const target = work.get(led.get(key)!);
      // A ride to a state with nothing left to do is not a ride. Keep it as the
      // fallback and go on looking for one that earns the exit.
      if (mover === null || (target && hasWork(target))) mover = i;
    }
    // A control the baseline has no edge for, done while the browser is already
    // here rather than in a second sweep. Nothing is known about where it goes,
    // so guessing that it stays put costs at most one re-entry.
    if (w.fresh.length > 0 && roomToSpare()) return w.fresh.splice(0, 1)[0];
    // Leave by the edge that earns the exit, so this state is finished behind us.
    if (mover !== null) return queue.splice(mover, 1)[0];
    return w.fresh.splice(0, 1)[0];
  }

  try {
    const loadWatch = new ActionWatch(page);
    const loaded = await session.gotoPath([]);
    const observedLoad = loadWatch.stop();
    if (!loaded) throw new Error(`could not load ${baseUrl}`);
    at = await captureState(page);
    load = {
      consoleErrors: observedLoad.consoleErrors,
      httpErrors: observedLoad.httpErrors,
      interactiveFound: at.elements.length,
      likelyAuthWall: looksLikeAuthWall(at.url, at.elements),
    };
    if (load.likelyAuthWall) {
      log(config.storageState
        ? '  entry page still looks like a login screen — the saved session may have expired'
        : '  entry page looks like a login screen — replaying the door, not the app');
    }

    for (;;) {
      const w = pickState();
      if (!w) break;

      // Out of budget. Stop here rather than re-entering every remaining state
      // only to record that there was nothing left to spend on it.
      if (actionsUsed >= config.maxActions) {
        limitHit = limitHit ?? `maxActions (${config.maxActions})`;
        for (const rest of work.values()) {
          if (rest.lost) continue;
          unwalked +=
            (rest.queue?.length ?? rest.node.interactiveCount) + rest.fresh.length;
          rest.queue = [];
          rest.fresh = [];
        }
        break;
      }

      // What is still owed on a state. Before its first visit that is every
      // control the baseline saw; after a partial one it is only what is left,
      // and charging the whole state again would count the walked half twice.
      const owed = () => (w.queue?.length ?? w.node.interactiveCount) + w.fresh.length;

      if (!seated(w)) {
        reentries++;
        if (!(await session.gotoPath(w.node.path))) {
          // Nothing inside a state we cannot reach can be judged, and reporting
          // each stranded control separately would bury the one real cause.
          w.lost = true;
          at = null;
          unwalked += owed();
          log(`  ✗ could not get back to ${w.node.fingerprint.route}`);
          continue;
        }
        at = await captureState(page);
      }
      if (at!.nodeId !== w.node.id) {
        w.lost = true;
        unwalked += owed();
        log(`  ✗ the path to ${w.node.fingerprint.route} now leads somewhere else`);
        continue;
      }

      // First arrival. What to test comes from the screen in front of us, not
      // from the baseline: a control added since is exactly what a diff is for.
      if (w.queue === null) {
        w.elements = at!.elements;
        w.structure = at!.fingerprint.structure;
        const submittable = submittableForms(w.elements);
        w.queue = [];
        for (const el of w.elements) {
          const screening = screen(el, config, baseUrl, submittable);
          if (screening.verdict === 'fold-into-form') continue;
          if (screening.verdict === 'skip') {
            skipped.push({
              nodeId: w.node.id, label: el.selector.label,
              reason: screening.reason, detail: screening.detail,
            });
            continue;
          }
          // Split here rather than at pick time, so the two passes are a
          // property of the work list and not of the order it is read in.
          if (led.has(controlKey(w.node.id, el.role, el.name))) w.queue.push(el);
          else w.fresh.push(el);
        }
        nodes[w.node.id] = {
          id: w.node.id,
          url: at!.url,
          title: at!.title,
          fingerprint: at!.fingerprint,
          path: w.node.path,
          interactiveCount: w.elements.length,
        };
        log(`state ${at!.fingerprint.route} (${w.elements.length} controls)`);
      }
      if (!hasWork(w)) continue;

      const el = pickControl(w);
      const result = await attempt(page, config, el, w.elements, at!);
      at = result.at;
      if (result.spent) actionsUsed++;
      if (result.lost) unwalked++;
      if (result.skip) {
        skipped.push({
          nodeId: w.node.id, label: el.selector.label,
          reason: result.skip.reason, detail: result.skip.detail,
        });
        continue;
      }

      const { action, outcome } = result.edge!;
      const after = result.at!;
      edges.push({
        from: w.node.id,
        to: outcome.kind === 'navigated' || outcome.kind === 'state-changed'
          ? after.nodeId
          : null,
        action,
        outcome,
      });

      // A screen the baseline never knew. Recorded, so the diff can report it,
      // and counted as unexplored — a replay stops at the edge of its map, and
      // an unexplored screen is not a clean one.
      if (after.nodeId !== result.from!.nodeId && !work.has(after.nodeId) && !nodes[after.nodeId]) {
        nodes[after.nodeId] = {
          id: after.nodeId,
          url: after.url,
          title: after.title,
          fingerprint: after.fingerprint,
          path: [...w.node.path, action],
          interactiveCount: after.elements.length,
        };
        statesUnexplored++;
        unwalked += after.elements.length;
        log(`  → ${after.fingerprint.route} is new, and a replay does not explore it`);
      }
    }
  } finally {
    await session.close();
  }

  markAlreadyApplied(edges);
  log(`replayed ${edges.length} interaction(s) with ${reentries} reload(s)`);

  return {
    version: GRAPH_VERSION,
    baseUrl,
    walkedAt: new Date().toISOString(),
    config,
    load,
    nodes,
    edges,
    coverage: {
      statesFound: Object.keys(nodes).length,
      edgesWalked: edges.length,
      edgesUnwalked: unwalked,
      skipped,
      limitHit,
      mode: 'replay',
      statesUnexplored,
      reentries,
    },
  };
}

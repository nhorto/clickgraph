import type {
  Action, LoadHealth, SkippedElement, UIEdge, UIGraph, UINode, WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { ActionWatch, captureState, type PageSnapshot } from './observer.js';
import {
  attempt, looksLikeAuthWall, markAlreadyApplied, openSession, screen, submittableForms,
} from './act.js';

export interface WalkOptions extends Partial<WalkConfig> {
  onProgress?: (message: string) => void;
}

export const DEFAULTS: Omit<WalkConfig, 'baseUrl'> = {
  maxStates: 40,
  maxActions: 200,
  maxDepth: 4,
  /** Quiet period with no DOM mutations that counts as "the page has settled". */
  settleMs: 250,
  allowDangerous: false,
  fillForms: false,
};

/**
 * Merge caller options over the defaults, dropping keys passed as undefined —
 * an unset CLI flag must fall back to the default, not spread `undefined` over
 * it.
 */
export function resolveConfig(baseUrl: string, overrides: Partial<WalkConfig>): WalkConfig {
  const provided = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<WalkConfig>;
  return { ...DEFAULTS, ...provided, baseUrl };
}

export async function walk(baseUrl: string, options: WalkOptions = {}): Promise<UIGraph> {
  const { onProgress, ...overrides } = options;
  const config = resolveConfig(baseUrl, overrides);
  const log = onProgress ?? (() => {});

  const nodes: Record<string, UINode> = {};
  const edges: UIEdge[] = [];
  let load: LoadHealth = { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const skipped: SkippedElement[] = [];
  let unwalked = 0;
  let limitHit: string | null = null;
  let actionsUsed = 0;

  const session = await openSession(baseUrl, config);
  const { page } = session;

  try {
    // Seed the frontier with the entry state, watching the load itself: an app
    // that errors on arrival must not walk "clean" just because a broken page
    // renders no buttons to click.
    const loadWatch = new ActionWatch(page);
    const loaded = await session.gotoPath([]);
    const observedLoad = loadWatch.stop();
    if (!loaded) throw new Error(`could not load ${baseUrl}`);
    const entry = await captureState(page);
    load = {
      consoleErrors: observedLoad.consoleErrors,
      httpErrors: observedLoad.httpErrors,
      interactiveFound: entry.elements.length,
      likelyAuthWall: looksLikeAuthWall(entry.url, entry.elements),
    };
    if (load.likelyAuthWall) {
      log(config.storageState
        ? '  entry page still looks like a login screen — the saved session may have expired'
        : '  entry page looks like a login screen — walking the door, not the app');
    }
    nodes[entry.nodeId] = {
      id: entry.nodeId,
      url: entry.url,
      title: entry.title,
      fingerprint: entry.fingerprint,
      path: [],
      interactiveCount: entry.elements.length,
    };

    const frontier: PageSnapshot[] = [entry];
    const queuedPaths = new Map<string, Action[]>([[entry.nodeId, []]]);
    const expanded = new Set<string>();

    while (frontier.length > 0) {
      const state = frontier.shift()!;
      if (expanded.has(state.nodeId)) continue;
      expanded.add(state.nodeId);

      const path = queuedPaths.get(state.nodeId) ?? [];
      log(`state ${state.fingerprint.route} (${state.elements.length} controls)`);

      const submittable = submittableForms(state.elements);

      /** Where the browser actually is right now, or null if unknown. */
      let atSnapshot: PageSnapshot | null = null;

      for (const el of state.elements) {
        if (actionsUsed >= config.maxActions) {
          limitHit = limitHit ?? `maxActions (${config.maxActions})`;
          unwalked++;
          continue;
        }

        // Everything that can be decided from the recorded control alone, so a
        // state whose controls are all skipped costs no re-entry.
        const screening = screen(el, config, baseUrl, submittable);
        if (screening.verdict === 'fold-into-form') continue;
        if (screening.verdict === 'skip') {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: screening.reason, detail: screening.detail,
          });
          continue;
        }

        // Re-enter the source state only when the browser is not already sitting
        // in it. Actions that change nothing — the common case — leave the page
        // exactly where the next action needs it, so the replay is skipped.
        // Compared on the fine structure tier, never the coarse identity tier:
        // reusing a page that merely *looks* like the source state would attribute
        // the next edge to the wrong place.
        if (!atSnapshot || atSnapshot.fingerprint.structure !== state.fingerprint.structure) {
          if (!(await session.gotoPath(path))) {
            unwalked++;
            atSnapshot = null;
            continue;
          }
          atSnapshot = await captureState(page);
        }

        const result = await attempt(page, config, el, state.elements, atSnapshot);
        atSnapshot = result.at;
        if (result.spent) actionsUsed++;
        if (result.lost) unwalked++;
        if (result.skip) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: result.skip.reason, detail: result.skip.detail,
          });
          continue;
        }

        const { action, outcome } = result.edge!;
        const after = result.at!;
        const reachedNew = after.nodeId !== result.from!.nodeId;

        edges.push({
          from: state.nodeId,
          // Record the destination whenever the action actually went somewhere,
          // including a self-loop when the screen changed within one node.
          to: outcome.kind === 'navigated' || outcome.kind === 'state-changed'
            ? after.nodeId
            : null,
          action,
          outcome,
        });

        if (reachedNew && !nodes[after.nodeId]) {
          if (Object.keys(nodes).length >= config.maxStates) {
            limitHit = limitHit ?? `maxStates (${config.maxStates})`;
            continue;
          }
          const newPath = [...path, action];
          nodes[after.nodeId] = {
            id: after.nodeId,
            url: after.url,
            title: after.title,
            fingerprint: after.fingerprint,
            path: newPath,
            interactiveCount: after.elements.length,
          };
          log(`  → discovered ${after.fingerprint.route}`);
          if (newPath.length < config.maxDepth) {
            queuedPaths.set(after.nodeId, newPath);
            frontier.push(after);
          } else {
            limitHit = limitHit ?? `maxDepth (${config.maxDepth})`;
            unwalked += after.elements.length;
          }
        }
      }
    }
  } finally {
    await session.close();
  }

  markAlreadyApplied(edges);

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
    },
  };
}

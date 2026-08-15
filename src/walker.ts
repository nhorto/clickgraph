import type {
  Action, LoadHealth, RouteCheck, RouteMapReport, SkippedElement, UIEdge, UIGraph, UINode,
  WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { ActionWatch, captureState, type PageSnapshot } from './observer.js';
import {
  attempt, looksLikeAuthWall, markAlreadyApplied, openSession, screen, submittableForms,
} from './act.js';
import { routeMatches, type RouteMap } from './routemap.js';

export interface WalkOptions extends Partial<WalkConfig> {
  onProgress?: (message: string) => void;
  /**
   * Addresses the source code says exist, checked against what the walk found.
   *
   * Consulted only after the walk has exhausted its own frontier, and the order
   * is the feature: a route reached by clicking is indistinguishable from one
   * reached by typing its address unless the clicking is allowed to happen
   * first. Seed at the start and every declared route is trivially "reached",
   * which is the report saying nothing at some expense.
   */
  routeMap?: RouteMap;
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
  const { onProgress, routeMap, ...overrides } = options;
  const config = resolveConfig(baseUrl, overrides);
  const log = onProgress ?? (() => {});

  const nodes: Record<string, UINode> = {};
  const edges: UIEdge[] = [];
  let load: LoadHealth = { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const skipped: SkippedElement[] = [];
  let unwalked = 0;
  let limitHit: string | null = null;
  let actionsUsed = 0;
  let reentries = 0;
  let routes: RouteMapReport | undefined;

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

    /**
     * Open every declared address the walk never found its own way to, and say
     * what was there.
     *
     * Runs once, after the frontier is empty, so "the walk reached it" has
     * already been decided by the walk. Anything that turns up here is by
     * definition a screen no control led to — which is the finding — and it goes
     * onto the frontier so its own controls are still walked rather than left as
     * a name in a report.
     */
    const consultRouteMap = async (map: RouteMap): Promise<RouteMapReport> => {
      const checks: RouteCheck[] = [];
      // Snapshotted before a single address is opened. `walked` has to mean the
      // walk got there by clicking, and seeding adds nodes as it goes — compare
      // against the live set and a catch-all route would call itself walked on
      // the strength of a page this loop had just seeded two lines earlier.
      const walkReached = Object.values(nodes).map((n) => n.fingerprint.route);
      const walkedNodeIds = new Set(Object.keys(nodes));

      for (const hint of map.hints) {
        const base = { route: hint.route, source: hint.source, guards: hint.guards };

        if (walkReached.some((seen) => routeMatches(hint.route, seen))) {
          checks.push({ ...base, status: 'walked' });
          continue;
        }
        if (hint.parameterized) {
          checks.push({
            ...base, status: 'unchecked',
            detail: 'takes parameters, so there is no address to open without inventing one',
          });
          continue;
        }
        if (Object.keys(nodes).length >= config.maxStates) {
          limitHit = limitHit ?? `maxStates (${config.maxStates})`;
          checks.push({
            ...base, status: 'unchecked',
            detail: `the run was already at its ${config.maxStates}-state budget`,
          });
          continue;
        }

        // Resolved against the origin, never against the entry page's own path.
        // A base-path deployment would need the prefix, but an entry URL like
        // `/orders` is just as likely to be a starting screen as a mount point,
        // and guessing wrong turns every declared route into a false 404. When
        // that is what happened, nothing matches at all, and `mapLooksUnrelated`
        // below says so in one sentence instead of a page of accusations.
        const target = new URL(hint.route, new URL(baseUrl).origin).href;
        const address: Action = {
          kind: 'goto',
          selector: { strategy: 'url', value: target, label: `address ${hint.route}` },
          role: 'address',
          name: hint.route,
          url: target,
        };

        const watch = new ActionWatch(page);
        const status = await session.gotoUrl(target);
        const observed = watch.stop();
        if (status === null) {
          checks.push({ ...base, status: 'absent', detail: 'the address did not open' });
          continue;
        }

        // Same severity rule the entry page is held to: a 5xx or an uncaught
        // exception is the app failing, and a 4xx is only the map being wrong
        // about an address. One is a defect, the other is a disagreement, and
        // they send whoever reads the report to different files.
        if (status >= 500 || observed.consoleErrors.length > 0) {
          checks.push({
            ...base, status: 'errored',
            detail: [
              status >= 500 ? `${status} at ${hint.route}` : '',
              ...observed.consoleErrors,
            ].filter(Boolean).slice(0, 2).join(' · '),
          });
          continue;
        }
        if (status >= 400) {
          checks.push({ ...base, status: 'absent', detail: `${status} at ${hint.route}` });
          continue;
        }

        const landed = await captureState(page);

        // It opened onto a state the walk itself had reached — a redirect, or an
        // alias. Map and app agree; there is nothing orphaned about it.
        //
        // Compared against the states the walk found, not against every state
        // known by now: two declared addresses can both land on one page that
        // only an address opens, and the second must not be able to call itself
        // walked because the first put it in the graph a moment ago.
        if (walkedNodeIds.has(landed.nodeId)) {
          checks.push({
            ...base, status: 'walked',
            detail: landed.fingerprint.route === hint.route
              ? undefined
              : `opening it lands on ${landed.fingerprint.route}, which the walk already covered`,
          });
          continue;
        }
        if (nodes[landed.nodeId]) {
          checks.push({
            ...base, status: 'url-only',
            detail:
              `it lands on ${landed.fingerprint.route}, which another declared address ` +
              'also opens and which nothing the walk clicked led to',
          });
          continue;
        }

        const gated = looksLikeAuthWall(landed.url, landed.elements);
        checks.push({
          ...base, status: 'url-only',
          detail: gated
            ? hint.guards.length > 0
              ? `it answers with a login screen, which is what the map says guards it (${hint.guards[0]})`
              : 'it answers with a login screen, and the map named no guard on it'
            : `nothing the walk clicked led here — it opened with ${landed.elements.length} control(s)`,
        });

        nodes[landed.nodeId] = {
          id: landed.nodeId,
          url: landed.url,
          title: landed.title,
          fingerprint: landed.fingerprint,
          path: [address],
          interactiveCount: landed.elements.length,
        };
        log(`  → ${hint.route} exists but nothing led to it`);
        // A login form is not the app behind it, and walking one proves nothing
        // — the same reason the entry page refuses to count as a clean run.
        if (gated) {
          unwalked += landed.elements.length;
          continue;
        }
        queuedPaths.set(landed.nodeId, [address]);
        frontier.push(landed);
      }

      // Every address the walk reached that the map never mentioned. A statement
      // about the map, not about the app — which is why it is a bare list and
      // never a finding.
      const undeclared = [...new Set(Object.values(nodes).map((n) => n.fingerprint.route))]
        .filter((seen) => !map.hints.some((h) => routeMatches(h.route, seen)))
        .sort();

      const checkable = map.hints.filter((h) => !h.parameterized).length;
      return {
        origin: map.origin,
        format: map.format,
        declared: map.hints.length,
        excluded: map.excluded,
        checks,
        undeclared,
        mapLooksUnrelated:
          checkable > 0 &&
          Object.keys(nodes).length > 0 &&
          !checks.some((c) => c.status === 'walked'),
      };
    };

    let mapPending = Boolean(routeMap);
    while (frontier.length > 0 || mapPending) {
      // The map is consulted only once the walk has nothing left of its own —
      // that is what makes "no control led here" a claim the walk has earned.
      if (frontier.length === 0) {
        mapPending = false;
        log(`checking ${routeMap!.hints.length} declared route(s) against what was walked`);
        routes = await consultRouteMap(routeMap!);
        continue;
      }
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
          reentries++;
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
          // Depth is how many clicks deep, so the address that opened a seeded
          // page does not spend one. Counting it would explore every page the
          // route map found one level shallower than the entry page's own tree,
          // for no reason a reader of the budget could guess at. Identical to
          // `newPath.length` for anything the walk clicked its way to.
          const clicksDeep = newPath.filter((a) => a.kind !== 'goto').length;
          if (clicksDeep < config.maxDepth) {
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
      mode: 'walk',
      reentries,
    },
    routes,
  };
}

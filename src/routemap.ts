/**
 * The static route map: what the source code says the app's addresses are.
 *
 * This is the one input to a walk that does not come from the running app, and
 * it is held at arm's length for that reason. A walk observes; a map asserts.
 * Where the two disagree either can be the one that is wrong — the map can be
 * stale, and the app can be missing a link — so nothing here decides anything
 * on its own. The disagreement is the output, not a verdict about the app.
 *
 * Two formats are read, sniffed rather than declared, because making an agent
 * convert one file into another before it can ask a question is friction that
 * ends with the question not being asked:
 *
 *   - an App Atlas `atlas.json`, whose endpoint nodes carry `method: 'PAGE'`
 *     for exactly the doors a browser can land on
 *   - a plain list of routes, for every other producer and for hand-writing
 */

import { readFileSync } from 'node:fs';

export interface RouteHint {
  /** The declared address, in this tool's own route vocabulary. */
  route: string;
  /** Where the map found it — a source file, usually. */
  source?: string;
  /**
   * Named guards the map says stand in front of it. A route that cannot be
   * reached is a different thing when something is documented as refusing
   * entry, so this is carried through to the report rather than counted.
   */
  guards: string[];
  /**
   * The address has parameters, so there is no such thing as visiting it
   * without inventing a value. Recorded rather than dropped: "not checked
   * because it needs an id" is a fact a reader needs, and silence would let it
   * pass for "checked and fine".
   */
  parameterized: boolean;
}

export interface RouteMap {
  /** The file this came from, named in the report so a stale map is traceable. */
  origin: string;
  /** What kind of file it turned out to be. */
  format: 'app-atlas' | 'routes';
  hints: RouteHint[];
  /**
   * Doors the map declared that a browser cannot land on — API handlers, CLI
   * entry points, queues, mobile screens. Counted, not listed: the count is
   * what explains an empty map without implying the map was empty.
   */
  excluded: number;
}

/**
 * Every spelling of "this segment is a variable", flattened to one.
 *
 * Each framework invents its own and they all mean the same thing. Next and
 * SvelteKit bracket it, Express and Rails colon it, Flask angles it, FastAPI
 * and chi brace it, Remix puts a dollar on it. Catch-alls are kept apart from
 * single segments because they match a different number of them.
 */
function normalizeSegment(segment: string): string {
  const catchAll =
    /^\[\[?\.\.\..+\]\]?$/.test(segment) || segment === '*' || segment.startsWith('$$');
  if (catchAll) return ':rest';
  const param =
    /^\[.+\]$/.test(segment) ||
    /^\{.+\}$/.test(segment) ||
    /^<.+>$/.test(segment) ||
    /^:.+/.test(segment) ||
    /^\$.+/.test(segment);
  return param ? ':param' : segment;
}

/**
 * A declared address in the same shape `normalizeRoute` produces for an
 * observed one, so the two can be compared without either side guessing at the
 * other's conventions.
 */
export function normalizeDeclaredRoute(raw: string): string {
  const segments = raw.split('?')[0].split('#')[0].split('/').filter(Boolean);
  return '/' + segments.map(normalizeSegment).join('/');
}

/**
 * Does this declared address describe that observed one?
 *
 * Segment by segment, with `:param` matching any single segment and `:rest`
 * matching the remainder. The observed side has already had its own volatile
 * segments collapsed to `:id` / `:uuid` / `:hash`, and those are just segments
 * here — a declared `:param` matches them, and a declared literal does not,
 * which is the correct answer in both directions.
 */
export function routeMatches(declared: string, observed: string): boolean {
  // The fragment is part of an observed route for hash-routed apps. A static
  // file-route map never produces one, so compare against the path alone and
  // let the whole-map check below speak for that kind of app.
  const want = declared.split('/').filter(Boolean);
  const got = observed.split('#')[0].split('/').filter(Boolean);
  let w = 0;
  let g = 0;
  while (w < want.length) {
    if (want[w] === ':rest') return got.length > g;
    if (g >= got.length) return false;
    if (want[w] !== ':param' && want[w] !== got[g]) return false;
    w++;
    g++;
  }
  return g === got.length;
}

/* ---------- readers ---------- */

/** An App Atlas atlas, recognized by its own format stamp rather than by name. */
function looksLikeAtlas(doc: any): boolean {
  return Boolean(doc?.meta?.formatVersion && Array.isArray(doc?.nodes));
}

/**
 * The browser-reachable doors in an App Atlas map.
 *
 * `PAGE` is the whole of the filter, and it is App Atlas's own word for it: a
 * page is where a person arrives, as opposed to the `GET /api/...` handlers
 * that answer with JSON, the CLI entry points, the queues, and the mobile
 * `SCREEN`s. Walking any of those in a browser would prove nothing about a UI,
 * and counting them as unreached would be an accusation about the wrong thing.
 */
function fromAtlas(doc: any, origin: string): RouteMap {
  const endpoints = doc.nodes.filter((n: any) => n?.kind === 'endpoint');
  const hints: RouteHint[] = [];
  for (const node of endpoints) {
    const meta = node.meta ?? {};
    if (meta.method !== 'PAGE') continue;
    // A door the map could not put an address on. It is still a door, but there
    // is nothing here to visit or to compare, so it counts as unreadable rather
    // than as missing.
    if (typeof meta.route !== 'string' || !meta.route) continue;
    const route = normalizeDeclaredRoute(meta.route);
    hints.push({
      route,
      source: typeof node.path === 'string' ? node.path : undefined,
      guards: Array.isArray(meta.guards)
        ? meta.guards.map((g: any) => String(g?.name ?? '')).filter(Boolean)
        : [],
      parameterized: route.includes(':param') || route.includes(':rest'),
    });
  }
  return {
    origin,
    format: 'app-atlas',
    hints: dedupe(hints),
    excluded: endpoints.length - hints.length,
  };
}

/**
 * A plain list, in whichever of the obvious shapes someone wrote it: bare
 * strings, or objects carrying the same fields the atlas reader fills in.
 */
function fromRoutes(doc: any, origin: string): RouteMap {
  const raw: any[] = Array.isArray(doc) ? doc : Array.isArray(doc?.routes) ? doc.routes : [];
  const hints: RouteHint[] = [];
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry : entry?.route;
    if (typeof value !== 'string' || !value) continue;
    const route = normalizeDeclaredRoute(value);
    hints.push({
      route,
      source: typeof entry?.source === 'string' ? entry.source : undefined,
      guards: Array.isArray(entry?.guards) ? entry.guards.map(String) : [],
      parameterized: route.includes(':param') || route.includes(':rest'),
    });
  }
  return { origin, format: 'routes', hints: dedupe(hints), excluded: 0 };
}

/**
 * One entry per address. A route declared twice — an App Router page and its
 * own loading state, two files landing on one URL — is one door, and reporting
 * it twice would double every count downstream.
 */
function dedupe(hints: RouteHint[]): RouteHint[] {
  const byRoute = new Map<string, RouteHint>();
  for (const hint of hints) {
    const existing = byRoute.get(hint.route);
    if (!existing) {
      byRoute.set(hint.route, hint);
      continue;
    }
    // Keep every guard either declaration named. A door locked in one place and
    // not the other is locked.
    existing.guards = [...new Set([...existing.guards, ...hint.guards])];
  }
  return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
}

export function loadRouteMap(path: string): RouteMap {
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read the route map at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (looksLikeAtlas(doc)) return fromAtlas(doc, path);
  if (Array.isArray(doc) || Array.isArray(doc?.routes)) return fromRoutes(doc, path);
  throw new Error(
    `${path} is not a route map — expected an App Atlas atlas.json, a JSON array of ` +
      'routes, or an object with a "routes" array',
  );
}

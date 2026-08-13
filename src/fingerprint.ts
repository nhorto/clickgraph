import { createHash } from 'node:crypto';
import type { ElementDescriptor, Fingerprint } from './types.js';

/**
 * State identity.
 *
 * This is the research-hard problem (see RESEARCH.md §3a): no approach gets
 * "are these two screens the same state?" right in general. v1 takes the
 * cheap, explainable option — normalized route + a hash of the interactive
 * structure — and keeps the layers separate so a mismatch can be attributed
 * to a route change or a structure change rather than an opaque hash diff.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

/**
 * Collapse volatile path segments so /orders/123 and /orders/456 are one state.
 *
 * The fragment is part of the route, not noise: hash-routed apps put their whole
 * routing table after the `#`, and on a single-page site each `#section` is a
 * real destination. Dropping it collapsed an entire site into one node.
 */
export function normalizeRoute(rawUrl: string): string {
  let pathname: string;
  let hash = '';
  try {
    const parsed = new URL(rawUrl);
    pathname = parsed.pathname;
    hash = parsed.hash;
  } catch {
    pathname = rawUrl;
  }
  const collapse = (seg: string) => {
    if (/^\d+$/.test(seg)) return ':id';
    if (UUID_RE.test(seg)) return ':uuid';
    if (LONG_HEX_RE.test(seg)) return ':hash';
    return seg;
  };
  const path = '/' + pathname.split('/').filter(Boolean).map(collapse).join('/');

  // '#' and '#top' alone are not distinct destinations.
  const fragment = hash.replace(/^#/, '');
  if (!fragment || fragment === 'top') return path;
  return `${path}#${fragment.split('/').filter(Boolean).map(collapse).join('/')}`;
}

/**
 * Strip the parts of visible text that change without the state changing:
 * digits, times, and whitespace runs. Prevents a live counter or timestamp
 * from minting a new "state" on every walk.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export function computeFingerprint(
  url: string,
  headings: string[],
  elements: ElementDescriptor[],
): Fingerprint {
  const route = normalizeRoute(url);

  // Two tiers, deliberately.
  //
  // `identity` answers "is this the same screen?" and is built only from the
  // route and its headings. Adding a button to a page must NOT mint a new
  // screen — otherwise every ordinary UI change orphans the whole graph and the
  // tool cries wolf on its own author's work.
  //
  // `structure` answers "did this screen change shape?" and includes every
  // interactive control. It is an attribute of the node, not part of its id,
  // so a shape change is reported as a change rather than a disappearance.
  const identityParts = headings.map((h) => normalizeText(h)).sort();
  const structureParts = [
    ...identityParts.map((h) => `h:${h}`),
    ...elements.map((el) => `${el.role}:${normalizeText(el.name)}`),
  ].sort();

  return {
    route,
    identity: sha(`${route}|${identityParts.join('|')}`),
    structure: sha(`${route}|${structureParts.join('|')}`),
    landmarks: headings.slice(0, 5).map((h) => h.trim()).filter(Boolean),
  };
}

/**
 * Node id uses the coarse identity tier only.
 *
 * Known v1 limitation: two genuinely different screens that share a route and
 * their headings will collapse into one node. That is the lossy judgment call
 * the research says has no correct answer — this errs toward under-splitting,
 * because a missed split is quieter than a graph that resets every commit.
 */
export function nodeId(fp: Fingerprint): string {
  return `${fp.route}#${fp.identity}`;
}

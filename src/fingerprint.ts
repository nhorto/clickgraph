import { createHash } from 'node:crypto';
import type { ElementDescriptor, Fingerprint } from './types.js';
import { FILL_TOKEN } from './formfill.js';

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

/**
 * Normalize a whole page's visible text down to what a release can change on
 * purpose, and hash that.
 *
 * This is NOT `PageSnapshot.contentHash`, and the difference is the whole of
 * issue #48. That hash is taken twice around a single click to decide whether
 * the click did anything, so it keeps digits — a control that only moves a
 * displayed number did something, and calling it dead is the costlier mistake.
 * This one is written into the graph and compared against a baseline taken on
 * another day, where the same digits are the noise: a counter, a timestamp, a
 * "3 minutes ago", an id in a table cell. A within-walk signal and a
 * baseline-comparable signal are different instruments, and the reason `diff`
 * could report "No change" over a table whose every cell had been reworded is
 * that only the first one existed.
 *
 * Two things are removed, each for its own reason:
 *
 * - **Digits**, because they move without anyone editing the app, and a text
 *   signal that fires on every run is one nobody will read by the second week.
 *   The cost is real and is accepted: a currency or count whose *only* change
 *   is numeric is invisible here. The wording around it is not.
 * - **The walker's own typed values.** Every synthesized value either carries
 *   `clickgraph-test` or is pure digits (`1`, `+15555550100`, `2030-01-01`),
 *   so those two rules between them cover the lot. Without this, a state
 *   reached by submitting a form renders the token into its own text and a
 *   `--fill-forms` baseline could never be compared with a walk without it.
 *   A value the CALLER declared with `--field` is deliberately left in: it is
 *   their string, it is stable across runs by construction, and a walk that
 *   changed it changed what it typed into the app.
 */
export function normalizeContent(text: string): string {
  return text
    .toLowerCase()
    .split(FILL_TOKEN)
    .join('')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export function computeFingerprint(
  url: string,
  headings: string[],
  elements: ElementDescriptor[],
  text: string,
): Fingerprint {
  const route = normalizeRoute(url);

  // Three tiers, deliberately.
  //
  // `identity` answers "is this the same screen?" and is built only from the
  // route and its headings. Adding a button to a page must NOT mint a new
  // screen — otherwise every ordinary UI change orphans the whole graph and the
  // tool cries wolf on its own author's work.
  //
  // `structure` answers "did this screen change shape?" and includes every
  // interactive control. It is an attribute of the node, not part of its id,
  // so a shape change is reported as a change rather than a disappearance.
  //
  // `content` answers "did this screen change what it says?" and is the third
  // tier because it belongs in neither of the other two. Not `identity`, for
  // the reason above squared: text is the most-edited thing in any app, and a
  // screen that minted a new node on every copy change would orphan its own
  // graph weekly. Not `structure` either, and that one is load-bearing —
  // `structure` is what routed re-entry compares on arrival to decide it is
  // back where it meant to be (issue #23), and what effect detection compares
  // across a click. Folding text into it would make a page with a clock
  // unroutable and make every re-render an "effect". Three questions, three
  // hashes, each answerable on its own.
  const identityParts = headings.map((h) => normalizeText(h)).sort();
  const structureParts = [
    ...identityParts.map((h) => `h:${h}`),
    ...elements.map((el) => `${el.role}:${normalizeText(el.name)}`),
  ].sort();

  return {
    route,
    identity: sha(`${route}|${identityParts.join('|')}`),
    structure: sha(`${route}|${structureParts.join('|')}`),
    content: sha(normalizeContent(text)),
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

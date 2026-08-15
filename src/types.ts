/**
 * The graph model.
 *
 * Design rule carried from the research: unwalked is never assumed working.
 * Anything the walker did not actually exercise is recorded as unwalked or
 * skipped, with a reason, so a run can never imply coverage it did not achieve.
 */

export const GRAPH_VERSION = '0.1';

/**
 * How a selector was derived. Earlier strategies survive redesigns better.
 *
 * `url` is not one of them — it names an address rather than an element, and it
 * exists so a `goto` action can carry a label like everything else. Nothing
 * resolves it to a control, because there is no control.
 */
export type SelectorStrategy = 'testid' | 'id' | 'role-name' | 'text' | 'css' | 'url';

export interface Selector {
  strategy: SelectorStrategy;
  value: string;
  /** Human-readable description, e.g. `button "Export"`. */
  label: string;
}

export interface ElementDescriptor {
  selector: Selector;
  role: string;
  name: string;
  tag: string;
  href: string | null;
  /** Raw `type` for inputs. `password` is what identifies a login wall. */
  inputType: string | null;
  /**
   * The enclosing `<form>`, identified by its position in the page, or null.
   *
   * Grouping is what makes a form testable at all. A single field proves almost
   * nothing on its own — its value is not part of the state fingerprint, and the
   * walker returns to the start before any submit happens — so the unit that
   * means something is the whole form.
   */
  formId: string | null;
  /**
   * How that grouping was arrived at. A `form` is what the app declared; a
   * `cluster` is what was inferred from the layout because the app declared
   * nothing — the React pattern of loose inputs and a handler-bound button.
   *
   * Worth keeping apart, because everything the browser will answer for a real
   * form it refuses to answer for a cluster. `checkValidity` above all: a form
   * says whether it would submit, and a cluster has nothing to ask.
   */
  formKind?: 'form' | 'cluster' | null;
  /** This control submits its form. */
  formSubmit: boolean;
  /**
   * A verified-unique CSS path to the same element, or null.
   *
   * The recorded selector is chosen for durability, which is not the same thing
   * as being resolvable: the name it matches on is derived from the DOM here,
   * while Playwright derives its own from the accessible-name algorithm, and
   * the two disagree over decorative content, CSS text-transform and title
   * attributes. This is what the walker falls back to when they do.
   */
  fallback: string | null;
  disabled: boolean;
  /**
   * Marked as the active tab or current page — by `aria-selected` /
   * `aria-current`, or by a class name like `is-current` *and* a name matching
   * the URL the browser is already on. The second form needs both halves: a
   * class alone is the app's private vocabulary, and trusting it would let
   * `active` on a broken button excuse the bug.
   */
  selected: boolean;
  /** Signals it responds to hover (cursor:help, title, aria-describedby). */
  hoverAffordance: boolean;
}

export interface Action {
  /**
   * `goto` is the odd one out: it is not something a user did to a control, it
   * is the run typing an address. It appears only in a node's `path` — the way
   * back to a state seeded from a route map — and never as an edge, because
   * there is no control to attribute it to and nothing to conclude from it.
   */
  kind: 'click' | 'hover' | 'select' | 'fill' | 'goto';
  selector: Selector;
  role: string;
  name: string;
  /** For `goto`, the address to open. */
  url?: string;
  /**
   * For `select`, the option that was chosen. Deliberately not part of the edge
   * key: an option list built from live data changes between runs, and a filter
   * that offers different names this week is still the same control.
   */
  value?: string;
  /**
   * For `fill`, what was typed into each field before the submit was clicked.
   * Kept out of the edge key for the same reason as `value`, and recorded so
   * that a row a walk created can be traced back to the run that created it.
   */
  fill?: { label: string; value: string }[];
}

/**
 * What happened when the action ran.
 *
 * `no-effect` is the money finding — a control that renders but produces no
 * navigation, no state change and no network traffic. It is reported as
 * "no observable effect", not "broken", because a few legitimate controls
 * (copy-to-clipboard, analytics pings) genuinely look like this.
 */
export type OutcomeKind =
  | 'navigated'
  | 'state-changed'
  | 'network-only'
  /**
   * The page moved without changing: a canvas panned or zoomed, the view
   * scrolled. Its own kind rather than a `state-changed`, because what is known
   * about it is weaker — that the geometry moved, not that anything the user
   * reads is different — and rolling it in would overstate the evidence.
   */
  | 'visual-only'
  | 'no-effect'
  | 'error';

export interface NetworkCall {
  method: string;
  url: string;
  status: number | null;
}

export interface Outcome {
  kind: OutcomeKind;
  urlBefore: string;
  urlAfter: string;
  network: NetworkCall[];
  consoleErrors: string[];
  httpErrors: string[];
  note?: string;
  /**
   * The outcome is expected rather than a defect — e.g. a link pointing at the
   * page you are already on. Recorded in the graph, kept out of findings.
   */
  benign?: boolean;
}

/**
 * The identity of a UI state, layered so a mismatch can be explained.
 *
 * `identity` decides node id (coarse: route + headings). `structure` detects
 * shape changes within a node (fine: every interactive control). Separating
 * them is what lets a page gain a button without the screen being reported
 * as a different, unreachable screen.
 */
export interface Fingerprint {
  /** Pathname with numeric/uuid segments collapsed, e.g. /orders/:id */
  route: string;
  /** Hash of route + headings. Determines node id. */
  identity: string;
  /** Hash of route + headings + interactive controls. A change is reportable. */
  structure: string;
  /** Human-readable anchors for debugging why two states differ. */
  landmarks: string[];
}

export interface UINode {
  id: string;
  url: string;
  title: string;
  fingerprint: Fingerprint;
  /** Actions from the base URL that reach this state. */
  path: Action[];
  interactiveCount: number;
}

export interface UIEdge {
  from: string;
  to: string | null;
  action: Action;
  outcome: Outcome;
}

/** A control that was found but deliberately not clicked. */
export interface SkippedElement {
  nodeId: string;
  label: string;
  reason: 'dangerous' | 'external' | 'disabled' | 'budget' | 'needs-input' | 'unreachable';
  detail?: string;
}

export interface Coverage {
  statesFound: number;
  edgesWalked: number;
  /** Controls discovered but never exercised. Never counted as working. */
  edgesUnwalked: number;
  skipped: SkippedElement[];
  /** Which budget stopped the walk, if any. null means the walk ran to completion. */
  limitHit: string | null;
  /**
   * How the run chose where to go. A replay visits the states a baseline
   * already knew and stops there; it never explores past them. Recorded
   * because the difference is invisible in the findings — a replay of a stale
   * baseline reports a clean run over an app it only partly saw, and nothing
   * else in this file would say so.
   */
  mode?: 'walk' | 'replay';
  /**
   * States a replay reached but did not explore, because they were not in the
   * baseline. Each one is a screen whose controls nothing has tried.
   */
  statesUnexplored?: number;
  /**
   * Times the run reloaded the app and clicked its way back to a state it had
   * already been in.
   *
   * This is where a run's time goes — 52 of them cost 43 of a 72-second walk on
   * the fixture — and it was measured with throwaway instrumentation before it
   * lived here. Recording it makes a speed claim checkable from the artifact
   * instead of from a patch someone has to write again.
   */
  reentries?: number;
}

export interface WalkConfig {
  baseUrl: string;
  maxStates: number;
  maxActions: number;
  maxDepth: number;
  settleMs: number;
  allowDangerous: boolean;
  /**
   * Fill each form with synthetic values and submit it, instead of leaving the
   * form untested. Off by default because a successful submission writes real
   * data — the same reasoning that keeps destructive controls unclicked.
   */
  fillForms: boolean;
  /**
   * Path to a Playwright storage-state file, so the walk starts logged in.
   * Only the path is recorded in the graph — the file holds session cookies and
   * must never be copied into an artifact that gets committed.
   */
  storageState?: string;
}

/**
 * The health of the entry page itself.
 *
 * Without this, an app that fails to load at all walks "cleanly": no controls
 * to click means no findings, which reads as success. An app that 502s on load
 * is the single most important thing a walk can report.
 */
export interface LoadHealth {
  consoleErrors: string[];
  httpErrors: string[];
  /** Controls found on the entry page. Zero means the walk saw nothing to do. */
  interactiveFound: number;
  /**
   * The entry page looks like a login screen. Without this, walking a gated app
   * reports a clean run of its login form and says nothing about the app behind
   * it — a pass that covers none of the thing under test.
   */
  likelyAuthWall?: boolean;
}

/* ---------- the static map, and where it disagrees ---------- */

/**
 * What became of one address the source code declared.
 *
 * The four outcomes are deliberately not a pass/fail axis. Only one of them
 * (`errored`) is a statement about the app on its own; the rest are statements
 * about the two artifacts disagreeing, and which one is wrong is not something
 * this tool can know.
 */
export type RouteStatus =
  /** The walk found its own way here by clicking. Map and app agree. */
  | 'walked'
  /**
   * It exists and it loads, but nothing the walk clicked led to it. Either the
   * app is missing a link, or the page is reached some way a walk cannot see —
   * a deep link from an email, a redirect, a route only some role is shown.
   */
  | 'url-only'
  /** Opening it did not produce a page. The map may be stale, or the route gone. */
  | 'absent'
  /** Opening it produced server errors or uncaught exceptions. This one is a defect. */
  | 'errored'
  /** Never opened — it takes parameters, or the run had no room left. */
  | 'unchecked';

export interface RouteCheck {
  route: string;
  status: RouteStatus;
  /** Why, in the words a reader needs — never a bare status. */
  detail?: string;
  source?: string;
  guards?: string[];
}

/**
 * The static map beside what the walk actually found.
 *
 * Kept out of `coverage` on purpose. Coverage is what this run did; this is a
 * comparison against something the run did not produce and cannot vouch for.
 */
export interface RouteMapReport {
  /** The file the map came from, so a stale one can be traced. */
  origin: string;
  format: 'app-atlas' | 'routes';
  declared: number;
  /** Doors declared that a browser cannot land on: APIs, CLIs, queues, mobile screens. */
  excluded: number;
  checks: RouteCheck[];
  /** Routes the walk reached that the map never declared. A fact about the map. */
  undeclared: string[];
  /**
   * Not one declared address matched anything the walk reached.
   *
   * At that point the likeliest explanation is not that every page in the app
   * is orphaned — it is that the map describes a different addressing scheme
   * than the browser sees: a hash-routed SPA, an app served under a base path,
   * a map built from a different repository. Reported as doubt about the map,
   * because the alternative is a page of confident nonsense.
   */
  mapLooksUnrelated: boolean;
}

export interface UIGraph {
  version: string;
  baseUrl: string;
  walkedAt: string;
  config: WalkConfig;
  load: LoadHealth;
  nodes: Record<string, UINode>;
  edges: UIEdge[];
  coverage: Coverage;
  /** Present only when a run was given a route map to check itself against. */
  routes?: RouteMapReport;
}

/* ---------- diff ---------- */

export type ChangeKind =
  | 'new-state'
  | 'missing-state'
  | 'changed-state'
  | 'new-edge'
  | 'missing-edge'
  | 'broken-edge'
  | 'fixed-edge'
  | 'changed-edge';

export interface Change {
  kind: ChangeKind;
  /** 'regression' is actionable now; 'progression' and 'info' are context. */
  severity: 'regression' | 'progression' | 'info';
  summary: string;
  detail?: string;
}

export interface GraphDiff {
  baselineWalkedAt: string;
  currentWalkedAt: string;
  changes: Change[];
}

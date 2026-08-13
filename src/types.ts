/**
 * The graph model.
 *
 * Design rule carried from the research: unwalked is never assumed working.
 * Anything the walker did not actually exercise is recorded as unwalked or
 * skipped, with a reason, so a run can never imply coverage it did not achieve.
 */

export const GRAPH_VERSION = '0.1';

/** How a selector was derived. Earlier strategies survive redesigns better. */
export type SelectorStrategy = 'testid' | 'id' | 'role-name' | 'text' | 'css';

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
  /** Marked as the active tab or current page via aria-selected / aria-current. */
  selected: boolean;
  /** Signals it responds to hover (cursor:help, title, aria-describedby). */
  hoverAffordance: boolean;
}

export interface Action {
  kind: 'click' | 'hover' | 'select' | 'fill';
  selector: Selector;
  role: string;
  name: string;
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

export interface UIGraph {
  version: string;
  baseUrl: string;
  walkedAt: string;
  config: WalkConfig;
  load: LoadHealth;
  nodes: Record<string, UINode>;
  edges: UIEdge[];
  coverage: Coverage;
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

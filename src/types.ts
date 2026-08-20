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
   * Raw `inputmode`, which is how a touch-first app says "digits go here".
   *
   * `type="number"` brings a spinner and scroll-to-change that are wrong on a
   * tablet, so apps built for one use `inputMode="numeric"` on a text input
   * instead. Both mean the same thing to the person typing, and until this was
   * read the walk saw only `type`, synthesized a word, and every control gated
   * on the field stayed disabled (issue #42).
   */
  inputMode: string | null;
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
   *
   * `selector` and `option` are what make the edge REPLAYABLE. A state that
   * only opens once a field holds the right value cannot be re-entered by
   * clicking the submit again — that lands on the empty-form branch, a
   * different screen with none of the controls the walk came back for. Both
   * are optional because graphs walked before this existed have neither, and
   * such an edge replays the way it always did: submit only.
   */
  fill?: {
    label: string;
    value: string;
    selector?: Selector;
    /** Present for a `<select>`: the option's value, which is what re-selects it. */
    option?: string;
  }[];
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
  /**
   * Failed requests the walk caused itself, under `--fail-requests`.
   *
   * Kept apart from `httpErrors` so a fault walk stays readable: without the
   * split, every edge in the run reports the sabotage as a defect and the app's
   * own errors are buried among hundreds of deliberate ones.
   */
  injectedFailures?: string[];
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
 * shape changes within a node (fine: every interactive control). `content`
 * detects text changes that move neither. Separating them is what lets a page
 * gain a button without the screen being reported as a different, unreachable
 * screen — and what lets a screen be reported as reworded without being
 * reported as rebuilt.
 */
export interface Fingerprint {
  /** Pathname with numeric/uuid segments collapsed, e.g. /orders/:id */
  route: string;
  /** Hash of route + headings. Determines node id. */
  identity: string;
  /** Hash of route + headings + interactive controls. A change is reportable. */
  structure: string;
  /**
   * Hash of the state's normalised visible text — digits and the walker's own
   * typed values removed. Reported on change, never part of the node id.
   *
   * Optional because a graph written before issue #48 does not carry one, and
   * a baseline that cannot answer the question must not be made to look as if
   * it answered "no": `diff` compares this only when both sides have it.
   */
  content?: string;
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

/**
 * A control that was found and not exercised, and why.
 *
 * Not only the ones we refuse on purpose. A control the walk ran out of budget
 * for, or could not get back to, belongs here too: the alternative — which is
 * what the walker used to do — is a control that exists in `interactiveCount`
 * and appears nowhere else in the graph, so coverage quietly shrinks its own
 * denominator and a screen nobody touched reads as covered (issue #19).
 */
export interface SkippedElement {
  nodeId: string;
  label: string;
  reason:
    | 'dangerous'
    | 'external'
    | 'disabled'
    /** A configured limit — maxActions, maxStates, maxDepth — ran out first. */
    | 'budget'
    | 'needs-input'
    | 'unreachable'
    /** The walk could not get the browser back to the state holding this control. */
    | 'not-reached'
    /** The state was discovered and queued, and the walk ended before expanding it. */
    | 'frontier-exhausted';
  detail?: string;
}

/**
 * A node whose controls do not add up, and the numbers that prove it.
 *
 * Every control a node enumerated should end the walk as exactly one of: an
 * out-edge, a field a form submission consumed, or a `skipped[]` entry. When
 * that fails to balance the bug is in clickgraph's own bookkeeping, not in the
 * app — but the coverage figures beside it are then unreliable, and a number a
 * reader would trust is worse than an obviously bad one, so it is reported
 * rather than swallowed.
 */
export interface AccountingGap {
  nodeId: string;
  route: string;
  /** Controls enumerated when the node was discovered; frozen from then on. */
  interactiveCount: number;
  /** Out-edges of this node. */
  walked: number;
  /** `skipped[]` entries naming this node. */
  skipped: number;
  /**
   * Controls a self-loop revealed after the node's list was frozen (issue #8).
   * They are walked but were never in `interactiveCount`, so they are added to
   * what the node had to offer rather than subtracted from what was done.
   */
  appeared: number;
  /**
   * Fields exercised by their form's submit rather than by a click of their
   * own, under `--fill-forms`. Covered without an edge to show for it.
   */
  viaFormSubmit: number;
  /** The imbalance in plain words, for a reader who will not do the algebra. */
  detail: string;
}

export interface Coverage {
  statesFound: number;
  edgesWalked: number;
  /**
   * Controls discovered but never exercised. Never counted as working.
   *
   * Derived from the graph at the end of the walk rather than tallied as it
   * runs, so the number cannot drift away from the nodes and edges a reader can
   * count for themselves (issue #19). Deliberate skips are included: a control
   * refused as dangerous was discovered and was not exercised, which is exactly
   * what this counts.
   */
  edgesUnwalked: number;
  skipped: SkippedElement[];
  /**
   * Nodes where `out-edges + form-filled + skipped` did not match the controls
   * the node offered. Absent on a healthy walk, which is every walk unless
   * clickgraph has a bookkeeping bug.
   */
  accountingGaps?: AccountingGap[];
  /** Which budget stopped the walk, if any. null means the walk ran to completion. */
  limitHit: string | null;
  /** Routes the caller declared should be reachable in this walk. */
  expectedRoutes?: string[];
  /** Declared routes for which the walk discovered no node. */
  unreachedRoutes?: string[];
  /**
   * Declared field values whose selector matched nothing the walk ever typed
   * into. A value that never lands is the failure this feature exists to
   * prevent — the walk goes on synthesizing, misses the state the value was
   * meant to open, and reports success — so it is surfaced rather than
   * shrugged off.
   */
  unusedFields?: string[];
}

export interface WalkConfig {
  baseUrl: string;
  maxStates: number;
  maxActions: number;
  maxDepth: number;
  settleMs: number;
  allowDangerous: boolean;
  /**
   * Re-enter a known state by taking a walked edge to it, instead of reloading
   * the base URL and replaying its whole action path (issue #23).
   *
   * On by default, because the replay is most of a deep walk's wall clock: a
   * state four clicks in is re-reached by four clicks, once per control on it.
   *
   * The two ways of arriving are only interchangeable where the app keeps
   * nothing a reload would clear, so arrival is verified against the state's
   * structure fingerprint every time and the reload is used anyway when it does
   * not match. `eval/equivalence.mjs` is the standing check that the two find
   * the same graph; turn this off to walk the way the tool did before it, or to
   * attribute a difference between two walks.
   */
  fastReentry: boolean;
  /**
   * Fill each form with synthetic values and submit it, instead of leaving the
   * form untested. Off by default because a successful submission writes real
   * data — the same reasoning that keeps destructive controls unclicked.
   */
  fillForms: boolean;
  /**
   * Shell command run immediately before the browser walk starts.
   *
   * This is recorded so a baseline documents how its app state was prepared.
   * A diff must never execute the value merely because it appeared in a graph
   * file; callers have to opt in to running it again.
   */
  pre?: string;
  /**
   * Path to a session file, so the walk starts logged in: a Playwright storage
   * state, plus the sessionStorage that storage state cannot hold and the walk
   * replays instead (see session.ts).
   *
   * Only the path is recorded in the graph — the file holds session cookies and
   * must never be copied into an artifact that gets committed.
   */
  storageState?: string;
  /** Normalized routes the resulting graph is expected to contain. */
  expectedRoutes?: string[];
  /** Route manifest to re-read on diff so newly declared screens are asserted. */
  expectedRoutesFile?: string;
  /**
   * Requests to fail on purpose for the whole walk, so error and retry UI
   * becomes reachable. Recorded because a fault walk and a healthy walk
   * describe different apps: diffing one against the other reports every
   * screen as regressed, which is why the config warning for a mismatch is
   * the loudest one the tool emits.
   */
  fault?: FaultInjection;
  /**
   * Values to type into specific fields instead of synthesizing them.
   *
   * Recorded, and inherited by a diff, for the same reason the fault is: the
   * value is what opens the state, so a run without it walks a smaller app and
   * every control behind the lookup reads as missing.
   */
  fields?: DeclaredField[];
}

/**
 * A value the caller declares for one field, because no synthetic value could
 * work there.
 *
 * The case this exists for is a lookup: a field whose only useful contents are
 * an identifier the app already knows. `clickgraph-test` is not a customer
 * number, so the submit lands on "no such record" and the whole detail view
 * behind it — with every control on it — never enters the graph (issue #20).
 */
export interface DeclaredField {
  /**
   * CSS selector, matched against the field by the browser's own
   * `Element.matches`. The browser is the authority on what a selector means,
   * so nothing here has to invent a second matching language.
   */
  match: string;
  value: string;
}

/**
 * A deliberate failure applied to matching requests for the duration of a walk.
 *
 * Not a scenario list yet (issue #15 sketches those): one blanket mode, one
 * extra walk, diffed against its own baseline, is what covers most of the value.
 */
export interface FaultInjection {
  /** Glob over the request URL — `*` stops at `/`, `**` does not. */
  pattern: string;
  /** Status to answer with, or `offline` to drop the connection outright. */
  status: number | 'offline';
  /** Restrict to these HTTP methods. Empty means every method. */
  methods?: string[];
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
  /**
   * Failures the walk injected during load. Held apart from `httpErrors` so a
   * fault walk is not condemned as unhealthy for doing exactly what it was
   * asked to do — an app whose entry screen fetches through the broken pattern
   * would otherwise fail its own run before clicking anything.
   */
  injectedFailures?: string[];
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
  /**
   * Version of clickgraph that produced this graph. Optional so graphs written
   * before producer provenance was added remain readable.
   */
  clickgraphVersion?: string;
  /** Version of the graph file format, independent of the producing build. */
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
  | 'changed-content'
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
  /** Missing when the baseline predates producer-version provenance. */
  baselineClickgraphVersion?: string;
  currentClickgraphVersion?: string;
  /** Current route gaps, carried so one-argument reportDiff calls stay honest. */
  currentUnreachedRoutes?: string[];
  /** Declared values the current walk never typed, carried for the same reason. */
  currentUnusedFields?: string[];
  changes: Change[];
}

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  AccountingGap, Action, DeclaredField, ElementDescriptor, LoadHealth, Selector, SkippedElement,
  UIEdge, UIGraph,
  UINode, WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { CLICKGRAPH_VERSION } from './version.js';
import {
  ActionWatch, captureState, classifyOutcome, compareScroll, instrumentChromeEffects,
  readScrollPositions, resolve,
  type PageSnapshot,
} from './observer.js';
import { normalizeRoute, normalizeText } from './fingerprint.js';
import { fieldSpec, refusesFill, synthesize } from './formfill.js';
import { faultSpec, installFault, isInjected } from './fault.js';
import { readSessionFile, seedSessionStorage } from './session.js';

/**
 * A control that leads to state X does nothing when clicked from state X — it
 * has already done its job. The same family as a link to the page you are
 * already on, but visible only once the whole walk is finished: the button that
 * opens a panel is recognizable as already-open only from the edge that opened
 * it.
 *
 * Deliberately narrow — it requires the identical control to have produced this
 * exact state elsewhere in the same walk. The accepted cost is a toggle that
 * ought to close its panel and does not, which this marks benign. That trade
 * follows the project's usual rule: a confident false finding costs more than a
 * quiet miss.
 */
function markAlreadyApplied(edges: UIEdge[]): void {
  const key = (edge: UIEdge, state: string) =>
    `${edge.action.role}|${normalizeText(edge.action.name)}→${state}`;
  const opens = new Set<string>();
  for (const edge of edges) {
    if (edge.to) opens.add(key(edge, edge.to));
  }
  for (const edge of edges) {
    if (edge.outcome.kind !== 'no-effect' || edge.outcome.benign) continue;
    if (opens.has(key(edge, edge.from))) {
      edge.outcome.benign = true;
      edge.outcome.note = 'the state this control opens is already showing';
    }
  }
}

/**
 * Controls we refuse to click unsupervised. The walker runs autonomously against
 * a real app, so anything that destroys data, spends money, or ends the session
 * is skipped by default and reported as skipped — never as passing.
 */
const DANGEROUS = [
  /\b(delete|remove|destroy|drop|purge|erase|wipe|reset)\b/i,
  /\b(sign|log)\s?out\b/i,
  /\b(pay|purchase|buy|checkout|subscribe|upgrade|donate)\b/i,
  /\b(deactivate|close account|cancel subscription|unsubscribe)\b/i,
];

export interface WalkOptions extends Partial<WalkConfig> {
  onProgress?: (message: string) => void;
}

const DEFAULTS: Omit<WalkConfig, 'baseUrl'> = {
  maxStates: 40,
  maxActions: 200,
  maxDepth: 4,
  /** Quiet period with no DOM mutations that counts as "the page has settled". */
  settleMs: 250,
  allowDangerous: false,
  fastReentry: true,
  fillForms: false,
  expectedRoutes: [],
  fields: [],
};

/** Run the caller's reset/setup command before opening the browser. */
async function runPreWalk(command: string, log: (message: string) => void): Promise<void> {
  log(`running pre-walk command: ${command}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Keep stdout clean for `--json`. Hook output is operational context, so it
    // travels with progress and errors on stderr.
    child.stdout?.on('data', (chunk) => process.stderr.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (err) => {
      reject(new Error(`could not start pre-walk command ${JSON.stringify(command)}: ${err.message}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal) {
        reject(new Error(`pre-walk command ${JSON.stringify(command)} was terminated by ${signal}`));
      } else {
        reject(new Error(
          `pre-walk command ${JSON.stringify(command)} failed with exit code ${code ?? 'unknown'}`,
        ));
      }
    });
  });
}

/**
 * Does the entry page look like a login screen?
 *
 * Two signals, and neither stands entirely alone. A password field is the
 * strong one, but it is not proof: a create-account page, an invite-a-user
 * page and a change-your-password page all have one, and none of them is a
 * door. The weaker case — a sign-in control on a route named for
 * authentication — is included because passwordless and SSO front doors have
 * no password field at all.
 *
 * What separates a door from a form that merely holds a password is where you
 * can go from it. A login screen is a dead end by construction: submit the
 * form or leave. A page inside an app sits in the app's own navigation, and
 * that navigation is visible on the entry snapshot without walking anywhere.
 * So the password signal is believed unless the page is demonstrably somewhere
 * you can already move around in — which keeps the flag loud for the shapes it
 * was built for, and stops it from firing on the highest-consequence forms in
 * any app (issue #36).
 *
 * This used to be described as costing only a sentence when it was wrong. It
 * does not: the flag clears `ok` and fails the run, so a false positive costs
 * the whole walk. Hence corroboration.
 */
function looksLikeAuthWall(url: string, elements: ElementDescriptor[]): boolean {
  const authRoute = /(^|\/)(login|signin|sign-in|auth|authenticate|sso)(\/|$|\?)/i.test(url);
  const signInControl = elements.some((el) =>
    /\b(sign|log)\s?in\b|\bcontinue with\b/i.test(el.name),
  );
  if (elements.some((el) => el.inputType === 'password')) {
    // Named for auth, or offering to sign you in: a door either way, however
    // much else is on the page.
    if (authRoute || signInControl) return true;
    return !hasAppNavigation(url, elements);
  }
  return authRoute && signInControl;
}

/**
 * Does this page offer a way into an app, rather than just a way through it?
 *
 * Counted as distinct in-app destinations, not as links: a login form's
 * "Forgot your password?" and "Create an account" are two links to the two
 * places a door leads, and a row of them is still a door. Three separate
 * routes is a navigation bar, which no login screen has and every page inside
 * an app does.
 */
function hasAppNavigation(url: string, elements: ElementDescriptor[]): boolean {
  const here = new URL(url).pathname;
  const destinations = new Set<string>();
  for (const el of elements) {
    if (!el.href || isExternal(el, url)) continue;
    if (/(^|\/)(login|signin|sign-in|register|signup|sign-up|forgot|reset)(\/|$|\?)/i.test(el.href)) {
      continue;
    }
    try {
      const to = new URL(el.href, url).pathname;
      if (to !== here) destinations.add(to);
    } catch {
      // An href the URL parser will not take is not a destination worth counting.
    }
  }
  return destinations.size >= 3;
}

/**
 * Controls that answer to typing rather than to a click.
 *
 * A click on a text field focuses it and changes nothing else, so every search
 * box and every form field in an app reads as a dead control. That is the same
 * mistake the select used to make, at far greater scale.
 */
function isTextEntry(el: ElementDescriptor): boolean {
  if (el.tag === 'textarea') return true;
  if (el.tag !== 'input') return false;
  return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'range', 'color']
    .includes(el.inputType ?? 'text');
}

/**
 * How long to wait for a control to become clickable.
 *
 * Playwright's five-second default is a waiting room for an app that is still
 * settling — but the walker has already waited for the DOM to go quiet before
 * it gets here, so anything still not actionable is usually not going to be.
 * The cost of the difference is real: thirteen controls parked off-screen in a
 * closed drawer spent sixty-five seconds of one walk proving it.
 */
const ACTION_TIMEOUT = 2000;

/**
 * Why a control could not be acted on, in the app's terms.
 *
 * Playwright knows exactly which actionability check failed and says so in its
 * call log. Flattening all of them into "could not be clicked" throws away the
 * only part a reader can act on — a control covered by a modal, a control still
 * animating, and a control in a drawer that was never opened are three
 * different gaps in coverage, and only one of them is about timing.
 */
const NOT_ACTIONABLE: [RegExp, string][] = [
  [/outside of the viewport/,
    'parked outside the viewport — it belongs to a panel or drawer that was not ' +
    'open when the walk reached this state'],
  [/intercepts pointer events/,
    'covered by something else on the page, so the click could not reach it'],
  [/not stable/,
    'still moving when the walk tried to click it — an animation outliving the settle window'],
  [/not visible/, 'on the page but no longer visible when the walk came back to this state'],
  [/not enabled/, 'disabled by the time the walk reached it'],
];

function whyNotActionable(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  for (const [pattern, reason] of NOT_ACTIONABLE) {
    if (pattern.test(message)) return reason;
  }
  return 'never became clickable';
}

interface OptionChoice {
  value: string;
  label: string;
}

/**
 * Choose an option a select is not already showing.
 *
 * Picking the one already selected would be a guaranteed no-op, which is the
 * same trap as clicking the tab you are already on: the control would look dead
 * while working perfectly. One option is enough to prove the select does
 * something, and walking every option of a long list would spend the whole
 * action budget on a single dropdown.
 *
 * An option with an EMPTY value is skipped where any other exists. "Choose a
 * role", "— none —", "All customers": the placeholder is the commonest first
 * option there is, and choosing it fills a field with nothing. On its own that
 * merely wastes an action; inside a group it is worse, because the submit then
 * declines an incomplete form and gets reported as a button that does nothing.
 * Falling back to it when every option is empty keeps a select that is genuinely
 * all-placeholder walkable rather than silently skipped.
 */
async function pickOption(page: Page, selector: Selector): Promise<OptionChoice | null> {
  try {
    return await resolve(page, selector).evaluate((el: any) => {
      const options = Array.from(el.options ?? []) as any[];
      const usable = options.filter((o) => !o.selected && !o.disabled);
      const next = usable.find((o) => o.value !== '') ?? usable[0];
      if (!next) return null;
      return { value: next.value, label: (next.label || next.value || '').trim() };
    });
  } catch {
    return null;
  }
}

/**
 * Find the control again — and find out quickly when it cannot be found.
 *
 * Two problems with one answer. Playwright waits five seconds before admitting
 * a selector matches nothing, and on a real dashboard a third of the controls
 * matched nothing: 150 of a 220-second walk was spent waiting to be told what
 * `count()` answers immediately.
 *
 * And they matched nothing because of the selector, not the app. The name here
 * is derived from the DOM; Playwright derives its own from the accessible-name
 * algorithm; the two disagree over decorative content, CSS text-transform and
 * title attributes. Rather than chase an algorithm this cannot reproduce, fall
 * back to the structural path — which both sides resolve with the same CSS
 * engine — and let the durable selector be merely preferred, not required.
 */
async function locate(page: Page, el: ElementDescriptor): Promise<Selector | null> {
  const found = async (selector: Selector) => {
    try {
      return (await resolve(page, selector).count()) > 0;
    } catch {
      return false;
    }
  };
  if (await found(el.selector)) return el.selector;
  if (el.fallback) {
    const alt: Selector = { strategy: 'css', value: el.fallback, label: el.selector.label };
    if (await found(alt)) return alt;
  }
  return null;
}

/**
 * Whether a control is still on the page, and if so whether it is disabled.
 *
 * Filling a form can REMOVE the very control that was going to be submitted,
 * and legitimately so: an app whose submit is conditionally rendered swaps it
 * for "nothing left to do" the moment a select narrows the list to empty. The
 * walk did that itself, one line earlier.
 *
 * Asking a locator that no longer resolves whether it is disabled costs a full
 * actionability timeout and then THROWS. Unhandled, that killed the whole run
 * — exit 1, no graph written, so a project lost its baseline and its gate in
 * one step over a single vanished button (issue #46). Presence is checked
 * first, with the same `count()` primitive `locate` uses, and the throw is
 * caught as well: a race between the two reads must not be fatal either.
 */
async function disabledNow(page: Page, selector: Selector): Promise<boolean | 'gone'> {
  try {
    if ((await resolve(page, selector).count()) === 0) return 'gone';
    return await resolve(page, selector).isDisabled({ timeout: ACTION_TIMEOUT });
  } catch {
    return 'gone';
  }
}

/**
 * The caller's declaration for this field, or null to synthesize a value.
 *
 * Matching is `Element.matches` in the page, so a declared selector means
 * exactly what it means everywhere else in the browser. First match wins, so
 * a specific selector listed before a general one narrows it.
 *
 * The whole declaration comes back rather than just its value, because which
 * one matched is what says the declaration was used at all.
 */
async function declaredFor(
  page: Page,
  at: Selector,
  fields: readonly DeclaredField[],
): Promise<DeclaredField | null> {
  for (const field of fields) {
    const hit = await resolve(page, at).evaluate(
      (el: Element, css: string) => el.matches(css),
      field.match,
    );
    if (hit) return field;
  }
  return null;
}

/**
 * Refuse a selector the browser cannot parse, before the walk starts.
 *
 * Left to the walk, a typo'd selector throws inside the fill loop and gets
 * blamed on the field — "could not type into ..." — which sends the reader
 * looking at their app instead of at their config.
 */
async function assertFieldSelectors(page: Page, fields: readonly DeclaredField[]): Promise<void> {
  if (fields.length === 0) return;
  const invalid = await page.evaluate((selectors: string[]) =>
    selectors.filter((css) => {
      try {
        document.querySelector(css);
        return false;
      } catch {
        return true;
      }
    }), fields.map((f) => f.match));
  if (invalid.length > 0) {
    throw new Error(
      `--field selector is not valid CSS: ${invalid.map((css) => JSON.stringify(css)).join(', ')}`,
    );
  }
}

/**
 * Will this form submit as it stands, or will the browser refuse it?
 *
 * `checkValidity` is the browser's own answer, which beats reading the markup
 * and guessing. An unknown answer counts as "it will submit", so this can only
 * ever hold back a click, never invent a reason to make one.
 */
async function formWillSubmit(page: Page, selector: Selector): Promise<boolean> {
  try {
    return await resolve(page, selector).evaluate((el: any) => {
      const form = el.form ?? el.closest('form');
      if (!form) return true;
      // Validation turned off is a submission that always goes through.
      if (form.noValidate || el.hasAttribute('formnovalidate')) return true;
      return form.checkValidity();
    });
  } catch {
    return true;
  }
}

/**
 * The same question, for a group the app never declared as a form.
 *
 * There is no form here, so there is nothing to ask `checkValidity` — and the
 * gap it leaves is the same false positive it was written to close. A handler
 * that quietly declines an empty cluster and a button wired to nothing are
 * identical from the outside: both change no DOM. So the fields are read
 * instead, and a cluster with an empty one is reported as needing input rather
 * than guessed at. Unreadable counts as filled, so this can only hold back a
 * click, never invent a reason to make one.
 */
async function clusterIsFilled(page: Page, fields: ElementDescriptor[]): Promise<boolean> {
  for (const field of fields) {
    try {
      const at = await locate(page, field);
      if (!at) continue;
      const value = await resolve(page, at).inputValue({ timeout: ACTION_TIMEOUT });
      if (value.trim() === '') return false;
    } catch {
      continue;
    }
  }
  return true;
}

function isDangerous(el: ElementDescriptor): boolean {
  const text = `${el.name} ${el.selector.label}`;
  return DANGEROUS.some((re) => re.test(text));
}

function isExternal(el: ElementDescriptor, baseUrl: string): boolean {
  if (!el.href) return false;
  if (/^(mailto:|tel:|sms:)/i.test(el.href)) return true;
  try {
    return new URL(el.href, baseUrl).origin !== new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Wait until the page actually stops changing, rather than for a fixed delay.
 *
 * A fixed delay is wrong in both directions: too short and an animated panel is
 * still opening when we snapshot, so a working control gets reported dead — the
 * most damaging mistake this tool can make. Too long and every dead control
 * costs that delay. A MutationObserver quiet-period does both jobs: it returns
 * as soon as nothing is happening, and keeps waiting while the DOM is still
 * moving, up to a hard cap.
 *
 * Not `networkidle`, which imposes a 500ms floor on every single action.
 */
async function settle(page: Page, quietMs: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await page
    .evaluate(
      ({ quiet, cap }) =>
        new Promise<void>((resolve) => {
          let idle: ReturnType<typeof setTimeout>;
          const observer = new MutationObserver(() => restart());
          const finish = () => {
            observer.disconnect();
            clearTimeout(idle);
            clearTimeout(hard);
            resolve();
          };
          const restart = () => {
            clearTimeout(idle);
            idle = setTimeout(finish, quiet);
          };
          const hard = setTimeout(finish, cap);
          observer.observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, characterData: true,
          });
          restart();
        }),
      { quiet: quietMs, cap: 3000 },
    )
    // The context is torn down if the click navigated; that is not an error.
    .catch(() => {});
}

/**
 * Do the scrolling the click was going to do anyway, first and on purpose.
 *
 * Playwright scrolls a control into view before it clicks it, so by the time an
 * action lands the page can be sitting somewhere the baseline snapshot has
 * never seen. Every control below the fold then looks like it moved the page,
 * which would make the scroll signal useless and — because `visual` samples
 * viewport-relative rectangles — already made dead controls read as working
 * (issue #22). Doing it here means the baseline is taken from exactly where the
 * click will happen, and what is left between the two readings is the action
 * and nothing else.
 *
 * A failure is swallowed: the click that follows fails for the same reason and
 * reports it properly, through `whyNotActionable`, which is the one place that
 * says so in the app's terms.
 *
 * Given a much shorter budget than the click for exactly that reason. This is a
 * measurement aid, not an actionability gate, and the control that can never be
 * scrolled into view — parked in a closed drawer, transformed off-screen —
 * would otherwise burn the full action timeout here and then the full action
 * timeout again on the click. Scrolling an element that can be scrolled is
 * immediate; anything that needs longer than this is a control the click is
 * about to give up on anyway.
 */
const REVEAL_TIMEOUT = 500;

async function bringIntoView(page: Page, selector: Selector): Promise<void> {
  await resolve(page, selector)
    .scrollIntoViewIfNeeded({ timeout: REVEAL_TIMEOUT })
    .catch(() => {});
}

export async function walk(baseUrl: string, options: WalkOptions = {}): Promise<UIGraph> {
  // Drop keys that were passed as undefined — an unset CLI flag must fall back
  // to the default, not spread `undefined` over it.
  const { onProgress, ...overrides } = options;
  const provided = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<WalkConfig>;

  const config: WalkConfig = { ...DEFAULTS, ...provided, baseUrl };
  config.expectedRoutes = [...new Set((config.expectedRoutes ?? []).map((route) =>
    normalizeRoute(new URL(route, baseUrl).href),
  ))];
  const log = onProgress ?? (() => {});

  if (config.pre) await runPreWalk(config.pre, log);

  const nodes: Record<string, UINode> = {};
  const edges: UIEdge[] = [];
  let load: LoadHealth = { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const skipped: SkippedElement[] = [];
  /** `--field` specs whose selector matched something the walk typed into. */
  const fieldsUsed = new Set<string>();
  let limitHit: string | null = null;
  let actionsUsed = 0;
  /**
   * How re-entry was paid for, kept for the progress log only.
   *
   * Deliberately not written into the graph: it says how fast the walk was, not
   * what the app does, and a baseline that carried it would report a diff every
   * time the routing happened to differ.
   */
  let routed = 0;
  let reloaded = 0;
  /**
   * Routes taken that did not arrive — the replay failed, or it landed on a
   * screen that was not the one the walk came back for.
   *
   * Counted separately from `reloaded` because it is the number that says
   * whether this app is one routing works on. A reload the graph knew no way
   * around is ordinary; a route that was tried and missed is clicks spent for
   * nothing, and many of them mean the app keeps something a reload clears.
   */
  let misrouted = 0;

  /**
   * The two corrections the coverage invariant needs, per node.
   *
   * `interactiveCount` is frozen at discovery, so on its own it is neither an
   * upper nor a lower bound on what the walk had to do. A self-loop can reveal
   * controls the frozen list never held (issue #8), which add to the work; and
   * under `--fill-forms` a field is exercised by its form's submit rather than
   * by an edge of its own, which removes work without leaving a trace. Both are
   * counted here so the balance at the end of the walk can be exact instead of
   * loosened until it passes (issue #19).
   */
  const tally = new Map<string, { appeared: number; viaFormSubmit: number }>();
  const tallyFor = (nodeId: string) => {
    let entry = tally.get(nodeId);
    if (!entry) tally.set(nodeId, (entry = { appeared: 0, viaFormSubmit: 0 }));
    return entry;
  };
  /** States found after maxStates was full, so each is reported once, not once per edge. */
  const unrecorded = new Set<string>();

  const browser: Browser = await chromium.launch();
  // Names `clickgraph login` rather than Playwright's own storageState call,
  // which is what this used to suggest. A hand-rolled storage state is still
  // accepted and still works, but it is the one route that cannot carry a
  // session kept in sessionStorage (issue #27) — so pointing a user at it is
  // pointing them at the failure this release exists to close.
  if (config.storageState && !existsSync(config.storageState)) {
    await browser.close();
    throw new Error(
      `no session file at ${config.storageState} — create one with ` +
        `clickgraph login ${baseUrl} --storage-state ${config.storageState}`,
    );
  }
  // Read and split here rather than handing Playwright the path: the file may
  // carry a sessionStorage half that Playwright has no way to restore, and
  // giving it a key it does not know is asking a future version to reject the
  // whole file (issue #27).
  let session;
  try {
    session = config.storageState ? readSessionFile(config.storageState) : undefined;
  } catch (err) {
    // Closed for the same reason the missing-file check above closes it: an
    // unreadable session file is a usage error, and it should not cost a
    // browser left running.
    await browser.close();
    throw err;
  }
  const context = await browser.newContext({
    acceptDownloads: false,
    storageState: session?.storageState,
  });
  // Before any page exists: the shims must be in place before the first app
  // script runs, or a print on load would go unseen.
  await instrumentChromeEffects(context);
  // Same window, same reason: an app reads its session as it loads, so a
  // sessionStorage seeded any later than this arrives after the entry screen
  // has already been captured as a login form.
  if (session && session.sessionStorage.length > 0) {
    await seedSessionStorage(context, session.sessionStorage);
    const walkOrigin = new URL(baseUrl).origin;
    const forWalk = session.sessionStorage.find((entry) => entry.origin === walkOrigin);
    if (forWalk) {
      log(`replaying ${forWalk.items.length} sessionStorage key(s) saved for ${walkOrigin}`);
    } else {
      // Silence here is the original bug wearing a different hat: the file
      // holds a session, the walk cannot use it, and the only symptom would be
      // a login screen the report blames on an expired session.
      log(
        `saved sessionStorage is for ${session.sessionStorage.map((e) => e.origin).join(', ')}, ` +
        `but this walk is ${walkOrigin} — sessionStorage is per origin, so none of it applies`,
      );
    }
  }
  // Same reason, and one more: a fault installed after the first navigation
  // would let the entry screen load healthily and then break everything after
  // it, so the walk would compare two different apps to each other.
  if (config.fault) {
    await installFault(context, config.fault);
    log(`failing requests matching ${faultSpec(config.fault)}`);
  }
  const page = await context.newPage();

  // Autonomous walking must never hang on a modal or leak tabs.
  page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  context.on('page', (p) => { if (p !== page) void p.close().catch(() => {}); });

  /** Return to a known state by replaying its action path from the base URL. */
  async function gotoPath(path: Action[]): Promise<boolean> {
    // The click that ended the previous state can still have a navigation in
    // flight when the walk asks to go back to the entry page — `settle` waits
    // for the DOM to go quiet, which a navigation already committed to does not
    // disturb. Playwright refuses to run two navigations at once and throws,
    // and this line used to be the only one in the function outside the try:
    // one racing nav link killed the whole walk with a stack trace, where
    // failing this path costs a single state marked not-reached.
    //
    // Worth exactly one retry rather than an immediate failure, because the
    // interruption says another navigation is already finishing — waiting for
    // it lands the browser somewhere real, and the second attempt then does
    // what the first one asked for.
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT });
      } catch {
        /* whatever it was did not finish either; the retry below is still worth a try */
      }
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      } catch {
        return false;
      }
    }
    await settle(page, config.settleMs);
    for (const action of path) {
      try {
        // Re-type before re-submitting. A state that exists only because a
        // field held the right value cannot be re-entered by clicking the
        // submit again: that lands on the empty-form branch, which is a
        // different screen with none of the controls the walk came back for
        // (issue #20). Entries recorded before this carry no selector, and
        // replay for them is the submit alone, exactly as it used to be.
        for (const entry of action.fill ?? []) {
          if (!entry.selector) continue;
          const field = resolve(page, entry.selector);
          if ((await field.count()) === 0) return false;
          if (entry.option === undefined) {
            await field.fill(entry.value, { timeout: ACTION_TIMEOUT });
          } else {
            await field.selectOption(entry.option, { timeout: ACTION_TIMEOUT });
          }
        }
        const step = resolve(page, action.selector);
        // A step that is not there will not appear by waiting five seconds for
        // it, and the whole path fails either way — so fail on the count.
        if ((await step.count()) === 0) return false;
        await step.click({ timeout: ACTION_TIMEOUT });
        await settle(page, config.settleMs);
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * The cheapest known way from one state to another: breadth-first over the
   * edges the walk has already taken.
   *
   * Only click edges are eligible, and the reason is different for each of the
   * kinds left out. A `fill` edge submits a form, so travelling through one
   * creates data as a side effect of going somewhere — the walk is allowed to
   * submit a form to test it, not to commute. A `select` edge records the
   * option's *label* rather than its value, so replaying one is a guess. And a
   * `hover` edge only holds while the pointer stays put, which the next action
   * moves. A click is the one action that means the same thing on the way back
   * as it did on the way out.
   *
   * `limit` is what the reload costs: replaying the path is `path.length`
   * clicks, and the reload itself is one more navigation on top of them. So a
   * route of equal length is already the better deal — it spends a click where
   * the reload spends a whole page load, and it leaves in-page state standing
   * instead of destroying it. Raising the budget from `path.length` to
   * `path.length + 1` converted eight more of the fixture's reloads into routes
   * with none of them missing their target.
   */
  function routeBetween(from: string, to: string, limit: number): Action[] | null {
    if (from === to || limit <= 0) return null;
    const outgoing = new Map<string, UIEdge[]>();
    for (const edge of edges) {
      if (!edge.to || edge.to === edge.from) continue;
      if (edge.action.kind !== 'click') continue;
      let list = outgoing.get(edge.from);
      if (!list) outgoing.set(edge.from, (list = []));
      list.push(edge);
    }
    const seen = new Set([from]);
    let frontier: { at: string; route: Action[] }[] = [{ at: from, route: [] }];
    while (frontier.length > 0) {
      const next: { at: string; route: Action[] }[] = [];
      for (const { at, route } of frontier) {
        if (route.length >= limit) continue;
        for (const edge of outgoing.get(at) ?? []) {
          const extended = [...route, edge.action];
          if (edge.to === to) return extended;
          if (seen.has(edge.to!)) continue;
          seen.add(edge.to!);
          next.push({ at: edge.to!, route: extended });
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Take a route from wherever the browser is standing now. */
  async function replayRoute(route: Action[]): Promise<boolean> {
    for (const action of route) {
      try {
        const step = resolve(page, action.selector);
        if ((await step.count()) === 0) return false;
        await step.click({ timeout: ACTION_TIMEOUT });
        await settle(page, config.settleMs);
      } catch {
        return false;
      }
    }
    return true;
  }

  try {
    // Seed the frontier with the entry state, watching the load itself: an app
    // that errors on arrival must not walk "clean" just because a broken page
    // renders no buttons to click.
    const loadWatch = new ActionWatch(page);
    const loaded = await gotoPath([]);
    const observedLoad = loadWatch.stop();
    if (!loaded) throw new Error(`could not load ${baseUrl}`);
    // As early as there is a document to ask. A selector the browser cannot
    // parse is a usage error, and finding it after forty states of walking
    // wastes the walk it was supposed to steer.
    await assertFieldSelectors(page, config.fields ?? []);
    const entry = await captureState(page);
    load = {
      // The walk's own sabotage is split out of both lists, so a fault run is
      // not judged unhealthy on arrival for doing what it was told (issue #15).
      consoleErrors: config.fault
        ? observedLoad.consoleErrors.filter(
            (e) => !/Failed to fetch|NetworkError|net::ERR_|clickgraph-injected-failure/i.test(e),
          )
        : observedLoad.consoleErrors,
      httpErrors: observedLoad.httpErrors.filter(
        (e) => !isInjected(e, observedLoad.injectedFailures),
      ),
      ...(observedLoad.injectedFailures.length > 0
        ? { injectedFailures: observedLoad.injectedFailures }
        : {}),
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
     * Every recorded state's snapshot, kept so a state the walk never expanded
     * can still name its own controls. A node carries only `interactiveCount`,
     * which is a number and not a list — and a number is precisely what cannot
     * be turned into per-control reasons after the browser has closed.
     */
    const discovered = new Map<string, PageSnapshot>([[entry.nodeId, entry]]);
    /** States held out of the frontier on purpose, and why. */
    const unqueued = new Map<string, string>();

    while (frontier.length > 0) {
      const state = frontier.shift()!;
      if (expanded.has(state.nodeId)) continue;
      expanded.add(state.nodeId);

      const path = queuedPaths.get(state.nodeId) ?? [];
      log(`state ${state.fingerprint.route} (${state.elements.length} controls)`);

      // Forms whose submit button is on screen. Their fields are exercised by
      // the submit, not one at a time — a form with no submit in reach has no
      // such action to belong to, so its fields fall back to being skipped.
      //
      // A submit that is disabled right now still counts, because filling is
      // what un-disables it: every create-account form disables its submit
      // until the fields are valid. Excluding it here sent its own fields to
      // the needs-input skip, which is how the form ended up unreachable from
      // both ends at once (issue #34).
      const submittable = new Set(
        state.elements
          .filter((e) => e.formSubmit && e.formId && (config.fillForms || !e.disabled))
          .map((e) => e.formId as string),
      );

      /** Where the browser actually is right now, or null if unknown. */
      let atSnapshot: PageSnapshot | null = null;

      /**
       * The state's work list — mutable, because a self-loop can grow it.
       *
       * A node's element list is frozen at discovery, so a control that only
       * exists after an action mutates the same screen — the row an "add item"
       * submit renders, the panel a disclosure opens — used to be walked never
       * and counted nowhere: not an edge, not a skip, not unwalked. Coverage
       * claimed completeness it did not have (issue #8). New controls found by
       * a self-loop are spliced in immediately after the action that revealed
       * them, so they are attempted while the screen that holds them is still
       * showing; `appearedIn` records that screen's structure so the re-entry
       * gate below knows which page they belong to.
       */
      const pending: { el: ElementDescriptor; appearedIn?: string }[] =
        state.elements.map((el) => ({ el }));
      const knownKeys = new Set(
        state.elements.map((el) => `${el.selector.strategy}|${el.selector.value}`),
      );

      /**
       * Fields left for their form's submit to exercise, and the forms that
       * actually got submitted.
       *
       * The two cannot be compared as the loop runs: a field can come before or
       * after its own submit in the work list, and the submit may yet be turned
       * away by native validation or by a field nothing can be typed into. So
       * the fields are set aside here and settled once the state is finished —
       * either the submit ran and they were typed into, or nobody ever touched
       * them and that is a gap with a name (issue #19).
       */
      const forSubmit: { el: ElementDescriptor; formId: string }[] = [];
      const submittedForms = new Set<string>();

      for (let i = 0; i < pending.length; i++) {
        const { el, appearedIn } = pending[i]!;
        if (actionsUsed >= config.maxActions) {
          limitHit = limitHit ?? `maxActions (${config.maxActions})`;
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label, reason: 'budget',
            detail: `the maxActions budget (${config.maxActions}) was spent before the walk ` +
              'reached this control',
          });
          continue;
        }

        // A disabled control is normally the end of the story. A form's submit
        // is the exception: "disabled until the form is valid" is the most
        // common shape there is, and the only thing that can make it valid is
        // typing into the form it submits. Skipping it here meant the fill
        // below never ran, so the submit stayed disabled forever and the whole
        // form — every create-account, invite-user and change-password flow —
        // was unwalkable while the run still exited 0 (issue #34). Let it
        // through to the fill; whether it actually became enabled is re-read
        // from the live page afterwards, and it is skipped there if it did not.
        if (el.disabled && !(config.fillForms && el.formSubmit && el.formId)) {
          skipped.push({ nodeId: state.nodeId, label: el.selector.label, reason: 'disabled' });
          continue;
        }
        if (isExternal(el, baseUrl)) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'external', detail: el.href ?? undefined,
          });
          continue;
        }
        if (!config.allowDangerous && isDangerous(el)) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'dangerous', detail: 'matched a destructive-action pattern',
          });
          continue;
        }
        if (isTextEntry(el)) {
          // Not skipped — this field gets a value when its form is submitted
          // below, which is the only context in which typing into it proves
          // anything. Set aside rather than dropped: "its submit will handle it"
          // is a promise, and the reconciliation below checks it was kept.
          if (config.fillForms && el.formId && submittable.has(el.formId)) {
            forSubmit.push({ el, formId: el.formId });
            continue;
          }
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'needs-input',
            detail: el.inputType === 'password'
              ? 'a password field is never typed into'
              : 'a text field responds to typing, not to a click',
          });
          continue;
        }

        // A control that appeared mid-state can only be acted on while the
        // screen that revealed it is still showing: the replay below re-enters
        // the state as it was at discovery, which does not include this
        // control. When the moment has passed, say so — a skip with a reason
        // beats silently reporting the control as covered (issue #8).
        if (appearedIn && atSnapshot?.fingerprint.structure !== appearedIn) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'unreachable',
            detail: 'appeared after an earlier action and was gone when the walk could return',
          });
          continue;
        }

        // Re-enter the source state only when the browser is not already sitting
        // in it. Actions that change nothing — the common case — leave the page
        // exactly where the next action needs it, so the replay is skipped.
        // Compared on the fine structure tier, never the coarse identity tier:
        // reusing a page that merely *looks* like the source state would attribute
        // the next edge to the wrong place.
        if (!appearedIn &&
            (!atSnapshot || atSnapshot.fingerprint.structure !== state.fingerprint.structure)) {
          let arrived: PageSnapshot | null = null;

          // Ride the graph back when it knows a way that beats the reload. This
          // is where a deep walk spends most of its wall clock: without it, a
          // state four clicks in is re-reached by a fresh load and four clicks,
          // once for every control on it (issue #23).
          //
          // Arrival is checked rather than assumed, and that check is the whole
          // safety argument. Routing and reloading are only interchangeable on
          // an app that keeps nothing a reload would clear — so the walk asks
          // the page where it ended up, and takes the slow way anyway when the
          // answer is not the state it came back for. An app that accumulates
          // pays the reload it needs; one that does not, stops paying it.
          if (config.fastReentry && atSnapshot) {
            const route = routeBetween(atSnapshot.nodeId, state.nodeId, path.length + 1);
            if (route) {
              const here = (await replayRoute(route)) ? await captureState(page) : null;
              if (here && here.fingerprint.structure === state.fingerprint.structure) {
                arrived = here;
                routed++;
              } else {
                misrouted++;
              }
            }
          }

          if (!arrived) {
            if (!(await gotoPath(path))) {
              skipped.push({
                nodeId: state.nodeId, label: el.selector.label,
                reason: 'not-reached',
                detail: 'the walk could not replay its way back to this state, so the control ' +
                  'was never tried',
              });
              atSnapshot = null;
              continue;
            }
            arrived = await captureState(page);
            reloaded++;
          }
          atSnapshot = arrived;
        }

        // Everything below acts on the control, so find it first. Like the
        // select and the form checks under it, this can only run once the
        // browser is actually sitting on the page.
        const target = await locate(page, el);
        if (!target) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'unreachable',
            detail: 'not on the page when the walk came back to this state',
          });
          continue;
        }

        // A select answers to choosing an option, never to being clicked, so it
        // needs a different action or it is guaranteed to look dead. This has to
        // come after the state has been re-entered above — the option list can
        // only be read once the browser is actually sitting on the page.
        let choice: OptionChoice | null = null;
        if (el.tag === 'select') {
          choice = await pickOption(page, target);
          if (!choice) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: 'no option available other than the one already chosen',
            });
            continue;
          }
        }

        // Fill the whole form, then submit it, as one action. Typing into a
        // single field and stopping there proves nothing: the value is not part
        // of the state fingerprint, so a working field looks inert, and the
        // walker returns to the start before any submit could use what was
        // typed. Opt-in, because a submission that succeeds writes real data.
        const filled: NonNullable<Action['fill']> = [];
        if (config.fillForms && el.formSubmit && el.formId) {
          const fields = state.elements.filter(
            (f) =>
              f !== el && f.formId === el.formId && !f.disabled &&
              (isTextEntry(f) || f.tag === 'select'),
          );

          // Locate every field and resolve its declared value BEFORE typing
          // into any of them. Whether a field was declared decides whether the
          // form is refused below, and only the browser can say which fields a
          // selector matches — so the question has to be asked first.
          let unfillable: string | null = null;
          const prepared: { field: ElementDescriptor; at: Selector; declared: string | null }[] = [];
          for (const field of fields) {
            try {
              const at = await locate(page, field);
              if (!at) throw new Error('field not found');
              const match = await declaredFor(page, at, config.fields ?? []);
              if (match) fieldsUsed.add(fieldSpec(match));
              prepared.push({ field, at, declared: match?.value ?? null });
            } catch {
              unfillable = field.selector.label;
              break;
            }
          }
          if (unfillable) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: `could not type into ${unfillable}, so the form was left alone`,
            });
            continue;
          }

          // One refusing field stops the whole form. Submitting it with that
          // field deliberately blank would test something nobody asked for.
          const refusal = prepared
            .map((p) => refusesFill(p.field, p.declared))
            .find((r) => r !== null);
          if (refusal) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: `${refusal} (${fields.length} field(s) left unfilled)`,
            });
            continue;
          }

          for (const { field, at, declared } of prepared) {
            try {
              if (field.tag === 'select') {
                // A declared value names the option outright. Where none was
                // declared, any option other than the current one will do —
                // the point is to prove the select is wired, not to choose
                // well.
                if (declared !== null) {
                  await resolve(page, at).selectOption(declared, { timeout: ACTION_TIMEOUT });
                  filled.push({
                    label: field.selector.label, value: declared, selector: at, option: declared,
                  });
                  continue;
                }
                const opt = await pickOption(page, at);
                if (!opt) continue; // nothing else to choose; leave it as it stands
                await resolve(page, at).selectOption(opt.value, { timeout: ACTION_TIMEOUT });
                filled.push({
                  label: field.selector.label, value: opt.label, selector: at, option: opt.value,
                });
              } else {
                const value = declared ?? synthesize(field);
                await resolve(page, at).fill(value, { timeout: ACTION_TIMEOUT });
                filled.push({ label: field.selector.label, value, selector: at });
              }
            } catch {
              unfillable = field.selector.label;
              break;
            }
          }
          if (unfillable) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: `could not type into ${unfillable}, so the form was left alone`,
            });
            continue;
          }
          // Re-read the page so the outcome measures the submit alone. An app
          // with live validation redraws while a field is being typed into, and
          // that redraw would otherwise be credited to the submit button.
          if (filled.length > 0) atSnapshot = await captureState(page);

          // The submit was allowed through the disabled gate on the strength of
          // the fill. Ask the page whether that worked rather than assuming it:
          // a form can stay disabled because it wants a field nothing here can
          // supply — a captcha, a confirm-password that must match, a value the
          // server has to bless. Clicking it then proves nothing, so this is
          // where such a form gets its honest skip, with the reason attached.
          const disabled = await disabledNow(page, target);
          // Gone, not disabled: the fill above removed it. Reported in the
          // vocabulary the walk already has for a control that is not there,
          // and with the cause named, because "unreachable" on its own reads
          // like the walk's failure rather than the app's design.
          if (disabled === 'gone') {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label, reason: 'unreachable',
              detail: filled.length > 0
                ? `filling ${filled.length} field(s) took it off the page before it could ` +
                  'be pressed'
                : 'it left the page between being enumerated and being pressed',
            });
            continue;
          }
          if (disabled) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label, reason: 'disabled',
              detail: filled.length > 0
                ? `still disabled after filling ${filled.length} field(s) — it needs something ` +
                  'the walk cannot supply'
                : 'disabled, and its form had no field the walk could fill',
            });
            continue;
          }
        }

        // Clicking the submit button of a form the browser will not accept
        // tests nothing: native validation refuses the submission and changes
        // no DOM, so a working control reads as dead. Left unhandled, every
        // form with a required field in every app is reported broken.
        if (el.formSubmit && !(await formWillSubmit(page, target))) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'needs-input',
            detail: filled.length > 0
              ? `still invalid after filling ${filled.length} field(s) — it needs something ` +
                'that cannot be synthesized'
              : 'the form is not filled in, so the browser refuses to submit it',
          });
          continue;
        }

        // And the same refusal where the browser has no opinion to offer,
        // because the app grouped its fields with layout instead of a <form>.
        // `formWillSubmit` answers true for anything with no form above it, so
        // without this the cluster's button is clicked against empty fields —
        // which is the check above skipped for every app that does not use
        // forms, which is most of them (issue #24).
        if (el.formSubmit && el.formKind === 'cluster') {
          const empty = state.elements.filter(
            (f) => f !== el && f.formId === el.formId && !f.disabled && isTextEntry(f),
          );
          if (empty.length > 0 && !(await clusterIsFilled(page, empty))) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: filled.length > 0
                ? `still empty after filling ${filled.length} field(s)`
                : `${empty.length} field(s) beside it are empty, and these are not in a ` +
                  'form, so nothing will say whether a click was declined or ignored',
            });
            continue;
          }
        }

        // Both gates above guarantee a snapshot; the narrowing is for the
        // compiler, and skipping is the honest fallback if that ever breaks.
        if (atSnapshot === null) {
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'not-reached',
            detail: 'the walk lost track of which screen the browser was on before this ' +
              'control could be tried',
          });
          continue;
        }
        // Reveal the control and re-read the baseline from where it now sits,
        // so the scroll reading either side of the click is attributable to the
        // click. The re-read is skipped when nothing moved — the common case,
        // and the reason this costs nothing on a page that fits the viewport —
        // and an unreadable comparison counts as movement, because a baseline
        // taken again is only slower, while a baseline left stale is wrong.
        // The settle is for apps that load content as it scrolls into view:
        // without it that content arrives between the two snapshots and the
        // click is credited with fetching it.
        const beforeReveal = await readScrollPositions(page);
        await bringIntoView(page, target);
        let scrollBefore = await readScrollPositions(page);
        let before = atSnapshot;
        if (compareScroll(beforeReveal, scrollBefore) !== 'same') {
          await settle(page, config.settleMs);
          scrollBefore = await readScrollPositions(page);
          before = await captureState(page);
          atSnapshot = before;
        }
        const action: Action = choice
          ? {
              kind: 'select', selector: target, role: el.role, name: el.name,
              value: choice.label,
            }
          : filled.length > 0
            ? {
                kind: 'fill', selector: target, role: el.role, name: el.name,
                fill: filled,
              }
            : { kind: 'click', selector: target, role: el.role, name: el.name };

        const watch = new ActionWatch(page);
        let clickFailed = false;
        let failure = 'never became clickable';
        try {
          if (choice) {
            await resolve(page, target).selectOption(choice.value, { timeout: ACTION_TIMEOUT });
          } else {
            await resolve(page, target).click({ timeout: ACTION_TIMEOUT });
          }
          await settle(page, config.settleMs);
        } catch (err) {
          clickFailed = true;
          failure = whyNotActionable(err);
        }
        const observed = watch.stop();
        actionsUsed++;

        if (clickFailed) {
          // No `unwalked++` beside the skip: the control is accounted for once,
          // by the entry below. Counting it in both places is how a tally and a
          // graph drift apart (issue #19).
          atSnapshot = null;
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'unreachable', detail: failure,
          });
          continue;
        }

        const scrollAfter = await readScrollPositions(page);
        let after = await captureState(page);
        atSnapshot = after;
        let outcome = classifyOutcome(
          before, after,
          { ...observed, scrolled: compareScroll(scrollBefore, scrollAfter) },
          el,
        );

        // A control that looks hover-driven and did nothing when clicked has not
        // been tested yet — it has been tested the wrong way. Try hovering
        // before calling it dead; an entire dashboard of glossary terms reads as
        // broken otherwise.
        if (outcome.kind === 'no-effect' && !outcome.benign && el.hoverAffordance) {
          let hoverBefore = after;
          let hoverScrollBefore = scrollAfter;
          try {
            // The pointer is still sitting on the element after the click, so
            // hovering it again fires no pointerenter. Move away first, or the
            // probe silently tests nothing.
            await page.mouse.move(0, 0);
            await page.waitForTimeout(50);
            // Then the same baseline discipline the click above uses: hover
            // scrolls to its target too, and a probe measured across that
            // scroll would credit the hover with moving the page (issue #22).
            await bringIntoView(page, target);
            hoverScrollBefore = await readScrollPositions(page);
            if (compareScroll(scrollAfter, hoverScrollBefore) !== 'same') {
              await settle(page, config.settleMs);
              hoverScrollBefore = await readScrollPositions(page);
              hoverBefore = await captureState(page);
            }
          } catch {
            /* the probe below fails for the same reason and keeps the click result */
          }
          const hoverWatch = new ActionWatch(page);
          try {
            await resolve(page, target).hover({ timeout: ACTION_TIMEOUT });
            await settle(page, config.settleMs);
          } catch {
            /* not hoverable either — keep the click result */
          }
          const hoverObserved = hoverWatch.stop();
          const hoverScrollAfter = await readScrollPositions(page);
          const afterHover = await captureState(page);
          const hoverOutcome = classifyOutcome(
            hoverBefore, afterHover,
            { ...hoverObserved, scrolled: compareScroll(hoverScrollBefore, hoverScrollAfter) },
            el,
          );
          if (hoverOutcome.kind !== 'no-effect') {
            action.kind = 'hover';
            outcome = { ...hoverOutcome, note: 'responds to hover, not to click' };
            after = afterHover;
            atSnapshot = afterHover;
          }
        }
        const reachedNew = after.nodeId !== before.nodeId;

        // A self-loop that changed the screen's structure is the signal that
        // this node now holds controls its frozen element list does not know
        // about (issue #8). Splice them in right after this action, so they
        // are attempted while the screen that holds them is still up.
        if (!reachedNew && outcome.kind === 'state-changed') {
          const fresh = after.elements.filter((n) => {
            const nKey = `${n.selector.strategy}|${n.selector.value}`;
            if (knownKeys.has(nKey)) return false;
            knownKeys.add(nKey);
            return true;
          });
          if (fresh.length > 0) {
            pending.splice(
              i + 1, 0,
              ...fresh.map((n) => ({ el: n, appearedIn: after.fingerprint.structure })),
            );
            // Work this node owes that its frozen `interactiveCount` never knew
            // about, so the balance at the end of the walk expects it.
            tallyFor(state.nodeId).appeared += fresh.length;
          }
        }

        // The submit ran, so whatever was set aside for it above was typed into
        // after all.
        if (el.formSubmit && el.formId) submittedForms.add(el.formId);

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
            // The screen was reached and then not written down, so without this
            // nothing in the graph would ever mention it or its controls — the
            // worst version of the undercount, because the denominator loses a
            // whole state rather than a few controls (issue #19). The entries
            // name a node that is deliberately absent from `nodes`; that is the
            // record of a screen the budget refused, and it is once per state
            // rather than once per edge that lands on it.
            if (!unrecorded.has(after.nodeId)) {
              unrecorded.add(after.nodeId);
              for (const missed of after.elements) {
                skipped.push({
                  nodeId: after.nodeId, label: missed.selector.label, reason: 'budget',
                  detail: `${after.fingerprint.route} was reached after the maxStates budget ` +
                    `(${config.maxStates}) was full, so the state itself was never recorded`,
                });
              }
            }
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
          discovered.set(after.nodeId, after);
          log(`  → discovered ${after.fingerprint.route}`);
          if (newPath.length < config.maxDepth) {
            queuedPaths.set(after.nodeId, newPath);
            frontier.push(after);
          } else {
            limitHit = limitHit ?? `maxDepth (${config.maxDepth})`;
            // Was `unwalked += after.elements.length`: a bulk number and not one
            // word about which controls it stood for. The state is recorded with
            // an `interactiveCount` and no out-edges and no skips, which is the
            // shape issue #19 opens on — a whole screen that reads as covered.
            // The sweep after the loop gives each of them a reason.
            unqueued.set(
              after.nodeId,
              `${after.fingerprint.route} is ${newPath.length} click(s) from the entry page ` +
                `and maxDepth is ${config.maxDepth}, so the state was never expanded`,
            );
          }
        }
      }

      // Settle up with the fields that were left to their form's submit. The
      // ones whose submit ran were typed into, and the edge it produced is the
      // proof — they are covered without an edge of their own, which the
      // balance below is told about. The rest belong to a form that was turned
      // away (native validation, a field nothing could be typed into, a submit
      // that never became clickable): nobody typed into them, and before this
      // they were the one deliberate silence left in the accounting.
      for (const { el, formId } of forSubmit) {
        if (submittedForms.has(formId)) {
          tallyFor(state.nodeId).viaFormSubmit++;
          continue;
        }
        skipped.push({
          nodeId: state.nodeId, label: el.selector.label,
          reason: 'needs-input',
          detail: 'its form was never submitted, so nothing was ever typed into this field',
        });
      }
    }

    // Every state that was found and never expanded, control by control.
    //
    // Doing this as a sweep over what was discovered — rather than at each site
    // that declines to expand a state — is deliberate: it holds for a reason
    // nobody has thought of yet. A state left on the frontier by a future early
    // exit gets `frontier-exhausted` and stays visible, instead of going quiet
    // the way the maxDepth cut above used to.
    for (const [nodeId, snapshot] of discovered) {
      if (expanded.has(nodeId)) continue;
      const why = unqueued.get(nodeId);
      for (const missed of snapshot.elements) {
        skipped.push({
          nodeId, label: missed.selector.label,
          reason: why ? 'budget' : 'frontier-exhausted',
          detail: why ?? 'the state was discovered and queued, and the walk ended before it ' +
            'was expanded',
        });
      }
    }
  } finally {
    await browser.close();
  }

  // Said out loud so the trade is visible in a run rather than only in a
  // benchmark: every routed re-entry is a page load and an action replay the
  // walk did not have to pay for, and every reload beside it is a state the
  // graph knew no cheap way back to.
  if (routed + reloaded > 0) {
    log(
      config.fastReentry
        ? `re-entered states ${routed + reloaded} time(s): ${routed} by a known route, ` +
          `${reloaded} by reloading` +
          (misrouted > 0
            ? ` (${misrouted} route(s) tried and missed — use --no-fast-reentry if that number ` +
              'is large, this app keeps something a reload clears)'
            : '')
        : `re-entered states ${reloaded} time(s), all by reloading (--no-fast-reentry)`,
    );
  }

  markAlreadyApplied(edges);

  /**
   * Balance every enumerated control against what the walk did with it.
   *
   * The invariant, per node:
   *
   *   interactiveCount + appeared  ==  out-edges + viaFormSubmit + skipped
   *
   * The left side is everything the node had to offer: the controls it was
   * enumerated with, plus the ones a self-loop revealed afterwards, which are
   * walked but were never in the frozen count (issue #8). The right side is
   * everything that was done about them. `viaFormSubmit` is on the right rather
   * than subtracted from the left because a filled field really was exercised —
   * it just has its form's edge to show for it instead of one of its own.
   *
   * Naively equating out-edges + skipped to interactiveCount does not balance
   * for either of those reasons, and the temptation is to relax it until it
   * passes. Naming the two corrections keeps it exact, which is the only form
   * worth asserting: an invariant that has been loosened until it holds proves
   * nothing about the thing it was written to catch.
   *
   * A violation does NOT throw. The walk has already run — a real graph, a real
   * browser session, minutes of real clicking — and the mismatch is in
   * clickgraph's own bookkeeping, not in the app. Destroying the evidence to
   * punish the accountant leaves a user with nothing to report and nothing to
   * debug with. It is recorded in the graph and shouted in the report instead,
   * which is the same rule the rest of this project runs on: a gap that is
   * stated is worth more than a number that looks clean.
   */
  const outEdges = new Map<string, number>();
  for (const edge of edges) outEdges.set(edge.from, (outEdges.get(edge.from) ?? 0) + 1);
  const skipsPerNode = new Map<string, number>();
  for (const entry of skipped) {
    skipsPerNode.set(entry.nodeId, (skipsPerNode.get(entry.nodeId) ?? 0) + 1);
  }

  const accountingGaps: AccountingGap[] = [];
  let unwalked = 0;
  for (const [nodeId, node] of Object.entries(nodes)) {
    const { appeared, viaFormSubmit } = tally.get(nodeId) ?? { appeared: 0, viaFormSubmit: 0 };
    const walked = outEdges.get(nodeId) ?? 0;
    const skips = skipsPerNode.get(nodeId) ?? 0;
    const offered = node.interactiveCount + appeared;
    // Discovered and not exercised — which is what edgesUnwalked has always
    // claimed to be, now taken from the graph instead of a running total that
    // could disagree with it.
    unwalked += offered - walked - viaFormSubmit;
    const gap = offered - walked - viaFormSubmit - skips;
    if (gap !== 0) {
      accountingGaps.push({
        nodeId,
        route: node.fingerprint.route,
        interactiveCount: node.interactiveCount,
        walked, skipped: skips, appeared, viaFormSubmit,
        detail: `${node.fingerprint.route}: ${offered} control(s) offered, ` +
          `${walked} walked + ${viaFormSubmit} filled by a form + ${skips} skipped — ` +
          `${gap > 0 ? `${gap} unexplained` : `${-gap} counted twice`}`,
      });
    }
  }
  // States the maxStates budget refused to record have no node to balance
  // against, and their controls are unwalked by definition.
  for (const entry of skipped) if (!nodes[entry.nodeId]) unwalked++;

  if (accountingGaps.length > 0) {
    log(
      `  coverage accounting does not balance on ${accountingGaps.length} state(s) — ` +
        'this is a clickgraph bug, and the coverage numbers below are unreliable',
    );
    for (const gap of accountingGaps) log(`    ${gap.detail}`);
  }

  const expectedRoutes = config.expectedRoutes ?? [];
  const reachedRoutes = new Set(Object.values(nodes).map((node) => node.fingerprint.route));
  const unreachedRoutes = expectedRoutes.filter((route) => !reachedRoutes.has(route));
  // A declared value that never landed is the silent failure this feature was
  // built to end. Counted here so it reaches the verdict rather than being
  // left for a reader to notice in an edge list.
  const unusedFields = (config.fields ?? [])
    .map(fieldSpec)
    .filter((spec) => !fieldsUsed.has(spec));

  return {
    clickgraphVersion: CLICKGRAPH_VERSION,
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
      ...(accountingGaps.length > 0 ? { accountingGaps } : {}),
      limitHit,
      expectedRoutes,
      unreachedRoutes,
      unusedFields,
    },
  };
}

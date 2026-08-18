import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  AccountingGap, Action, ElementDescriptor, LoadHealth, Selector, SkippedElement, UIEdge, UIGraph,
  UINode, WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { CLICKGRAPH_VERSION } from './version.js';
import {
  ActionWatch, captureState, classifyOutcome, instrumentChromeEffects, resolve,
  type PageSnapshot,
} from './observer.js';
import { normalizeRoute, normalizeText } from './fingerprint.js';
import { refusesFill, synthesize } from './formfill.js';
import { faultSpec, installFault, isInjected } from './fault.js';

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
  fillForms: false,
  expectedRoutes: [],
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
 * A visible password field is the signal that stands on its own. The weaker
 * case — a sign-in control on a route named for authentication — is included
 * because passwordless and SSO front doors have no password field at all.
 *
 * This only ever adds a caveat to the report. Getting it wrong costs a sentence;
 * missing a login wall costs a clean run that covered nothing but the door.
 */
function looksLikeAuthWall(url: string, elements: ElementDescriptor[]): boolean {
  if (elements.some((el) => el.inputType === 'password')) return true;
  const authRoute = /(^|\/)(login|signin|sign-in|auth|authenticate|sso)(\/|$|\?)/i.test(url);
  const signInControl = elements.some((el) =>
    /\b(sign|log)\s?in\b|\bcontinue with\b/i.test(el.name),
  );
  return authRoute && signInControl;
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
 */
async function pickOption(page: Page, selector: Selector): Promise<OptionChoice | null> {
  try {
    return await resolve(page, selector).evaluate((el: any) => {
      const options = Array.from(el.options ?? []) as any[];
      const next = options.find((o) => !o.selected && !o.disabled);
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
  let limitHit: string | null = null;
  let actionsUsed = 0;

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
  if (config.storageState && !existsSync(config.storageState)) {
    await browser.close();
    throw new Error(
      `no storage state at ${config.storageState} — create one by signing in once, ` +
        `then saving the session with Playwright's context.storageState({ path })`,
    );
  }
  const context = await browser.newContext({
    acceptDownloads: false,
    storageState: config.storageState,
  });
  // Before any page exists: the shims must be in place before the first app
  // script runs, or a print on load would go unseen.
  await instrumentChromeEffects(context);
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
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await settle(page, config.settleMs);
    for (const action of path) {
      try {
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

  try {
    // Seed the frontier with the entry state, watching the load itself: an app
    // that errors on arrival must not walk "clean" just because a broken page
    // renders no buttons to click.
    const loadWatch = new ActionWatch(page);
    const loaded = await gotoPath([]);
    const observedLoad = loadWatch.stop();
    if (!loaded) throw new Error(`could not load ${baseUrl}`);
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
      const submittable = new Set(
        state.elements
          .filter((e) => e.formSubmit && e.formId && !e.disabled)
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

        if (el.disabled) {
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
          atSnapshot = await captureState(page);
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
        const filled: { label: string; value: string }[] = [];
        if (config.fillForms && el.formSubmit && el.formId) {
          const fields = state.elements.filter(
            (f) =>
              f !== el && f.formId === el.formId && !f.disabled &&
              (isTextEntry(f) || f.tag === 'select'),
          );
          // One refusing field stops the whole form. Submitting it with that
          // field deliberately blank would test something nobody asked for.
          const refusal = fields.map(refusesFill).find((r) => r !== null);
          if (refusal) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: `${refusal} (${fields.length} field(s) left unfilled)`,
            });
            continue;
          }

          let unfillable: string | null = null;
          for (const field of fields) {
            try {
              const at = await locate(page, field);
              if (!at) throw new Error('field not found');
              if (field.tag === 'select') {
                const opt = await pickOption(page, at);
                if (!opt) continue; // nothing else to choose; leave it as it stands
                await resolve(page, at).selectOption(opt.value, { timeout: ACTION_TIMEOUT });
                filled.push({ label: field.selector.label, value: opt.label });
              } else {
                const value = synthesize(field);
                await resolve(page, at).fill(value, { timeout: ACTION_TIMEOUT });
                filled.push({ label: field.selector.label, value });
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
        const before = atSnapshot;
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

        let after = await captureState(page);
        atSnapshot = after;
        let outcome = classifyOutcome(before, after, observed, el);

        // A control that looks hover-driven and did nothing when clicked has not
        // been tested yet — it has been tested the wrong way. Try hovering
        // before calling it dead; an entire dashboard of glossary terms reads as
        // broken otherwise.
        if (outcome.kind === 'no-effect' && !outcome.benign && el.hoverAffordance) {
          const hoverWatch = new ActionWatch(page);
          try {
            // The pointer is still sitting on the element after the click, so
            // hovering it again fires no pointerenter. Move away first, or the
            // probe silently tests nothing.
            await page.mouse.move(0, 0);
            await page.waitForTimeout(50);
            await resolve(page, target).hover({ timeout: ACTION_TIMEOUT });
            await settle(page, config.settleMs);
          } catch {
            /* not hoverable either — keep the click result */
          }
          const hoverObserved = hoverWatch.stop();
          const afterHover = await captureState(page);
          const hoverOutcome = classifyOutcome(after, afterHover, hoverObserved, el);
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
    },
  };
}

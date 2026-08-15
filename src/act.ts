/**
 * Everything involved in exercising one control on a page that is already open.
 *
 * This lives apart from the walker because it is the part two callers need. A
 * walk discovers what to do next by clicking and seeing where it lands; a replay
 * is handed the list up front. Those are two scheduling strategies over one set
 * of rules — the safety refusals, the select and form handling, the hover retry,
 * the outcome classification.
 *
 * That set of rules is most of what this project knows. Nearly every entry in
 * the README's list of rules is a false positive some real app produced, and a
 * second copy of them would mean every future fix has to be found twice and
 * applied twice. The scheduling is allowed to differ. The judgment is not.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  Action, ElementDescriptor, Outcome, Selector, SkippedElement, UIEdge, WalkConfig,
} from './types.js';
import { ActionWatch, captureState, classifyOutcome, resolve, type PageSnapshot } from './observer.js';
import { normalizeText } from './fingerprint.js';
import { refusesFill, synthesize } from './formfill.js';

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

/**
 * How long to wait for a control to become clickable.
 *
 * Playwright's five-second default is a waiting room for an app that is still
 * settling — but the walker has already waited for the DOM to go quiet before
 * it gets here, so anything still not actionable is usually not going to be.
 * The cost of the difference is real: thirteen controls parked off-screen in a
 * closed drawer spent sixty-five seconds of one walk proving it.
 */
export const ACTION_TIMEOUT = 2000;

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

/**
 * Controls that answer to typing rather than to a click.
 *
 * A click on a text field focuses it and changes nothing else, so every search
 * box and every form field in an app reads as a dead control. That is the same
 * mistake the select used to make, at far greater scale.
 */
export function isTextEntry(el: ElementDescriptor): boolean {
  if (el.tag === 'textarea') return true;
  if (el.tag !== 'input') return false;
  return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'range', 'color']
    .includes(el.inputType ?? 'text');
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
export async function settle(page: Page, quietMs: number): Promise<void> {
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
export async function locate(page: Page, el: ElementDescriptor): Promise<Selector | null> {
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
 * Choose an option to *submit a form with*, which is a different question.
 *
 * `pickOption` above answers "what would prove this select responds", and its
 * answer is an option the control is not already showing. That is the wrong
 * answer here, in the one case that matters most: a required select sitting on
 * a `<option value="">Pick one…</option>` placeholder. Whichever option the
 * walk left showing, "something else" eventually comes back around to the
 * placeholder — and the placeholder is the single value that makes the form
 * invalid, so the submit is skipped as `needs-input` and the button behind it
 * never gets tested at all.
 *
 * It is reachable because a walk does not reload between actions in one state,
 * so a select still shows whatever the previous action chose. Every form with a
 * required select in every app is affected, and the symptom is silence rather
 * than a wrong finding, which is why it went unnoticed.
 *
 * So: prefer a real value over an empty one, and only fall back to an empty
 * value when the control offers nothing else. Being different from what is
 * showing does not matter — the submit is what is under test, not the select.
 */
async function pickFillOption(page: Page, selector: Selector): Promise<OptionChoice | null> {
  try {
    return await resolve(page, selector).evaluate((el: any) => {
      const options = (Array.from(el.options ?? []) as any[]).filter((o) => !o.disabled);
      if (options.length === 0) return null;
      const next = options.find((o) => o.value !== '') ?? options[0];
      return { value: next.value, label: (next.label || next.value || '').trim() };
    });
  } catch {
    return null;
  }
}

/**
 * Will this form submit as it stands, or will the browser refuse it?
 *
 * `checkValidity` is the browser's own answer, which beats reading the markup
 * and guessing. An unknown answer counts as "it will submit", so this can only
 * ever hold back a click, never invent a reason to make one.
 */
/**
 * Did the select keep the option it was just given?
 *
 * Asked of the live element rather than of a snapshot, because a value lives in
 * a property: nothing about it appears in an attribute, in the page's text, or
 * in the `selected` attributes of the options, so there is nothing for a DOM
 * comparison to notice.
 *
 * A select that answers "no" here has refused the change, which is the shape of
 * a controlled component whose handler never commits one — React restores the
 * old value when onChange does not set state, and the control cannot be changed
 * at all. That is a real defect and the walker used to report the option as
 * chosen regardless, describing a change that never happened.
 *
 * Unreadable counts as "no". The excuse this feeds requires positive evidence
 * that the value took, and a question that could not be asked has not answered
 * it.
 */
async function selectionHeld(page: Page, selector: Selector, wanted: string): Promise<boolean> {
  try {
    return await resolve(page, selector).evaluate(
      (el: any, want: string) => el.value === want,
      wanted,
    );
  } catch {
    return false;
  }
}

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

/* ---------- the browser a run drives ---------- */

export interface Session {
  page: Page;
  context: BrowserContext;
  /** Return to a known state by replaying its action path from the base URL. */
  gotoPath(path: Action[]): Promise<boolean>;
  /**
   * Open one address directly and report the status the document answered with,
   * or null if it never answered.
   *
   * The status has to come from the navigation itself rather than from watching
   * the network, because what matters is the status of the page that was landed
   * on. An address that redirects to a 404 answers 404 at a URL nobody asked
   * for, and matching error lines against the requested address would score that
   * as a page that exists.
   */
  gotoUrl(url: string): Promise<number | null>;
  close(): Promise<void>;
}

export async function openSession(baseUrl: string, config: WalkConfig): Promise<Session> {
  if (config.storageState && !existsSync(config.storageState)) {
    throw new Error(
      `no storage state at ${config.storageState} — create one by signing in once, ` +
        `then saving the session with Playwright's context.storageState({ path })`,
    );
  }
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({
    acceptDownloads: false,
    storageState: config.storageState,
  });
  const page = await context.newPage();

  // Autonomous walking must never hang on a modal or leak tabs.
  page.on('dialog', (d) => void d.dismiss().catch(() => {}));
  context.on('page', (p) => { if (p !== page) void p.close().catch(() => {}); });

  return {
    page,
    context,
    async gotoPath(path: Action[]): Promise<boolean> {
      // A path that begins with an address starts there instead of at the base
      // URL. That is how a state seeded from a route map is returned to: there
      // is no click path into it — that is the whole finding — so the address
      // is the only way back, and it has to survive into every later re-entry.
      const lead = path[0]?.kind === 'goto' ? path[0] : null;
      await page.goto(lead?.url ?? baseUrl, { waitUntil: 'domcontentloaded' });
      await settle(page, config.settleMs);
      for (const action of lead ? path.slice(1) : path) {
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
    },
    async gotoUrl(url: string): Promise<number | null> {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        await settle(page, config.settleMs);
        // A same-document navigation answers no response of its own. Nothing
        // failed, so it counts as served rather than as never answered.
        return response ? response.status() : 200;
      } catch {
        return null;
      }
    },
    close: () => browser.close(),
  };
}

/* ---------- deciding whether to act at all ---------- */

/** What the screening step concluded about a control, before any page work. */
export type Screening =
  | { verdict: 'act' }
  /** Not this control's own action — its value goes in when its form is submitted. */
  | { verdict: 'fold-into-form' }
  | { verdict: 'skip'; reason: SkippedElement['reason']; detail?: string };

/**
 * The refusals that can be decided from the recorded control alone.
 *
 * Kept separate from `attempt` because none of them need the browser to be
 * sitting on the page, and that is worth real time: a state whose every control
 * is skipped costs no re-entry at all.
 */
export function screen(
  el: ElementDescriptor,
  config: WalkConfig,
  baseUrl: string,
  /** Forms with a reachable submit button, so their fields can be folded in. */
  submittable: Set<string>,
): Screening {
  if (el.disabled) return { verdict: 'skip', reason: 'disabled' };
  if (isExternal(el, baseUrl)) {
    return { verdict: 'skip', reason: 'external', detail: el.href ?? undefined };
  }
  if (!config.allowDangerous && isDangerous(el)) {
    return {
      verdict: 'skip', reason: 'dangerous', detail: 'matched a destructive-action pattern',
    };
  }
  if (isTextEntry(el)) {
    // Not skipped — this field gets a value when its form is submitted, which
    // is the only context in which typing into it proves anything.
    if (config.fillForms && el.formId && submittable.has(el.formId)) {
      return { verdict: 'fold-into-form' };
    }
    return {
      verdict: 'skip',
      reason: 'needs-input',
      detail: el.inputType === 'password'
        ? 'a password field is never typed into'
        : 'a text field responds to typing, not to a click',
    };
  }
  return { verdict: 'act' };
}

/** Forms whose submit button is on screen, and whose fields therefore have an
 * action to belong to. A form with no submit in reach has none, so its fields
 * fall back to being skipped. */
export function submittableForms(elements: ElementDescriptor[]): Set<string> {
  return new Set(
    elements
      .filter((e) => e.formSubmit && e.formId && !e.disabled)
      .map((e) => e.formId as string),
  );
}

/* ---------- acting ---------- */

export interface AttemptResult {
  /** What the control did, when it was actually exercised. */
  edge?: { action: Action; outcome: Outcome };
  /**
   * The snapshot the outcome was measured against. Usually the source state,
   * but filling a form re-reads the page first, so it is not always — and
   * "did this action reach somewhere new" has to be asked of the same screen
   * the outcome was judged from.
   */
  from?: PageSnapshot;
  /** Why it was not, when it was not. */
  skip?: { reason: SkippedElement['reason']; detail?: string };
  /** Where the browser is now. null means that is no longer known. */
  at: PageSnapshot | null;
  /** A click or a selection actually happened, so it counts against the budget. */
  spent: boolean;
  /** The control was left unexercised, and not by our choice. */
  lost: boolean;
}

/**
 * Exercise one control, with the browser already sitting in its source state.
 *
 * Everything here needs the live page — the option list of a select, the
 * browser's own validity answer for a form, and of course the click itself.
 */
export async function attempt(
  page: Page,
  config: WalkConfig,
  el: ElementDescriptor,
  /** Every control in the source state. Form filling needs the siblings. */
  siblings: ElementDescriptor[],
  /** What the browser is showing right now. */
  before: PageSnapshot,
): Promise<AttemptResult> {
  const stay = (skip: AttemptResult['skip'], at: PageSnapshot | null = before): AttemptResult =>
    ({ skip, at, spent: false, lost: false });

  const target = await locate(page, el);
  if (!target) {
    return stay({
      reason: 'unreachable',
      detail: 'not on the page when the walk came back to this state',
    });
  }

  // A select answers to choosing an option, never to being clicked, so it needs
  // a different action or it is guaranteed to look dead. This has to come after
  // the state has been re-entered — the option list can only be read once the
  // browser is actually sitting on the page.
  let choice: OptionChoice | null = null;
  if (el.tag === 'select') {
    choice = await pickOption(page, target);
    if (!choice) {
      return stay({
        reason: 'needs-input',
        detail: 'no option available other than the one already chosen',
      });
    }
  }

  // Fill the whole form, then submit it, as one action. Typing into a single
  // field and stopping there proves nothing: the value is not part of the state
  // fingerprint, so a working field looks inert, and the walker returns to the
  // start before any submit could use what was typed. Opt-in, because a
  // submission that succeeds writes real data.
  let at: PageSnapshot = before;
  const filled: { label: string; value: string }[] = [];
  if (config.fillForms && el.formSubmit && el.formId) {
    const fields = siblings.filter(
      (f) =>
        f !== el && f.formId === el.formId && !f.disabled &&
        (isTextEntry(f) || f.tag === 'select'),
    );
    // One refusing field stops the whole form. Submitting it with that field
    // deliberately blank would test something nobody asked for.
    const refusal = fields.map(refusesFill).find((r) => r !== null);
    if (refusal) {
      return stay({
        reason: 'needs-input',
        detail: `${refusal} (${fields.length} field(s) left unfilled)`,
      });
    }

    let unfillable: string | null = null;
    for (const field of fields) {
      try {
        const fieldAt = await locate(page, field);
        if (!fieldAt) throw new Error('field not found');
        if (field.tag === 'select') {
          const opt = await pickFillOption(page, fieldAt);
          if (!opt) continue; // nothing to choose; leave it as it stands
          await resolve(page, fieldAt).selectOption(opt.value, { timeout: ACTION_TIMEOUT });
          filled.push({ label: field.selector.label, value: opt.label });
        } else {
          const value = synthesize(field);
          await resolve(page, fieldAt).fill(value, { timeout: ACTION_TIMEOUT });
          filled.push({ label: field.selector.label, value });
        }
      } catch {
        unfillable = field.selector.label;
        break;
      }
    }
    if (unfillable) {
      return stay({
        reason: 'needs-input',
        detail: `could not type into ${unfillable}, so the form was left alone`,
      });
    }
    // Re-read the page so the outcome measures the submit alone. An app with
    // live validation redraws while a field is being typed into, and that
    // redraw would otherwise be credited to the submit button.
    if (filled.length > 0) at = await captureState(page);
  }

  // Clicking the submit button of a form the browser will not accept tests
  // nothing: native validation refuses the submission and changes no DOM, so a
  // working control reads as dead. Left unhandled, every form with a required
  // field in every app is reported broken.
  if (el.formSubmit && !(await formWillSubmit(page, target))) {
    return stay(
      {
        reason: 'needs-input',
        detail: filled.length > 0
          ? `still invalid after filling ${filled.length} field(s) — it needs something ` +
            'that cannot be synthesized'
          : 'the form is not filled in, so the browser refuses to submit it',
      },
      at,
    );
  }

  // And the same refusal where the browser has no opinion to offer, because the
  // app grouped its fields with layout instead of a <form>. Without this the
  // cluster's button is clicked against empty fields — which is exactly the
  // check above, skipped for every app that does not use forms.
  if (el.formSubmit && el.formKind === 'cluster') {
    const fields = siblings.filter(
      (f) => f !== el && f.formId === el.formId && !f.disabled && isTextEntry(f),
    );
    if (fields.length > 0 && !(await clusterIsFilled(page, fields))) {
      return stay(
        {
          reason: 'needs-input',
          detail: filled.length > 0
            ? `still empty after filling ${filled.length} field(s)`
            : `${fields.length} field(s) beside it are empty, and these are not in a ` +
              'form, so nothing will say whether a click was declined or ignored',
        },
        at,
      );
    }
  }

  const action: Action = choice
    ? { kind: 'select', selector: target, role: el.role, name: el.name, value: choice.label }
    : filled.length > 0
      ? { kind: 'fill', selector: target, role: el.role, name: el.name, fill: filled }
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

  if (clickFailed) {
    return {
      skip: { reason: 'unreachable', detail: failure },
      at: null,
      spent: true,
      lost: true,
    };
  }

  // Asked before the state is captured, while the browser is still sitting on
  // the page the selection happened on.
  //
  // `consumable` is the second, independent half: something in the same form
  // that will submit it. Read from the siblings rather than from the select,
  // because a field never carries `formSubmit` itself — the control that submits
  // does. A form with no submit control in it is a form nothing can send, so
  // there is no later moment where the value could be proven to matter.
  const selection = choice
    ? {
        held: await selectionHeld(page, target, choice.value),
        consumable:
          el.formId !== null &&
          siblings.some((f) => f.formId === el.formId && f.formSubmit && !f.disabled),
      }
    : undefined;

  let after = await captureState(page);
  let outcome = classifyOutcome(at, after, observed, el, selection);

  // A control that looks hover-driven and did nothing when clicked has not been
  // tested yet — it has been tested the wrong way. Try hovering before calling
  // it dead; an entire dashboard of glossary terms reads as broken otherwise.
  if (outcome.kind === 'no-effect' && !outcome.benign && el.hoverAffordance) {
    const hoverWatch = new ActionWatch(page);
    try {
      // The pointer is still sitting on the element after the click, so hovering
      // it again fires no pointerenter. Move away first, or the probe silently
      // tests nothing.
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
    }
  }

  return { edge: { action, outcome }, from: at, at: after, spent: true, lost: false };
}

/* ---------- reading the finished run ---------- */

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
export function markAlreadyApplied(edges: UIEdge[]): void {
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
 * Does the entry page look like a login screen?
 *
 * A visible password field is the signal that stands on its own. The weaker
 * case — a sign-in control on a route named for authentication — is included
 * because passwordless and SSO front doors have no password field at all.
 *
 * This only ever adds a caveat to the report. Getting it wrong costs a sentence;
 * missing a login wall costs a clean run that covered nothing but the door.
 */
export function looksLikeAuthWall(url: string, elements: ElementDescriptor[]): boolean {
  if (elements.some((el) => el.inputType === 'password')) return true;
  const authRoute = /(^|\/)(login|signin|sign-in|auth|authenticate|sso)(\/|$|\?)/i.test(url);
  const signInControl = elements.some((el) =>
    /\b(sign|log)\s?in\b|\bcontinue with\b/i.test(el.name),
  );
  return authRoute && signInControl;
}

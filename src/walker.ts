import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  Action, ElementDescriptor, LoadHealth, Selector, SkippedElement, UIEdge, UIGraph, UINode,
  WalkConfig,
} from './types.js';
import { GRAPH_VERSION } from './types.js';
import { ActionWatch, captureState, classifyOutcome, resolve, type PageSnapshot } from './observer.js';
import { normalizeText } from './fingerprint.js';

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
};

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
  const log = onProgress ?? (() => {});

  const nodes: Record<string, UINode> = {};
  const edges: UIEdge[] = [];
  let load: LoadHealth = { consoleErrors: [], httpErrors: [], interactiveFound: 0 };
  const skipped: SkippedElement[] = [];
  let unwalked = 0;
  let limitHit: string | null = null;
  let actionsUsed = 0;

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
        await resolve(page, action.selector).click({ timeout: 5000 });
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

    while (frontier.length > 0) {
      const state = frontier.shift()!;
      if (expanded.has(state.nodeId)) continue;
      expanded.add(state.nodeId);

      const path = queuedPaths.get(state.nodeId) ?? [];
      log(`state ${state.fingerprint.route} (${state.elements.length} controls)`);

      /** Where the browser actually is right now, or null if unknown. */
      let atSnapshot: PageSnapshot | null = null;

      for (const el of state.elements) {
        if (actionsUsed >= config.maxActions) {
          limitHit = limitHit ?? `maxActions (${config.maxActions})`;
          unwalked++;
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

        // Re-enter the source state only when the browser is not already sitting
        // in it. Actions that change nothing — the common case — leave the page
        // exactly where the next action needs it, so the replay is skipped.
        // Compared on the fine structure tier, never the coarse identity tier:
        // reusing a page that merely *looks* like the source state would attribute
        // the next edge to the wrong place.
        if (!atSnapshot || atSnapshot.fingerprint.structure !== state.fingerprint.structure) {
          if (!(await gotoPath(path))) {
            unwalked++;
            atSnapshot = null;
            continue;
          }
          atSnapshot = await captureState(page);
        }

        // A select answers to choosing an option, never to being clicked, so it
        // needs a different action or it is guaranteed to look dead. This has to
        // come after the state has been re-entered above — the option list can
        // only be read once the browser is actually sitting on the page.
        let choice: OptionChoice | null = null;
        if (el.tag === 'select') {
          choice = await pickOption(page, el.selector);
          if (!choice) {
            skipped.push({
              nodeId: state.nodeId, label: el.selector.label,
              reason: 'needs-input',
              detail: 'no option available other than the one already chosen',
            });
            continue;
          }
        }

        const before = atSnapshot;
        const action: Action = choice
          ? {
              kind: 'select', selector: el.selector, role: el.role, name: el.name,
              value: choice.label,
            }
          : { kind: 'click', selector: el.selector, role: el.role, name: el.name };

        const watch = new ActionWatch(page);
        let clickFailed = false;
        try {
          if (choice) {
            await resolve(page, el.selector).selectOption(choice.value, { timeout: 5000 });
          } else {
            await resolve(page, el.selector).click({ timeout: 5000 });
          }
          await settle(page, config.settleMs);
        } catch {
          clickFailed = true;
        }
        const observed = watch.stop();
        actionsUsed++;

        if (clickFailed) {
          unwalked++;
          atSnapshot = null;
          skipped.push({
            nodeId: state.nodeId, label: el.selector.label,
            reason: 'budget', detail: 'element could not be clicked (not actionable within 5s)',
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
            await resolve(page, el.selector).hover({ timeout: 5000 });
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
          if (newPath.length < config.maxDepth) {
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
    await browser.close();
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
    },
  };
}

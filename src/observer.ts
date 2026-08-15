import { createHash } from 'node:crypto';
import type { Page, ConsoleMessage, Request, Response } from 'playwright';
import type { ElementDescriptor, NetworkCall, Outcome, Selector } from './types.js';
import { computeFingerprint, nodeId } from './fingerprint.js';

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  elements: ElementDescriptor[];
  nodeId: string;
  fingerprint: ReturnType<typeof computeFingerprint>;
  /** Hash of visible text. Only ever used to detect whether an action did anything. */
  contentHash: string;
  /**
   * Hash of scroll position and inline transforms — what moved without the page
   * reading differently. Same purpose as `contentHash`, and same restriction:
   * only ever used to decide whether an action did anything.
   */
  geometryHash: string;
}

/**
 * Runs in the browser. Enumerates every visible, enabled interactive control
 * and derives the most durable selector available for each.
 *
 * Selector priority is deliberate: test ids and stable ids survive redesigns,
 * role+name survives DOM restructuring, and a CSS path is the last resort we
 * record as fragile rather than silently trust.
 */
/* c8 ignore start — executes in page context, not under node coverage */
function extractPageData() {
  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="switch"]', '[onclick]',
  ].join(', ');

  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy'];

  function isVisible(el: any): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
      return false;
    }
    // A control the app has hidden from the accessibility tree is not available
    // to anyone — this is how a well-built modal says that nothing behind it can
    // be reached. Without this, an open dialog leaves the whole page underneath
    // it enumerated as clickable, and every one of those controls comes back
    // covered by the dialog's own backdrop.
    return !el.closest('[aria-hidden="true"], [inert]');
  }

  function accessibleName(el: any): string {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id: string) => document.getElementById(id)?.textContent ?? '')
        .join(' ').trim();
      if (text) return text;
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.textContent?.trim()) return label.textContent.trim();
      }
      const wrapping = el.closest('label');
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
      if (el.placeholder?.trim()) return el.placeholder.trim();
      if (el.type === 'submit' && el.value) return String(el.value).trim();
    }

    const title = el.getAttribute('title');
    if (title?.trim()) return title.trim();

    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 100);

    const alt = el.querySelector('img[alt]')?.getAttribute('alt');
    return alt?.trim() ?? '';
  }

  function roleOf(el: any): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return 'generic';
  }

  /** React/Radix-style generated ids change every render — never anchor to them. */
  function isStableId(id: string): boolean {
    if (!id) return false;
    if (id.startsWith(':r') || id.startsWith('radix-') || id.startsWith('headlessui-')) return false;
    if (/\d{6,}/.test(id)) return false;
    return true;
  }

  /**
   * The form a control belongs to. `el.form` covers fields moved out of their
   * form with the `form` attribute; `closest` covers everything else, including
   * the div-with-a-role controls that have no `form` property at all.
   */
  function formOf(el: any): any {
    return el.form ?? el.closest('form');
  }

  /**
   * How far above a field to look for the button that submits it. Six levels of
   * wrapper divs covers the styling layers a component library puts between a
   * label and its card; past that the ancestor is the page, and everything on
   * the page is "in reach" of everything else.
   */
  const CLUSTER_DEPTH = 6;

  /** Takes typing or choosing, rather than clicking. Mirrors `isTextEntry`. */
  function isFieldLike(el: any): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    return !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'range', 'color']
      .includes((el.getAttribute('type') || 'text').toLowerCase());
  }

  /**
   * Could be the thing that submits a cluster. Links are deliberately not here:
   * a "Forgot your password?" beside a login box is not competing to be the
   * submit, and counting it would refuse every cluster worth finding.
   */
  function isPressLike(el: any): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return true;
    if (tag === 'input') {
      return ['submit', 'button', 'image', 'reset']
        .includes((el.getAttribute('type') || '').toLowerCase());
    }
    return el.getAttribute('role') === 'button';
  }

  /**
   * Says it is the current item with a class name instead of with ARIA.
   *
   * App Atlas's breadcrumb for the page you are already on is
   * `class="crumb is-current"` with no `aria-current` anywhere, so it read as a
   * dead control — clicking the crumb for where you already are correctly does
   * nothing, and every one of the existing rules missed it: no ARIA to read, not
   * a link so there is no href to compare, and the walk arrived by a different
   * control so it was never "already applied".
   *
   * A class name is a far weaker signal than an ARIA attribute. It is the app's
   * private vocabulary, and `active` sitting on a genuinely broken button would
   * excuse the bug — the exact false negative this project trades away findings
   * to avoid. So the class is never enough on its own: the control must also
   * name the place the browser is already at. Two independent signals agreeing
   * is what makes it safe to act on; either one alone is a guess.
   */
  function marksItselfCurrent(el: any, name: string): boolean {
    const tokens: string[] = el.classList ? Array.from(el.classList) : [];
    const flagged = tokens.some((c) => /(^|-)(current|active|selected)$/.test(c.toLowerCase()));
    if (!flagged) return false;
    // Compared as slugs, because a breadcrumb reads "Q3 report" while the URL
    // it names says `/reports/q3-report`. Requiring the label verbatim would
    // only ever match apps whose routes are already written in prose.
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const label = slug(name);
    // Short names match everything. "Map" turns up in half the URLs on the web.
    if (label.length < 3) return false;
    let here = location.href;
    try {
      here = decodeURIComponent(here);
    } catch {
      /* a malformed escape is not worth failing over — compare what we have */
    }
    return slug(here).includes(label);
  }

  /** The control that submits its form — a bare `<button>` defaults to submit. */
  function isSubmitControl(el: any): boolean {
    if (!formOf(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    if (tag === 'input') {
      return ['submit', 'image'].includes((el.getAttribute('type') || '').toLowerCase());
    }
    return false;
  }

  /**
   * A structural path to the element, for when nothing more durable exists.
   *
   * It has to be anchored honestly. The old version stopped after eight levels
   * and prefixed `body >` anyway, which describes an element that is not there:
   * every lookup through such a path silently matches nothing. On a real
   * dashboard that was a third of the deep controls, each one costing a
   * five-second timeout before being written off as unclickable.
   */
  function cssPath(el: any): string | null {
    const parts: string[] = [];
    let cur: any = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      if (cur.id && isStableId(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        return parts.join(' > ');
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c: any) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      // A path this long is not worth trusting. No path beats a wrong one.
      if (parts.length > 40) return null;
    }
    return parts.length && cur === document.body ? `body > ${parts.join(' > ')}` : null;
  }

  const all = Array.from(document.querySelectorAll(INTERACTIVE)).filter(isVisible);
  // Position in the page is enough of an identifier: grouping only has to hold
  // within one snapshot, and a form rarely carries a stable id of its own.
  const forms = Array.from(document.querySelectorAll('form'));

  /**
   * The grouping the app never wrote down.
   *
   * Plenty of real apps put some inputs and a button on the page with no
   * `<form>` anywhere and wire the button to a handler. Nothing in that DOM says
   * which fields belong to which button, so the grouping has to be inferred —
   * and the inference is only worth making where being wrong does not cost
   * anything. Typing into fields that do not belong together is worse than not
   * typing at all, so a field joins a cluster only when exactly one button is in
   * reach of it. Two, and which one it is for is a guess; none, and there is
   * nothing to submit with. Either way the field stays skipped, as it is today.
   *
   * Anchored from the fields rather than the buttons because there are far fewer
   * of them, and because on most screens there are none at all — which makes
   * this cost nothing on the screens that do not need it.
   */
  const clusterId = new Map<any, string>();
  {
    const bareFields = all.filter((el: any) => !formOf(el) && isFieldLike(el));
    if (bareFields.length > 0) {
      const barePresses = all.filter((el: any) => !formOf(el) && isPressLike(el));
      const members = new Map<any, any[]>();
      for (const field of bareFields) {
        let node: any = field.parentElement;
        for (let depth = 0; node && depth < CLUSTER_DEPTH; depth++, node = node.parentElement) {
          const reach = barePresses.filter((b: any) => node.contains(b));
          if (reach.length === 0) continue;
          // More than one, and this field's submit is a guess. Stop climbing:
          // a wider ancestor only ever has more buttons in it, not fewer.
          if (reach.length > 1) break;
          members.set(reach[0], [...(members.get(reach[0]) ?? []), field]);
          break;
        }
      }
      let n = 0;
      for (const [button, fields] of members) {
        const id = `cluster-${n++}`;
        clusterId.set(button, id);
        for (const field of fields) clusterId.set(field, id);
      }
    }
  }

  // Count duplicates up front so we only claim a selector is unique when it is.
  const roleNameCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  for (const el of all) {
    const key = `${roleOf(el)}|${accessibleName(el)}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) ?? 0) + 1);
    const text = (el as any).innerText?.trim();
    if (text) textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
  }

  const elements = all.map((el: any) => {
    const role = roleOf(el);
    const name = accessibleName(el);
    const tag = el.tagName.toLowerCase();

    let selector: { strategy: string; value: string; label: string };
    const label = name ? `${role} "${name}"` : `${role} <${tag}>`;

    let testid: string | null = null;
    let testidAttr = '';
    for (const attr of TESTID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) { testid = v; testidAttr = attr; break; }
    }

    // Checked here so a path that matches two elements — or none — is never
    // handed on as though it identified one.
    let css: string | null = cssPath(el);
    if (css) {
      try {
        if (document.querySelectorAll(css).length !== 1) css = null;
      } catch {
        css = null;
      }
    }

    if (testid && document.querySelectorAll(`[${testidAttr}="${CSS.escape(testid)}"]`).length === 1) {
      selector = { strategy: 'testid', value: `[${testidAttr}="${testid}"]`, label };
    } else if (el.id && isStableId(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      selector = { strategy: 'id', value: `#${el.id}`, label };
    } else if (name && roleNameCounts.get(`${role}|${name}`) === 1) {
      selector = { strategy: 'role-name', value: `${role}|${name}`, label };
    } else if (el.innerText?.trim() && textCounts.get(el.innerText.trim()) === 1) {
      selector = { strategy: 'text', value: el.innerText.trim(), label };
    } else if (css) {
      selector = { strategy: 'css', value: css, label };
    } else {
      // Nothing unique is left. Recorded anyway rather than dropped, so the
      // control shows up as something that could not be pinned down.
      selector = { strategy: 'role-name', value: `${role}|${name}`, label };
    }

    return {
      selector,
      role,
      name,
      tag,
      href: el.getAttribute('href'),
      // The raw input type, kept because role flattens the ones that matter:
      // password identifies a login wall, and the rest decide what a future
      // walker would be allowed to type into a field.
      inputType: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
      formId:
        forms.indexOf(formOf(el)) >= 0
          ? `form-${forms.indexOf(formOf(el))}`
          : (clusterId.get(el) ?? null),
      formKind: formOf(el) ? 'form' : clusterId.has(el) ? 'cluster' : null,
      // A second way to reach the same element, for when the first one stops
      // working. Never stored in the graph — it exists only within a run.
      fallback: css,
      // A cluster's button is its submit by construction: it is the one button
      // its fields could belong to, which is the whole reason the cluster formed.
      formSubmit: isSubmitControl(el) || (clusterId.has(el) && isPressLike(el)),
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      // Already the active tab / current page. Clicking it is expected to do
      // nothing, so a no-effect result here is not a defect.
      selected:
        el.getAttribute('aria-selected') === 'true' ||
        (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') ||
        marksItselfCurrent(el, name),
      // Looks like it responds to hover rather than click — a glossary term, a
      // tooltip trigger. Clicking these does nothing by design, so a click-only
      // walker would report a whole dashboard of them as dead controls.
      hoverAffordance:
        window.getComputedStyle(el).cursor === 'help' ||
        el.hasAttribute('title') ||
        el.hasAttribute('aria-describedby'),
    };
  });

  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Visible text, used only to decide whether a click had any effect. Digits are
  // kept deliberately: a click that only changes a displayed number DID do
  // something, and calling that control dead is the costlier mistake.
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();

  // What a click can change without changing a word on the page.
  //
  // A canvas that pans or zooms rewrites one CSS transform and nothing else: no
  // text enters or leaves the page and no control appears or disappears, so a
  // fingerprint built from text and controls sees an identical page and the
  // button that moved it reads as dead. Three working buttons on App Atlas's
  // React Flow graph — Zoom In, Zoom Out, Fit View — were reported exactly that
  // way, and confirmed working by hand.
  //
  // Deliberately narrow, in both directions. Reading computed styles for every
  // element would cost a full style resolution on every snapshot; inline
  // transforms are how JS-driven pan and zoom is actually implemented (React
  // Flow, d3-zoom, and the libraries built on them assign style.transform
  // directly), and an attribute selector finds them without touching the style
  // engine. Element rectangles are deliberately *not* included: they move for
  // reasons that have nothing to do with the click — late layout, an animation
  // that outlasts the settle — and every one of those would hide a genuinely
  // dead control behind a "something moved".
  const geometry = [
    `scroll:${Math.round(window.scrollX)},${Math.round(window.scrollY)}`,
    ...Array.from(document.querySelectorAll('[style*="transform"]'))
      .slice(0, 200)
      .map((el: any, i: number) => `${i}:${el.style?.transform ?? ''}`),
  ].join('|');

  return { title: document.title, headings, elements, text, geometry };
}
/* c8 ignore stop */

export async function captureState(page: Page): Promise<PageSnapshot> {
  const data = await page.evaluate(extractPageData);
  const url = page.url();
  const elements = data.elements as unknown as ElementDescriptor[];
  const fingerprint = computeFingerprint(url, data.headings, elements);
  return {
    url,
    title: data.title,
    headings: data.headings,
    elements,
    fingerprint,
    nodeId: nodeId(fingerprint),
    contentHash: createHash('sha256').update(data.text).digest('hex').slice(0, 12),
    geometryHash: createHash('sha256').update(data.geometry).digest('hex').slice(0, 12),
  };
}

/** Turn a recorded selector back into a live Playwright locator. */
export function resolve(page: Page, selector: Selector) {
  switch (selector.strategy) {
    case 'testid':
    case 'id':
    case 'css':
      return page.locator(selector.value).first();
    case 'role-name': {
      const [role, ...rest] = selector.value.split('|');
      return page.getByRole(role as any, { name: rest.join('|'), exact: true }).first();
    }
    case 'text':
      return page.getByText(selector.value, { exact: true }).first();
  }
}

/** Collects everything that happens during a single action. */
export class ActionWatch {
  private network: NetworkCall[] = [];
  private consoleErrors: string[] = [];
  private httpErrors: string[] = [];
  private statuses = new Map<string, number>();

  private onRequest = (req: Request) => {
    const type = req.resourceType();
    if (type === 'xhr' || type === 'fetch' || type === 'document') {
      this.network.push({ method: req.method(), url: req.url(), status: null });
    }
  };

  private onResponse = (res: Response) => {
    this.statuses.set(res.url(), res.status());
    if (res.status() >= 400) {
      const type = res.request().resourceType();
      if (type === 'xhr' || type === 'fetch' || type === 'document') {
        this.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    }
  };

  private onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Resource-load failures are already captured, with their status and URL,
    // in httpErrors. Keeping the console copy double-counts one failure and
    // hides the real JavaScript errors among the duplicates.
    if (/Failed to load resource/i.test(text)) return;
    this.consoleErrors.push(text.slice(0, 200));
  };

  private onPageError = (err: Error) => {
    this.consoleErrors.push(`uncaught: ${err.message.slice(0, 200)}`);
  };

  constructor(private page: Page) {
    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
  }

  stop() {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('console', this.onConsole);
    this.page.off('pageerror', this.onPageError);
    for (const call of this.network) {
      call.status = this.statuses.get(call.url) ?? null;
    }
    return {
      network: this.network,
      consoleErrors: this.consoleErrors,
      httpErrors: this.httpErrors,
    };
  }
}

export function classifyOutcome(
  before: PageSnapshot,
  after: PageSnapshot,
  watch: { network: NetworkCall[]; consoleErrors: string[]; httpErrors: string[] },
  /** The control that was clicked, when known — used to recognize self-links. */
  element?: ElementDescriptor,
): Outcome {
  const base: Omit<Outcome, 'kind'> = {
    urlBefore: before.url,
    urlAfter: after.url,
    network: watch.network,
    consoleErrors: watch.consoleErrors,
    httpErrors: watch.httpErrors,
  };

  // Not every failed request is a defect, and treating them alike buries the
  // real ones. A 5xx or an uncaught exception is a problem no matter what the
  // UI did. A 4xx often is not: apps legitimately use 404 to mean "this
  // optional thing does not exist", handle it, and carry on.
  const serverErrors = watch.httpErrors.filter((e) => /^5\d\d /.test(e));
  const clientErrors = watch.httpErrors.filter((e) => /^4\d\d /.test(e));

  if (serverErrors.length > 0 || watch.consoleErrors.length > 0) {
    return { ...base, kind: 'error', note: serverErrors[0] ?? watch.consoleErrors[0] };
  }

  // A 4xx alongside a visible response means the app handled it. Record the
  // request in the outcome, but judge the interaction by what the user saw.
  const handled = clientErrors.length > 0
    ? { note: `handled a failed request: ${clientErrors[0]}` }
    : {};

  if (before.url !== after.url) return { ...base, ...handled, kind: 'navigated' };

  // Compare the FINE tier here, never the node id.
  //
  // Node id is deliberately coarse (route + headings) so a page can gain a
  // button without becoming a different screen. Using it to decide whether a
  // click did anything reports every panel that opens without changing a
  // heading as a dead control — which is exactly what it did on a real
  // dashboard before this was fixed.
  if (
    before.fingerprint.structure !== after.fingerprint.structure ||
    before.contentHash !== after.contentHash
  ) {
    return { ...base, ...handled, kind: 'state-changed' };
  }

  // Nothing the page says changed, but something about where it sits did. Below
  // the content check on purpose: a click that changes what the page reads is a
  // state change whether or not it also moved something, and this must never be
  // the answer where the stronger one applies.
  if (before.geometryHash !== after.geometryHash) {
    return {
      ...base,
      ...handled,
      kind: 'visual-only',
      note: 'the view moved — scrolled, panned or zoomed — with no change to content',
    };
  }

  // A request failed and the user saw nothing happen. That silent failure is a
  // real defect, and it is the one case where a 4xx alone is worth reporting.
  if (clientErrors.length > 0) {
    return {
      ...base,
      kind: 'error',
      note: `${clientErrors[0]} — and nothing visible changed`,
    };
  }
  if (watch.network.length > 0) {
    return {
      ...base,
      kind: 'network-only',
      note: 'fired a request but the visible state did not change',
    };
  }

  // Clicking the tab you are already on is correct behavior, not a dead control.
  if (element?.selected) {
    return {
      ...base,
      kind: 'no-effect',
      benign: true,
      note: 'control is already the selected tab or current page',
    };
  }

  // A link to the page you are already on doing nothing is correct behavior,
  // not a dead control. Record it, but keep it out of the findings list.
  if (element?.href) {
    try {
      if (new URL(element.href, before.url).href === new URL(before.url).href) {
        return {
          ...base,
          kind: 'no-effect',
          benign: true,
          note: 'link points at the page it is already on',
        };
      }
    } catch {
      /* unparseable href — fall through to the normal report */
    }
  }

  return {
    ...base,
    kind: 'no-effect',
    note: 'no navigation, no state change, no network traffic',
  };
}

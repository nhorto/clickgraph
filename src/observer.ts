import { createHash } from 'node:crypto';
import type { BrowserContext, Page, ConsoleMessage, Dialog, Request, Response } from 'playwright';
import type { ElementDescriptor, NetworkCall, Outcome, Selector } from './types.js';
import { computeFingerprint, nodeId } from './fingerprint.js';
import { beginInjectedCapture, drainInjectedCapture, isInjected } from './fault.js';

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  elements: ElementDescriptor[];
  nodeId: string;
  fingerprint: ReturnType<typeof computeFingerprint>;
  /**
   * Hash of visible text, digits and all. Only ever used to detect whether an
   * action did anything — never compared against another run.
   *
   * Not to be confused with `fingerprint.content`, which is the normalised,
   * persisted, baseline-comparable one (issue #48). Two hashes of the same
   * string answering two different questions, and the difference is digits: a
   * click that moves a counter IS an effect, and a counter that has moved
   * since Tuesday is NOT a change anyone made.
   */
  contentHash: string;
  /**
   * Hash of geometry and colour. Also only ever used to detect whether an action
   * did anything — never part of state identity, which stays coarse on purpose.
   *
   * Without it a purely visual control — zoom, pan, a theme toggle — is
   * indistinguishable from one wired to nothing (issue #1).
   */
  visualHash: string;
  /**
   * Hash of form-control VALUE state: each select's chosen option, each
   * checkbox's checked bit. Effect detection only, never identity — same
   * standing as the two hashes above.
   *
   * A framework that controls its inputs sets the `value` property, not an
   * attribute, so a MutationObserver sees nothing and the chosen option is
   * invisible to both other signals: a working select read as a dead control
   * (issue #5). Text values stay out on purpose — typing is exercised through
   * form submission, and a keystroke-by-keystroke hash would make every field
   * look like an effect.
   */
  formStateHash: string;
  /**
   * Hash of the class attributes carried by everything that is not itself a
   * control. Effect detection only, never identity — the same standing as the
   * three hashes above.
   *
   * The other signals are structural, textual and geometric, and a class flip
   * on a plain element is none of those. A masked PIN entry moves a dot from
   * `pin-dot` to `pin-dot filled`: no text, no attribute the element list
   * carries, no rectangle — so all eleven keys of a working keypad came back
   * as dead controls (issue #26). The family is wider than the keypad: step
   * indicators, progress bars, an active-tab underline drawn on a div, the
   * selected highlight on a custom list item.
   */
  classHash: string;
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
      // Read for the same reason as `type`, and separately: an app may set
      // either, both, or neither, and `inputmode` is the one a touch-first app
      // reaches for.
      inputMode: (el.getAttribute('inputmode') || '').toLowerCase() || null,
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
        (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false'),
      // Looks like it responds to hover rather than click — a glossary term, a
      // tooltip trigger. Clicking these does nothing by design, so a click-only
      // walker would report a whole dashboard of them as dead controls.
      hoverAffordance:
        window.getComputedStyle(el).cursor === 'help' ||
        el.hasAttribute('title') ||
        el.hasAttribute('aria-describedby'),
    };
  });

  // Filtered like every other reader in this function, and for a sharper reason
  // than consistency: these headings are what state identity is built from, and
  // markup the user cannot see has no business deciding which screen they are
  // on. An SPA that keeps all its screens mounted and shows one at a time — a
  // wizard, a tabbed settings page, a kiosk flow — handed every screen the same
  // heading list, so identity barely moved as the walk moved. The screens
  // collapsed into a single node, the walker stopped expanding because it
  // believed it had been there, and the run still exited 0 over an app it never
  // got through (issue #25). The landmarks it reported named only hidden
  // screens: five anchors, not one of them on the page.
  //
  // A screen with no visible heading falls back to route-only identity, and
  // that is left standing on purpose. Two heading-less screens on one route
  // still collapse — but they collapsed before this too, and the only
  // tie-breakers on offer are the control list and the body text, which
  // `structure` already carries precisely because they move whenever anyone
  // edits the UI. Promoting either into identity would trade a quiet
  // under-split for a graph that orphans itself every commit, which is the
  // costlier failure and the one README argues against.
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter(isVisible)
    .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // Visible text, used only to decide whether a click had any effect. Digits are
  // kept deliberately: a click that only changes a displayed number DID do
  // something, and calling that control dead is the costlier mistake.
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();

  // Geometry and colour, for the effects the two signals above cannot see.
  //
  // Everything else captured here is structural or textual, so a control whose
  // whole job is visual came back indistinguishable from one wired to nothing:
  // a diagram's Zoom In moved the viewport transform from scale(0.34) to
  // scale(0.408) and changed not one character of innerText (issue #1). A
  // light/dark toggle is the same shape and much more common.
  //
  // Rounded to 2px on purpose. The point is to catch a zoom, a pan, a collapse
  // — changes of tens or hundreds of pixels — while staying deaf to sub-pixel
  // reflow and to the tail of an animation that has not quite stopped. Being
  // too sensitive here is the more expensive mistake in both directions: it
  // reports dead controls as working, which does not merely add noise, it
  // deletes the findings this tool exists to produce.
  //
  // Colour is read off `body` only, not per element. A theme switch changes it
  // there whether it works by swapping a class or by moving a CSS variable on
  // :root, and one read cannot drift the way a sampled set can.
  const round = (n: number) => Math.round(n / 2) * 2;
  const bodyStyle = window.getComputedStyle(document.body);

  // Transforms are read separately from the controls' own geometry, and the
  // first version of this was wrong for want of that distinction. It sampled
  // only the interactive elements — but a diagram zooms by transforming the
  // container its nodes live in, while the Zoom In button sits in a panel
  // outside that container and does not move a pixel. The measurement covered
  // exactly the geometry that stays still, and changed nothing at all.
  //
  // A transform is how the whole web moves things without touching layout:
  // canvas zoom and pan, drawers, carousels, drag. Reading them wherever they
  // are declared catches the family, not one library's spelling of it.
  const transforms = Array.from(document.querySelectorAll('[style*="transform"]'))
    .map((el: any) => el.style.transform)
    .filter(Boolean);

  const visual = [
    document.documentElement.className,
    document.body.className,
    bodyStyle.backgroundColor,
    bodyStyle.color,
    ...transforms,
    ...Array.from(document.querySelectorAll(INTERACTIVE))
      .filter(isVisible)
      .map((el: any) => {
        const r = el.getBoundingClientRect();
        return `${round(r.x)},${round(r.y)},${round(r.width)},${round(r.height)}`;
      }),
  ].join('|');

  // Form-control value state, read off the PROPERTIES. A controlled select
  // holds its choice in `value`/`selectedIndex` with no attribute ever
  // changing, so this is the only signal that can see the chosen option
  // (issue #5). Keyed by position: like form grouping, it only has to hold
  // within one snapshot.
  const formState = [
    ...Array.from(document.querySelectorAll('select'))
      .filter(isVisible)
      .map((el: any, i: number) => `s${i}:${el.selectedIndex}:${el.value}`),
    ...Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'))
      .filter(isVisible)
      .map((el: any, i: number) => `c${i}:${el.checked ? 1 : 0}`),
  ].join('|');

  // Class attributes, for the effects that are neither text, nor structure, nor
  // geometry. A masked PIN keypad is the sharpest case — the dots are divs, and
  // a keypress only adds `filled` to one of them (issue #26) — but any state a
  // page draws by flipping a class on something that is not a control lands
  // here: a step rail, a progress bar, a tab underline on a div.
  //
  // Scope: every element carrying a class, minus the controls themselves. The
  // narrower scope the issue also offered — the nearest common container of the
  // visible controls — is both more work and less safe, because it is derived
  // from where the CONTROLS are while the elements this signal exists to see
  // are by definition not controls. A mask sitting above a keypad, or a step
  // rail beside a wizard's buttons, can fall outside the very box drawn to
  // contain them, and a signal that can silently exclude the thing it is
  // looking for is worse than none.
  //
  // Dropping the controls is what keeps this from crying wolf, and it is the
  // whole of the noise budget. A click puts the pointer and the focus ring on
  // its target, and component libraries mirror both into class names —
  // `is-hovered`, `is-focused`, `focus-visible` — so a sample that included
  // them would report an effect for every click ever made. That is the
  // expensive direction: it does not add noise, it deletes findings. Excluding
  // controls removes that entire family without a blocklist of framework
  // spellings, and costs only the control that flips a class on ITSELF and on
  // nothing else, which is a quiet miss and the trade this project always
  // takes. Animation classes are already covered by the settle window, which
  // waits for attribute mutations to stop before either snapshot is taken.
  //
  // Tokens are sorted so a framework that re-adds the same classes in a
  // different order does not read as a change. `className` is only a string on
  // HTML elements — on SVG it is an SVGAnimatedString — so the attribute is
  // read directly rather than trusted to be one.
  const controls = new Set(Array.from(document.querySelectorAll(INTERACTIVE)));
  const classes = Array.from(document.querySelectorAll('[class]'))
    .filter((el) => !controls.has(el))
    .map((el) =>
      (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).sort().join(' '),
    )
    .join('|');

  return { title: document.title, headings, elements, text, visual, formState, classes };
}
/* c8 ignore stop */

export async function captureState(page: Page): Promise<PageSnapshot> {
  const data = await page.evaluate(extractPageData);
  const url = page.url();
  const elements = data.elements as unknown as ElementDescriptor[];
  const fingerprint = computeFingerprint(url, data.headings, elements, data.text);
  return {
    url,
    title: data.title,
    headings: data.headings,
    elements,
    fingerprint,
    nodeId: nodeId(fingerprint),
    contentHash: createHash('sha256').update(data.text).digest('hex').slice(0, 12),
    visualHash: createHash('sha256').update(data.visual).digest('hex').slice(0, 12),
    formStateHash: createHash('sha256').update(data.formState).digest('hex').slice(0, 12),
    classHash: createHash('sha256').update(data.classes).digest('hex').slice(0, 12),
  };
}

/**
 * Where the page and each of its scrollable regions are scrolled to.
 *
 * Read on its own rather than folded into `captureState`, because unlike every
 * other signal this one is not a property of the state: the walk moves the page
 * itself to reach a control, so a scroll offset only means something when both
 * readings are taken around the action alone (issue #22). The walker owns that
 * pairing, so the reading has to be something it can ask for by name.
 */
export interface ScrollReading {
  x: number;
  y: number;
  /** One entry per element that can scroll, in document order. */
  panes: { key: string; top: number; left: number }[];
}

export async function readScrollPositions(page: Page): Promise<ScrollReading | null> {
  try {
    return await page.evaluate(() => {
      // Overflow is checked before the computed style so the expensive call is
      // made only for the handful of elements that could possibly scroll: the
      // dimension reads flush layout once and are then answered from cache,
      // while getComputedStyle on every node of a large app is not free.
      const scrollable = (v: string) => v === 'auto' || v === 'scroll' || v === 'overlay';
      const panes: { key: string; top: number; left: number }[] = [];
      for (const el of Array.from(document.querySelectorAll('*')) as any[]) {
        const overflowsY = el.scrollHeight > el.clientHeight + 1;
        const overflowsX = el.scrollWidth > el.clientWidth + 1;
        if (!overflowsY && !overflowsX) continue;
        const style = window.getComputedStyle(el);
        if (!(overflowsY && scrollable(style.overflowY)) &&
            !(overflowsX && scrollable(style.overflowX))) continue;
        // Keyed by position and tag, the way form state and transforms are:
        // identity only has to hold between two readings taken seconds apart.
        // The class attribute is deliberately not part of the key — a page that
        // flips a class on its scroller would otherwise lose the pane's
        // identity and, with it, the reading.
        panes.push({
          key: `${panes.length}:${el.tagName}${el.id ? `#${el.id}` : ''}`,
          top: Math.round(el.scrollTop),
          left: Math.round(el.scrollLeft),
        });
      }
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), panes };
    });
  } catch {
    // The page navigated out from under the read. Not knowing is reported as
    // not knowing; see compareScroll.
    return null;
  }
}

/**
 * How far a scroll offset has to move before it counts.
 *
 * The walk brings a control into view with Playwright's own scroll before it
 * takes the baseline, and the click's scroll then finds nothing left to do — so
 * in principle the residue is zero. In practice a sticky header, a
 * `scroll-margin` or a sub-pixel device ratio can leave a pixel or two behind,
 * and every effect this signal exists to catch — back to top, a jump link, a
 * carousel arrow — moves hundreds. A few pixels of slack costs nothing real and
 * removes the one way this could report a dead control as working.
 */
const SCROLL_TOLERANCE = 4;

export type ScrollChange = 'same' | 'page' | 'region' | 'unknown';

/**
 * `unknown` is not `same`. A missing reading, or a set of scrollers that has
 * itself changed between the two, means the comparison cannot be trusted —
 * and both callers want the cautious reading of that: the walker re-takes its
 * baseline, and `classifyOutcome` claims no effect it cannot prove.
 */
export function compareScroll(
  before: ScrollReading | null,
  after: ScrollReading | null,
): ScrollChange {
  if (!before || !after) return 'unknown';
  const moved = (a: number, b: number) => Math.abs(a - b) > SCROLL_TOLERANCE;
  if (moved(before.x, after.x) || moved(before.y, after.y)) return 'page';
  if (before.panes.length !== after.panes.length) return 'unknown';
  let region = false;
  for (let i = 0; i < before.panes.length; i++) {
    const a = before.panes[i];
    const b = after.panes[i];
    if (a.key !== b.key) return 'unknown';
    if (moved(a.top, b.top) || moved(a.left, b.left)) region = true;
  }
  return region ? 'region' : 'same';
}

/**
 * Effects that live in browser chrome, not in the page (issue #9).
 *
 * A button wired to `window.print()` has no page-side footprint at all: no
 * DOM change, no navigation, no network. No richer snapshot can see it — the
 * only way is to be told, so a shim installed before any page script runs
 * reports the invocation out through a context binding. The shim swallows
 * `print` rather than forwarding it: a real print dialog would hang an
 * autonomous walk the same way an un-dismissed `alert` would.
 */
const chromeEffectSink = new WeakMap<Page, string[]>();

export async function instrumentChromeEffects(context: BrowserContext): Promise<void> {
  await context.exposeBinding('__clickgraphChromeEffect', ({ page }, effect: unknown) => {
    if (typeof effect === 'string') chromeEffectSink.get(page)?.push(effect);
  });
  await context.addInitScript(() => {
    const report = (effect: string) => {
      void (window as any).__clickgraphChromeEffect?.(effect);
    };
    window.print = () => report('window.print()');
    // Clipboard writes still happen — a copy button that also updates its own
    // label ("Copied!") should keep doing so — but headless contexts may
    // refuse them, and a refused copy is still a wired control.
    const clipboard = navigator.clipboard;
    if (clipboard) {
      const originalWrite = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text: string) => {
        report('clipboard write');
        return originalWrite(text).catch(() => undefined);
      };
    }
  });
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
  private dialogs: { type: string; message: string }[] = [];

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

  private onDialog = (dialog: Dialog) => {
    this.dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 200) });
  };

  constructor(private page: Page) {
    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
    page.on('dialog', this.onDialog);
    // A fresh sink per action: whatever the shims report between here and
    // stop() belongs to this action alone.
    chromeEffectSink.set(page, []);
    beginInjectedCapture(page);
  }

  stop() {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('console', this.onConsole);
    this.page.off('pageerror', this.onPageError);
    this.page.off('dialog', this.onDialog);
    for (const call of this.network) {
      call.status = this.statuses.get(call.url) ?? null;
    }
    const chromeEffects = chromeEffectSink.get(this.page) ?? [];
    chromeEffectSink.delete(this.page);
    return {
      network: this.network,
      consoleErrors: this.consoleErrors,
      httpErrors: this.httpErrors,
      injectedFailures: drainInjectedCapture(this.page),
      chromeEffects,
      dialogs: this.dialogs,
    };
  }
}

export function classifyOutcome(
  before: PageSnapshot,
  after: PageSnapshot,
  watch: {
    network: NetworkCall[];
    consoleErrors: string[];
    httpErrors: string[];
    injectedFailures?: string[];
    chromeEffects?: string[];
    dialogs?: { type: string; message: string }[];
    /**
     * What moved between the moment the click was about to land and the moment
     * it had. Supplied by the walker rather than read off the two snapshots,
     * because only the walker knows which scrolling was the app's and which was
     * its own (issue #22).
     */
    scrolled?: ScrollChange;
  },
  /** The control that was clicked, when known — used to recognize self-links. */
  element?: ElementDescriptor,
): Outcome {
  const injected = watch.injectedFailures ?? [];
  const base: Omit<Outcome, 'kind'> = {
    urlBefore: before.url,
    urlAfter: after.url,
    network: watch.network,
    consoleErrors: watch.consoleErrors,
    httpErrors: watch.httpErrors,
    ...(injected.length > 0 ? { injectedFailures: injected } : {}),
  };

  // A failure the walk caused is not evidence about the app (issue #15). What
  // it is evidence about is the app's RESPONSE, so an injected failure takes
  // the same route a 4xx does below: judged by what the user saw, not by the
  // status. Classifying it as an error instead would condemn every screen in a
  // fault walk, including the ones handling it correctly.
  const organic = watch.httpErrors.filter((e) => !isInjected(e, injected));
  // A dropped connection surfaces as a console error with no status, so the
  // console has to be filtered by the same test or `offline` mode reports every
  // correctly-handled failure as an uncaught defect.
  const organicConsole = injected.length === 0
    ? watch.consoleErrors
    : watch.consoleErrors.filter(
        (e) => !/Failed to fetch|NetworkError|net::ERR_|clickgraph-injected-failure/i.test(e),
      );

  // Not every failed request is a defect, and treating them alike buries the
  // real ones. A 5xx or an uncaught exception is a problem no matter what the
  // UI did. A 4xx often is not: apps legitimately use 404 to mean "this
  // optional thing does not exist", handle it, and carry on.
  const serverErrors = organic.filter((e) => /^5\d\d /.test(e));
  const clientErrors = [...organic.filter((e) => /^4\d\d /.test(e)), ...injected];

  if (serverErrors.length > 0 || organicConsole.length > 0) {
    return { ...base, kind: 'error', note: serverErrors[0] ?? organicConsole[0] };
  }

  // A 4xx alongside a visible response means the app handled it. Record the
  // request in the outcome, but judge the interaction by what the user saw.
  const handled = clientErrors.length > 0
    ? {
        note: injected.length > 0
          ? `showed the user something when the request failed: ${clientErrors[0]}`
          : `handled a failed request: ${clientErrors[0]}`,
      }
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

  // The whole effect was to move the page, or a region of it: back to top, a
  // jump link, a carousel arrow that slides a strip. No text changes, no
  // attribute changes, no control changes, so before this the control sat in
  // the report beside the genuinely unwired ones (issue #22).
  //
  // Read BEFORE the visual signal on purpose, even though a window scroll also
  // moves every rectangle `visual` samples. Both answers are "this control
  // works"; only one of them says what it did, and "it scrolled the page" is
  // the more useful sentence to hand a reader than "the view changed visually".
  if (watch.scrolled === 'page' || watch.scrolled === 'region') {
    return {
      ...base,
      ...handled,
      kind: 'state-changed',
      note: watch.scrolled === 'page'
        ? 'scrolled the page — no text or control changed'
        : 'scrolled a region of the page — no text or control changed',
    };
  }

  // Same controls, same words, different picture. Reported as a working control
  // with the reason attached, because "it did something you cannot read in the
  // text" is a true and useful thing to say — and because the alternative was
  // calling every zoom, pan and theme toggle a dead control (issue #1).
  if (before.visualHash !== after.visualHash) {
    return {
      ...base,
      ...handled,
      kind: 'state-changed',
      note: 'the view changed visually — no text or control changed',
    };
  }

  // An element that is not a control changed its classes: a dot in a PIN mask
  // filling in, a step marker going active, a highlight moving between custom
  // list items. The user can see it and no other signal can, so before this the
  // whole eleven-key keypad reported dead at once (issue #26).
  if (before.classHash !== after.classHash) {
    return {
      ...base,
      ...handled,
      kind: 'state-changed',
      note: 'an element changed its class — a state the page draws in CSS, not in text',
    };
  }

  // The effect lives in browser chrome, which no page snapshot can see: a
  // print dialog, a clipboard write (issue #9). Same shape as the visual-only
  // case — a working control whose effect needs the reason attached — except
  // here the proof comes from a shim being told, not from looking harder.
  if (watch.chromeEffects && watch.chromeEffects.length > 0) {
    return {
      ...base,
      ...handled,
      kind: 'state-changed',
      note: `invoked ${[...new Set(watch.chromeEffects)].join(', ')} — ` +
        'browser chrome, which no page snapshot can see',
    };
  }

  // confirm/prompt/alert are browser chrome too. The walker dismisses them so
  // an autonomous run never authorizes the guarded action, but raising the
  // dialog proves the control is wired. Calling that a dead control is false;
  // record the safe decline branch and say what remains unwalked (issue #17).
  if (watch.dialogs && watch.dialogs.length > 0) {
    const dialog = watch.dialogs[0];
    const message = dialog.message ? `: ${JSON.stringify(dialog.message)}` : '';
    return {
      ...base,
      ...handled,
      kind: 'state-changed',
      note: `raised a ${dialog.type} dialog${message}; it was dismissed, so its accept branch was not walked`,
    };
  }

  // A request failed and the user saw nothing happen. That silent failure is a
  // real defect, and it is the one case where a 4xx alone is worth reporting.
  //
  // Under fault injection this is the whole point of the run: the walk broke
  // the request on purpose and the app rendered no banner, no retry, nothing.
  // Whatever went wrong, the user was not told.
  if (clientErrors.length > 0) {
    return {
      ...base,
      kind: 'error',
      note: injected.length > 0
        ? `the request failed (${clientErrors[0]}) and nothing visible changed — ` +
          'the failure was swallowed, so the user was told nothing'
        : `${clientErrors[0]} — and nothing visible changed`,
    };
  }
  if (watch.network.length > 0) {
    return {
      ...base,
      kind: 'network-only',
      note: 'fired a request but the visible state did not change',
    };
  }

  // The control now holds the chosen value — a select showing its new option,
  // a checkbox now checked — and nothing else moved (issue #5). Which of two
  // things that means depends on where the control lives:
  //
  // Inside a form, holding the value IS the job. The choice is consumed by the
  // submit, and the submit's own edge is the proof of that — so this is
  // correct behavior, recorded and kept out of findings, exactly like a link
  // to the page it is already on. A controlled framework select whose broken
  // handler discards the choice never reaches here: the value snaps back
  // before the snapshot, the hash matches, and it still reads as no-effect.
  //
  // Outside a form there is no submit coming. A standalone filter that holds
  // the choice while filtering nothing is the planted-defect case, so it stays
  // a finding — with the sharper note, because "the choice went nowhere" is
  // more useful than "nothing happened".
  if (before.formStateHash !== after.formStateHash) {
    if (element?.formId) {
      return {
        ...base,
        kind: 'no-effect',
        benign: true,
        note: 'holds the chosen value for its form — the submit is what consumes it',
      };
    }
    return {
      ...base,
      kind: 'no-effect',
      note: 'holds the chosen value, but nothing on the page responded to it',
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

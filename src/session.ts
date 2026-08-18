/**
 * The third store a saved sign-in can live in.
 *
 * Playwright's storage state carries cookies and localStorage and nothing else:
 * `context.storageState()` has no sessionStorage anywhere in its shape. An app
 * that keeps its session per tab — the deliberate choice when a session must
 * not outlive the tab, as a shared office machine wants — therefore saved a
 * file with nothing in it, and `--storage-state` walked straight back into the
 * login screen. Worse, `login` reported success either way, so the tool told
 * the user to do a thing that could not work and then said nothing (issue #27).
 *
 * This module is the part of a session that Playwright does not model: reading
 * sessionStorage out of a signed-in context, and judging when its absence from
 * the storage state is the whole story rather than a detail.
 */

import type { BrowserContext } from 'playwright';

/** One key/value pair, in the shape Playwright already uses for localStorage. */
export interface StorageItem {
  name: string;
  value: string;
}

/** Everything one origin had in sessionStorage when the session was saved. */
export interface SessionStorageOrigin {
  origin: string;
  items: StorageItem[];
}

/** Exactly what `context.storageState()` returns — cookies and localStorage. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * Read sessionStorage out of every page the signed-in context still has open.
 *
 * Read through `page.evaluate` rather than Playwright's newer `WebStorage` API
 * because this package supports playwright ^1.49, which does not have it, and
 * the loop below works on every version either way.
 */
export async function captureSessionStorage(
  context: BrowserContext,
): Promise<SessionStorageOrigin[]> {
  const byOrigin = new Map<string, Map<string, string>>();
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    let origin: string;
    try {
      const url = new URL(page.url());
      // about:blank and data: URLs have no storage worth saving, and their
      // origin is not one any walk can be seeded against.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      origin = url.origin;
    } catch {
      continue;
    }
    let items: StorageItem[];
    try {
      items = await page.evaluate(() => {
        const found: { name: string; value: string }[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const name = sessionStorage.key(i);
          if (name === null) continue;
          found.push({ name, value: sessionStorage.getItem(name) ?? '' });
        }
        return found;
      });
    } catch {
      // The human may have closed or navigated the tab between the two lines
      // above; a page we cannot read is not a reason to lose the rest.
      continue;
    }
    // sessionStorage is per tab, so two tabs on one origin can hold different
    // values for the same key. The first tab that had a key wins, because the
    // alternative — last write wins — silently discards the session the human
    // actually signed in with whenever a second tab is open.
    const existing = byOrigin.get(origin) ?? new Map<string, string>();
    for (const item of items) {
      if (!existing.has(item.name)) existing.set(item.name, item.value);
    }
    byOrigin.set(origin, existing);
  }
  return [...byOrigin]
    .map(([origin, items]) => ({
      origin,
      items: [...items].map(([name, value]) => ({ name, value })),
    }))
    .filter((entry) => entry.items.length > 0);
}

/** Standard cookie domain match: `.example.com` covers `app.example.com`. */
function cookieAppliesTo(domain: string, host: string): boolean {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain;
  return host === bare || host.endsWith(`.${bare}`);
}

/**
 * Origins whose sign-in a Playwright storage state cannot carry at all.
 *
 * The condition is narrow on purpose, because the obvious version of it cries
 * wolf. Plenty of apps park a wizard step, a scroll position or a draft in
 * sessionStorage while their session sits in a cookie; warning those that their
 * session cannot be saved would be false, and a tool that warns falsely gets
 * its warnings ignored. So an origin is reported only when sessionStorage holds
 * something AND the storage state captured nothing that could be carrying the
 * session for that origin — no cookie whose domain matches it, and no
 * localStorage of its own. An app in that state has, by definition, nothing
 * else the saved file could restore: whatever signed it in is in the one store
 * that was not saved.
 */
export function sessionStorageOnlyOrigins(
  state: StorageState,
  sessionStorage: SessionStorageOrigin[],
): string[] {
  return sessionStorage
    .filter((entry) => entry.items.length > 0)
    .filter((entry) => {
      const host = new URL(entry.origin).hostname;
      const cookie = state.cookies.some((c) => cookieAppliesTo(c.domain, host));
      const local = state.origins.some(
        (o) => o.origin === entry.origin && o.localStorage.length > 0,
      );
      return !cookie && !local;
    })
    .map((entry) => entry.origin);
}

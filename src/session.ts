/**
 * The session file: the third store a sign-in can live in, and how it is kept.
 *
 * Playwright's storage state carries cookies and localStorage and nothing else:
 * `context.storageState()` has no sessionStorage anywhere in its shape. An app
 * that keeps its session per tab — the deliberate choice when a session must
 * not outlive the tab, as a shared office machine wants — therefore saved a
 * file with nothing in it, and `--storage-state` walked straight back into the
 * login screen. Worse, `login` reported success either way, so the tool told
 * the user to do a thing that could not work and then said nothing (issue #27).
 *
 * Playwright cannot serialize sessionStorage, but a walk can replay it, so the
 * file is its storage state plus one key of ours:
 *
 *   {
 *     "cookies":        [ { "name": …, "domain": … } ],                 // Playwright's
 *     "origins":        [ { "origin": …, "localStorage": [ … ] } ],     // Playwright's
 *     "sessionStorage": [ { "origin": …, "items": [ … ] } ]             // ours
 *   }
 *
 * One file rather than a sidecar, because the two halves are one secret with
 * one lifetime and `--storage-state` names one path: a sidecar can be copied,
 * moved or deleted apart from the file it belongs to, and a session half
 * restored is a login screen with no explanation attached. The key path names
 * the store every entry came from, so nobody reading the file later has to
 * infer which of the three a value belongs to.
 *
 * The cost is that the file is no longer something Playwright reads for us.
 * `newContext({ storageState })` is handed the cookies-and-origins half as an
 * object, after this module has read the file and split it. Passing the path
 * straight through would have made our own key Playwright's business to
 * validate — it tolerates unknown keys today, and a version that stopped would
 * fail every walk rather than ignore one field.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

/** A session file, split into the half Playwright understands and the half it does not. */
export interface SavedSession {
  storageState: StorageState;
  sessionStorage: SessionStorageOrigin[];
}

/**
 * Read a session file, keeping the two halves apart.
 *
 * Anything written before this change has no `sessionStorage` key and reads as
 * an empty list, which is exactly what it held — so an existing session file
 * keeps working, and so does one hand-written as a plain Playwright storage
 * state. A `sessionStorage` key that is present but malformed throws instead:
 * it means something meant to carry a session, and dropping it quietly would
 * reproduce the silence this whole issue is about.
 */
export function readSessionFile(path: string): SavedSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `session file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`session file ${path} is not a JSON object`);
  }
  const file = parsed as Record<string, unknown>;
  return {
    storageState: {
      cookies: (file.cookies as StorageState['cookies']) ?? [],
      origins: (file.origins as StorageState['origins']) ?? [],
    },
    sessionStorage: parseSessionStorage(file.sessionStorage, path),
  };
}

function parseSessionStorage(value: unknown, path: string): SessionStorageOrigin[] {
  if (value === undefined) return [];
  const malformed = () =>
    new Error(
      `session file ${path} has a "sessionStorage" key that is not a list of ` +
      '{ origin, items: [{ name, value }] } — re-run clickgraph login to rewrite it',
    );
  if (!Array.isArray(value)) throw malformed();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw malformed();
    const { origin, items } = entry as { origin?: unknown; items?: unknown };
    if (typeof origin !== 'string' || !Array.isArray(items)) throw malformed();
    return {
      origin,
      items: items.map((item) => {
        if (!item || typeof item !== 'object') throw malformed();
        const { name, value: itemValue } = item as { name?: unknown; value?: unknown };
        if (typeof name !== 'string' || typeof itemValue !== 'string') throw malformed();
        return { name, value: itemValue };
      }),
    };
  });
}

/**
 * Write both halves as one file.
 *
 * Written here rather than by `context.storageState({ path })` for the single
 * reason that Playwright would write only its own half, and the sessionStorage
 * appended afterwards would be a second write that could fail on its own.
 */
export function writeSessionFile(
  path: string,
  storageState: StorageState,
  sessionStorage: SessionStorageOrigin[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file = {
    ...storageState,
    ...(sessionStorage.length > 0 ? { sessionStorage } : {}),
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Put a saved sessionStorage back before the app can look for it.
 *
 * `addInitScript` runs in every document before any of its scripts do, which is
 * the only moment this works: an app reads its session on load, so seeding it
 * after the first navigation means the first screen is the login screen and the
 * walk has already recorded it. Installed the same way, and for the same
 * reason, as the chrome-effect shims the walker puts in beside it.
 */
export async function seedSessionStorage(
  context: BrowserContext,
  origins: SessionStorageOrigin[],
): Promise<void> {
  await context.addInitScript((saved: SessionStorageOrigin[]) => {
    try {
      // sessionStorage is per origin, so a value saved for one host must never
      // appear on another. Frames with an opaque origin match nothing and are
      // left alone.
      const mine = saved.find((entry) => entry.origin === window.location.origin);
      if (!mine) return;
      for (const item of mine.items) {
        // Seed, not enforce. sessionStorage survives navigation within the tab,
        // so after the first page the app owns these keys: re-imposing the
        // captured value on every navigation would overwrite a token the app
        // had refreshed. The accepted cost is that a key the app deletes comes
        // back on the next navigation — which needs a walk that clicked sign
        // out, and sign out is skipped as dangerous unless asked for.
        if (window.sessionStorage.getItem(item.name) === null) {
          window.sessionStorage.setItem(item.name, item.value);
        }
      }
    } catch {
      // A sandboxed frame throws on any storage access. Nothing about that
      // stops the rest of the walk.
    }
  }, origins);
}

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

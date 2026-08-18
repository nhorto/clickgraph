/**
 * Capture a signed-in session, once, by hand.
 *
 * Telling someone to "save a Playwright storage state" is telling them to go
 * write a script, which is enough friction to make the auth support unused. So
 * this opens a real browser window, waits while a human signs in, and saves the
 * session when they say they are done.
 *
 * The human types their own credentials into their own browser. Nothing here
 * reads, stores, or transmits them — the only thing written to disk is the
 * session state the browser itself produces, and that file holds live cookies,
 * so it is treated as a secret everywhere it is mentioned.
 */

import { chromium, type BrowserContext } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { captureSessionStorage, sessionStorageOnlyOrigins } from './session.js';

export interface LoginOptions {
  url: string;
  out: string;
  onMessage?: (message: string) => void;
}

export async function captureLogin({ url, out, onMessage }: LoginOptions): Promise<void> {
  const say = onMessage ?? (() => {});
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    say('A browser window is open. Sign in there, then press Enter here.');
    say('Type your credentials into that window only — nothing is read from it.');
    await waitForEnter();
    await saveSignedInSession(context, out, say);
  } finally {
    await browser.close();
  }
}

/**
 * Everything `login` does once the human says they are signed in.
 *
 * Split out from the wait above so it can be driven by a context that was
 * signed in some other way. `login` is interactive by design — it blocks on a
 * keypress — so without this seam the only end-to-end check possible for any of
 * it is a person watching a browser window.
 */
export async function saveSignedInSession(
  context: BrowserContext,
  out: string,
  onMessage?: (message: string) => void,
): Promise<void> {
  const say = onMessage ?? (() => {});
  // The page may have been closed or navigated away; the session lives on the
  // context either way, so the state is still worth saving.
  mkdirSync(dirname(out), { recursive: true });
  // Read before writing: sessionStorage has to come off a live page, and the
  // storage state is what decides whether its absence matters.
  const sessionStorage = await captureSessionStorage(context);
  const state = await context.storageState({ path: out });
  say(`Session saved to ${out}`);
  say('It contains live cookies. Keep it out of git, and re-run this when it expires.');
  // Said here, at the moment of capture, because the alternative is silence
  // until a walk days later lands on the login form and reports the door
  // instead of the app — a report with nothing in it pointing back at this
  // file. One sentence here is the whole investigation (issue #27).
  for (const origin of sessionStorageOnlyOrigins(state, sessionStorage)) {
    say(
      `WARNING: ${origin} keeps its session in sessionStorage, which a saved ` +
      "session cannot carry — Playwright's storage state holds cookies and " +
      'localStorage only, and this sign-in left neither.',
    );
    say('--storage-state will land on the login screen again.');
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.stdin.off('data', done);
      // The walk never reads stdin, so leaving it resumed would hold the
      // process open after the browser closes.
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once('data', done);
  });
}

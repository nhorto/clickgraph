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

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

    // The page may have been closed or navigated away; the session lives on the
    // context either way, so the state is still worth saving.
    mkdirSync(dirname(out), { recursive: true });
    await context.storageState({ path: out });
    say(`Session saved to ${out}`);
    say('It contains live cookies. Keep it out of git, and re-run this when it expires.');
  } finally {
    await browser.close();
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

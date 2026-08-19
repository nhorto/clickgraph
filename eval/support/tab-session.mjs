/**
 * Mint a signed-in session for the fixture's /tab-app, the way scripts/verify.sh
 * does: sign in by script, then save the context with `saveSignedInSession` so
 * the sessionStorage half comes along.
 *
 * Used by the equivalence harness so one of its scenarios walks an app that
 * actually has a session to lose. Reads CLICKGRAPH_URL; writes the path given
 * as the first argument.
 */
import { chromium } from 'playwright';
import { saveSignedInSession } from '../../dist/login.js';

const base = process.env.CLICKGRAPH_URL;
const out = process.argv[2];
if (!base || !out) {
  console.error('usage: CLICKGRAPH_URL=… node eval/support/tab-session.mjs <out.json>');
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tab-app`);
  await page.fill('#tab-email', 'walker@example.com');
  await page.fill('#tab-password', 'not-read-by-anything');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=tab-export]');
  await saveSignedInSession(context, out, () => {});
} finally {
  await browser.close();
}

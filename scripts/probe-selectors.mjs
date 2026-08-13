/**
 * Why does a recorded selector fail to find its control again?
 *
 * Loads a page, captures it the way the walker does, then immediately tries to
 * resolve every selector it just wrote down — on the same page, with nothing
 * changed in between. Anything that fails here fails for a reason internal to
 * the tool, not because the app moved.
 *
 * Usage: node scripts/probe-selectors.mjs http://localhost:5173
 */
import { chromium } from 'playwright';
import { captureState, resolve } from '../dist/observer.js';

const url = process.argv[2];
if (!url) throw new Error('usage: node scripts/probe-selectors.mjs <url>');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const state = await captureState(page);
console.log(`${state.elements.length} controls found on ${state.url}\n`);

let repaired = 0;
const lost = [];
for (const el of state.elements) {
  const count = await resolve(page, el.selector).count().catch(() => -1);
  if (count > 0) continue;
  // The fallback is what the walker reaches for next, so measure the same thing
  // the walk will actually experience rather than the recorded selector alone.
  const viaFallback = el.fallback
    ? await page.locator(el.fallback).count().catch(() => -1)
    : 0;
  if (viaFallback > 0) { repaired++; continue; }
  lost.push(el);
}

console.log(`${repaired} recorded selectors do not resolve, and are repaired by the fallback`);
console.log(`${lost.length} of ${state.elements.length} cannot be found at all\n`);
for (const el of lost) {
  console.log(`  [${el.selector.strategy}] ${el.selector.value}`);
  console.log(`      fallback: ${el.fallback ?? 'none'}`);
}

await browser.close();

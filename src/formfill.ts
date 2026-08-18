/**
 * The values the walker types into a form.
 *
 * Two rules govern everything here, and one exception is granted from outside.
 *
 * Every value is obviously synthetic and carries the tool's name, because a
 * submitted form writes real data. Anything a walk creates should be traceable
 * to the walk at a glance, not mistaken for a real user's record. Addresses use
 * the reserved `.invalid` domain and the 555-01xx phone block, which cannot
 * reach anyone by accident.
 *
 * And nothing is invented where a wrong guess is expensive. A password field
 * stops the whole form rather than being typed into: a synthetic password sent
 * to a login form is a failed sign-in attempt, which on a real app means rate
 * limiting or a locked-out account. A file upload stops it too, because there is
 * nothing honest to put there.
 *
 * The exception is a value the caller declares for a named field. Synthesis is
 * guessing, and both rules above are about guessing well; a declared value is
 * not a guess, so it overrides the synthetic one and — for a password alone —
 * the refusal too. It is still typed into a real app, so it inherits none of
 * the traceability the `clickgraph-test` token gives: what a declared value
 * writes looks exactly like what a person would have written.
 */

import type { DeclaredField, ElementDescriptor } from './types.js';

/** Present in every value the walker types, so the data it creates is greppable. */
export const FILL_TOKEN = 'clickgraph-test';

/**
 * Why this field must not be filled, or null if it can be.
 *
 * One of these stops the entire form, not just its own field: a form submitted
 * with a field deliberately left blank tests something nobody asked for.
 *
 * `declared` is the caller's own value for this field, when they gave one. It
 * clears the password refusal and nothing else. The refusal is about what may
 * be INVENTED — a guessed password is a failed sign-in attempt against a real
 * account — and a value someone typed into their own config is not a guess.
 * A file input stays refused either way: there is no string that fills one.
 */
export function refusesFill(el: ElementDescriptor, declared?: string | null): string | null {
  if (el.inputType === 'password' && declared == null) {
    return 'a password field is never typed into — a wrong password is a failed sign-in attempt';
  }
  if (el.inputType === 'file') return 'a file upload has nothing honest to synthesize';
  return null;
}

/**
 * Parse one `--field` argument: a CSS selector, `=`, and the value.
 *
 * Neither side owns `=`, which is why this is not a `split`. Attribute
 * selectors carry one — `[data-testid="code"]` — and so do plenty of values,
 * so the separator is the first `=` at bracket depth zero and outside quotes.
 * Splitting on the first `=` outright takes `[data-testid` as the selector;
 * splitting on the last takes `#q=a` out of `#q=a=b`. Both are silent: the
 * result is a selector that matches nothing, which is a walk that quietly
 * covers less than it says.
 */
export function parseFieldSpec(spec: string): DeclaredField {
  let depth = 0;
  let quote: string | null = null;
  let at = -1;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i]!;
    if (quote !== null) {
      if (c === quote && spec[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[' || c === '(') {
      depth++;
    } else if (c === ']' || c === ')') {
      depth--;
    } else if (c === '=' && depth === 0) {
      at = i;
      break;
    }
  }
  if (at <= 0) {
    throw new Error(
      `--field needs <css-selector>=<value>, e.g. --field "#order-code=ORD-1042" (got ${JSON.stringify(spec)})`,
    );
  }
  const match = spec.slice(0, at).trim();
  if (match === '') throw new Error(`--field has an empty selector: ${JSON.stringify(spec)}`);
  return { match, value: spec.slice(at + 1) };
}

/** The `--field` argument that would reproduce a declared field. */
export function fieldSpec(field: DeclaredField): string {
  return `${field.match}=${field.value}`;
}

/**
 * A value for one field, chosen by its input type.
 *
 * The dates are deliberately in the future, which suits the common cases
 * (bookings, expiry, scheduling) and is wrong for a date of birth. That guess is
 * safe to make because the browser gets the last word: a value outside the
 * field's own min/max leaves the form invalid, and an invalid form is reported
 * as unfilled rather than submitted.
 */
export function synthesize(el: ElementDescriptor): string {
  if (el.tag === 'textarea') return `${FILL_TOKEN} — submitted by an automated UI walk`;
  switch (el.inputType) {
    case 'email':
      return `${FILL_TOKEN}@example.invalid`;
    case 'url':
      return `https://example.invalid/${FILL_TOKEN}`;
    case 'tel':
      return '+15555550100';
    case 'number':
      return '1';
    case 'date':
      return '2030-01-01';
    case 'month':
      return '2030-01';
    case 'week':
      return '2030-W01';
    case 'time':
      return '12:00';
    case 'datetime-local':
      return '2030-01-01T12:00';
    default:
      return FILL_TOKEN;
  }
}

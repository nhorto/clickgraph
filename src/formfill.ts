/**
 * The values the walker types into a form.
 *
 * Two rules govern everything here.
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
 */

import type { ElementDescriptor } from './types.js';

/** Present in every value the walker types, so the data it creates is greppable. */
export const FILL_TOKEN = 'clickgraph-test';

/**
 * Why this field must not be filled, or null if it can be.
 *
 * One of these stops the entire form, not just its own field: a form submitted
 * with a field deliberately left blank tests something nobody asked for.
 */
export function refusesFill(el: ElementDescriptor): string | null {
  if (el.inputType === 'password') {
    return 'a password field is never typed into — a wrong password is a failed sign-in attempt';
  }
  if (el.inputType === 'file') return 'a file upload has nothing honest to synthesize';
  return null;
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

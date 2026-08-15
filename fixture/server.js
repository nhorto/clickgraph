/**
 * A deliberately imperfect demo app, used to prove the walker finds real problems.
 *
 * Planted defects (what a correct walk must report):
 *   1. /orders  "Export"        — button with no handler at all  → no-effect
 *   2. /settings "Save settings" — POSTs to an endpoint that 500s → error
 *   3. /orders  "Region" select  — renders options, ignores the choice
 *   4. /feedback "Send feedback" — the form swallows its own submission.
 *      Only visible with --fill-forms: unfilled, the browser refuses to submit
 *      it at all, and a walk that reported that as a dead button would be
 *      blaming the app for its own empty form.
 *
 * Planted traps (what a correct walk must NOT do):
 *   5. /settings "Delete account" — must be skipped as dangerous
 *   6. /settings external link    — must be skipped as off-origin
 *   7. /settings "Advanced" button — disabled, must be skipped
 *   8. /signup — a form that works. Filled and submitted it creates an
 *      account; left alone it must be reported as skipped, never as broken.
 *
 * Run with BREAK=1 to simulate a regression: the working "Refresh" button
 * loses its handler and the order-detail link stops navigating.
 *
 * Run with AUTH=1 to put the whole app behind a login screen, so the walker can
 * be checked against the case it used to get wrong: without a session it walks
 * the login form and reports a clean run of a page nobody cares about.
 *
 * Run with CRUMB=1 to add /reports/q3-report, where the app marks the current
 * breadcrumb with a CSS class and no ARIA at all. Its dead-on-purpose crumb sits
 * beside a genuinely broken button that also carries an "active" class, because
 * the risk in reading class names is excusing exactly that.
 *
 * Run with CANVAS=1 to add /canvas, where a button's whole effect is geometric:
 * it rewrites a CSS transform and changes not a word on the page. Beside it sits
 * a button wired to nothing, because the interesting question is not whether a
 * zoom can be detected but whether detecting it excuses the dead control next to
 * it.
 *
 * Run with CLUSTER=1 to add /invite, a screen with no <form> on it at all: two
 * loose inputs and a button wired by hand, which is how most React apps write a
 * form. Clicking that button with the fields empty changes nothing, exactly as a
 * dead button would — so a walk that has not filled them must report that it
 * could not tell, and one that has must prove the button works. Its second card
 * puts two buttons beside one field, which is the case where the grouping cannot
 * be inferred and guessing it would mean typing into fields that do not belong
 * together.
 *
 * Run with VALUE=1 to add /order-options and its three selects, which are the
 * same control from the outside: each takes an option and leaves the page
 * reading exactly as it did, because the only thing a select changes is its own
 * value, and a value is a property rather than an attribute or a word of text.
 * "The value changed" therefore cannot be the signal — it is true of the broken
 * ones too. Only one of the three is working:
 *
 *   - Delivery sits in a form whose submit reads it. A consumer exists, so its
 *     silence at selection time proves nothing either way, and the submit is
 *     where the proof lives. Must not be reported.
 *   - Gift wrap sits in the same form and refuses the option: its handler never
 *     commits, so the value snaps back, which is what React does to a controlled
 *     select whose onChange does not set state. Being in a form must stay
 *     necessary without becoming sufficient, or the excuse above swallows this.
 *     Must still be reported.
 *   - Theme sits alone with no form and no handler. An immediate effect is the
 *     only effect it could ever have, so silence is the whole defect. Must still
 *     be reported.
 *
 * The form's required select also carries an empty placeholder, which is what
 * exposed --fill-forms filling it with the one value that makes the form
 * invalid.
 *
 * Run with ORPHAN=1 to add /audit — a real, working screen that nothing on the
 * site links to. It is reachable only by typing its address, which is exactly
 * what fixture/routes.json declares and what a walk on its own can never find.
 * The screen carries one working button and one dead one, because finding a page
 * is only worth anything if its controls then get walked. Beside it the map
 * declares two addresses that behave differently on arrival — one 404s and one
 * 500s — because "the map is stale" and "the page is broken" must not come back
 * as the same sentence. Everything else the map declares is reachable by
 * clicking and must stay silent.
 *
 * Run with ROUTE=1 to add a whole new screen, reached by a new link on /orders,
 * with a dead button on it. This is the case that separates a walk from a
 * replay: a walk discovers the screen and finds the dead button, while a replay
 * only knows the states its baseline knew. What a replay must not do is come
 * back clean — reaching a screen and not opening it has to be reported, or the
 * faster mode quietly buys its speed with silence.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4173);
const BREAK = process.env.BREAK === '1';
const AUTH = process.env.AUTH === '1';
const ROUTE = process.env.ROUTE === '1';
const CLUSTER = process.env.CLUSTER === '1';
const CANVAS = process.env.CANVAS === '1';
const CRUMB = process.env.CRUMB === '1';
const ORPHAN = process.env.ORPHAN === '1';
const VALUE = process.env.VALUE === '1';

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <form method="post" action="/login">
    <label>Email <input type="email" name="email"></label>
    <label>Password <input type="password" name="password"></label>
    <button type="submit">Sign in</button>
  </form>
  <p><a href="/forgot">Forgot your password?</a></p>
</body></html>`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  nav a { margin-right: 1rem; }
  button { padding: .4rem .8rem; margin: .25rem .25rem .25rem 0; }
  button[disabled] { opacity: .5; }
  #modal { border: 2px solid #333; padding: 1rem; margin-top: 1rem; }
  .card { border: 1px solid #ccc; padding: 1rem; margin: 1rem 0; }
</style></head>
<body>
<nav><a href="/">Home</a><a href="/orders">Orders</a><a href="/settings">Settings</a><a href="/signup">Sign up</a><a href="/feedback">Feedback</a><a href="/about">About</a></nav>
${body}
</body></html>`;

const routes = {
  '/': page('Home', `
    <h1>Acme Dashboard</h1>
    <p>Welcome back.</p>
    <button id="open-welcome" data-testid="open-welcome">Show tips</button>
    <div id="slot"></div>
    <script>
      document.getElementById('open-welcome').addEventListener('click', () => {
        document.getElementById('slot').innerHTML =
          '<div id="modal"><h2>Getting started</h2><p>Three tips for you.</p>' +
          '<button id="dismiss-tips">Dismiss</button></div>';
        document.getElementById('dismiss-tips').addEventListener('click', () => {
          document.getElementById('slot').innerHTML = '';
        });
      });
    </script>`),

  '/orders': page('Orders', `
    <h1>Orders</h1>
    <ul><li><a href="/orders/1042" data-testid="order-link"${BREAK ? ' onclick="return false"' : ''}>Order #1042</a></li></ul>
    <label>Status
      <select id="status-filter" data-testid="status-filter" aria-label="Filter orders by status">
        <option value="all">All</option>
        <option value="open">Open</option>
        <option value="shipped">Shipped</option>
      </select>
    </label>
    <label>Region
      <select id="region-filter" data-testid="region-filter" aria-label="Filter orders by region">
        <option value="all">All regions</option>
        <option value="emea">EMEA</option>
      </select>
    </label>
    <button id="export" data-testid="export">Export</button>
    <button id="refresh" data-testid="refresh">Refresh</button>
    ${ROUTE ? `<p><a href="/reports" data-testid="reports-link">Reports</a></p>` : ''}
    ${process.env.FEATURE === '1' ? `
    <button id="print" data-testid="print">Print invoice</button>
    <button id="archive" data-testid="archive">Archive</button>` : ''}
    <p id="status"></p>
    <script>
      // "Export" is intentionally wired to nothing at all.
      // The status filter works; the region filter is a planted defect — a
      // select that renders its options and does nothing with the choice.
      document.getElementById('status-filter').addEventListener('change', (e) => {
        document.getElementById('status').textContent = 'Filtered by ' + e.target.value;
      });
      ${process.env.FEATURE === '1' ? `
      // A just-shipped feature: "Print invoice" works, "Archive" was never wired up.
      document.getElementById('print').addEventListener('click', async () => {
        await fetch('/api/orders');
        document.getElementById('status').textContent = 'Sent to printer';
      });` : ''}
      ${BREAK ? '' : `
      document.getElementById('refresh').addEventListener('click', async () => {
        await fetch('/api/orders');
        document.getElementById('status').textContent = 'Refreshed';
      });`}
    </script>`),

  // Only linked when ROUTE=1. The button on it is wired to nothing, so a run
  // that opens this screen has a finding to report and a run that merely
  // arrives at it has none — which is the whole difference being tested.
  '/reports': page('Reports', `
    <h1>Reports</h1>
    <button id="run-report" data-testid="run-report">Run report</button>
    <p><a href="/orders">Back to orders</a></p>`),

  '/orders/1042': page('Order #1042', `
    <h1>Order #1042</h1>
    <p>Two items, shipped.</p>
    <a href="/orders">Back to orders</a>`),

  '/settings': page('Settings', `
    <h1>Settings</h1>
    <button id="save" data-testid="save">Save settings</button>
    <button id="advanced" disabled>Advanced options</button>
    <button id="delete-account">Delete account</button>
    <p><a href="https://example.com/docs">Read the docs</a></p>
    ${CLUSTER ? `<p><a href="/invite" data-testid="invite-link">Invite a teammate</a></p>` : ''}
    ${CANVAS ? `<p><a href="/canvas" data-testid="canvas-link">Canvas</a></p>` : ''}
    ${CRUMB ? `<p><a href="/reports/q3-report" data-testid="q3-link">Q3 report</a></p>` : ''}
    ${VALUE ? `<p><a href="/order-options" data-testid="options-link">Order options</a></p>` : ''}
    <script>
      document.getElementById('save').addEventListener('click', async () => {
        await fetch('/api/save', { method: 'POST' });
      });
      document.getElementById('delete-account').addEventListener('click', () => {
        document.body.innerHTML = '<h1>Account deleted</h1>';
      });
    </script>`),

  '/signup': page('Sign up', `
    <h1>Sign up</h1>
    <form id="signup">
      <p><label>Name <input type="text" id="name" name="name" required></label></p>
      <p><label>Email <input type="email" id="email" name="email" required></label></p>
      <p><label>Plan
        <select id="plan" name="plan" aria-label="Plan">
          <option value="free">Free</option>
          <option value="team">Team</option>
        </select></label></p>
      <button type="submit">Create account</button>
    </form>
    <p id="signup-result"></p>
    <script>
      // A form that works. Required fields mean an unfilled walk cannot submit
      // it at all — the case that used to be reported as a dead button.
      document.getElementById('plan').addEventListener('change', (e) => {
        document.getElementById('signup-result').textContent = 'Plan: ' + e.target.value;
      });
      document.getElementById('signup').addEventListener('submit', async (e) => {
        e.preventDefault();
        await fetch('/api/signup', { method: 'POST' });
        document.getElementById('signup-result').textContent =
          'Account created for ' + document.getElementById('email').value;
      });
    </script>`),

  '/feedback': page('Feedback', `
    <h1>Feedback</h1>
    <form id="feedback">
      <p><label>Message <textarea id="message" name="message" required></textarea></label></p>
      <button type="submit">Send feedback</button>
    </form>
    <script>
      // Planted defect: the submission is intercepted and then dropped. The
      // form looks complete, accepts what you type, and loses it.
      document.getElementById('feedback').addEventListener('submit', (e) => e.preventDefault());
    </script>`),

  // Only linked when CLUSTER=1. Two cards, and the difference between them is
  // the whole feature: the first is a group the walker has to infer, the second
  // is one it has to refuse to infer.
  ...(CLUSTER
    ? {
        '/invite': page('Invite', `
    <h1>Invite a teammate</h1>

    <div class="card">
      <p><label>Name <input type="text" id="invite-name" name="name"></label></p>
      <p><label>Email <input type="email" id="invite-email" name="email"></label></p>
      <button id="send-invite" data-testid="send-invite">Send invite</button>
    </div>
    <p id="invite-result"></p>

    <div class="card">
      <p><label>Note <input type="text" id="note" name="note"></label></p>
      <button id="save-note" data-testid="save-note">Save note</button>
      <button id="clear-note" data-testid="clear-note">Clear</button>
    </div>
    <p id="note-result"></p>

    <script>
      // No <form> anywhere on this page, which is the point. "Send invite"
      // declines an empty invite in silence — indistinguishable, from outside,
      // from a button wired to nothing. A walk that has not filled the fields
      // must say it could not tell, and one that has must prove it works.
      document.getElementById('send-invite').addEventListener('click', async () => {
        const name = document.getElementById('invite-name').value.trim();
        const email = document.getElementById('invite-email').value.trim();
        if (!name || !email) return;
        await fetch('/api/signup', { method: 'POST' });
        document.getElementById('invite-result').textContent = 'Invited ' + email;
      });
      // The second card has two buttons, so which one "Note" is for is a guess.
      // Both work on their own, so refusing to group them costs a walk nothing
      // here — the field stays skipped, and neither button is called dead.
      document.getElementById('save-note').addEventListener('click', () => {
        document.getElementById('note-result').textContent =
          'Saved: ' + document.getElementById('note').value;
      });
      document.getElementById('clear-note').addEventListener('click', () => {
        document.getElementById('note').value = '';
        document.getElementById('note-result').textContent = 'Cleared';
      });
    </script>`),
      }
    : {}),

  // Only linked when CANVAS=1. Two buttons over one diagram: one moves it and
  // changes not a word on the page, one is wired to nothing. Telling those apart
  // is the whole point — a signal that says "something moved" would excuse both.
  ...(CANVAS
    ? {
        '/canvas': page('Canvas', `
    <h1>Canvas</h1>
    <div id="viewport" style="transform: scale(1); width: 220px; height: 90px; border: 1px solid #333">
      <p>A diagram lives here.</p>
    </div>
    <button id="zoom-in" data-testid="zoom-in">Zoom in</button>
    <button id="recenter" data-testid="recenter">Recenter</button>
    <script>
      // Works, and leaves the page reading exactly as it did.
      document.getElementById('zoom-in').addEventListener('click', () => {
        const vp = document.getElementById('viewport');
        const now = parseFloat((vp.style.transform.match(/scale\\(([\\d.]+)\\)/) || [])[1] || '1');
        vp.style.transform = 'scale(' + (now + 0.25) + ')';
      });
      // "Recenter" is wired to nothing at all, on a page where something else
      // does move. It has to still be reported.
    </script>`),
      }
    : {}),

  // Only linked when CRUMB=1. The app says "you are here" in CSS and nowhere
  // else — no aria-current, and these are buttons, so there is no href to
  // compare either. The second card is the guard: a class alone must not be
  // enough, or "active" becomes a way for any broken button to excuse itself.
  ...(CRUMB
    ? {
        '/reports/q3-report': page('Q3 report', `
    <h1>Q3 report</h1>
    <nav class="crumbs">
      <a href="/">Home</a>
      <button class="crumb is-current" data-testid="crumb-current">Q3 report</button>
    </nav>

    <p><button class="toolbar-btn active" data-testid="stale-refresh">Refresh totals</button></p>
    <script>
      // Both buttons here are wired to nothing, and only one of them is a bug.
      //
      // The breadcrumb for the page you are on does nothing because that is what
      // a breadcrumb for the current page does. "Refresh totals" does nothing
      // because it is broken — and it carries class="active" precisely so that
      // excusing it is the easiest mistake available. What separates them is
      // that one names the page the browser is on and the other does not.
    </script>`),
      }
    : {}),

  // Only linked when VALUE=1. Two selects whose choice changes nothing a
  // snapshot can see, because the only thing either one changes is its own
  // value — and a value lives in a property, which mutates no attribute and
  // rewrites no text.
  //
  // They are the same select from the outside. Both take the option. Both leave
  // the page reading exactly as it did. The DOM cannot tell them apart, which is
  // why the choice of signal matters: "the value changed" is true of both, so a
  // rule built on it would excuse the broken one along with the working one.
  //
  // What separates them is whether anything exists to consume the value.
  // "Delivery" sits in a form with a submit that reads it, so its silence at
  // selection time proves nothing — the submit is what would prove it either
  // way. "Theme" sits alone with no form, no submit and no handler: an immediate
  // effect is the only effect it could ever have, so silence is the whole defect.
  ...(VALUE
    ? {
        '/order-options': page('Order options', `
    <h1>Order options</h1>

    <form id="delivery-form" method="post" action="/api/order-options">
      <p><label>Delivery
        <select id="delivery" name="delivery" data-testid="delivery" required>
          <option value="">Pick a speed…</option>
          <option value="standard">Standard</option>
          <option value="express">Express</option>
        </select>
      </label></p>
      <p><label>Gift wrap
        <select id="giftwrap" name="giftwrap" data-testid="giftwrap">
          <option value="none">No wrapping</option>
          <option value="paper">Gift paper</option>
        </select>
      </label></p>
      <p><button type="submit" data-testid="save-options">Save options</button></p>
    </form>

    <p><label>Theme
      <select id="theme" data-testid="theme" aria-label="Theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label></p>
    <script>
      // Controlled the way React controls a select: the value is written as a
      // property from state, never as an attribute, and no option's "selected"
      // attribute is ever touched. This is the shape that reads as dead.
      var delivery = '';
      var deliverySelect = document.getElementById('delivery');
      deliverySelect.addEventListener('change', function (e) {
        delivery = e.target.value;
        render();
      });
      function render() {
        deliverySelect.value = delivery;
      }

      // The bug a controlled select actually has, and the guard on the rule
      // above: this one is controlled by state that its handler never updates,
      // so the value snaps back to what state still says. React does this to
      // itself — it restores the controlled value when onChange does not commit
      // one — and the result is a select that cannot be changed at all.
      //
      // It is inside the form, so "it has a submit to consume it" excuses it.
      // Being in a form has to stay necessary and not become sufficient, or the
      // cure for the false positive above swallows this.
      var giftwrapCommitted = 'none';
      var giftwrapSelect = document.getElementById('giftwrap');
      giftwrapSelect.addEventListener('change', function (e) {
        e.target.value = giftwrapCommitted;
      });

      // "Theme" is wired to nothing at all, on a page where another select is
      // just as silent and is working. It has to still be reported.
    </script>`),
      }
    : {}),

  // No link anywhere on the site points here. That is the whole point: the page
  // works, and a walk that only clicks can never arrive. Its two buttons are
  // there so that finding the screen is worth something — a screen named in a
  // report and never opened would be the same silence in a longer sentence.
  ...(ORPHAN
    ? {
        '/audit': page('Audit log', `
    <h1>Audit log</h1>
    <p>Nothing links here. You have to know the address.</p>
    <button id="audit-refresh" data-testid="audit-refresh">Reload entries</button>
    <button data-testid="audit-export">Export audit log</button>
    <div id="audit-slot"></div>
    <script>
      document.getElementById('audit-refresh').addEventListener('click', () => {
        document.getElementById('audit-slot').textContent = 'Reloaded.';
      });
      // "Export audit log" is wired to nothing — the dead control that only
      // exists on the screen nothing links to.
    </script>`),
      }
    : {}),

  '/about': page('About', `<h1>About</h1><p>Acme, since 1998.</p>`),
};

createServer((req, res) => {
  const path = req.url.split('?')[0];

  // The gate, when AUTH=1: no session cookie means every route is the login
  // page. A walker without a saved session sees only the door.
  if (AUTH && !/(^|;\s*)session=/.test(req.headers.cookie ?? '')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(LOGIN_PAGE);
  }

  if (path === '/api/orders') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"orders":[{"id":1042}]}');
  }
  if (path === '/api/signup') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  // The consumer that makes "Delivery" a working control rather than a dead
  // one. It reads the value; nothing about choosing an option reaches it until
  // the form is submitted, which is exactly why selection time proves nothing.
  if (path === '/api/order-options') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (path === '/api/save') {
    // Planted defect: this endpoint is broken.
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end('{"error":"could not persist settings"}');
  }

  // A second declared address for a page that already has no way in. The old URL
  // still redirects, which is good manners and no help at all — following it
  // arrives somewhere nothing links to either, so it cannot count as a page the
  // walk reached.
  if (ORPHAN && path === '/audit-log') {
    res.writeHead(302, { location: '/audit' });
    return res.end();
  }

  // Declared in the route map, and broken rather than missing. A 500 is the app
  // failing; the 404 below it is only the map being out of date. A run that
  // reports those as one thing is telling whoever reads it to fix the wrong file.
  if (ORPHAN && path === '/broken-export') {
    res.writeHead(500, { 'content-type': 'text/html' });
    return res.end(page('Export', '<h1>500</h1><p>the export service is down</p>'));
  }

  const body = routes[path];
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end(page('Not found', '<h1>404</h1>'));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}).listen(PORT, () => {
  console.log(`fixture app on http://localhost:${PORT}${BREAK ? ' (BREAK=1)' : ''}`);
});

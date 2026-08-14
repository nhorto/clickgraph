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
  if (path === '/api/save') {
    // Planted defect: this endpoint is broken.
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end('{"error":"could not persist settings"}');
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

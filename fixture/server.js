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
 *   9. /orders "Print order" and "Copy order link" — controls whose whole
 *      effect is browser chrome (window.print, clipboard). Invisible to any
 *      page snapshot, so without the shims they read as dead (issue #9).
 *  10. /signup "Referral source" — an in-form select with no change handler:
 *      it holds the choice for the submit to consume. Calling it dead blames
 *      a working form field for doing exactly its job (issue #5).
 *  11. /about "More actions" reveals a panel WITHOUT changing any heading, so
 *      its "Beep" button exists only after a self-loop — the class of control
 *      that used to be walked never and counted nowhere (issue #8). Beep is
 *      unwired, so a correct walk must reach it AND report it dead.
 *  12. /orders "Retire order" raises a confirm dialog. The safe decline branch
 *      is observable browser chrome, not a dead control (issue #17).
 *  13. /kiosk keeps six screens mounted and shows one at a time, with every
 *      heading in the document belonging to a screen the user cannot see. A
 *      walk that reads hidden headings gives all six the same identity and
 *      collapses them into one node it never gets past — and still exits 0
 *      (issue #25). Reached only by walking /kiosk directly.
 *  14. /tab-app keeps its whole session in sessionStorage, which a Playwright
 *      storage state does not carry (issue #27). Unlinked from the nav and
 *      gated in the browser rather than the server: without the tab session
 *      replayed, a walk of it sees a sign-in form and nothing else, and the
 *      unwired "Export workspace" button behind it is proof the walk got in.
 *
 * Run with BREAK=1 to simulate a regression: the working "Refresh" button
 * loses its handler and the order-detail link stops navigating.
 *
 * Run with EMPTY=1 to omit the only order row from /orders while keeping the
 * /orders/1042 page available by direct address. This simulates an app whose
 * fixture data is missing, making a real screen undiscoverable to the walker.
 *
 * Run with AUTH=1 to put the whole app behind a login screen, so the walker can
 * be checked against the case it used to get wrong: without a session it walks
 * the login form and reports a clean run of a page nobody cares about.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4173);
const BREAK = process.env.BREAK === '1';
const EMPTY = process.env.EMPTY === '1';
const AUTH = process.env.AUTH === '1';

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

/**
 * A kiosk flow in the shape issue #25 was found in: one document, every screen
 * mounted at once, CSS showing one of them at a time. The entry screen carries
 * zero visible headings and the five screens parked behind it carry all of
 * them, so a fingerprint that reads headings straight out of the DOM hands
 * every screen the same identity, the whole flow collapses to one node, and the
 * walk stops expanding because it believes it has already been everywhere.
 *
 * Nothing here is broken on purpose, and that is the point. The failure this
 * route exists to catch is not a missed finding but a clean exit 0 over an app
 * the walk never got through — the one outcome the tool is built to prevent.
 *
 * The name buttons are the counterweight. Ana and Bo lead to the same PIN
 * screen with different text on it, and that has to stay one node: identity is
 * meant to split on the screen you are looking at, not on everything that
 * differs between two visits to it.
 *
 * Deliberately absent from the shared nav, so a walk from / never wanders in
 * and every existing expectation about the fixture holds unchanged.
 */
const KIOSK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shop floor terminal</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  button { padding: .4rem .8rem; margin: .25rem .25rem .25rem 0; }
  .screen { display: none; }
  .screen.active { display: block; }
</style></head>
<body>
  <section class="screen active" id="idle">
    <p>Tap to begin.</p>
    <button data-testid="kiosk-clock-in" data-goto="who">Clock in</button>
    <button data-testid="kiosk-supervisor" data-goto="supervisor">Supervisor</button>
  </section>
  <section class="screen" id="who">
    <h2>Who are you?</h2>
    <button data-testid="kiosk-ana" data-goto="pin" data-name="Ana">Ana</button>
    <button data-testid="kiosk-bo" data-goto="pin" data-name="Bo">Bo</button>
    <button data-testid="kiosk-who-back" data-goto="idle">Back</button>
  </section>
  <section class="screen" id="pin">
    <h2>Enter your PIN</h2>
    <p id="pin-who"></p>
    <button data-testid="kiosk-confirm" data-goto="hello">Confirm</button>
    <button data-testid="kiosk-pin-back" data-goto="who">Back</button>
  </section>
  <section class="screen" id="hello">
    <h2>Hello</h2>
    <p>You are clocked in.</p>
    <button data-testid="kiosk-done" data-goto="idle">Done</button>
  </section>
  <section class="screen" id="supervisor">
    <h2>Supervisor menu</h2>
    <button data-testid="kiosk-reports" data-goto="reports">Reports</button>
    <button data-testid="kiosk-sup-back" data-goto="idle">Back</button>
  </section>
  <section class="screen" id="reports">
    <h2>Shift reports</h2>
    <p>Nothing recorded for this shift.</p>
    <button data-testid="kiosk-reports-back" data-goto="supervisor">Back</button>
  </section>
  <script>
    // Screens are shown and hidden, never mounted and unmounted. A framework
    // would do the same thing with a class or a hidden attribute; the DOM the
    // walker reads is identical either way.
    const show = (id) => {
      for (const s of document.querySelectorAll('.screen')) {
        s.classList.toggle('active', s.id === id);
      }
    };
    for (const b of document.querySelectorAll('button[data-goto]')) {
      b.addEventListener('click', () => {
        if (b.dataset.name) {
          document.getElementById('pin-who').textContent = 'Signing in as ' + b.dataset.name;
        }
        show(b.dataset.goto);
      });
    }
  </script>
</body></html>`;

/**
 * A page with no nav, for the cases that have to be walked on their own.
 *
 * The two below are about what a snapshot can and cannot see, and both depend
 * on the exact order their controls are walked in — a PIN mask fills up as the
 * keys are pressed, and a scroll check needs the page to still be at the top
 * when it reaches the control below the fold. Six nav links in front of them
 * would put a navigation and a replay between every pair of presses, and drag
 * the rest of the app into a walk that is not about it.
 */
const bare = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }</style>
</head><body>
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
    ${EMPTY ? '' : `<ul><li><a href="/orders/1042" data-testid="order-link"${BREAK ? ' onclick="return false"' : ''}>Order #1042</a></li></ul>`}
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
    <button id="print-order" data-testid="print-order">Print order</button>
    <button id="copy-link" data-testid="copy-link">Copy order link</button>
    <button id="retire-order" data-testid="retire-order">Retire order</button>
    <!--
      The pair issue #15 exists for. While the API answers, these two are
      indistinguishable: both fire one request and neither is a finding. Break
      the request and they separate — "Sync orders" leaves the user staring at
      an unchanged screen, "Reload orders" says what went wrong. No healthy
      walk can tell them apart, which is exactly why the error path had to
      become reachable.
    -->
    <button id="sync-orders" data-testid="sync-orders">Sync orders</button>
    <button id="reload-orders" data-testid="reload-orders">Reload orders</button>
    <p id="orders-error" role="alert"></p>
    ${process.env.FEATURE === '1' ? `
    <button id="print" data-testid="print">Print invoice</button>
    <button id="archive" data-testid="archive">Archive</button>` : ''}
    <p id="status"></p>
    <!--
      A control that works and whose only effect is visual: it scales a
      container and changes not one character of text, exactly like the zoom on
      a diagram. Before the visual signal existed this was indistinguishable
      from "Export" — a button wired to nothing — and every canvas zoom, pan and
      theme toggle on the web read as a dead control (issue #1).

      The chart is deliberately outside the transformed element's own subtree in
      spirit: what moves is the container, not the button that moves it. That is
      what defeated the first attempt at the fix, which sampled the geometry of
      the interactive controls and so measured only things that stay still.
    -->
    <div id="chart-frame" style="overflow:hidden;width:200px;height:60px">
      <div id="chart" style="transform: scale(1); width:200px; height:60px; background:#ddd">
        <span>orders chart</span>
      </div>
    </div>
    <button id="zoom-in" data-testid="zoom-in" aria-label="Zoom In">Zoom In</button>
    <script>
      // "Export" is intentionally wired to nothing at all.
      // "Print order" and "Copy order link" work, but their whole effect is
      // browser chrome — the case no page snapshot can see (issue #9).
      document.getElementById('print-order').addEventListener('click', () => window.print());
      document.getElementById('copy-link').addEventListener('click', () => {
        navigator.clipboard?.writeText(location.href)?.catch(() => {});
      });
      document.getElementById('retire-order').addEventListener('click', async () => {
        if (!window.confirm('Retire this order?')) return;
        await fetch('/api/retire', { method: 'POST' });
        document.getElementById('status').textContent = 'Order retired';
      });
      // Swallows its own failure: the rejection is caught and discarded, so a
      // broken API produces a screen that never changes. Under a healthy walk
      // this is network-only — a request fired, nothing visible moved — which
      // is not a finding, because a great many working controls look like that.
      document.getElementById('sync-orders').addEventListener('click', () => {
        fetch('/api/orders').catch(() => {});
      });
      // Handles it. Same request, same silence on success; the difference only
      // exists on the failure branch.
      document.getElementById('reload-orders').addEventListener('click', async () => {
        try {
          const res = await fetch('/api/orders');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          document.getElementById('orders-error').textContent = '';
        } catch (err) {
          document.getElementById('orders-error').textContent =
            'Could not reload orders: ' + err.message;
        }
      });
      // "Zoom In" works, and proves the opposite case: a real effect that no
      // amount of reading the text or the control list can see.
      let chartScale = 1;
      document.getElementById('zoom-in').addEventListener('click', () => {
        chartScale = Math.round((chartScale + 0.2) * 10) / 10;
        document.getElementById('chart').style.transform = 'scale(' + chartScale + ')';
      });
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
      <p><label>Referral source
        <select id="referral" name="referral" aria-label="Referral source">
          <option value="friend">A friend</option>
          <option value="search">Search</option>
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

  '/about': page('About', `
    <h1>About</h1><p>Acme, since 1998.</p>
    <button id="more" data-testid="more-actions">More actions</button>
    <div id="extra"></div>
    <script>
      // The panel appears with no heading change: same node, new controls —
      // visible only through the self-loop that revealed them (issue #8).
      // "Beep" is intentionally wired to nothing.
      let openPanel = false;
      document.getElementById('more').addEventListener('click', () => {
        openPanel = !openPanel;
        document.getElementById('extra').innerHTML = openPanel
          ? '<button id="beep" data-testid="beep">Beep</button>' : '';
      });
    </script>`),

  '/kiosk': KIOSK,
  /*
   * The masked PIN keypad of issue #26: eleven working controls whose entire
   * effect is a class on something that is not a control.
   *
   * The dots are plain divs. A keypress moves one from `pin-dot` to
   * `pin-dot filled` — no text, no attribute the element list carries, no
   * rectangle, nothing on body or :root — so every signal the snapshot had came
   * back byte-identical and all eleven keys were reported dead at once.
   *
   * The fifth press wraps back to the first dot rather than ignoring the
   * keystroke. A keypad that went quiet once the mask was full would make keys
   * 5 through 0 honestly no-effect, and the check would then be measuring the
   * fixture instead of the tool.
   *
   * "Forgot your PIN?" is wired to nothing, and it is the guard on the whole
   * fix: a class signal sensitive enough to see a dot fill must still leave
   * this one dead. Being too sensitive here does not add noise, it deletes the
   * findings the tool exists to produce.
   */
  '/keypad': bare('Enter your PIN', `
    <h1>Enter your PIN</h1>
    <div id="mask">
      <div class="pin-dot"></div><div class="pin-dot"></div>
      <div class="pin-dot"></div><div class="pin-dot"></div>
    </div>
    <div id="pad">
      <button>1</button><button>2</button><button>3</button>
      <button>4</button><button>5</button><button>6</button>
      <button>7</button><button>8</button><button>9</button>
      <button>0</button><button>Back</button>
    </div>
    <p><button id="pin-help">Forgot your PIN?</button></p>
    <style>
      #mask { display: flex; gap: .5rem; margin: 1rem 0 }
      .pin-dot { width: 1rem; height: 1rem; border-radius: 50%; border: 2px solid #333 }
      .pin-dot.filled { background: #333 }
      #pad button { width: 3rem; padding: .4rem }
    </style>
    <script>
      const dots = () => Array.from(document.querySelectorAll('.pin-dot'));
      const filled = () => dots().filter((d) => d.classList.contains('filled'));
      document.querySelectorAll('#pad button').forEach((key) => {
        key.addEventListener('click', () => {
          if (key.textContent === 'Back') {
            filled().pop()?.classList.remove('filled');
            return;
          }
          const all = dots();
          if (filled().length === all.length) all.forEach((d) => d.classList.remove('filled'));
          all[filled().length].classList.add('filled');
        });
      });
      // "Forgot your PIN?" is intentionally wired to nothing at all.
    </script>`),

  /*
   * The scrolling controls of issue #22, and the trap that comes with them.
   *
   * "Scroll the notes" moves a region, "Back to top" moves the window. Neither
   * changes a character of text, an attribute or a control, so both used to
   * land in the report beside the genuinely unwired ones.
   *
   * "Share release notes" is the reason the filler below is 2400px tall. It is
   * wired to nothing and it sits far below the fold, so the walk has to scroll
   * to reach it — which means a naive before/after reading of window.scrollY
   * calls it a working scroller, and a baseline taken before the scroll-into-
   * view makes even the viewport-relative geometry in `visual` disagree with
   * itself. Both mistakes report a dead control as working. A check without a
   * dead control this far down the page would pass for the wrong reason.
   */
  '/release-notes': bare('Release notes', `
    <h1>Release notes</h1>
    <div id="notes">
      <p>2.4.0 — the walker learned to read scroll position.</p>
      <p>2.3.0 — class attributes joined the snapshot.</p>
      <p>2.2.0 — dialogs are observed rather than feared.</p>
      <p>2.1.0 — faults can be injected for a whole walk.</p>
      <p>2.0.0 — controls revealed by a self-loop are walked.</p>
      <p>1.9.0 — form values are read off the properties.</p>
      <p>1.8.0 — browser chrome effects are reported by a shim.</p>
      <p>1.7.0 — geometry and colour became an effect signal.</p>
    </div>
    <p><button id="scroll-notes">Scroll the notes</button></p>
    <div id="filler">A very long changelog lives here.</div>
    <p><button id="back-to-top">Back to top</button></p>
    <p><button id="share-notes">Share release notes</button></p>
    <style>
      #notes { height: 6rem; overflow-y: auto; border: 1px solid #333; padding: 0 .5rem }
      #filler { height: 2400px; background: #f0f0f0 }
    </style>
    <script>
      document.getElementById('scroll-notes').addEventListener('click', () => {
        document.getElementById('notes').scrollTop += 120;
      });
      document.getElementById('back-to-top').addEventListener('click', () => {
        window.scrollTo(0, 0);
      });
      // "Share release notes" is intentionally wired to nothing at all.
    </script>`),
  // The app of issue #27: its session lives in sessionStorage, so a Playwright
  // storage state saves nothing of it. Deliberately standalone — no nav, no
  // cookie, no server-side gate — so a walk of this route sees the door and
  // only the door until the tab session is replayed into it.
  '/tab-app': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tab workspace</title></head>
<body>
  <div id="root"></div>
  <script>
    // Per tab, not for ever: office machines are shared, and a session that
    // outlives the tab is the thing this app refuses to have.
    const KEY = 'acme.tab-session';
    function render() {
      const root = document.getElementById('root');
      if (sessionStorage.getItem(KEY) !== null) {
        // Only reachable with the tab session present, and wired to nothing:
        // a walk that reports this button is a walk that really got inside.
        root.innerHTML = '<h1>Tab workspace</h1><p>Signed in, for this tab only.</p>' +
          '<button id="tab-export" data-testid="tab-export">Export workspace</button>';
        return;
      }
      root.innerHTML = '<h1>Sign in</h1>' +
        '<form id="tab-signin">' +
        '<p><label>Email <input type="email" id="tab-email" name="email" required></label></p>' +
        '<p><label>Password <input type="password" id="tab-password" name="password" required></label></p>' +
        '<button type="submit">Sign in</button></form>';
      document.getElementById('tab-signin').addEventListener('submit', (e) => {
        e.preventDefault();
        sessionStorage.setItem(KEY, JSON.stringify({
          user: document.getElementById('tab-email').value, token: 'tab-token-1042',
        }));
        render();
      });
    }
    render();
  </script>
</body></html>`,
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

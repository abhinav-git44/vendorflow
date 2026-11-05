'use strict';
const { html: sendHtml, redirect, clientIp } = require('../../lib/http');
const { safeEqual } = require('../../lib/util');

module.exports = function authPages(router, W) {
  const { svc, config, sessions, layout, html } = W;

  const demoBox = () => (config.demoMode ? html`<div class="demo-box"><strong>Evaluator demo account</strong>
    <div class="kv"><span>Email</span><code>demo@vendorflow.example</code></div>
    <div class="kv"><span>Password</span><code>${config.demoPassword}</code></div>
    <p class="muted small">Other demo roles (same password): arjun.procurement@, neha.compliance@, vikram.reviewer@, ananya.viewer@vendorflow.example</p></div>` : '');

  function loginPage(req, res, { error, email = '', status = 200 } = {}) {
    const next = W.safeNext(req.query.next || req.body?.next);
    const connecting = next.startsWith('/oauth/authorize');
    sendHtml(res, status, layout.bare('Sign in', html`
      <h1 class="auth-title">${connecting ? 'Sign in to connect Claude' : 'Sign in'}</h1>
      ${connecting ? html`<p class="muted">Claude is asking to connect to your VendorFlow workspace. Sign in to continue.</p>` : ''}
      ${error ? html`<div class="alert error" role="alert">${error}</div>` : ''}
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="next" value="${next}">
        <label class="field"><span>Email</span><input type="email" name="email" value="${email}" required autocomplete="username" autofocus></label>
        <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn primary block">Sign in</button>
      </form>
      ${demoBox()}
      <p class="muted small center">New to VendorFlow? <a href="/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">Create a workspace</a> · <a href="/connect">How Claude connects</a></p>
      <p class="muted small center">Forgot your password? Ask your workspace owner to reset access from Team Members.</p>`, req.flash));
  }

  router.get('/login', (req, res) => {
    if (req.session && req.session.ctx) return redirect(res, W.safeNext(req.query.next));
    loginPage(req, res);
  });

  router.post('/login', async (req, res) => {
    await W.parseRequestBody(req);
    const { email, password } = req.body;
    if (!W.loginLimiter.check(`login:${clientIp(req)}:${String(email).toLowerCase()}`).ok) {
      return loginPage(req, res, { error: 'Too many sign-in attempts. Wait a few minutes and try again.', email, status: 429 });
    }
    const user = svc.members.authenticate(email, password);
    if (!user) return loginPage(req, res, { error: 'Incorrect email or password.', email, status: 401 });
    const orgs = svc.members.orgsForUser(user.id);
    sessions.create(res, user.id, orgs[0]?.id || null);
    return redirect(res, W.safeNext(req.body.next));
  });

  router.get('/signup', (req, res) => {
    sendHtml(res, 200, layout.bare('Create workspace', html`
      <h1 class="auth-title">Create your VendorFlow workspace</h1>
      <p class="muted">Free to start. Your organisation's data is isolated from every other workspace.</p>
      <form method="post" action="/signup" class="stack">
        <input type="hidden" name="next" value="${W.safeNext(req.query.next)}">
        <label class="field"><span>Your name</span><input name="name" required minlength="2" maxlength="80" autocomplete="name"></label>
        <label class="field"><span>Work email</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="field"><span>Password</span><input type="password" name="password" required minlength="10" autocomplete="new-password"><small class="muted">At least 10 characters, with letters and numbers.</small></label>
        <label class="field"><span>Organisation name</span><input name="org_name" required minlength="2" maxlength="120"></label>
        <button class="btn primary block">Create workspace</button>
      </form>
      <p class="muted small center">Already have an account? <a href="/login">Sign in</a></p>`, req.flash));
  });

  router.post('/signup', async (req, res) => {
    await W.parseRequestBody(req);
    try {
      const { userId, orgId } = svc.members.signup({ name: req.body.name, email: req.body.email, password: req.body.password, org_name: req.body.org_name });
      sessions.create(res, userId, orgId);
      W.flash(res, 'success', 'Workspace created. Next: connect Claude from Settings, or add your first vendor.');
      return redirect(res, W.safeNext(req.body.next));
    } catch (err) {
      W.flash(res, 'error', err.message);
      return redirect(res, '/signup');
    }
  });

  router.post('/logout', async (req, res) => {
    await W.parseRequestBody(req);
    if (req.session && req.body.csrf && safeEqual(req.body.csrf, req.session.csrf)) sessions.destroy(req, res);
    return redirect(res, '/login');
  });

  router.post('/switch-org', W.auth(async (req, res) => {
    if (!sessions.switchOrg(req.session, req.body.org_id)) W.flash(res, 'error', 'You are not a member of that organisation.');
    return redirect(res, '/');
  }));

  /** Public page: how to connect Claude (also linked from OAuth metadata). */
  router.get('/connect', (req, res) => {
    sendHtml(res, 200, layout.bare('Connect Claude', html`
      <h1 class="auth-title">Connect Claude to VendorFlow</h1>
      <ol class="steps">
        <li>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
        <li>Name it <strong>VendorFlow</strong> and paste this URL:<div class="copy-row"><code id="mcp-url">${config.appUrl}/mcp</code><button class="btn sm" type="button" data-copy="#mcp-url">Copy</button></div></li>
        <li>Click <strong>Connect</strong>. You'll be sent here to sign in and choose the organisation. Approve access.</li>
        <li>In a chat, enable the VendorFlow connector and ask, for example: <em>"Create a vendor called ABC Technologies, contact Rahul Sharma, category Technology."</em></li>
      </ol>
      <p class="muted small">VendorFlow never runs AI itself. Claude does the reasoning; VendorFlow stores the records, enforces permissions and keeps working after the chat ends.</p>
      <p class="center"><a class="btn" href="/login">Sign in</a></p>`));
  });
};

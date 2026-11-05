'use strict';
const crypto = require('node:crypto');
const { uuid, nowIso, sha256, randomToken, safeEqual } = require('../lib/util');
const { json, html: sendHtml, redirect, readBody, parseForm, RateLimiter, clientIp } = require('../lib/http');
const { html } = require('../web/html');
const { bare } = require('../web/layout');

/**
 * OAuth 2.1 authorization server for the MCP connector:
 *  - RFC 9728 protected-resource metadata, RFC 8414 server metadata
 *  - RFC 7591 dynamic client registration (Claude registers itself)
 *  - Authorization code + PKCE (S256 only), refresh-token rotation, RFC 7009 revocation
 * The user signs in with their normal VendorFlow account and picks the organisation to connect.
 */
function registerOAuthRoutes(router, { db, config, svc, sessions }) {
  const base = config.appUrl;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version' };
  const tokenLimiter = new RateLimiter({ windowMs: 60_000, max: 30 });
  const registerLimiter = new RateLimiter({ windowMs: 60 * 60_000, max: 20 });

  const resourceMeta = {
    resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'VendorFlow', scopes_supported: ['vendorflow'],
  };
  const asMeta = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['vendorflow'],
    service_documentation: `${base}/connect`,
  };
  router.get('/.well-known/oauth-protected-resource', (req, res) => json(res, 200, resourceMeta, cors));
  router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => json(res, 200, resourceMeta, cors));
  router.get('/.well-known/oauth-authorization-server', (req, res) => json(res, 200, asMeta, cors));
  router.get('/.well-known/oauth-authorization-server/mcp', (req, res) => json(res, 200, asMeta, cors));
  router.get('/.well-known/openid-configuration', (req, res) => json(res, 200, asMeta, cors));

  const validRedirect = (u) => {
    try {
      const url = new URL(u);
      if (url.hash) return false;
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    } catch { return false; }
  };

  // ---- Dynamic client registration ----
  router.post('/oauth/register', async (req, res) => {
    if (!registerLimiter.check(clientIp(req)).ok) return json(res, 429, { error: 'too_many_requests' }, cors);
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, cors); }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirect(u))) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http://localhost) URLs' }, cors);
    }
    const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
    const clientId = `vfc_${randomToken(16)}`;
    const secret = method === 'none' ? null : randomToken(32);
    const name = String(body.client_name || 'MCP client').slice(0, 100);
    db.run('INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, auth_method, created_at) VALUES (?,?,?,?,?,?)',
      clientId, secret ? sha256(secret) : null, name, JSON.stringify(uris), method, nowIso());
    return json(res, 201, {
      client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name, redirect_uris: uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }, cors);
  });

  const getClient = (id) => (id ? db.get('SELECT * FROM oauth_clients WHERE client_id = ?', String(id)) : null);

  function errorPage(res, status, message) {
    return sendHtml(res, status, bare('Connection error', html`
      <h1 class="auth-title">Can't connect</h1><p class="muted">${message}</p>
      <p class="muted small">Remove the VendorFlow connector in Claude and add it again. If this keeps happening, contact support.</p>`));
  }

  /** Validate an authorize request; returns {params, client} or renders an error. */
  function checkAuthorize(q, res) {
    const client = getClient(q.client_id);
    if (!client) { errorPage(res, 400, 'This connection request came from an unknown client.'); return null; }
    if (!q.redirect_uri || !JSON.parse(client.redirect_uris).includes(q.redirect_uri)) { errorPage(res, 400, 'The redirect address does not match the registered client.'); return null; }
    const back = (error, desc) => {
      const u = new URL(q.redirect_uri);
      u.searchParams.set('error', error);
      if (desc) u.searchParams.set('error_description', desc);
      if (q.state) u.searchParams.set('state', q.state);
      redirect(res, u.toString());
      return null;
    };
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'PKCE with S256 is required');
    return { client };
  }

  const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

  router.get('/oauth/authorize', (req, res) => {
    const q = Object.fromEntries(PARAMS.map((k) => [k, req.query[k]]).filter(([, v]) => v !== undefined));
    const ok = checkAuthorize(q, res);
    if (!ok) return;
    const session = sessions.load(req);
    if (!session) return redirect(res, `/login?next=${encodeURIComponent(req.url)}&connect=1`);
    const orgs = svc.members.orgsForUser(session.user.id);
    if (!orgs.length) return errorPage(res, 403, 'Your account is not a member of any organisation.');
    return sendHtml(res, 200, bare('Connect Claude to VendorFlow', html`
      <div class="connect-mark" aria-hidden="true"><span>C</span><span class="connect-arrow">→</span><span class="brand-dot">V</span></div>
      <h1 class="auth-title">Allow ${ok.client.client_name} to use VendorFlow?</h1>
      <p class="muted">Signed in as <strong>${session.user.name}</strong> (${session.user.email}). Claude will be able to read and change vendor records in the organisation you choose, with your role's permissions. Every action is logged as "${session.user.name} via Claude".</p>
      <form method="post" action="/oauth/authorize" class="stack">
        <input type="hidden" name="csrf" value="${session.csrf}">
        ${PARAMS.filter((k) => q[k] !== undefined).map((k) => html`<input type="hidden" name="${k}" value="${q[k]}">`)}
        <label class="field"><span>Organisation</span>
          <select name="org_id">${orgs.map((o) => html`<option value="${o.id}" ${o.id === session.orgId ? 'selected' : ''}>${o.name} — ${o.role.replace(/_/g, ' ')}</option>`)}</select>
        </label>
        <div class="row gap"><button class="btn primary" name="decision" value="allow">Allow access</button><button class="btn" name="decision" value="deny">Cancel</button></div>
      </form>
      <p class="muted small">You can disconnect at any time from Settings → Claude connection.</p>`));
  });

  router.post('/oauth/authorize', async (req, res) => {
    const session = sessions.load(req);
    const form = parseForm(await readBody(req, 64 * 1024));
    if (!session) return redirect(res, '/login');
    if (!form.csrf || !safeEqual(form.csrf, session.csrf)) return errorPage(res, 403, 'Your session expired. Please start the connection again from Claude.');
    const ok = checkAuthorize(form, res);
    if (!ok) return;
    const u = new URL(form.redirect_uri);
    if (form.state) u.searchParams.set('state', form.state);
    if (form.decision !== 'allow') {
      u.searchParams.set('error', 'access_denied');
      return redirect(res, u.toString());
    }
    const orgId = form.org_id;
    if (!svc.members.membership(session.user.id, orgId)) return errorPage(res, 403, 'You are not a member of that organisation.');
    const code = randomToken(32);
    db.run(`INSERT INTO oauth_codes (code_hash, client_id, user_id, org_id, redirect_uri, code_challenge, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      sha256(code), ok.client.client_id, session.user.id, orgId, form.redirect_uri, form.code_challenge, new Date(Date.now() + 5 * 60_000).toISOString(), nowIso());
    svc.activity.log({ orgId, actor: { type: 'user', id: session.user.id, label: session.user.name } },
      { action: 'mcp.connected', entityType: 'credential', entityId: ok.client.client_id, summary: `Connected ${ok.client.client_name} via OAuth` });
    u.searchParams.set('code', code);
    u.searchParams.set('iss', base);
    return redirect(res, u.toString());
  });

  // ---- Token endpoint ----
  async function readTokenBody(req) {
    const raw = await readBody(req, 64 * 1024);
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) { try { return JSON.parse(raw.toString('utf8')); } catch { return {}; } }
    return parseForm(raw);
  }

  function authClient(req, body) {
    let id = body.client_id, secret = body.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
    if (basic) {
      const [bid, bsecret] = Buffer.from(basic, 'base64').toString('utf8').split(':').map(decodeURIComponent);
      id = bid; secret = bsecret;
    }
    const client = getClient(id);
    if (!client) return null;
    if (client.client_secret_hash) {
      if (!secret || !safeEqual(sha256(secret), client.client_secret_hash)) return null;
    }
    return client;
  }

  router.post('/oauth/token', async (req, res) => {
    const noStore = { ...cors, 'Cache-Control': 'no-store', Pragma: 'no-cache' };
    if (!tokenLimiter.check(clientIp(req)).ok) return json(res, 429, { error: 'slow_down' }, noStore);
    const body = await readTokenBody(req);
    const client = authClient(req, body);
    if (!client) return json(res, 401, { error: 'invalid_client' }, noStore);

    if (body.grant_type === 'authorization_code') {
      const row = body.code ? db.get('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(body.code)) : null;
      const fail = (d) => json(res, 400, { error: 'invalid_grant', error_description: d }, noStore);
      if (!row || row.client_id !== client.client_id) return fail('Unknown authorization code');
      if (row.used_at) return fail('Authorization code already used');
      if (row.expires_at < nowIso()) return fail('Authorization code expired');
      if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return fail('redirect_uri mismatch');
      const verifier = String(body.code_verifier || '');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(challenge, row.code_challenge)) return fail('PKCE verification failed');
      db.run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?', nowIso(), row.code_hash);
      if (!svc.members.membership(row.user_id, row.org_id)) return fail('User no longer has access');
      return json(res, 200, { ...svc.credentials.issueOAuthTokens({ userId: row.user_id, orgId: row.org_id, clientId: client.client_id }), scope: 'vendorflow' }, noStore);
    }
    if (body.grant_type === 'refresh_token') {
      const tokens = body.refresh_token ? svc.credentials.exchangeRefresh(String(body.refresh_token), client.client_id) : null;
      if (!tokens) return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired or revoked' }, noStore);
      return json(res, 200, { ...tokens, scope: 'vendorflow' }, noStore);
    }
    return json(res, 400, { error: 'unsupported_grant_type' }, noStore);
  });

  router.post('/oauth/revoke', async (req, res) => {
    const body = await readTokenBody(req);
    if (body.token) db.run('UPDATE mcp_credentials SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', nowIso(), sha256(String(body.token)));
    return json(res, 200, {}, cors);
  });
}

module.exports = { registerOAuthRoutes };

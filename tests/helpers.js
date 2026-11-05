'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { seedDemo, demoPdf } = require('../src/seed');

const DEMO_PW = 'Test-Demo-Pass-123';
const quiet = { log() {}, error() {} };

/** Boot a real HTTP server on a random port with a throwaway database. */
async function startApp({ seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-test-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '1', DEMO_PASSWORD: DEMO_PW });
  const app = createApp({ config, logger: quiet });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.appUrl = base; // links & OAuth issuer follow the real port
  if (seed) seedDemo({ db: app.db, svc: app.svc, config });
  return {
    base, app, config, dir,
    async close() { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Cookie-jar browser session against the web app. */
async function login(base, email, password = DEMO_PW) {
  const jar = { cookie: '' };
  const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password, next: '/' }) });
  const sc = r.headers.get('set-cookie');
  if (!sc || !sc.includes('vf_session=')) throw new Error(`login failed (${r.status})`);
  jar.cookie = sc.split(';')[0];
  const page = await (await fetch(`${base}/settings`, { headers: { cookie: jar.cookie } })).text();
  jar.csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  jar.get = (p) => fetch(base + p, { headers: { cookie: jar.cookie }, redirect: 'manual' });
  jar.post = (p, fields, { csrf = true } = {}) => fetch(base + p, {
    method: 'POST', redirect: 'manual', headers: { cookie: jar.cookie, 'content-type': 'application/x-www-form-urlencoded', referer: base + '/' },
    body: new URLSearchParams({ ...(csrf ? { csrf: jar.csrf } : {}), ...fields }),
  });
  jar.upload = (p, fields, file) => {
    const fd = new FormData();
    fd.set('csrf', jar.csrf);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set('file', new Blob([file.buffer]), file.filename);
    return fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie: jar.cookie, referer: base + '/' }, body: fd });
  };
  jar.flash = (res) => { const c = res.headers.get('set-cookie') || ''; const m = /vf_flash=([^;]+)/.exec(c); return m ? JSON.parse(decodeURIComponent(m[1])) : null; };
  return jar;
}

/** Full OAuth 2.1 + PKCE connector flow, exactly as Claude performs it. Returns tokens. */
async function oauthConnect(base, email, password = DEMO_PW) {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' };
  const jar = await login(base, email, password);
  const page = await (await jar.get(`/oauth/authorize?${new URLSearchParams(q)}`)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
  const orgId = /name="org_id"><option value="([^"]+)"/.exec(page)[1];
  const r = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie: jar.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, csrf, org_id: orgId, decision: 'allow' }) });
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirectUri }) })).json();
  return { ...tok, client_id: reg.client_id };
}

function mcpClient(base, token) {
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  };
  const call = async (name, args = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { protocolError: body.error };
    return { isError: body.result.isError, text: body.result.content[0].text, data: body.result.structuredContent };
  };
  return { rpc, call };
}

const pdf = (title = 'Test') => ({ buffer: demoPdf(title, ['test file']), filename: 'test.pdf' });

module.exports = { startApp, login, oauthConnect, mcpClient, pdf, DEMO_PW };

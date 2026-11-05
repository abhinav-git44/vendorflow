'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, oauthConnect, mcpClient } = require('./helpers');

let env, owner, client;
test.before(async () => {
  env = await startApp();
  owner = await oauthConnect(env.base, 'demo@vendorflow.example');
  client = mcpClient(env.base, owner.access_token);
});
test.after(() => env.close());

const post = (body, headers = {}) => fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('discovery: 401 challenge points at protected-resource metadata', async () => {
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  const prm = await (await fetch(`${env.base}/.well-known/oauth-protected-resource`)).json();
  const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
  assert.ok(prm.resource.endsWith('/mcp'));
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.registration_endpoint);
});

test('OAuth: codes are single-use, PKCE enforced, refresh tokens rotate', async () => {
  const t = await oauthConnect(env.base, 'neha.compliance@vendorflow.example');
  assert.equal(t.token_type, 'Bearer');
  const refresh = (rt) => fetch(`${env.base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: t.client_id }) });
  const r1 = await refresh(t.refresh_token);
  assert.equal(r1.status, 200);
  const r2 = await refresh(t.refresh_token);
  assert.equal(r2.status, 400, 'a used refresh token is rejected');
  const bad = await fetch(`${env.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(bad.status, 400, 'non-https redirect URIs are refused');
});

test('protocol: initialize, notifications, tools/list, ping, batch, errors', async () => {
  const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  assert.match(init.body.result.instructions, /Claude/);
  const odd = await client.rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(odd.body.result.protocolVersion, '2025-11-25', 'falls back to latest supported');
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${owner.access_token}` });
  assert.equal(note.status, 202);
  const list = await client.rpc('tools/list', {});
  const names = list.body.result.tools.map((t) => t.name);
  for (const n of ['create_vendor', 'list_vendors', 'get_vendor', 'update_vendor', 'archive_vendor', 'add_document', 'set_document_status', 'list_vendor_documents',
    'get_expiring_documents', 'create_checklist', 'get_vendor_compliance', 'compliance_report', 'assign_task', 'update_task_status', 'list_pending_tasks',
    'request_approval', 'decide_approval', 'list_pending_approvals']) assert.ok(names.includes(n), n);
  for (const t of list.body.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 30, t.name);
    assert.ok(!JSON.stringify(t.inputSchema).includes('patternHint'));
  }
  assert.deepEqual((await client.rpc('ping', {})).body.result, {});
  assert.equal((await client.rpc('nope/method', {})).body.error.code, -32601);
  assert.equal((await client.call('no_such_tool')).protocolError.code, -32602);
  const batch = await (await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }], { authorization: `Bearer ${owner.access_token}` })).json();
  assert.equal(batch.length, 2);
  const parse = await post('{not json', { authorization: `Bearer ${owner.access_token}` });
  assert.equal((await parse.json()).error.code, -32700);
  assert.equal((await fetch(`${env.base}/mcp`)).status, 405);
});

test('auth: invalid, revoked and expired tokens are rejected', async () => {
  const bad = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer vf_at_forged' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /invalid_token/);
  // API key lifecycle: create in settings, use, revoke
  const jar = await login(env.base, 'demo@vendorflow.example');
  const html = await (await jar.post('/settings/credentials', { name: 'Inspector' })).text();
  const key = /<code id="new-key">([^<]+)<\/code>/.exec(html)[1];
  assert.match(key, /^vf_key_/);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM mcp_credentials WHERE token_hash = ?', key).n, 0, 'plaintext never stored');
  const k = mcpClient(env.base, key);
  assert.equal((await k.rpc('ping', {})).status, 200);
  const id = env.app.db.get("SELECT id FROM mcp_credentials WHERE kind = 'api_key' AND name = 'Inspector'").id;
  await jar.post(`/settings/credentials/${id}/revoke`, {});
  assert.equal((await k.rpc('ping', {})).status, 401);
  // expiry
  const t = await oauthConnect(env.base, 'arjun.procurement@vendorflow.example');
  env.app.db.run("UPDATE mcp_credentials SET expires_at = '2000-01-01T00:00:00Z' WHERE kind = 'oauth_access' AND user_id = (SELECT id FROM profiles WHERE email = 'arjun.procurement@vendorflow.example')");
  assert.equal((await mcpClient(env.base, t.access_token).rpc('ping', {})).status, 401);
});

test('tools validate input and return clear errors (nothing saved on failure)', async () => {
  const before = env.app.db.get('SELECT COUNT(*) AS n FROM vendors').n;
  let r = await client.call('create_vendor', { company_name: 'Bad GST', gst_number: '123' });
  assert.ok(r.isError);
  assert.match(r.text, /GSTIN/);
  r = await client.call('create_vendor', { company_name: 'Extra', hacker: true });
  assert.match(r.text, /not a recognised field/);
  r = await client.call('get_vendor', { vendor: 'Does Not Exist Ltd' });
  assert.match(r.text, /NOT_FOUND/);
  r = await client.call('update_vendor', { vendor: 'Kaveri Packaging Solutions', status: 'approved' });
  assert.match(r.text, /approval request/);
  assert.equal(env.app.db.get('SELECT COUNT(*) AS n FROM vendors').n, before);
});

test('role permissions apply through MCP too', async () => {
  const viewer = mcpClient(env.base, (await oauthConnect(env.base, 'ananya.viewer@vendorflow.example')).access_token);
  const r = await viewer.call('create_vendor', { company_name: 'Viewer Attempt' });
  assert.ok(r.isError);
  assert.match(r.text, /FORBIDDEN/);
  const ok = await viewer.call('list_vendors', {});
  assert.ok(ok.data.total >= 10);
});

test('MCP tokens are bound to one organisation', async () => {
  const jar = await fetch(`${env.base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Other Owner', email: 'other@else.example', password: 'Password1234', org_name: 'Elsewhere Inc' }) });
  assert.equal(jar.status, 303);
  const other = mcpClient(env.base, (await oauthConnect(env.base, 'other@else.example', 'Password1234')).access_token);
  assert.equal((await other.call('list_vendors', {})).data.total, 0);
  assert.match((await other.call('get_vendor', { vendor: 'VF-1001' })).text, /NOT_FOUND/);
  assert.match((await other.call('get_vendor', { vendor: 'Northwind Logistics' })).text, /NOT_FOUND/);
  const mine = await other.call('create_vendor', { company_name: 'Northwind Logistics' });
  assert.equal(mine.data.vendor_id, 'VF-1001', 'same name allowed in a different tenant');
});

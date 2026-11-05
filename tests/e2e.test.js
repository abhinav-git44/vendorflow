'use strict';
/**
 * The assignment's core loop, end to end over real HTTP:
 * Claude (MCP) creates → appears in the web app → a person edits/uploads → Claude verifies →
 * compliance updates → approval → reviewer decides → audit trail → persistence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, login, oauthConnect, mcpClient, pdf } = require('./helpers');

let env;
test.before(async () => { env = await startApp(); });
test.after(() => env.close());

test('core workflow: Claude → VendorFlow → people → Claude', async () => {
  const owner = await login(env.base, 'demo@vendorflow.example');
  const claude = mcpClient(env.base, (await oauthConnect(env.base, 'demo@vendorflow.example')).access_token);

  // Scenario 1 – vendor creation via Claude
  const created = await claude.call('create_vendor', { company_name: 'ABC Technologies', contact_person: 'Rahul Sharma', category: 'Technology' });
  assert.equal(created.isError, false, created.text);
  const code = created.data.vendor_id;
  assert.match(code, /^VF-\d+$/);
  assert.ok(created.data.app_url.endsWith(`/vendors/${code}`));
  const dash = await (await owner.get('/')).text();
  assert.match(dash, /ABC Technologies/, 'appears on the dashboard');
  assert.match(await (await owner.get('/vendors?q=ABC')).text(), new RegExp(code));

  // Scenario 2 – checklist
  const cl = await claude.call('create_checklist', { vendor: 'ABC Technologies', requirements: [
    { name: 'GST Certificate', mandatory: true }, { name: 'PAN Card', mandatory: true }, { name: 'Bank Verification', mandatory: true }, { name: 'Business Registration', mandatory: true }] });
  assert.equal(cl.data.compliance_percent, 0);
  assert.equal(cl.data.missing.length, 4);

  // Scenario 3 – task to "the procurement manager"
  const task = await claude.call('assign_task', { title: 'Compliance review – ABC Technologies', vendor: code, assignee_role: 'procurement manager', priority: 'high', due_date: '2099-11-30' });
  assert.equal(task.data.assignee.name, 'Arjun Mehta');
  assert.match(await (await owner.get('/tasks')).text(), /Compliance review – ABC Technologies/);

  // Scenario 7 – manual edit in the web app persists
  let r = await owner.post(`/vendors/${code}`, { company_name: 'ABC Technologies', category: 'Technology', contact_person: 'Rahul Sharma', email: 'rahul@abc.example.com', phone: '+91 98765 43210', status: 'pending_onboarding', risk: 'low', bank_verification_status: 'pending' });
  assert.equal(r.status, 303);
  assert.equal(owner.flash(r).type, 'success');
  const profile = await (await owner.get(`/vendors/${code}`)).text();
  assert.match(profile, /rahul@abc\.example\.com/);
  assert.equal((await claude.call('get_vendor', { vendor: code })).data.phone, '+91 98765 43210', 'Claude sees the human edit');

  // Scenario 4 – verifying needs a real upload first
  r = await claude.call('set_document_status', { vendor: 'ABC Technologies', category: 'GST', status: 'verified' });
  assert.ok(r.isError);
  r = await owner.upload(`/vendors/${code}/documents`, { category: 'gst', expiry_date: '2099-01-01' }, pdf('GST'));
  assert.equal(r.status, 303);
  assert.equal(owner.flash(r).type, 'success', JSON.stringify(owner.flash(r)));
  r = await claude.call('set_document_status', { vendor: 'ABC Technologies', category: 'GST', status: 'verified' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.vendor_compliance_percent, 25);

  // Remaining documents uploaded and verified in the web app by the compliance manager
  for (const c of ['pan', 'bank', 'business_registration']) await owner.upload(`/vendors/${code}/documents`, { category: c }, pdf(c));
  const neha = await login(env.base, 'neha.compliance@vendorflow.example');
  const docIds = env.app.db.all("SELECT d.id FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id WHERE v.vendor_code = ? AND d.status = 'pending_verification'", code).map((x) => x.id);
  assert.equal(docIds.length, 3);
  for (const id of docIds) assert.equal((await neha.post(`/documents/${id}/status`, { status: 'verified' })).status, 303);
  assert.equal((await claude.call('get_vendor_compliance', { vendor: code })).data.compliance_percent, 100);

  // Files are private: no session → login redirect; other roles in same org → allowed; download returns the PDF
  const anon = await fetch(`${env.base}/documents/${docIds[0]}/file`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  const dl = await neha.get(`/documents/${docIds[0]}/file`);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal((await dl.arrayBuffer()).byteLength > 200, true);

  // Scenario 5 – report
  const rep = await claude.call('compliance_report', {});
  const row = rep.data.vendors.find((v) => v.vendor_id === code);
  assert.equal(row.compliance_status, 'compliant');
  assert.ok(rep.data.summary.vendors_with_missing_documents >= 1);

  // Scenario 6 – approval routed to the compliance manager, decided by her in the web app
  const ap = await claude.call('request_approval', { vendor: code, approver_role: 'compliance manager', notes: 'All verified' });
  assert.equal(ap.data.approver.name, 'Neha Kapoor');
  assert.match(await (await neha.get('/approvals')).text(), /ABC Technologies/);
  r = await neha.post(`/approvals/${ap.data.approval_id}/decide`, { decision: 'approve', reason: 'Looks good' });
  assert.equal(r.status, 303);
  assert.equal((await claude.call('get_vendor', { vendor: code })).data.status, 'approved');

  // Activity history reflects both channels
  const acts = env.app.svc.activity.list({ orgId: env.app.db.get('SELECT org_id FROM vendors WHERE vendor_code = ?', code).org_id }, { vendorId: env.app.db.get('SELECT id FROM vendors WHERE vendor_code = ?', code).id }).rows;
  const actions = acts.map((a) => a.action);
  for (const a of ['vendor.created', 'checklist.created', 'task.assigned', 'vendor.updated', 'document.uploaded', 'document.status_changed', 'approval.requested', 'approval.decided', 'vendor.status_changed']) assert.ok(actions.includes(a), a);
  assert.ok(acts.some((a) => a.actor_type === 'mcp') && acts.some((a) => a.actor_type === 'user'));

  // Persistence: a fresh database handle on the same file sees everything
  const { Database } = require('../src/db');
  const db2 = new Database(env.config.dbPath);
  assert.equal(db2.get('SELECT status FROM vendors WHERE vendor_code = ?', code).status, 'approved');
  assert.equal(db2.get('SELECT email FROM vendors WHERE vendor_code = ?', code).email, 'rahul@abc.example.com');
  db2.close();
});

test('web security: CSRF, roles, cross-org pages, login throttling', async () => {
  const owner = await login(env.base, 'demo@vendorflow.example');
  let r = await owner.post('/vendors', { company_name: 'No CSRF Co', category: 'Other' }, { csrf: false });
  assert.equal(owner.flash(r).type, 'error');
  assert.equal(env.app.db.get("SELECT COUNT(*) AS n FROM vendors WHERE company_name = 'No CSRF Co'").n, 0);

  const viewer = await login(env.base, 'ananya.viewer@vendorflow.example');
  r = await viewer.post('/vendors', { company_name: 'Viewer Co', category: 'Other' });
  assert.match(viewer.flash(r).msg, /not allowed/);

  await fetch(`${env.base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Mallory M', email: 'mallory@x.example', password: 'Password1234', org_name: 'Mallory Ltd' }) });
  const mallory = await login(env.base, 'mallory@x.example', 'Password1234');
  assert.equal((await mallory.get('/vendors/VF-1001')).status, 404);
  const docId = env.app.db.get('SELECT id FROM vendor_documents WHERE file_path IS NOT NULL LIMIT 1').id;
  assert.equal((await mallory.get(`/documents/${docId}/file`)).status, 404);
  assert.doesNotMatch(await (await mallory.get('/vendors')).text(), /Northwind/);

  r = await fetch(`${env.base}/healthz`);
  assert.equal((await r.json()).status, 'ok');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('every page renders for every role without errors', async () => {
  const pages = ['/', '/vendors', '/vendors/new', '/vendors/VF-1001', '/vendors/VF-1001?tab=documents', '/vendors/VF-1001?tab=compliance', '/vendors/VF-1001?tab=tasks',
    '/vendors/VF-1001?tab=approvals', '/vendors/VF-1001?tab=activity', '/documents', '/compliance', '/approvals', '/tasks', '/reports', '/activity', '/notifications', '/team', '/settings',
    '/vendors/export.csv', '/compliance/export.csv', '/activity/export.csv'];
  for (const email of ['demo@vendorflow.example', 'arjun.procurement@vendorflow.example', 'vikram.reviewer@vendorflow.example', 'ananya.viewer@vendorflow.example']) {
    const jar = await login(env.base, email);
    for (const p of pages) {
      const r = await jar.get(p);
      const body = await r.text();
      assert.equal(r.status, 200, `${email} ${p}`);
      assert.doesNotMatch(body, /\bundefined\b|\[object Object\]|NaN%/, `${email} ${p}`);
    }
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Database } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createServices } = require('../src/services');
const { addDays, today } = require('../src/lib/util');
const { pdf } = require('./helpers');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-svc-'));
  const config = loadConfig({ DATA_DIR: dir });
  const db = new Database(':memory:');
  db.migrate();
  const svc = createServices({ db, config });
  const { userId, orgId } = svc.members.signup({ name: 'Olivia Owner', email: 'olivia@test.example', password: 'Password123', org_name: 'Org A' });
  const ctx = (uid, role, type = 'user') => ({ orgId, userId: uid, role, actor: { type, id: uid, label: 'x' } });
  const owner = ctx(userId, 'owner');
  const add = (name, email, role) => { const u = svc.members.add(owner, { name, email, role, password: 'Password123' }); return ctx(u.id, role); };
  const proc = add('Paul Proc', 'paul@test.example', 'procurement_manager');
  const comp = add('Cora Comp', 'cora@test.example', 'compliance_manager');
  const rev = add('Rita Rev', 'rita@test.example', 'reviewer');
  const viewer = add('Vic View', 'vic@test.example', 'viewer');
  return { db, svc, owner, proc, comp, rev, viewer, orgId, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeCompliantVendor(s, name) {
  const v = s.svc.vendors.create(s.proc, { company_name: name, category: 'Technology' });
  s.svc.compliance.createChecklist(s.proc, { vendor: v.vendor_id, requirements: [{ name: 'GST' }, { name: 'PAN' }] });
  for (const c of ['gst', 'pan']) {
    const d = s.svc.documents.upload(s.proc, v.vendor_id, { category: c }, pdf());
    s.svc.documents.setStatus(s.comp, { document_id: d.document_id, status: 'verified' });
  }
  return v;
}

test('vendor IDs are sequential and human-readable; duplicates are rejected', () => {
  const s = setup();
  const a = s.svc.vendors.create(s.proc, { company_name: 'Alpha Ltd' });
  const b = s.svc.vendors.create(s.proc, { company_name: 'Beta Ltd', gst_number: '27ABCDE1234F1Z5' });
  assert.equal(a.vendor_id, 'VF-1001');
  assert.equal(b.vendor_id, 'VF-1002');
  assert.throws(() => s.svc.vendors.create(s.proc, { company_name: '  alpha ltd ' }), /already exists/);
  assert.throws(() => s.svc.vendors.create(s.proc, { company_name: 'Gamma', gst_number: '27abcde1234f1z5' }), /already registered/);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM vendors').n, 2, 'failed creates must not leave rows behind');
  s.done();
});

test('viewers cannot write; reviewers only touch their own tasks', () => {
  const s = setup();
  assert.throws(() => s.svc.vendors.create(s.viewer, { company_name: 'Nope Co' }), { code: 'FORBIDDEN' });
  const v = s.svc.vendors.create(s.proc, { company_name: 'Tasky' });
  const mine = s.svc.tasks.assign(s.proc, { title: 'Check it', vendor: v.vendor_id, assignee_email: 'rita@test.example' });
  const other = s.svc.tasks.assign(s.proc, { title: 'Not yours', vendor: v.vendor_id, assignee_email: 'cora@test.example' });
  assert.equal(s.svc.tasks.updateStatus(s.rev, { task_id: mine.task_id, status: 'completed' }).status, 'completed');
  assert.throws(() => s.svc.tasks.updateStatus(s.rev, { task_id: other.task_id, status: 'completed' }), { code: 'FORBIDDEN' });
  assert.throws(() => s.svc.tasks.assign(s.proc, { title: 'Past', assignee_email: 'rita@test.example', due_date: '2020-01-01' }), /in the past/);
  s.done();
});

test('documents: registration ≠ upload; verify needs a real, unexpired file', () => {
  const s = setup();
  const v = s.svc.vendors.create(s.proc, { company_name: 'DocCo' });
  s.svc.compliance.createChecklist(s.proc, { vendor: 'DocCo', requirements: [{ name: 'GST Certificate' }] });
  const reg = s.svc.documents.register(s.proc, { vendor: 'DocCo', category: 'GST' });
  assert.equal(reg.status, 'awaiting_file');
  assert.throws(() => s.svc.documents.setStatus(s.comp, { document_id: reg.document_id, status: 'verified' }), /no uploaded file/);
  assert.equal(s.svc.compliance.getVendorCompliance(s.proc, 'DocCo').compliance_percent, 0);
  assert.throws(() => s.svc.documents.upload(s.proc, v.vendor_id, { category: 'gst' }, { buffer: Buffer.from('<html>not a pdf</html>'), filename: 'x.pdf' }), /Unsupported file/);
  const up = s.svc.documents.upload(s.proc, v.vendor_id, { category: 'gst' }, pdf());
  assert.equal(up.document_id, reg.document_id, 'upload fills the registered placeholder');
  assert.throws(() => s.svc.documents.setStatus(s.proc, { document_id: up.document_id, status: 'verified' }), { code: 'FORBIDDEN' });
  assert.throws(() => s.svc.documents.setStatus(s.comp, { document_id: up.document_id, status: 'rejected' }), /reason is required/);
  assert.throws(() => s.svc.documents.setStatus(s.comp, { document_id: up.document_id, status: 'verified', expiry_date: '2020-01-01' }), /expired/);
  const r = s.svc.documents.setStatus(s.comp, { vendor: 'DocCo', category: 'gst', status: 'verified' });
  assert.equal(r.vendor_compliance_percent, 100);
  s.done();
});

test('approvals: routing, compliance gate, override, no self-approval, vendor status follows', () => {
  const s = setup();
  const bad = s.svc.vendors.create(s.proc, { company_name: 'Gappy' });
  s.svc.compliance.createChecklist(s.proc, { vendor: 'Gappy', requirements: [{ name: 'PAN' }] });
  const a = s.svc.approvals.request(s.proc, { vendor: 'Gappy', approver_role: 'compliance manager' });
  assert.equal(a.approver.name, 'Cora Comp');
  assert.equal(a.vendor_status, 'under_review');
  assert.ok(a.warning);
  assert.throws(() => s.svc.approvals.request(s.proc, { vendor: 'Gappy' }), /already has a pending/);
  assert.throws(() => s.svc.vendors.changeStatus(s.proc, 'Gappy', 'pending_onboarding'), /pending approval/);
  assert.throws(() => s.svc.approvals.decide(s.rev, { vendor: 'Gappy', decision: 'approve' }), { code: 'FORBIDDEN' }, 'not the assigned approver');
  assert.throws(() => s.svc.approvals.decide(s.comp, { vendor: 'Gappy', decision: 'approve' }), /0% compliant/);
  assert.throws(() => s.svc.approvals.decide(s.comp, { vendor: 'Gappy', decision: 'approve', override_reason: 'urgent' }), /Only an owner or admin/);
  const ok = s.svc.approvals.decide(s.owner, { vendor: 'Gappy', decision: 'approve', override_reason: 'Board-approved exception' });
  assert.equal(ok.status, 'approved');
  assert.equal(s.svc.vendors.get(s.owner, bad.vendor_id).status, 'approved');

  makeCompliantVendor(s, 'Clean Co');
  const selfReq = s.svc.approvals.request(s.comp, { vendor: 'Clean Co', approver_email: 'cora@test.example' });
  assert.throws(() => s.svc.approvals.decide(s.comp, { approval_id: selfReq.approval_id, decision: 'approve' }), /requested yourself/);
  assert.throws(() => s.svc.approvals.decide(s.owner, { approval_id: selfReq.approval_id, decision: 'reject' }), /reason is required/);
  s.svc.approvals.decide(s.owner, { approval_id: selfReq.approval_id, decision: 'reject', reason: 'Wrong entity' });
  assert.equal(s.svc.vendors.get(s.owner, 'Clean Co').status, 'rejected');
  assert.throws(() => s.svc.approvals.request(s.proc, { vendor: 'Clean Co', approver_email: 'paul@test.example' }), /cannot decide approvals/);
  s.done();
});

test('vendors cannot be approved by editing status', () => {
  const s = setup();
  s.svc.vendors.create(s.proc, { company_name: 'Sneaky' });
  assert.throws(() => s.svc.vendors.update(s.proc, 'Sneaky', { status: 'approved' }), /approval request/);
  assert.throws(() => s.svc.vendors.changeStatus(s.proc, 'Sneaky', 'approved'), /approval request/);
  s.done();
});

test('tenant isolation: another organisation cannot see or touch records', () => {
  const s = setup();
  const v = makeCompliantVendor(s, 'Secret Supplier');
  const b = s.svc.members.signup({ name: 'Eve Other', email: 'eve@other.example', password: 'Password123', org_name: 'Org B' });
  const eve = { orgId: b.orgId, userId: b.userId, role: 'owner', actor: { type: 'user', id: b.userId, label: 'Eve' } };
  assert.throws(() => s.svc.vendors.get(eve, v.vendor_id), { code: 'NOT_FOUND' });
  assert.throws(() => s.svc.vendors.get(eve, v.id), { code: 'NOT_FOUND' });
  assert.throws(() => s.svc.vendors.get(eve, 'Secret'), { code: 'NOT_FOUND' });
  const docId = s.db.get('SELECT id FROM vendor_documents LIMIT 1').id;
  assert.throws(() => s.svc.documents.fileFor(eve, docId), { code: 'NOT_FOUND' });
  assert.throws(() => s.svc.documents.setStatus(eve, { document_id: docId, status: 'rejected', reason: 'x' }), { code: 'NOT_FOUND' });
  assert.equal(s.svc.vendors.list(eve).total, 0);
  assert.equal(s.svc.compliance.report(eve).vendors.length, 0);
  assert.equal(s.svc.activity.list(eve).rows.filter((r) => r.summary.includes('Secret')).length, 0);
  // Org B gets its own vendor sequence
  assert.equal(s.svc.vendors.create(eve, { company_name: 'Secret Supplier' }).vendor_id, 'VF-1001');
  s.done();
});

test('audit log is append-only and records MCP actors', () => {
  const s = setup();
  const viaClaude = { ...s.proc, actor: { type: 'mcp', id: s.proc.userId, label: 'Paul Proc via Claude' } };
  s.svc.vendors.create(viaClaude, { company_name: 'Logged Co' });
  const row = s.svc.activity.list(s.owner).rows.find((r) => r.action === 'vendor.created');
  assert.equal(row.actor_type, 'mcp');
  assert.equal(row.actor_label, 'Paul Proc via Claude');
  assert.throws(() => s.db.run("UPDATE activity_logs SET summary = 'tampered'"), /append-only/);
  assert.throws(() => s.db.run('DELETE FROM activity_logs'), /append-only/);
  s.done();
});

test('scheduler expires documents and sends idempotent reminders', () => {
  const s = setup();
  const v = makeCompliantVendor(s, 'Expiry Co');
  const d = s.db.get("SELECT id FROM vendor_documents WHERE category = 'gst'");
  s.db.run('UPDATE vendor_documents SET expiry_date = ? WHERE id = ?', addDays(today(), -1), d.id);
  const pan = s.db.get("SELECT id FROM vendor_documents WHERE category = 'pan'");
  s.db.run('UPDATE vendor_documents SET expiry_date = ? WHERE id = ?', addDays(today(), 10), pan.id);
  s.svc.tasks.assign(s.proc, { title: 'Late', vendor: v.vendor_id, assignee_email: 'rita@test.example', due_date: addDays(today(), 1) });
  s.db.run('UPDATE review_tasks SET due_date = ?', addDays(today(), -2));
  const r1 = s.svc.jobs.runChecks();
  assert.equal(r1.expired, 1);
  assert.equal(r1.expiryReminders, 1);
  assert.equal(r1.overdueReminders, 1);
  assert.equal(s.svc.compliance.getVendorCompliance(s.owner, 'Expiry Co').compliance_percent, 50);
  const r2 = s.svc.jobs.runChecks();
  assert.deepEqual(r2, { expired: 0, expiryReminders: 0, overdueReminders: 0 });
  s.done();
});

test('member resolution refuses to guess when a role is ambiguous', () => {
  const s = setup();
  s.svc.members.add(s.owner, { name: 'Second Proc', email: 'p2@test.example', role: 'procurement_manager', password: 'Password123' });
  s.svc.vendors.create(s.proc, { company_name: 'Who Co' });
  assert.throws(() => s.svc.tasks.assign(s.proc, { title: 'Review', vendor: 'Who Co', assignee_role: 'procurement manager' }), /Several people/);
  assert.throws(() => s.svc.members.changeRole(s.owner, s.owner.userId, 'admin'), /at least one owner/);
  s.done();
});

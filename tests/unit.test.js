'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../src/lib/validate');
const { computeCompliance, effectiveDocStatus } = require('../src/services/compliance');
const { sniffMime } = require('../src/services/documents');
const { MATRIX, P, can } = require('../src/auth/permissions');
const { toCsv } = require('../src/lib/csv');
const { hashPassword, verifyPassword } = require('../src/auth/passwords');
const D = require('../src/domain');
const { demoPdf } = require('../src/seed');

test('validator: required, formats, enums and unknown fields', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['name'], properties: {
    name: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' }, when: { type: 'string', format: 'date' },
    level: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer', minimum: 1 }, items: { type: 'array', maxItems: 2, items: { type: 'string' } } } };
  assert.deepEqual(validate(schema, { name: '  Acme  ', n: '3' }), { name: 'Acme', n: 3 });
  assert.throws(() => validate(schema, {}), /name is required/);
  assert.throws(() => validate(schema, { name: 'Ok', email: 'nope' }), /valid email/);
  assert.throws(() => validate(schema, { name: 'Ok', when: '2026-02-30' }), /YYYY-MM-DD/);
  assert.throws(() => validate(schema, { name: 'Ok', level: 'c' }), /one of: a, b/);
  assert.throws(() => validate(schema, { name: 'Ok', extra: 1 }), /extra is not a recognised field/);
  assert.deepEqual(validate(schema, { name: 'Ok', extra: 1 }, { stripUnknown: true }), { name: 'Ok' });
  assert.throws(() => validate(schema, { name: 'Ok', items: ['1', '2', '3'] }), /at most 2/);
  assert.throws(() => validate(schema, { name: 'Ok', n: 0 }), /≥ 1/);
});

test('compliance: % counts only verified, unexpired mandatory requirements', () => {
  const items = [
    { id: 1, name: 'GST', doc_category: 'gst', mandatory: 1 },
    { id: 2, name: 'PAN', doc_category: 'pan', mandatory: 1 },
    { id: 3, name: 'Bank', doc_category: 'bank', mandatory: 1 },
    { id: 4, name: 'Registration', doc_category: 'business_registration', mandatory: 1 },
    { id: 5, name: 'ISO', doc_category: 'quality', mandatory: 0 },
  ];
  const day = '2026-06-01';
  const docs = [
    { id: 'a', category: 'gst', status: 'verified', expiry_date: '2027-01-01', file_path: 'x', created_at: '1' },
    { id: 'b', category: 'pan', status: 'pending_verification', file_path: 'x', created_at: '1' },
    { id: 'c', category: 'bank', status: 'verified', expiry_date: '2026-05-01', file_path: 'x', created_at: '1' }, // expired
    { id: 'd', category: 'business_registration', status: 'awaiting_file', created_at: '1' }, // record without file
    { id: 'e', category: 'quality', status: 'verified', file_path: 'x', created_at: '1' },
  ];
  const c = computeCompliance(items, docs, day);
  assert.equal(c.mandatoryTotal, 4);
  assert.equal(c.mandatoryMet, 1);
  assert.equal(c.percent, 25);
  assert.equal(c.status, 'partial');
  assert.deepEqual(c.items.map((i) => i.state), ['verified', 'pending', 'expired', 'missing', 'verified']);
  assert.deepEqual(c.missing, ['Registration']);
  assert.deepEqual(c.expired, ['Bank']);
});

test('compliance: edge cases (no checklist, all verified, best document wins, expiring soon)', () => {
  assert.equal(computeCompliance([], []).status, 'no_checklist');
  assert.equal(computeCompliance([], []).percent, null);
  const items = [{ id: 1, name: 'GST', doc_category: 'gst', mandatory: 1 }];
  const docs = [
    { id: 'old', category: 'gst', status: 'rejected', file_path: 'x', created_at: '2' },
    { id: 'new', category: 'gst', status: 'verified', expiry_date: '2026-06-10', file_path: 'x', created_at: '1' },
  ];
  const c = computeCompliance(items, docs, '2026-06-01');
  assert.equal(c.percent, 100);
  assert.equal(c.status, 'compliant');
  assert.equal(c.items[0].document.id, 'new');
  assert.deepEqual(c.expiringSoon, ['GST']);
  assert.equal(computeCompliance(items, [{ ...docs[0], deleted_at: 'x' }]).status, 'non_compliant');
  assert.equal(effectiveDocStatus({ status: 'verified', expiry_date: '2020-01-01' }, '2026-01-01'), 'expired');
  assert.equal(effectiveDocStatus({ status: 'rejected', expiry_date: '2020-01-01' }, '2026-01-01'), 'rejected');
});

test('file type sniffing ignores names and claimed types', () => {
  assert.equal(sniffMime(demoPdf('x', ['y'])), 'application/pdf');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffMime(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffMime(Buffer.from('MZ executable....')), null);
});

test('role permissions are defined centrally and least-privilege', () => {
  const ctx = (role) => ({ role });
  assert.ok(can(ctx('owner'), P.MEMBER_MANAGE));
  assert.ok(!can(ctx('procurement_manager'), P.DOCUMENT_VERIFY));
  assert.ok(can(ctx('compliance_manager'), P.APPROVAL_DECIDE));
  assert.ok(!can(ctx('reviewer'), P.VENDOR_WRITE));
  assert.equal(MATRIX.viewer.length, 0);
  for (const role of D.ROLES) assert.ok(Array.isArray(MATRIX[role]), role);
});

test('vendor status transitions never allow skipping approval', () => {
  for (const [from, tos] of Object.entries(D.VENDOR_TRANSITIONS)) {
    if (from !== 'under_review' && from !== 'suspended') assert.ok(!tos.includes('approved'), `${from} → approved should not be a manual transition`);
  }
  assert.ok(D.VENDOR_TRANSITIONS.archived.includes('draft'));
});

test('document category and role aliases', () => {
  assert.equal(D.normaliseDocCategory('GST'), 'gst');
  assert.equal(D.normaliseDocCategory('GST Certificate'), 'gst');
  assert.equal(D.normaliseDocCategory('bank letter'), 'bank');
  assert.equal(D.normaliseDocCategory('ISO 9001'), 'quality');
  assert.equal(D.normaliseDocCategory('Certificate of Incorporation'), 'incorporation');
  assert.equal(D.normaliseDocCategory('banana'), null);
  assert.equal(D.normaliseRole('the procurement manager'), 'procurement_manager');
  assert.equal(D.normaliseRole('Compliance Manager'), 'compliance_manager');
});

test('CSV escapes quotes and blocks spreadsheet formula injection', () => {
  const csv = toCsv([{ label: 'A', key: 'a' }, { label: 'B', key: 'b' }], [{ a: '=HYPERLINK("x")', b: 'He said "hi", ok' }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"He said ""hi"", ok"/);
});

test('passwords are salted scrypt hashes', () => {
  const h1 = hashPassword('Correct-horse-1');
  const h2 = hashPassword('Correct-horse-1');
  assert.notEqual(h1, h2);
  assert.ok(verifyPassword('Correct-horse-1', h1));
  assert.ok(!verifyPassword('wrong-password-1', h1));
});

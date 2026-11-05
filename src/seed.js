'use strict';
/**
 * Demonstration data. Every organisation, person, vendor, GSTIN/PAN and document
 * here is fictional and flagged is_demo = 1. Document files are generated PDFs
 * stamped "DEMONSTRATION DOCUMENT – NOT A REAL CERTIFICATE".
 */
const { uuid, nowIso, today, addDays } = require('./lib/util');
const { hashPassword } = require('./auth/passwords');
const D = require('./domain');

function demoPdf(title, lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const body = [
    'BT /F1 9 Tf 0.8 0 0 rg 72 760 Td (DEMONSTRATION DOCUMENT - NOT A REAL CERTIFICATE - VENDORFLOW SAMPLE DATA) Tj ET',
    `BT /F1 20 Tf 0 0 0 rg 72 715 Td (${esc(title)}) Tj ET`,
    `BT /F1 11 Tf 72 680 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`,
    '0.85 0.85 0.85 RG 2 w 60 40 492 740 re S',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PEOPLE = [
  ['Priya Nair', 'demo@vendorflow.example', 'owner'],
  ['Rohan Desai', 'rohan.admin@vendorflow.example', 'admin'],
  ['Arjun Mehta', 'arjun.procurement@vendorflow.example', 'procurement_manager'],
  ['Neha Kapoor', 'neha.compliance@vendorflow.example', 'compliance_manager'],
  ['Vikram Rao', 'vikram.reviewer@vendorflow.example', 'reviewer'],
  ['Ananya Iyer', 'ananya.viewer@vendorflow.example', 'viewer'],
];

function seedDemo({ db, svc, config, log = () => {} }) {
  if (db.get('SELECT 1 FROM organizations WHERE is_demo = 1')) return { skipped: true };
  const t = today();
  const pw = hashPassword(config.demoPassword);
  const users = {};

  // People + organisation
  db.tx(() => {
    for (const [name, email, role] of PEOPLE) {
      const id = uuid();
      db.run('INSERT INTO profiles (id, email, name, password_hash, is_demo, created_at) VALUES (?,?,?,?,1,?)', id, email, name, pw, nowIso());
      users[role] = { id, name, role };
    }
  });
  const orgId = db.tx(() => svc.members.createOrg({ name: 'Acme Manufacturing (Demo)', ownerId: users.owner.id, ownerName: users.owner.name, isDemo: true }));
  db.run("UPDATE organizations SET legal_name = 'Acme Manufacturing Demo Pvt Ltd', country = 'India', address = '4th Floor, Demo Tech Park, Pune 411001', tax_id = '27DEMOZ0000Z1Z0' WHERE id = ?", orgId);
  for (const role of PEOPLE.map((p) => p[2]).filter((r) => r !== 'owner')) {
    db.run('INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?,?,?,?,?)', uuid(), orgId, users[role].id, role, nowIso());
  }
  const ctx = (role, type = 'user') => ({ orgId, userId: users[role].id, role, actor: { type, id: users[role].id, label: type === 'mcp' ? `${users[role].name} via Claude` : users[role].name } });
  const owner = ctx('owner'), proc = ctx('procurement_manager'), comp = ctx('compliance_manager'), procClaude = ctx('procurement_manager', 'mcp');

  // Vendors: [name, category, contact, risk, monthsAgo, scenario]
  const V = [
    ['Northwind Logistics', 'Logistics', 'Kabir Malhotra', 'low', 5, 'approved'],
    ['Sahyadri Steel Industries', 'Raw Materials', 'Meera Kulkarni', 'medium', 5, 'approved_expiring'],
    ['BrightPath IT Services', 'Technology', 'Sanjay Pillai', 'medium', 4, 'approved_gst_expired'],
    ['Lotus Facility Management', 'Facilities', 'Farah Sheikh', 'low', 3, 'under_review'],
    ['Kaveri Packaging Solutions', 'Manufacturing', 'Ravi Shankar', 'medium', 2, 'partial'],
    ['Zenith Marketing Collective', 'Marketing', 'Tanya Bose', 'medium', 2, 'pan_rejected'],
    ['Apex Legal Associates', 'Professional Services', 'Aditi Rao', 'low', 4, 'approved'],
    ['Monsoon Cloud Hosting', 'Technology', 'Dev Banerjee', 'high', 0, 'draft_claude'],
    ['Deccan Chemicals', 'Raw Materials', 'Imran Qureshi', 'critical', 5, 'suspended'],
    ['Coastal Freight Carriers', 'Logistics', 'Joseph Fernandes', 'high', 1, 'rejected'],
    ['Indigo Print House', 'Marketing', 'Lata Menon', 'low', 1, 'awaiting_file'],
    ['Greenleaf Office Supplies', 'Facilities', 'Harish Gupta', 'low', 3, 'approved_optional_pending'],
  ];
  const letters = 'ABCDEFGHJKLM';
  const vendors = {};
  V.forEach(([name, category, contact, risk, monthsAgo, scenario], i) => {
    const L = letters[i];
    const c = scenario === 'draft_claude' ? procClaude : proc;
    const v = svc.vendors.create(c, {
      company_name: name, legal_name: `${name} Pvt Ltd (Demo)`, category, contact_person: contact,
      email: `${contact.split(' ')[0].toLowerCase()}@${name.split(' ')[0].toLowerCase()}.example.com`, phone: `+91 90000 0${String(1000 + i).slice(1)}`,
      website: `https://${name.split(' ')[0].toLowerCase()}.example.com`, address: `${10 + i} Demo Industrial Estate, ${['Pune', 'Mumbai', 'Bengaluru', 'Chennai', 'Hyderabad', 'Ahmedabad'][i % 6]}`, country: 'India',
      gst_number: `27DEMO${L}${1000 + i}${L}1Z${i % 10}`, pan_number: `DEMO${L}${1000 + i}${L}`, registration_number: `U00000MH2019PTC${String(100000 + i)}`,
      risk, status: scenario === 'draft_claude' ? 'draft' : 'pending_onboarding',
      notes: 'Demonstration vendor. All details are fictional.',
    });
    const created = new Date(Date.now() - (monthsAgo * 30 + (i % 7)) * 86400000).toISOString();
    db.run('UPDATE vendors SET is_demo = 1, created_at = ?, onboarding_date = ?, manager_id = ? WHERE id = ?', created, created.slice(0, 10), users.procurement_manager.id, v.id);
    vendors[scenario + i] = { ...v, scenario, idx: i };
  });

  const upload = (v, cat, { expiry, verify, reject, by = proc } = {}) => {
    const d = svc.documents.upload(by, v.vendor_id, { category: cat, issue_date: addDays(t, -300), expiry_date: expiry },
      { buffer: demoPdf(D.DOC_CATEGORY_LABELS[cat], [`Vendor: ${v.company_name} (Demo)`, `Vendor ID: ${v.vendor_id}`, `Issued: ${addDays(t, -300)}`, expiry ? `Valid until: ${expiry}` : 'No expiry', 'This file is sample data for evaluating VendorFlow.']),
        filename: `${cat}-${v.vendor_id.toLowerCase()}.pdf` });
    db.run("UPDATE vendor_documents SET source = 'seed' WHERE id = ?", d.document_id);
    if (verify) svc.documents.setStatus(comp, { document_id: d.document_id, status: 'verified' });
    if (reject) svc.documents.setStatus(comp, { document_id: d.document_id, status: 'rejected', reason: reject });
    return d;
  };
  const STD = ['gst', 'pan', 'bank', 'business_registration'];
  const checklist = (v, extra = []) => svc.compliance.createChecklist(proc, { vendor: v.vendor_id, requirements: [
    ...STD.map((c) => ({ name: D.DOC_CATEGORY_LABELS[c], category: c, mandatory: true })), ...extra] });
  const approve = (v) => {
    svc.approvals.request(proc, { vendor: v.vendor_id, approver_role: 'compliance_manager', notes: 'All mandatory documents verified. Recommend approval.' });
    svc.approvals.decide(comp, { vendor: v.vendor_id, decision: 'approve', reason: 'Documents verified; bank details confirmed.' });
  };

  for (const v of Object.values(vendors)) {
    const yr = addDays(t, 300 + v.idx * 5);
    switch (v.scenario) {
      case 'approved':
        checklist(v, [{ name: 'Insurance Certificate', category: 'insurance', mandatory: false }]);
        STD.forEach((c) => upload(v, c, { verify: true, expiry: c === 'gst' ? yr : undefined }));
        upload(v, 'insurance', { verify: true, expiry: addDays(t, 200) });
        approve(v);
        break;
      case 'approved_expiring':
        checklist(v, [{ name: 'Insurance Certificate', category: 'insurance', mandatory: true }]);
        STD.forEach((c) => upload(v, c, { verify: true }));
        upload(v, 'insurance', { verify: true, expiry: addDays(t, 12) });
        approve(v);
        break;
      case 'approved_gst_expired': {
        checklist(v, [{ name: 'ISO 27001 Certificate', category: 'quality', mandatory: true }]);
        const gst = upload(v, 'gst', { verify: true, expiry: addDays(t, 30) });
        ['pan', 'bank', 'business_registration'].forEach((c) => upload(v, c, { verify: true }));
        upload(v, 'quality', { verify: true, expiry: addDays(t, 25) });
        approve(v);
        db.run('UPDATE vendor_documents SET expiry_date = ? WHERE id = ?', addDays(t, -6), gst.document_id); // lapsed since approval
        break;
      }
      case 'under_review':
        checklist(v);
        ['gst', 'pan'].forEach((c) => upload(v, c, { verify: true }));
        ['bank', 'business_registration'].forEach((c) => upload(v, c));
        svc.approvals.request(proc, { vendor: v.vendor_id, approver_role: 'compliance_manager', notes: 'Facilities contract for Pune plant starts next month. Bank letter and registration uploaded today.' });
        break;
      case 'partial':
        checklist(v);
        upload(v, 'gst', { verify: true, expiry: addDays(t, 280) });
        upload(v, 'pan');
        break;
      case 'pan_rejected':
        checklist(v);
        upload(v, 'gst', { verify: true });
        upload(v, 'pan', { reject: 'Name on PAN card does not match the legal entity name.' });
        upload(v, 'bank');
        break;
      case 'draft_claude':
        break; // created "via Claude", no checklist yet
      case 'suspended':
        checklist(v, [{ name: 'Insurance Certificate', category: 'insurance', mandatory: true }, { name: 'Quality Certificate', category: 'quality', mandatory: true }]);
        STD.forEach((c) => upload(v, c, { verify: true }));
        { const ins = upload(v, 'insurance', { verify: true, expiry: addDays(t, 20) });
          const q = upload(v, 'quality', { verify: true, expiry: addDays(t, 20) });
          approve(v);
          db.run('UPDATE vendor_documents SET expiry_date = ? WHERE id IN (?, ?)', addDays(t, -15), ins.document_id, q.document_id); }
        svc.vendors.changeStatus(owner, v.vendor_id, 'suspended');
        break;
      case 'rejected':
        checklist(v, [{ name: 'Insurance Certificate', category: 'insurance', mandatory: true }]);
        STD.forEach((c) => upload(v, c, { verify: true }));
        upload(v, 'insurance', { reject: 'Policy does not cover cargo liability.' });
        svc.approvals.request(proc, { vendor: v.vendor_id, approver_role: 'compliance_manager', notes: 'Urgent: needed for Q4 freight.' });
        svc.approvals.decide(comp, { vendor: v.vendor_id, decision: 'reject', reason: 'Insurance certificate does not cover cargo liability; vendor must resubmit.' });
        break;
      case 'awaiting_file':
        checklist(v);
        upload(v, 'gst', { verify: true });
        svc.documents.register(procClaude, { vendor: v.vendor_id, category: 'pan', expiry_date: undefined });
        svc.documents.register(procClaude, { vendor: v.vendor_id, category: 'bank', name: 'Cancelled cheque / bank letter' });
        break;
      case 'approved_optional_pending':
        checklist(v, [{ name: 'ISO 9001 Certificate', category: 'quality', mandatory: false }]);
        STD.forEach((c) => upload(v, c, { verify: true }));
        upload(v, 'quality', { expiry: addDays(t, 400) });
        approve(v);
        break;
      default:
    }
  }

  // Tasks
  const byName = (n) => Object.values(vendors).find((v) => v.company_name === n);
  const task = (vendorName, title, role, priority, due, status, opts = {}) => {
    const tk = svc.tasks.assign(proc, { title, vendor: vendorName ? byName(vendorName).vendor_id : undefined, assignee_email: PEOPLE.find((p) => p[2] === role)[1], priority, due_date: due > t ? due : addDays(t, 1), description: opts.description });
    if (due <= t) db.run('UPDATE review_tasks SET due_date = ? WHERE id = ?', due, tk.task_id);
    if (status !== 'todo') svc.tasks.updateStatus(role === 'reviewer' ? ctx('reviewer') : comp, { task_id: tk.task_id, status });
  };
  task('Lotus Facility Management', 'Verify bank letter and business registration', 'compliance_manager', 'high', addDays(t, 2), 'in_progress', { description: 'Both uploaded; check names match the GST certificate.' });
  task('Kaveri Packaging Solutions', 'Chase missing bank verification & registration', 'procurement_manager', 'medium', addDays(t, -3), 'todo');
  task('Zenith Marketing Collective', 'Request corrected PAN card', 'procurement_manager', 'high', addDays(t, 4), 'todo');
  task('BrightPath IT Services', 'Collect renewed GST certificate', 'procurement_manager', 'critical', addDays(t, -1), 'todo', { description: 'GST certificate lapsed after approval; vendor is non-compliant.' });
  task('Sahyadri Steel Industries', 'Insurance renewal follow-up', 'procurement_manager', 'medium', addDays(t, 10), 'todo');
  task('Deccan Chemicals', 'Quarterly risk review', 'reviewer', 'high', addDays(t, 14), 'blocked', { description: 'Blocked until renewed insurance and quality certificates arrive.' });
  task('Northwind Logistics', 'Annual compliance review', 'reviewer', 'low', addDays(t, 30), 'todo');
  task('Apex Legal Associates', 'Onboarding compliance review', 'compliance_manager', 'medium', addDays(t, -20), 'completed');
  task(null, 'Update supplier code of conduct template', 'compliance_manager', 'low', addDays(t, 21), 'todo');

  svc.jobs.runChecks();
  log(`[seed] demo organisation created: ${Object.keys(vendors).length} vendors, ${PEOPLE.length} users`);
  return { orgId, users };
}

module.exports = { seedDemo, demoPdf, PEOPLE };

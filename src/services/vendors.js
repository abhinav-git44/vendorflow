'use strict';
const { uuid, nowIso, today } = require('../lib/util');
const { E, fromDbError } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { P, requirePerm } = require('../auth/permissions');
const D = require('../domain');

const GST = { type: 'string', pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', patternHint: '15-character GSTIN, e.g. 27ABCDE1234F1Z5' };
const PAN = { type: 'string', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', patternHint: '10-character PAN, e.g. ABCDE1234F' };

const vendorFields = {
  company_name: { type: 'string', minLength: 2, maxLength: 160, description: 'Trading / display name of the vendor company.' },
  legal_name: { type: 'string', maxLength: 200, description: 'Registered legal entity name, if different.' },
  category: { type: 'string', maxLength: 60, description: `Vendor category, e.g. ${D.DEFAULT_VENDOR_CATEGORIES.join(', ')}.` },
  contact_person: { type: 'string', maxLength: 120 },
  email: { type: 'string', format: 'email', maxLength: 160 },
  phone: { type: 'string', pattern: '^\\+?[0-9 ()-]{7,20}$', patternHint: 'digits, spaces, +, - and brackets only', maxLength: 24 },
  website: { type: 'string', maxLength: 200, description: 'Website URL. https:// is added if missing.' },
  address: { type: 'string', maxLength: 400, description: 'Registered address.' },
  country: { type: 'string', maxLength: 80 },
  gst_number: { ...GST, description: 'Indian GSTIN (15 characters), where applicable.' },
  pan_number: { ...PAN, description: 'Indian PAN (10 characters), where applicable.' },
  registration_number: { type: 'string', maxLength: 60, description: 'Company / business registration number (e.g. CIN).' },
  bank_verification_status: { type: 'string', enum: D.BANK_STATUSES },
  onboarding_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
  risk: { type: 'string', enum: D.RISK_LEVELS, description: 'Risk classification.' },
  notes: { type: 'string', maxLength: 2000, description: 'Internal notes (not shared with the vendor).' },
  manager_email: { type: 'string', format: 'email', description: 'Email of the team member who manages this vendor.' },
  manager_id: { type: 'string', maxLength: 64, description: 'Internal user id of the manager (web form).' },
};

const createSchema = {
  type: 'object', additionalProperties: false, required: ['company_name'],
  properties: { ...vendorFields, status: { type: 'string', enum: ['draft', 'pending_onboarding'], description: 'Initial status (default pending_onboarding).' } },
};
const updateSchema = {
  type: 'object', additionalProperties: false,
  properties: { ...vendorFields, status: { type: 'string', enum: D.VENDOR_STATUSES } },
};
const listSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 100 },
    status: { type: 'string', enum: [...D.VENDOR_STATUSES, 'active', 'all'] },
    category: { type: 'string', maxLength: 60 },
    risk: { type: 'string', enum: D.RISK_LEVELS },
    compliance: { type: 'string', enum: ['compliant', 'partial', 'non_compliant', 'no_checklist'] },
    manager_id: { type: 'string', maxLength: 64 },
    sort: { type: 'string', enum: ['name', 'newest', 'oldest', 'code', 'status', 'compliance', 'risk'] },
    page: { type: 'integer', minimum: 1, maximum: 10000 },
    page_size: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

const companyKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function preprocess(input) {
  const v = { ...input };
  for (const k of ['gst_number', 'pan_number']) if (typeof v[k] === 'string') v[k] = v[k].toUpperCase().replace(/\s+/g, '');
  if (typeof v.website === 'string' && v.website.trim() && !/^https?:\/\//i.test(v.website.trim())) v.website = 'https://' + v.website.trim();
  if (typeof v.category === 'string' && v.category.trim()) {
    const match = D.DEFAULT_VENDOR_CATEGORIES.find((c) => c.toLowerCase() === v.category.trim().toLowerCase());
    if (match) v.category = match;
  }
  return v;
}

module.exports = function vendorService({ db, config, svc }) {
  const link = (code, tab) => `${config.appUrl}/vendors/${code}${tab ? `?tab=${tab}` : ''}`;

  function rowById(ctx, id) {
    return db.get('SELECT * FROM vendors WHERE id = ? AND org_id = ?', id, ctx.orgId);
  }

  /** Find a vendor by code (VF-1001), id or name. Never crosses org boundaries. */
  function resolve(ctx, ref) {
    if (!ref || typeof ref !== 'string' || !ref.trim()) throw E.validation('A vendor reference (vendor ID like VF-1001 or company name) is required.');
    const r = ref.trim();
    let row;
    if (/^VF-\d+$/i.test(r)) row = db.get('SELECT * FROM vendors WHERE org_id = ? AND vendor_code = ?', ctx.orgId, r.toUpperCase());
    else if (/^[0-9a-f-]{36}$/i.test(r)) row = rowById(ctx, r);
    else {
      row = db.get('SELECT * FROM vendors WHERE org_id = ? AND company_key = ?', ctx.orgId, companyKey(r));
      if (!row) {
        const like = db.all("SELECT * FROM vendors WHERE org_id = ? AND (company_name LIKE ? OR legal_name LIKE ?) AND status != 'archived' LIMIT 6",
          ctx.orgId, `%${r}%`, `%${r}%`);
        if (like.length === 1) row = like[0];
        else if (like.length > 1) throw E.ambiguous(`"${r}" matches several vendors: ${like.map((v) => `${v.company_name} (${v.vendor_code})`).join(', ')}. Use the vendor ID.`);
      }
    }
    if (!row) throw E.notFound(`Vendor "${r}" was not found in this organisation.`);
    return row;
  }

  function managerFrom(ctx, v) {
    if (v.manager_email) return svc.members.resolve(ctx, { email: v.manager_email }).id;
    if (v.manager_id) {
      if (!svc.members.membership(v.manager_id, ctx.orgId)) throw E.validation('The selected manager is not a member of this organisation.');
      return v.manager_id;
    }
    return undefined;
  }

  function checkDuplicates(ctx, { company_name, gst_number }, excludeId) {
    if (company_name) {
      const dup = db.get('SELECT vendor_code, company_name, status FROM vendors WHERE org_id = ? AND company_key = ? AND id != ?',
        ctx.orgId, companyKey(company_name), excludeId || '');
      if (dup) throw E.conflict(`A vendor named "${dup.company_name}" already exists (${dup.vendor_code}, ${D.VENDOR_STATUS_LABELS[dup.status]}).`, { vendor_id: dup.vendor_code });
    }
    if (gst_number) {
      const dup = db.get('SELECT vendor_code, company_name FROM vendors WHERE org_id = ? AND gst_number = ? AND id != ?', ctx.orgId, gst_number, excludeId || '');
      if (dup) throw E.conflict(`GSTIN ${gst_number} is already registered to ${dup.company_name} (${dup.vendor_code}).`, { vendor_id: dup.vendor_code });
    }
  }

  function create(ctx, input) {
    requirePerm(ctx, P.VENDOR_WRITE, 'create vendors');
    const v = validate(createSchema, preprocess(input), { stripUnknown: ctx.actor.type === 'user' });
    const managerId = managerFrom(ctx, v) ?? (['procurement_manager'].includes(ctx.role) ? ctx.userId : null);
    try {
      return db.tx(() => {
        checkDuplicates(ctx, v);
        const seq = db.get('UPDATE organizations SET vendor_seq = vendor_seq + 1 WHERE id = ? RETURNING vendor_seq', ctx.orgId).vendor_seq;
        const id = uuid();
        const code = `VF-${seq}`;
        const ts = nowIso();
        db.run(
          `INSERT INTO vendors (id, org_id, vendor_code, company_name, company_key, legal_name, category, contact_person, email, phone, website,
             address, country, gst_number, pan_number, registration_number, bank_verification_status, onboarding_date, manager_id, status, risk,
             notes, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, ctx.orgId, code, v.company_name, companyKey(v.company_name), v.legal_name, v.category || 'Other', v.contact_person, v.email,
          v.phone, v.website, v.address, v.country || (v.gst_number || v.pan_number ? 'India' : null), v.gst_number, v.pan_number,
          v.registration_number, v.bank_verification_status || 'not_started', v.onboarding_date || today(), managerId,
          v.status || 'pending_onboarding', v.risk || 'medium', v.notes, ctx.userId || null, ts, ts,
        );
        svc.activity.log(ctx, { action: 'vendor.created', entityType: 'vendor', entityId: id, vendorId: id, summary: `Created vendor ${v.company_name} (${code})` });
        const recipients = [managerId, ...svc.notifications.usersWithRoles(ctx.orgId, ['owner', 'admin'])];
        svc.notifications.notify(ctx, recipients, { type: 'vendor.created', title: `New vendor: ${v.company_name}`, body: `${code} was added by ${ctx.actor.label}.`, link: `/vendors/${code}` });
        return get(ctx, code);
      });
    } catch (err) {
      throw fromDbError(err) || err;
    }
  }

  function update(ctx, ref, input) {
    requirePerm(ctx, P.VENDOR_WRITE, 'edit vendors');
    const current = resolve(ctx, ref);
    const v = validate(updateSchema, preprocess(input), { stripUnknown: ctx.actor.type === 'user' });
    const managerId = managerFrom(ctx, v);
    const fields = Object.keys(vendorFields).filter((k) => !['manager_email', 'manager_id'].includes(k) && k in v);
    const changes = {};
    for (const k of fields) if ((v[k] ?? null) !== (current[k] ?? null)) changes[k] = { from: current[k], to: v[k] ?? null };
    if (managerId !== undefined && managerId !== current.manager_id) changes.manager_id = { from: current.manager_id, to: managerId };
    if (v.status && v.status !== current.status) {
      if (v.status === 'archived') throw E.state('Use archive to archive a vendor.');
      assertTransition(current.status, v.status);
    }
    try {
      return db.tx(() => {
        checkDuplicates(ctx, { company_name: changes.company_name ? v.company_name : null, gst_number: changes.gst_number ? v.gst_number : null }, current.id);
        const sets = Object.keys(changes).map((k) => `${k} = ?`);
        const vals = Object.keys(changes).map((k) => changes[k].to);
        if (changes.company_name) { sets.push('company_key = ?'); vals.push(companyKey(v.company_name)); }
        if (sets.length) {
          db.run(`UPDATE vendors SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`, ...vals, nowIso(), current.id, ctx.orgId);
          const changed = Object.keys(changes).filter((k) => k !== 'manager_id').map((k) => k.replace(/_/g, ' '));
          if (changes.manager_id) changed.push('manager');
          svc.activity.log(ctx, { action: 'vendor.updated', entityType: 'vendor', entityId: current.id, vendorId: current.id,
            summary: `Updated ${current.company_name}: ${changed.join(', ')}`, metadata: { changes } });
        }
        if (v.status && v.status !== current.status) logStatus(ctx, current, v.status);
        return get(ctx, current.id);
      });
    } catch (err) {
      throw fromDbError(err) || err;
    }
  }

  function assertTransition(from, to) {
    if (to === 'approved') throw E.state('Vendors are approved by deciding an approval request (request_approval → decide_approval), not by editing their status.');
    if (!D.VENDOR_TRANSITIONS[from].includes(to)) {
      throw E.state(`A vendor cannot move from ${D.VENDOR_STATUS_LABELS[from]} to ${D.VENDOR_STATUS_LABELS[to]}. Allowed next statuses: ${D.VENDOR_TRANSITIONS[from].map((s) => D.VENDOR_STATUS_LABELS[s]).join(', ')}.` +
        (to === 'approved' ? ' Vendors are approved through an approval request.' : ''));
    }
  }

  /** Internal: used by approvals; bypasses manual-transition rules but still audits. */
  function setStatusInternal(ctx, vendor, to) {
    db.run('UPDATE vendors SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', to, nowIso(), vendor.id, ctx.orgId);
    logStatus(ctx, vendor, to);
  }

  function logStatus(ctx, vendor, to) {
    if (!db.get('SELECT 1 FROM vendors WHERE id = ? AND status = ?', vendor.id, to)) {
      db.run('UPDATE vendors SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', to, nowIso(), vendor.id, ctx.orgId);
    }
    svc.activity.log(ctx, { action: 'vendor.status_changed', entityType: 'vendor', entityId: vendor.id, vendorId: vendor.id,
      summary: `${vendor.company_name} status: ${D.VENDOR_STATUS_LABELS[vendor.status]} → ${D.VENDOR_STATUS_LABELS[to]}`, metadata: { from: vendor.status, to } });
  }

  function changeStatus(ctx, ref, to) {
    requirePerm(ctx, to === 'archived' ? P.VENDOR_ARCHIVE : P.VENDOR_WRITE, to === 'archived' ? 'archive vendors' : 'change vendor status');
    const vendor = resolve(ctx, ref);
    if (!D.VENDOR_STATUSES.includes(to)) throw E.validation('Unknown vendor status.');
    if (vendor.status === to) return get(ctx, vendor.id);
    assertTransition(vendor.status, to);
    if (to !== 'archived' && db.get("SELECT 1 FROM approval_requests WHERE vendor_id = ? AND status = 'pending'", vendor.id)) {
      throw E.state(`${vendor.company_name} has a pending approval request. Decide or cancel it first.`);
    }
    return db.tx(() => {
      logStatus(ctx, vendor, to);
      if (to === 'archived') {
        db.run("UPDATE approval_requests SET status = 'cancelled', updated_at = ? WHERE vendor_id = ? AND status = 'pending'", nowIso(), vendor.id);
        db.run("UPDATE review_tasks SET status = 'cancelled', updated_at = ? WHERE vendor_id = ? AND status IN ('todo','in_progress','blocked')", nowIso(), vendor.id);
      }
      return get(ctx, vendor.id);
    });
  }

  const archive = (ctx, ref) => changeStatus(ctx, ref, 'archived');

  function toDto(row, compliance) {
    const manager = row.manager_id ? db.get('SELECT id, name, email FROM profiles WHERE id = ?', row.manager_id) : null;
    return {
      vendor_id: row.vendor_code,
      id: row.id,
      company_name: row.company_name,
      legal_name: row.legal_name,
      category: row.category,
      status: row.status,
      status_label: D.VENDOR_STATUS_LABELS[row.status],
      risk: row.risk,
      contact_person: row.contact_person,
      email: row.email,
      phone: row.phone,
      website: row.website,
      address: row.address,
      country: row.country,
      gst_number: row.gst_number,
      pan_number: row.pan_number,
      registration_number: row.registration_number,
      bank_verification_status: row.bank_verification_status,
      onboarding_date: row.onboarding_date,
      manager: manager ? { name: manager.name, email: manager.email, id: manager.id } : null,
      notes: row.notes,
      is_demo: Boolean(row.is_demo),
      compliance: compliance ? { percent: compliance.percent, status: compliance.status, mandatory_met: compliance.mandatoryMet, mandatory_total: compliance.mandatoryTotal } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      app_url: link(row.vendor_code),
    };
  }

  function get(ctx, ref) {
    const row = resolve(ctx, ref);
    return toDto(row, svc.compliance.forVendor(ctx, row.id));
  }

  function list(ctx, input = {}) {
    const f = validate(listSchema, input, { stripUnknown: true });
    const where = ['org_id = ?'];
    const params = [ctx.orgId];
    const status = f.status || 'active';
    if (status === 'active') where.push("status != 'archived'");
    else if (status !== 'all') { where.push('status = ?'); params.push(status); }
    if (f.category) { where.push('category = ? COLLATE NOCASE'); params.push(f.category); }
    if (f.risk) { where.push('risk = ?'); params.push(f.risk); }
    if (f.manager_id) { where.push('manager_id = ?'); params.push(f.manager_id); }
    if (f.q) {
      where.push('(company_name LIKE ? OR legal_name LIKE ? OR vendor_code LIKE ? OR contact_person LIKE ? OR email LIKE ? OR gst_number LIKE ?)');
      const like = `%${f.q}%`;
      params.push(like, like, like, like, like, like);
    }
    const order = {
      name: 'company_name COLLATE NOCASE ASC', newest: 'created_at DESC', oldest: 'created_at ASC', code: 'CAST(substr(vendor_code, 4) AS INTEGER) ASC',
      status: 'status ASC, company_name ASC', risk: "CASE risk WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, company_name",
      compliance: 'company_name',
    }[f.sort || 'newest'];
    let rows = db.all(`SELECT * FROM vendors WHERE ${where.join(' AND ')} ORDER BY ${order}`, ...params);
    const compMap = svc.compliance.forOrg(ctx);
    if (f.compliance) rows = rows.filter((r) => (compMap.get(r.id) || { status: 'no_checklist' }).status === f.compliance);
    if (f.sort === 'compliance') rows.sort((a, b) => (compMap.get(a.id)?.percent ?? -1) - (compMap.get(b.id)?.percent ?? -1));
    const pageSize = f.page_size || 25;
    const page = f.page || 1;
    const total = rows.length;
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    return { total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), vendors: slice.map((r) => toDto(r, compMap.get(r.id))) };
  }

  function categories(ctx) {
    const used = db.all('SELECT DISTINCT category FROM vendors WHERE org_id = ? ORDER BY category', ctx.orgId).map((r) => r.category);
    const tpl = db.all('SELECT DISTINCT vendor_category AS c FROM compliance_requirements WHERE org_id = ?', ctx.orgId).map((r) => r.c);
    return [...new Set([...D.DEFAULT_VENDOR_CATEGORIES, ...tpl, ...used])].sort();
  }

  return { resolve, rowById, create, update, changeStatus, setStatusInternal, archive, get, list, toDto, categories, link, schemas: { createSchema, updateSchema, vendorFields } };
};

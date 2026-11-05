'use strict';
const { uuid, nowIso, today, addDays } = require('../lib/util');
const { E } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { P, requirePerm } = require('../auth/permissions');
const D = require('../domain');

const EXPIRING_WINDOW_DAYS = 30;

/** The document status as of a given day: past-expiry documents are expired, whatever their stored status. */
function effectiveDocStatus(doc, onDate = today()) {
  if (!doc) return 'missing';
  if (doc.expiry_date && doc.expiry_date < onDate && ['uploaded', 'pending_verification', 'verified'].includes(doc.status)) return 'expired';
  return doc.status;
}

const RANK = { verified: 0, pending_verification: 1, uploaded: 2, awaiting_file: 3, rejected: 4, expired: 5 };

/**
 * Pure compliance calculation (unit-tested).
 * Compliance % = valid & verified mandatory requirements / total mandatory requirements × 100.
 * A record existing is never enough: it must have a file, be verified, and be unexpired.
 */
function computeCompliance(items, docs, onDate = today()) {
  const soon = addDays(onDate, EXPIRING_WINDOW_DAYS);
  const detailed = items.map((item) => {
    const candidates = docs
      .filter((d) => d.category === item.doc_category && !d.deleted_at)
      .map((d) => ({ ...d, effective: effectiveDocStatus(d, onDate) }))
      .sort((a, b) => (RANK[a.effective] - RANK[b.effective]) || String(b.created_at).localeCompare(String(a.created_at)));
    const doc = candidates[0] || null;
    let state;
    if (!doc || doc.effective === 'awaiting_file') state = 'missing';
    else if (doc.effective === 'uploaded' || doc.effective === 'pending_verification') state = 'pending';
    else state = doc.effective; // verified | rejected | expired
    const expiringSoon = state === 'verified' && doc.expiry_date && doc.expiry_date <= soon;
    return {
      id: item.id, name: item.name, doc_category: item.doc_category, mandatory: Boolean(item.mandatory), state,
      expiring_soon: Boolean(expiringSoon),
      document: doc ? { id: doc.id, name: doc.name, status: doc.effective, expiry_date: doc.expiry_date, has_file: Boolean(doc.file_path) } : null,
    };
  });
  const mandatory = detailed.filter((d) => d.mandatory);
  const met = mandatory.filter((d) => d.state === 'verified').length;
  const percent = !items.length ? null : mandatory.length ? Math.round((met / mandatory.length) * 100) : 100;
  let status;
  if (!items.length) status = 'no_checklist';
  else if (percent === 100) status = 'compliant';
  else if (met > 0) status = 'partial';
  else status = 'non_compliant';
  const by = (s) => detailed.filter((d) => d.state === s).map((d) => d.name);
  return {
    percent, status, mandatoryTotal: mandatory.length, mandatoryMet: met, items: detailed,
    missing: by('missing'), pending: by('pending'), rejected: by('rejected'), expired: by('expired'),
    expiringSoon: detailed.filter((d) => d.expiring_soon).map((d) => d.name),
  };
}

const COMPLIANCE_LABELS = { compliant: 'Fully compliant', partial: 'Partially compliant', non_compliant: 'Non-compliant', no_checklist: 'No checklist' };

const requirementSchema = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120, description: 'Requirement name, e.g. "GST Certificate".' },
    category: { type: 'string', maxLength: 60, description: `Document category. One of: ${D.DOC_CATEGORIES.join(', ')} (common aliases like "GST", "PAN", "bank" also work). Inferred from the name if omitted.` },
    mandatory: { type: 'boolean', description: 'Defaults to true.' },
  },
};
const checklistSchema = {
  type: 'object', additionalProperties: false, required: ['vendor'],
  properties: {
    vendor: { type: 'string', description: 'Vendor ID (e.g. VF-1001) or company name.' },
    name: { type: 'string', maxLength: 120, description: 'Checklist name (optional).' },
    requirements: { type: 'array', maxItems: 20, items: requirementSchema, description: 'Required documents. If omitted, the organisation template for the vendor category is applied.' },
    replace: { type: 'boolean', description: 'If true, remove existing requirements not in this list. Default false (merge).' },
  },
};

module.exports = function complianceService({ db, svc }) {
  function itemsFor(ctx, vendorId) {
    return db.all(`SELECT i.* FROM compliance_checklist_items i JOIN compliance_checklists c ON c.id = i.checklist_id
                   WHERE c.vendor_id = ? AND c.org_id = ? ORDER BY i.mandatory DESC, i.rowid`, vendorId, ctx.orgId);
  }
  const docsFor = (ctx, vendorId) => db.all('SELECT * FROM vendor_documents WHERE vendor_id = ? AND org_id = ? AND deleted_at IS NULL', vendorId, ctx.orgId);

  const forVendor = (ctx, vendorId) => computeCompliance(itemsFor(ctx, vendorId), docsFor(ctx, vendorId));

  /** Compliance for every vendor in the org, computed in one pass. */
  function forOrg(ctx) {
    const items = db.all(`SELECT i.*, c.vendor_id FROM compliance_checklist_items i JOIN compliance_checklists c ON c.id = i.checklist_id WHERE c.org_id = ? ORDER BY i.mandatory DESC, i.rowid`, ctx.orgId);
    const docs = db.all('SELECT * FROM vendor_documents WHERE org_id = ? AND deleted_at IS NULL', ctx.orgId);
    const vendors = db.all('SELECT id FROM vendors WHERE org_id = ?', ctx.orgId);
    const group = (arr) => arr.reduce((m, x) => (m.get(x.vendor_id) || m.set(x.vendor_id, []).get(x.vendor_id)).push(x) && m, new Map());
    const ig = group(items), dg = group(docs);
    const out = new Map();
    for (const v of vendors) out.set(v.id, computeCompliance(ig.get(v.id) || [], dg.get(v.id) || []));
    return out;
  }

  function templateFor(ctx, vendorCategory) {
    const rows = db.all('SELECT * FROM compliance_requirements WHERE org_id = ? AND vendor_category = ? COLLATE NOCASE ORDER BY mandatory DESC, name', ctx.orgId, vendorCategory);
    if (rows.length) return rows.map((r) => ({ name: r.name, category: r.doc_category, mandatory: Boolean(r.mandatory) }));
    return [['gst', 'GST Certificate'], ['pan', 'PAN Card'], ['bank', 'Bank Verification'], ['business_registration', 'Business Registration']]
      .map(([category, name]) => ({ name, category, mandatory: true }));
  }

  function createChecklist(ctx, input) {
    requirePerm(ctx, P.CHECKLIST_WRITE, 'create compliance checklists');
    const v = validate(checklistSchema, input);
    const vendor = svc.vendors.resolve(ctx, v.vendor);
    if (vendor.status === 'archived') throw E.state(`${vendor.company_name} is archived.`);
    const reqs = (v.requirements && v.requirements.length ? v.requirements : templateFor(ctx, vendor.category)).map((r, i) => {
      const cat = D.normaliseDocCategory(r.category) || D.normaliseDocCategory(r.name);
      if (!cat) throw E.validation(`requirements[${i}] "${r.name}": could not determine the document category. Use one of: ${D.DOC_CATEGORIES.join(', ')}.`);
      return { name: r.name, category: cat, mandatory: r.mandatory !== false };
    });
    const seen = new Set();
    for (const r of reqs) {
      if (seen.has(r.category)) throw E.validation(`Two requirements map to the same document category (${D.DOC_CATEGORY_LABELS[r.category]}). Each category can appear once per checklist.`);
      seen.add(r.category);
    }
    return db.tx(() => {
      const ts = nowIso();
      let cl = db.get('SELECT * FROM compliance_checklists WHERE vendor_id = ? AND org_id = ?', vendor.id, ctx.orgId);
      const created = !cl;
      if (!cl) {
        cl = { id: uuid() };
        db.run('INSERT INTO compliance_checklists (id, org_id, vendor_id, name, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          cl.id, ctx.orgId, vendor.id, v.name || `${vendor.company_name} onboarding checklist`, ctx.userId || null, ts, ts);
      } else {
        db.run('UPDATE compliance_checklists SET updated_at = ?, name = COALESCE(?, name) WHERE id = ?', ts, v.name || null, cl.id);
      }
      let added = 0, updatedN = 0, removed = 0;
      for (const r of reqs) {
        const existing = db.get('SELECT * FROM compliance_checklist_items WHERE checklist_id = ? AND doc_category = ?', cl.id, r.category);
        if (existing) {
          if (existing.name !== r.name || Boolean(existing.mandatory) !== r.mandatory) {
            db.run('UPDATE compliance_checklist_items SET name = ?, mandatory = ? WHERE id = ?', r.name, r.mandatory, existing.id);
            updatedN++;
          }
        } else {
          db.run('INSERT INTO compliance_checklist_items (id, org_id, checklist_id, name, doc_category, mandatory, created_at) VALUES (?,?,?,?,?,?,?)',
            uuid(), ctx.orgId, cl.id, r.name, r.category, r.mandatory, ts);
          added++;
        }
      }
      if (v.replace) {
        const keep = reqs.map((r) => r.category);
        removed = db.run(`DELETE FROM compliance_checklist_items WHERE checklist_id = ? AND doc_category NOT IN (${keep.map(() => '?').join(',')})`, cl.id, ...keep).changes;
      }
      const comp = forVendor(ctx, vendor.id);
      svc.activity.log(ctx, {
        action: created ? 'checklist.created' : 'checklist.updated', entityType: 'checklist', entityId: cl.id, vendorId: vendor.id,
        summary: `${created ? 'Created' : 'Updated'} compliance checklist for ${vendor.company_name}: ${reqs.map((r) => r.name).join(', ')} (${comp.percent}% compliant)`,
        metadata: { added, updated: updatedN, removed },
      });
      if (vendor.status === 'draft') svc.vendors.setStatusInternal(ctx, vendor, 'pending_onboarding');
      return { vendor_id: vendor.vendor_code, company_name: vendor.company_name, checklist_id: cl.id, created, added, updated: updatedN, removed, ...complianceDto(comp), app_url: svc.vendors.link(vendor.vendor_code, 'compliance') };
    });
  }

  function removeItem(ctx, vendorRef, itemId) {
    requirePerm(ctx, P.CHECKLIST_WRITE, 'edit compliance checklists');
    const vendor = svc.vendors.resolve(ctx, vendorRef);
    const item = db.get(`SELECT i.* FROM compliance_checklist_items i JOIN compliance_checklists c ON c.id = i.checklist_id
                         WHERE i.id = ? AND c.vendor_id = ? AND c.org_id = ?`, itemId, vendor.id, ctx.orgId);
    if (!item) throw E.notFound('Checklist requirement not found.');
    db.tx(() => {
      db.run('DELETE FROM compliance_checklist_items WHERE id = ?', item.id);
      svc.activity.log(ctx, { action: 'checklist.item_removed', entityType: 'checklist', entityId: item.checklist_id, vendorId: vendor.id, summary: `Removed requirement "${item.name}" from ${vendor.company_name}` });
    });
  }

  function complianceDto(c) {
    return {
      compliance_percent: c.percent, compliance_status: c.status, compliance_label: COMPLIANCE_LABELS[c.status],
      mandatory_met: c.mandatoryMet, mandatory_total: c.mandatoryTotal,
      requirements: c.items.map((i) => ({ name: i.name, category: i.doc_category, mandatory: i.mandatory, state: i.state, expiring_soon: i.expiring_soon,
        document: i.document && { document_id: i.document.id, status: i.document.status, expiry_date: i.document.expiry_date, has_file: i.document.has_file } })),
      missing: c.missing, pending_verification: c.pending, rejected: c.rejected, expired: c.expired, expiring_within_30_days: c.expiringSoon,
    };
  }

  function getVendorCompliance(ctx, vendorRef) {
    const vendor = svc.vendors.resolve(ctx, vendorRef);
    return { vendor_id: vendor.vendor_code, company_name: vendor.company_name, vendor_status: vendor.status, ...complianceDto(forVendor(ctx, vendor.id)), app_url: svc.vendors.link(vendor.vendor_code, 'compliance') };
  }

  function report(ctx, input = {}) {
    const f = validate({
      type: 'object', additionalProperties: false, properties: {
        vendor_status: { type: 'string', enum: [...D.VENDOR_STATUSES, 'active', 'all'] },
        compliance_status: { type: 'string', enum: Object.keys(COMPLIANCE_LABELS) },
        only_with_gaps: { type: 'boolean' },
        category: { type: 'string', maxLength: 60 },
        manager_id: { type: 'string', maxLength: 64 },
      },
    }, input, { stripUnknown: true });
    const where = ['org_id = ?'];
    const params = [ctx.orgId];
    const vs = f.vendor_status || 'active';
    if (vs === 'active') where.push("status != 'archived'");
    else if (vs !== 'all') { where.push('status = ?'); params.push(vs); }
    if (f.category) { where.push('category = ? COLLATE NOCASE'); params.push(f.category); }
    if (f.manager_id) { where.push('manager_id = ?'); params.push(f.manager_id); }
    const vendors = db.all(`SELECT * FROM vendors WHERE ${where.join(' AND ')} ORDER BY company_name COLLATE NOCASE`, ...params);
    const map = forOrg(ctx);
    let rows = vendors.map((v) => {
      const c = map.get(v.id);
      return {
        vendor_id: v.vendor_code, company_name: v.company_name, category: v.category, vendor_status: v.status, risk: v.risk,
        compliance_percent: c.percent, compliance_status: c.status, mandatory_met: c.mandatoryMet, mandatory_total: c.mandatoryTotal,
        missing: c.missing, pending_verification: c.pending, rejected: c.rejected, expired: c.expired, expiring_within_30_days: c.expiringSoon,
      };
    });
    if (f.compliance_status) rows = rows.filter((r) => r.compliance_status === f.compliance_status);
    if (f.only_with_gaps) rows = rows.filter((r) => r.compliance_status !== 'compliant');
    const count = (s) => rows.filter((r) => r.compliance_status === s).length;
    return {
      generated_at: nowIso(),
      summary: {
        vendors: rows.length, fully_compliant: count('compliant'), partially_compliant: count('partial'), non_compliant: count('non_compliant'), no_checklist: count('no_checklist'),
        vendors_with_missing_documents: rows.filter((r) => r.missing.length).length,
        vendors_with_expired_documents: rows.filter((r) => r.expired.length).length,
      },
      vendors: rows,
    };
  }

  function listTemplates(ctx) {
    return db.all('SELECT * FROM compliance_requirements WHERE org_id = ? ORDER BY vendor_category, mandatory DESC, name', ctx.orgId);
  }
  function addTemplate(ctx, input) {
    requirePerm(ctx, P.SETTINGS_MANAGE, 'change compliance requirements');
    const v = validate({ type: 'object', required: ['vendor_category', 'doc_category'], properties: {
      vendor_category: { type: 'string', minLength: 2, maxLength: 60 }, doc_category: { type: 'string', enum: D.DOC_CATEGORIES }, mandatory: { type: 'boolean' },
    } }, input, { stripUnknown: true });
    try {
      db.run('INSERT INTO compliance_requirements (id, org_id, vendor_category, name, doc_category, mandatory, created_at) VALUES (?,?,?,?,?,?,?)',
        uuid(), ctx.orgId, v.vendor_category, D.DOC_CATEGORY_LABELS[v.doc_category], v.doc_category, v.mandatory !== false, nowIso());
    } catch { throw E.conflict('That requirement already exists for this vendor category.'); }
  }
  function removeTemplate(ctx, id) {
    requirePerm(ctx, P.SETTINGS_MANAGE, 'change compliance requirements');
    db.run('DELETE FROM compliance_requirements WHERE id = ? AND org_id = ?', id, ctx.orgId);
  }

  return { forVendor, forOrg, createChecklist, removeItem, getVendorCompliance, report, templateFor, listTemplates, addTemplate, removeTemplate, complianceDto, schemas: { checklistSchema } };
};

module.exports.computeCompliance = computeCompliance;
module.exports.effectiveDocStatus = effectiveDocStatus;
module.exports.COMPLIANCE_LABELS = COMPLIANCE_LABELS;

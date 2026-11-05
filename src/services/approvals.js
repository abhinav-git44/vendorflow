'use strict';
const { uuid, nowIso } = require('../lib/util');
const { E } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { P, MATRIX, requirePerm } = require('../auth/permissions');
const D = require('../domain');

const requestSchema = {
  type: 'object', additionalProperties: false, required: ['vendor'],
  properties: {
    vendor: { type: 'string', description: 'Vendor ID (VF-1001) or company name.' },
    approver_email: { type: 'string', format: 'email', description: 'Approver email.' },
    approver_name: { type: 'string', maxLength: 80 },
    approver_role: { type: 'string', maxLength: 40, description: 'Route to whoever holds this role, e.g. "compliance manager".' },
    notes: { type: 'string', maxLength: 1000, description: 'Context for the approver.' },
  },
};
const decideSchema = {
  type: 'object', additionalProperties: false, required: ['decision'],
  properties: {
    approval_id: { type: 'string', description: 'Approval request ID. Alternatively give the vendor.' },
    vendor: { type: 'string', description: 'Vendor ID or name with a pending approval.' },
    decision: { type: 'string', enum: ['approve', 'reject'] },
    reason: { type: 'string', maxLength: 1000, description: 'Required for rejection; recorded in the audit trail.' },
    override_reason: { type: 'string', maxLength: 500, description: 'Only to approve a vendor that is not 100% compliant (owner/admin). Explain why.' },
  },
};

module.exports = function approvalService({ db, config, svc }) {
  const SELECT = `SELECT a.*, v.vendor_code, v.company_name, v.status AS vendor_status, p.name AS approver_name, p.email AS approver_email,
                  r.name AS requester_name, d.name AS decider_name
                  FROM approval_requests a JOIN vendors v ON v.id = a.vendor_id JOIN profiles p ON p.id = a.approver_id
                  LEFT JOIN profiles r ON r.id = a.requested_by LEFT JOIN profiles d ON d.id = a.decided_by`;

  function dto(row) {
    return {
      approval_id: row.id, type: row.type, status: row.status, vendor_id: row.vendor_code, company_name: row.company_name, vendor_status: row.vendor_status,
      approver: { name: row.approver_name, email: row.approver_email }, requested_by: row.requester_name, notes: row.notes,
      decision_reason: row.decision_reason, decided_by: row.decider_name, decided_at: row.decided_at, created_at: row.created_at,
      app_url: `${config.appUrl}/approvals?highlight=${row.id}`,
    };
  }
  function getRow(ctx, id) {
    const row = db.get(`${SELECT} WHERE a.id = ? AND a.org_id = ?`, id, ctx.orgId);
    if (!row) throw E.notFound('Approval request not found.');
    return row;
  }

  function request(ctx, input) {
    requirePerm(ctx, P.APPROVAL_REQUEST, 'request approvals');
    const v = validate(requestSchema, input, { stripUnknown: ctx.actor.type === 'user' });
    const vendor = svc.vendors.resolve(ctx, v.vendor);
    const approver = svc.members.resolve(ctx, { email: v.approver_email, name: v.approver_name, role: v.approver_role || (!v.approver_email && !v.approver_name ? 'compliance_manager' : undefined) }, 'route it to');
    if (!MATRIX[approver.role].includes(P.APPROVAL_DECIDE)) throw E.validation(`${approver.name} (${approver.role_label}) cannot decide approvals. Choose an owner, admin, compliance manager or reviewer.`);
    const pending = db.get("SELECT id FROM approval_requests WHERE vendor_id = ? AND status = 'pending'", vendor.id);
    if (pending) throw E.conflict(`${vendor.company_name} already has a pending approval request.`, { approval_id: pending.id });
    let type;
    if (['draft', 'pending_onboarding', 'under_review'].includes(vendor.status)) type = 'vendor_onboarding';
    else if (vendor.status === 'suspended') type = 'vendor_reactivation';
    else throw E.state(`${vendor.company_name} is ${D.VENDOR_STATUS_LABELS[vendor.status]}; approval can be requested for vendors in onboarding or suspended.`);
    return db.tx(() => {
      const id = uuid();
      const ts = nowIso();
      db.run(`INSERT INTO approval_requests (id, org_id, vendor_id, type, notes, approver_id, requested_by, status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`, id, ctx.orgId, vendor.id, type, v.notes, approver.id, ctx.userId || null, ts, ts);
      if (type === 'vendor_onboarding' && vendor.status !== 'under_review') svc.vendors.setStatusInternal(ctx, vendor, 'under_review');
      svc.activity.log(ctx, { action: 'approval.requested', entityType: 'approval', entityId: id, vendorId: vendor.id,
        summary: `Requested ${type.replace('vendor_', '')} approval for ${vendor.company_name} from ${approver.name}` });
      svc.notifications.notify(ctx, [approver.id], { type: 'approval.requested', title: `Approval needed: ${vendor.company_name}`, body: v.notes || `Requested by ${ctx.actor.label}`, link: `/approvals?highlight=${id}` });
      const comp = svc.compliance.forVendor(ctx, vendor.id);
      return { ...dto(getRow(ctx, id)), vendor_compliance_percent: comp.percent,
        warning: comp.status !== 'compliant' ? `Note: ${vendor.company_name} is ${comp.percent ?? 0}% compliant; outstanding: ${[...comp.missing, ...comp.pending, ...comp.rejected, ...comp.expired].join(', ') || 'no checklist'}.` : undefined };
    });
  }

  function decide(ctx, input) {
    requirePerm(ctx, P.APPROVAL_DECIDE, 'decide approvals');
    const v = validate(decideSchema, input);
    let row;
    if (v.approval_id) row = getRow(ctx, v.approval_id);
    else if (v.vendor) {
      const vendor = svc.vendors.resolve(ctx, v.vendor);
      const p = db.get("SELECT id FROM approval_requests WHERE vendor_id = ? AND org_id = ? AND status = 'pending'", vendor.id, ctx.orgId);
      if (!p) throw E.notFound(`${vendor.company_name} has no pending approval request.`);
      row = getRow(ctx, p.id);
    } else throw E.validation('Provide approval_id or vendor.');
    if (row.status !== 'pending') throw E.state(`This request is already ${row.status}.`);
    const isAdmin = ['owner', 'admin'].includes(ctx.role);
    if (row.approver_id !== ctx.userId && !isAdmin) throw E.forbidden(`This request is assigned to ${row.approver_name}. Only they (or an owner/admin) can decide it.`);
    if (row.requested_by === ctx.userId && !isAdmin) throw E.forbidden('You cannot decide an approval you requested yourself.');
    if (v.decision === 'reject' && !v.reason) throw E.validation('A reason is required to reject.');
    const vendor = svc.vendors.rowById(ctx, row.vendor_id);
    const comp = svc.compliance.forVendor(ctx, vendor.id);
    if (v.decision === 'approve' && comp.status !== 'compliant') {
      if (!v.override_reason) {
        throw E.state(`${vendor.company_name} is ${comp.percent ?? 0}% compliant (outstanding: ${[...comp.missing, ...comp.pending, ...comp.rejected, ...comp.expired].join(', ') || 'no checklist defined'}). ` +
          'Resolve these first, or an owner/admin can approve with an override_reason.');
      }
      if (!isAdmin) throw E.forbidden('Only an owner or admin can approve a vendor that is not fully compliant.');
    }
    return db.tx(() => {
      const ts = nowIso();
      const status = v.decision === 'approve' ? 'approved' : 'rejected';
      const reason = v.reason || (v.override_reason ? `Compliance override: ${v.override_reason}` : null);
      db.run('UPDATE approval_requests SET status = ?, decision_reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?', status, reason, ctx.userId, ts, ts, row.id);
      const fresh = svc.vendors.rowById(ctx, vendor.id);
      const vendorTo = status === 'approved' ? 'approved' : (row.type === 'vendor_reactivation' ? 'suspended' : 'rejected');
      if (fresh.status !== vendorTo) svc.vendors.setStatusInternal(ctx, fresh, vendorTo);
      svc.activity.log(ctx, { action: 'approval.decided', entityType: 'approval', entityId: row.id, vendorId: vendor.id,
        summary: `${status === 'approved' ? 'Approved' : 'Rejected'} ${vendor.company_name}${reason ? ` — ${reason}` : ''}`, metadata: { decision: status, override: Boolean(v.override_reason) } });
      svc.notifications.notify(ctx, [row.requested_by, vendor.manager_id], { type: `approval.${status}`, title: `${vendor.company_name} ${status}`, body: reason || `Decided by ${ctx.actor.label}`, link: `/vendors/${vendor.vendor_code}?tab=approvals` });
      return dto(getRow(ctx, row.id));
    });
  }

  function cancel(ctx, id) {
    requirePerm(ctx, P.APPROVAL_REQUEST, 'cancel approvals');
    const row = getRow(ctx, id);
    if (row.status !== 'pending') throw E.state('Only pending requests can be cancelled.');
    db.tx(() => {
      db.run("UPDATE approval_requests SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), row.id);
      const vendor = svc.vendors.rowById(ctx, row.vendor_id);
      if (vendor.status === 'under_review') svc.vendors.setStatusInternal(ctx, vendor, 'pending_onboarding');
      svc.activity.log(ctx, { action: 'approval.cancelled', entityType: 'approval', entityId: row.id, vendorId: row.vendor_id, summary: `Cancelled approval request for ${row.company_name}` });
    });
  }

  function list(ctx, f = {}) {
    const where = ['a.org_id = ?'];
    const params = [ctx.orgId];
    if (f.status && f.status !== 'all') { where.push('a.status = ?'); params.push(f.status); }
    if (f.vendorId) { where.push('a.vendor_id = ?'); params.push(f.vendorId); }
    if (f.approverId) { where.push('a.approver_id = ?'); params.push(f.approverId); }
    return db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 300`, ...params).map(dto);
  }

  function listPending(ctx, input = {}) {
    const v = validate({ type: 'object', additionalProperties: false, properties: {
      mine: { type: 'boolean', description: 'Only requests assigned to the connected user.' }, vendor: { type: 'string' },
    } }, input);
    const rows = list(ctx, { status: 'pending', approverId: v.mine ? ctx.userId : undefined, vendorId: v.vendor ? svc.vendors.resolve(ctx, v.vendor).id : undefined });
    const map = svc.compliance.forOrg(ctx);
    const withComp = rows.map((r) => {
      const vendor = svc.vendors.resolve(ctx, r.vendor_id);
      const c = map.get(vendor.id);
      return { ...r, vendor_compliance_percent: c.percent, vendor_compliance_status: c.status };
    });
    return { count: withComp.length, approvals: withComp };
  }

  return { request, decide, cancel, list, listPending, getRow, dto, schemas: { requestSchema, decideSchema } };
};

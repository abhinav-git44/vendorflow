'use strict';
const fs = require('node:fs');
const { redirect, send } = require('../../lib/http');
const { toCsv } = require('../../lib/csv');
const { can, P } = require('../../auth/permissions');
const D = require('../../domain');
const { COMPLIANCE_LABELS } = require('../../services/compliance');

module.exports = function workPages(router, W) {
  const { svc, layout: L, html } = W;

  // ======================= DOCUMENTS =======================
  router.get('/documents', W.auth(async (req, res) => {
    const q = req.query;
    const docs = q.status === 'expiring' ? svc.documents.expiring(req.ctx, { days: 30 }) : svc.documents.list(req.ctx, { status: q.status, category: q.category, q: q.q });
    const csrf = req.session.csrf;
    const canVerify = can(req.ctx, P.DOCUMENT_VERIFY);
    const body = html`
      ${L.pageHeader('Documents', 'Every compliance document across active vendors. Upload files from the vendor\'s Documents tab.')}
      <form class="filters" method="get">
        <input name="q" value="${q.q || ''}" placeholder="Search document or vendor" aria-label="Search">
        <select name="status" aria-label="Status"><option value="">Any status</option>${L.options([['pending', 'Awaiting verification'], ['awaiting_file', 'Awaiting file'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['expired', 'Expired'], ['expiring', 'Expiring within 30 days']], q.status)}</select>
        <select name="category" aria-label="Category"><option value="">Any type</option>${L.options(D.DOC_CATEGORIES, q.category, D.DOC_CATEGORY_LABELS)}</select>
        <button class="btn">Apply</button>${Object.keys(q).length ? html`<a class="btn ghost" href="/documents">Reset</a>` : ''}
      </form>
      <div class="card">${docs.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Document</th><th>Vendor</th><th>Status</th><th>Expiry</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${docs.map((d) => html`<tr>
          <td><strong>${d.name}</strong><div class="muted small">${d.category_label}</div></td>
          <td><a href="/vendors/${d.vendor_id}?tab=documents">${d.company_name}</a><div class="muted small">${d.vendor_id}</div></td>
          <td>${L.docBadge(d.status)}</td>
          <td>${d.expiry_date ? html`${L.fmtDate(d.expiry_date)}<div class="small ${d.days_to_expiry < 0 ? 'text-critical' : d.days_to_expiry <= 30 ? 'text-serious' : 'muted'}">${d.days_to_expiry < 0 ? `${-d.days_to_expiry}d ago` : `in ${d.days_to_expiry}d`}</div>` : html`<span class="muted">—</span>`}</td>
          <td class="small">${d.uploaded_at ? html`${L.fmtRelative(d.uploaded_at)}<div class="muted">${d.uploaded_by || ''}</div>` : html`<span class="muted">No file</span>`}</td>
          <td><div class="row gap end">${d.has_file ? html`<a class="btn sm ghost" href="/documents/${d.document_id}/file?inline=1" target="_blank" rel="noopener">Preview</a>` : ''}
            ${canVerify && d.has_file && ['pending_verification', 'uploaded'].includes(d.status) ? html`<form method="post" action="/documents/${d.document_id}/status"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="verified"><button class="btn sm success">Verify</button></form>` : ''}
            <a class="btn sm" href="/vendors/${d.vendor_id}?tab=documents#doc-${d.document_id}">Open</a></div></td></tr>`)}</tbody></table></div>`
    : L.emptyState('No documents match', q.status ? 'Try another filter.' : 'Documents appear here once uploaded on a vendor profile.')}</div>`;
    W.render(req, res, { title: 'Documents', active: 'documents', body });
  }));

  router.get('/documents/:id/file', W.auth(async (req, res) => {
    const f = svc.documents.fileFor(req.ctx, req.params.id);
    const disp = req.query.inline === '1' ? 'inline' : 'attachment';
    res.writeHead(200, {
      'Content-Type': f.mime, 'Content-Length': fs.statSync(f.abs).size, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${disp}; filename="${f.filename.replace(/"/g, '')}"`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
    });
    fs.createReadStream(f.abs).pipe(res);
  }));

  const backToDoc = (req, res, d) => W.back(req, res, `/vendors/${d.vendor_id}?tab=documents`);
  router.post('/documents/:id/status', W.auth(async (req, res) => {
    const r = svc.documents.setStatus(req.ctx, { document_id: req.params.id, status: req.body.status, reason: req.body.reason });
    W.flash(res, 'success', `${r.document.name} marked ${r.document.status_label.toLowerCase()}. ${r.document.company_name} is now ${r.vendor_compliance_percent ?? 0}% compliant.`);
    backToDoc(req, res, r.document);
  }));
  router.post('/documents/:id/replace', W.auth(async (req, res) => {
    const d = svc.documents.replace(req.ctx, req.params.id, req.files.file);
    W.flash(res, 'success', `New file uploaded for ${d.name}; it needs verification again.`);
    backToDoc(req, res, d);
  }));
  router.post('/documents/:id/attach', W.auth(async (req, res) => {
    const d = svc.documents.replace(req.ctx, req.params.id, req.files.file);
    W.flash(res, 'success', `${d.name} uploaded and awaiting verification.`);
    backToDoc(req, res, d);
  }));
  router.post('/documents/:id/dates', W.auth(async (req, res) => {
    svc.documents.setDates(req.ctx, req.params.id, { issue_date: req.body.issue_date, expiry_date: req.body.expiry_date });
    W.flash(res, 'success', 'Dates saved.');
    W.back(req, res, '/documents');
  }));
  router.post('/documents/:id/delete', W.auth(async (req, res) => {
    svc.documents.remove(req.ctx, req.params.id);
    W.flash(res, 'success', 'Document deleted.');
    W.back(req, res, '/documents');
  }));

  // ======================= COMPLIANCE =======================
  router.get('/compliance', W.auth(async (req, res) => {
    const q = req.query;
    const members = svc.members.list(req.ctx);
    const r = svc.compliance.report(req.ctx, { compliance_status: q.compliance, category: q.category, vendor_status: q.vendor_status || 'active', only_with_gaps: q.gaps === '1', manager_id: q.manager });
    const s = r.summary;
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const gapList = (arr, tone) => (arr.length ? html`<span class="gaps ${tone}">${arr.join(', ')}</span>` : '');
    const body = html`
      ${L.pageHeader('Compliance', 'Calculated from verified, unexpired documents against each vendor\'s mandatory checklist.', html`<a class="btn" href="/compliance/export.csv?${qs}">${L.icon('download')}Export CSV</a>`)}
      <section class="mini-stats">
        <a class="mini-stat" href="/compliance?compliance=compliant"><span>${L.badge('good', 'Fully compliant')}</span><strong>${s.fully_compliant}</strong></a>
        <a class="mini-stat" href="/compliance?compliance=partial"><span>${L.badge('warning', 'Partial')}</span><strong>${s.partially_compliant}</strong></a>
        <a class="mini-stat" href="/compliance?compliance=non_compliant"><span>${L.badge('critical', 'Non-compliant')}</span><strong>${s.non_compliant}</strong></a>
        <a class="mini-stat" href="/compliance?compliance=no_checklist"><span>${L.badge('neutral', 'No checklist')}</span><strong>${s.no_checklist}</strong></a>
        <a class="mini-stat" href="/compliance?gaps=1"><span>With missing documents</span><strong>${s.vendors_with_missing_documents}</strong></a>
        <a class="mini-stat" href="/documents?status=expired"><span>With expired documents</span><strong>${s.vendors_with_expired_documents}</strong></a>
      </section>
      <form class="filters" method="get">
        <select name="compliance" aria-label="Compliance"><option value="">Any compliance</option>${L.options(Object.entries(COMPLIANCE_LABELS), q.compliance)}</select>
        <select name="vendor_status" aria-label="Vendor status">${L.options([['active', 'All active vendors'], ...D.VENDOR_STATUSES.map((x) => [x, D.VENDOR_STATUS_LABELS[x]])], q.vendor_status || 'active')}</select>
        <select name="category" aria-label="Category"><option value="">All categories</option>${L.options(svc.vendors.categories(req.ctx), q.category)}</select>
        <select name="manager" aria-label="Manager"><option value="">Any manager</option>${L.options(members.map((m) => [m.id, m.name]), q.manager)}</select>
        <label class="check"><input type="checkbox" name="gaps" value="1" ${q.gaps === '1' ? 'checked' : ''}> Only vendors with gaps</label>
        <button class="btn">Apply</button>${Object.keys(q).length ? html`<a class="btn ghost" href="/compliance">Reset</a>` : ''}
      </form>
      <div class="card">${r.vendors.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Vendor</th><th>Status</th><th>Compliance</th><th>Outstanding</th></tr></thead>
        <tbody>${r.vendors.map((v) => html`<tr>
          <td><a class="strong" href="/vendors/${v.vendor_id}?tab=compliance">${v.company_name}</a><div class="muted small">${v.vendor_id} · ${v.category}</div></td>
          <td>${L.vendorBadge(v.vendor_status)}</td>
          <td>${L.progress(v.compliance_percent, v.compliance_status)}<div class="muted small">${v.mandatory_total ? `${v.mandatory_met}/${v.mandatory_total} mandatory verified` : ''}</div></td>
          <td class="small">${v.compliance_status === 'no_checklist' ? html`<span class="muted">Define a checklist</span>` : html`
            ${v.missing.length ? html`<div><strong>Missing:</strong> ${gapList(v.missing, 'critical')}</div>` : ''}
            ${v.pending_verification.length ? html`<div><strong>To verify:</strong> ${gapList(v.pending_verification, 'warning')}</div>` : ''}
            ${v.rejected.length ? html`<div><strong>Rejected:</strong> ${gapList(v.rejected, 'critical')}</div>` : ''}
            ${v.expired.length ? html`<div><strong>Expired:</strong> ${gapList(v.expired, 'serious')}</div>` : ''}
            ${v.expiring_within_30_days.length ? html`<div><strong>Expiring soon:</strong> ${gapList(v.expiring_within_30_days, 'serious')}</div>` : ''}
            ${v.compliance_status === 'compliant' && !v.expiring_within_30_days.length ? html`<span class="text-good">All mandatory documents verified</span>` : ''}`}</td></tr>`)}</tbody></table></div>`
    : L.emptyState('No vendors match these filters', null)}</div>`;
    W.render(req, res, { title: 'Compliance', active: 'compliance', body });
  }));

  router.get('/compliance/export.csv', W.auth(async (req, res) => {
    const q = req.query;
    const r = svc.compliance.report(req.ctx, { compliance_status: q.compliance, category: q.category, vendor_status: q.vendor_status || 'active', only_with_gaps: q.gaps === '1', manager_id: q.manager });
    const csv = toCsv([
      { label: 'Vendor ID', key: 'vendor_id' }, { label: 'Company', key: 'company_name' }, { label: 'Category', key: 'category' }, { label: 'Vendor status', key: 'vendor_status' },
      { label: 'Compliance % (calculated)', key: 'compliance_percent' }, { label: 'Compliance status (calculated)', key: 'compliance_status' },
      { label: 'Mandatory verified', key: 'mandatory_met' }, { label: 'Mandatory total', key: 'mandatory_total' },
      { label: 'Missing', key: 'missing' }, { label: 'Pending verification', key: 'pending_verification' }, { label: 'Rejected', key: 'rejected' }, { label: 'Expired', key: 'expired' },
      { label: 'Expiring within 30 days', key: 'expiring_within_30_days' },
    ], r.vendors);
    send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="compliance-${new Date().toISOString().slice(0, 10)}.csv"` });
  }));

  // ======================= APPROVALS =======================
  router.get('/approvals', W.auth(async (req, res) => {
    const status = req.query.status || 'pending';
    const mine = req.query.mine === '1';
    const list = svc.approvals.list(req.ctx, { status, approverId: mine ? req.ctx.userId : undefined });
    const comp = svc.compliance.forOrg(req.ctx);
    const csrf = req.session.csrf;
    const isAdmin = ['owner', 'admin'].includes(req.ctx.role);
    const tabs = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['all', 'All']];
    const body = html`
      ${L.pageHeader('Approvals', 'Vendor onboarding and reactivation decisions. Request approval from a vendor\'s Approvals tab or from Claude.')}
      <nav class="tabs">${tabs.map(([k, l]) => html`<a class="${status === k ? 'active' : ''}" href="/approvals?status=${k}${mine ? '&mine=1' : ''}">${l}</a>`)}
        <a class="${mine ? 'active' : ''} push" href="/approvals?status=${status}${mine ? '' : '&mine=1'}">${mine ? '✓ ' : ''}Assigned to me</a></nav>
      <div class="stack">${list.length ? list.map((a) => {
    const vendor = svc.vendors.resolve(req.ctx, a.vendor_id);
    const c = comp.get(vendor.id);
    const mayDecide = a.status === 'pending' && can(req.ctx, P.APPROVAL_DECIDE) && (isAdmin || a.approver.email === req.session.user.email);
    return html`<div class="card approval ${req.query.highlight === a.approval_id ? 'highlight' : ''}" id="a-${a.approval_id}">
          <div class="card-head"><div><h2><a href="/vendors/${a.vendor_id}">${a.company_name}</a> <span class="muted small">${a.vendor_id}</span></h2>
            <div class="muted small">${a.type === 'vendor_reactivation' ? 'Reactivation' : 'Onboarding'} · approver ${a.approver.name} · requested by ${a.requested_by || '—'} ${L.fmtRelative(a.created_at)}</div></div>${L.approvalBadge(a.status)}</div>
          <div class="pad approval-body">
            <div>${L.progress(c.percent, c.status)}<div class="muted small">${c.status === 'compliant' ? 'All mandatory documents verified' : `Outstanding: ${[...c.missing, ...c.pending, ...c.rejected, ...c.expired].join(', ') || 'no checklist defined'}`}</div>
              ${a.notes ? html`<p class="small"><strong>Notes:</strong> ${a.notes}</p>` : ''}${a.decision_reason ? html`<p class="small"><strong>Decision:</strong> ${a.decision_reason} — ${a.decided_by}, ${L.fmtRelative(a.decided_at)}</p>` : ''}</div>
            ${mayDecide ? html`<form method="post" action="/approvals/${a.approval_id}/decide" class="decide stack">
              <input type="hidden" name="csrf" value="${csrf}">
              <label class="field"><span>Reason / comment</span><input name="reason" maxlength="1000" placeholder="Required to reject"></label>
              ${c.status !== 'compliant' && isAdmin ? html`<label class="field"><span>Compliance override reason (owner/admin)</span><input name="override_reason" maxlength="500" placeholder="Required to approve a non-compliant vendor"></label>` : ''}
              <div class="row gap"><button class="btn success" name="decision" value="approve">${L.icon('check')}Approve</button><button class="btn danger" name="decision" value="reject">${L.icon('x')}Reject</button></div>
            </form>` : a.status === 'pending' && can(req.ctx, P.APPROVAL_REQUEST) ? html`<form method="post" action="/approvals/${a.approval_id}/cancel" data-confirm="Cancel this approval request?"><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm ghost">Cancel request</button></form>` : ''}
          </div></div>`;
  }) : html`<div class="card">${L.emptyState(status === 'pending' ? 'No pending approvals' : 'Nothing here', status === 'pending' ? 'The queue is clear.' : null)}</div>`}</div>`;
    W.render(req, res, { title: 'Approvals', active: 'approvals', body });
  }));

  router.post('/approvals', W.auth(async (req, res) => {
    const a = svc.approvals.request(req.ctx, { vendor: req.body.vendor, approver_email: req.body.approver_email, notes: req.body.notes });
    W.flash(res, 'success', `Approval requested from ${a.approver.name}.`);
    redirect(res, `/vendors/${a.vendor_id}?tab=approvals`);
  }));
  router.post('/approvals/:id/decide', W.auth(async (req, res) => {
    const a = svc.approvals.decide(req.ctx, { approval_id: req.params.id, decision: req.body.decision, reason: req.body.reason, override_reason: req.body.override_reason });
    W.flash(res, 'success', `${a.company_name} ${a.status}.`);
    redirect(res, `/approvals?status=${a.status}&highlight=${a.approval_id}`);
  }));
  router.post('/approvals/:id/cancel', W.auth(async (req, res) => {
    svc.approvals.cancel(req.ctx, req.params.id);
    W.flash(res, 'success', 'Approval request cancelled.');
    redirect(res, '/approvals');
  }));

  // ======================= TASKS =======================
  router.get('/tasks', W.auth(async (req, res) => {
    const q = req.query;
    const status = q.status || 'open';
    const members = svc.members.list(req.ctx);
    const tasks = svc.tasks.list(req.ctx, { status, assigneeId: q.mine === '1' ? req.ctx.userId : q.assignee || undefined, overdue: q.overdue === '1', priority: q.priority });
    const csrf = req.session.csrf;
    const canWrite = can(req.ctx, P.TASK_WRITE);
    const vendors = canWrite ? svc.vendors.list(req.ctx, { sort: 'name', page_size: 200 }).vendors : [];
    const body = html`
      ${L.pageHeader('Tasks', 'Review tasks and follow-ups. Overdue tasks trigger reminders automatically.')}
      <form class="filters" method="get">
        <select name="status" aria-label="Status">${L.options([['open', 'Open'], ...D.TASK_STATUSES.map((s) => [s, D.TASK_STATUS_LABELS[s]]), ['all', 'All']], status)}</select>
        <select name="assignee" aria-label="Assignee"><option value="">Anyone</option>${L.options(members.map((m) => [m.id, m.name]), q.assignee)}</select>
        <select name="priority" aria-label="Priority"><option value="">Any priority</option>${L.options(D.TASK_PRIORITIES, q.priority)}</select>
        <label class="check"><input type="checkbox" name="mine" value="1" ${q.mine === '1' ? 'checked' : ''}> Mine</label>
        <label class="check"><input type="checkbox" name="overdue" value="1" ${q.overdue === '1' ? 'checked' : ''}> Overdue</label>
        <button class="btn">Apply</button>${Object.keys(q).filter((k) => k !== 'highlight').length ? html`<a class="btn ghost" href="/tasks">Reset</a>` : ''}
      </form>
      <div class="grid-docs">
      <div class="card">${tasks.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Task</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>${tasks.map((t) => {
    const mayUpdate = canWrite || (can(req.ctx, P.TASK_UPDATE_OWN) && t.assignee?.id === req.ctx.userId);
    return html`<tr class="${q.highlight === t.task_id ? 'highlight' : ''}" id="t-${t.task_id}">
          <td><strong>${t.title}</strong>${t.company_name ? html`<div class="small"><a href="/vendors/${t.vendor_id}?tab=tasks">${t.company_name}</a></div>` : ''}${t.description ? html`<div class="muted small clamp">${t.description}</div>` : ''}</td>
          <td>${t.assignee?.name || html`<span class="muted">—</span>`}</td><td>${L.priorityBadge(t.priority)}</td>
          <td>${t.due_date ? html`<span class="${t.overdue ? 'text-critical strong' : ''}">${L.fmtDate(t.due_date)}</span>${t.overdue ? html`<div class="small text-critical">Overdue</div>` : ''}` : html`<span class="muted">—</span>`}</td>
          <td>${mayUpdate ? html`<form method="post" action="/tasks/${t.task_id}/status" class="inline"><input type="hidden" name="csrf" value="${csrf}">
            <select name="status" data-autosubmit aria-label="Task status">${L.options(D.TASK_STATUSES, t.status, D.TASK_STATUS_LABELS)}</select><noscript><button class="btn sm">Save</button></noscript></form>` : L.taskBadge(t.status)}</td></tr>`;
  })}</tbody></table></div>` : L.emptyState(status === 'open' ? 'No open tasks' : 'No tasks match', 'Assign review tasks here or ask Claude: "Assign a high-priority compliance review for ABC Technologies to the procurement manager."')}</div>
      ${canWrite ? html`<div class="card"><div class="card-head"><h2>New task</h2></div>
        <form method="post" action="/tasks" class="pad stack"><input type="hidden" name="csrf" value="${csrf}">
          <label class="field"><span>Title <em class="req">*</em></span><input name="title" required minlength="3" maxlength="160"></label>
          <label class="field"><span>Vendor</span><select name="vendor"><option value="">— None —</option>${vendors.map((v) => html`<option value="${v.vendor_id}">${v.company_name} (${v.vendor_id})</option>`)}</select></label>
          <label class="field"><span>Assignee <em class="req">*</em></span><select name="assignee_email" required>${members.map((m) => html`<option value="${m.email}">${m.name} (${m.role_label})</option>`)}</select></label>
          <div class="row gap"><label class="field"><span>Priority</span><select name="priority">${L.options(D.TASK_PRIORITIES, 'medium')}</select></label><label class="field"><span>Deadline</span><input type="date" name="due_date"></label></div>
          <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="2000"></textarea></label>
          <button class="btn primary">Create task</button></form></div>` : ''}
      </div>`;
    W.render(req, res, { title: 'Tasks', active: 'tasks', body });
  }));

  router.post('/tasks', W.auth(async (req, res) => {
    const t = svc.tasks.assign(req.ctx, { title: req.body.title, vendor: req.body.vendor || undefined, assignee_email: req.body.assignee_email, priority: req.body.priority, due_date: req.body.due_date, description: req.body.description });
    W.flash(res, 'success', `Task assigned to ${t.assignee.name}.`);
    W.back(req, res, `/tasks?highlight=${t.task_id}`);
  }));
  router.post('/tasks/:id/status', W.auth(async (req, res) => {
    const t = svc.tasks.updateStatus(req.ctx, { task_id: req.params.id, status: req.body.status });
    W.flash(res, 'success', `"${t.title}" is now ${t.status_label}.`);
    W.back(req, res, '/tasks');
  }));
};

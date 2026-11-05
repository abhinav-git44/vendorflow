'use strict';
const { redirect, send } = require('../../lib/http');
const { toCsv } = require('../../lib/csv');
const { can, P } = require('../../auth/permissions');
const D = require('../../domain');

module.exports = function vendorPages(router, W) {
  const { svc, layout: L, html } = W;

  // ---------- shared vendor form ----------
  function vendorForm(ctx, v = {}, { action, submit, csrf, isEdit }) {
    const members = svc.members.list(ctx);
    const cats = svc.vendors.categories(ctx);
    const statusChoices = isEdit ? [v.status, ...D.VENDOR_TRANSITIONS[v.status].filter((s) => s !== 'approved' && s !== 'archived')] : ['pending_onboarding', 'draft'];
    const f = (name, label, attrs = {}) => html`<label class="field"><span>${label}${attrs.required ? html` <em class="req">*</em>` : ''}</span>
      <input name="${name}" value="${v[name] ?? ''}" ${attrs.type ? html`type="${attrs.type}"` : ''} ${attrs.required ? 'required' : ''} ${attrs.placeholder ? html`placeholder="${attrs.placeholder}"` : ''} ${attrs.pattern ? html`pattern="${attrs.pattern}"` : ''} ${attrs.list ? html`list="${attrs.list}"` : ''} maxlength="${attrs.max || 200}" ${attrs.upper ? 'data-upper' : ''}></label>`;
    return html`<form method="post" action="${action}" class="card pad form-grid" data-validate>
      <input type="hidden" name="csrf" value="${csrf}">
      <h2 class="span-2">Company</h2>
      ${f('company_name', 'Company name', { required: true, max: 160 })}
      ${f('legal_name', 'Legal name')}
      ${f('category', 'Category', { required: true, list: 'cat-list', max: 60 })}<datalist id="cat-list">${cats.map((c) => html`<option value="${c}">`)}</datalist>
      ${f('registration_number', 'Registration number (CIN)', { max: 60 })}
      ${f('gst_number', 'GSTIN', { placeholder: '27ABCDE1234F1Z5', pattern: '[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z]', max: 15, upper: true })}
      ${f('pan_number', 'PAN', { placeholder: 'ABCDE1234F', pattern: '[A-Za-z]{5}[0-9]{4}[A-Za-z]', max: 10, upper: true })}
      <label class="field span-2"><span>Registered address</span><textarea name="address" rows="2" maxlength="400">${v.address || ''}</textarea></label>
      ${f('country', 'Country', { max: 80 })}
      ${f('website', 'Website', { placeholder: 'https://', max: 200 })}
      <h2 class="span-2">Contact</h2>
      ${f('contact_person', 'Contact person', { max: 120 })}
      ${f('email', 'Email', { type: 'email', max: 160 })}
      ${f('phone', 'Phone', { placeholder: '+91 98765 43210', max: 24 })}
      <label class="field"><span>Onboarding date</span><input type="date" name="onboarding_date" value="${v.onboarding_date || ''}"></label>
      <h2 class="span-2">Management</h2>
      <label class="field"><span>Assigned manager</span><select name="manager_id"><option value="">— Unassigned —</option>${members.map((m) => html`<option value="${m.id}" ${v.manager?.id === m.id ? 'selected' : ''}>${m.name} (${m.role_label})</option>`)}</select></label>
      <label class="field"><span>Status</span><select name="status">${L.options(statusChoices, v.status || 'pending_onboarding', D.VENDOR_STATUS_LABELS)}</select></label>
      <label class="field"><span>Risk classification</span><select name="risk">${L.options(D.RISK_LEVELS, v.risk || 'medium', { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' })}</select></label>
      <label class="field"><span>Bank account verification</span><select name="bank_verification_status">${L.options(D.BANK_STATUSES, v.bank_verification_status || 'not_started', { not_started: 'Not started', pending: 'Pending', verified: 'Verified', failed: 'Failed' })}</select></label>
      <label class="field span-2"><span>Internal notes</span><textarea name="notes" rows="3" maxlength="2000">${v.notes || ''}</textarea></label>
      <div class="span-2 row gap end"><a class="btn" href="${isEdit ? `/vendors/${v.vendor_id}` : '/vendors'}">Cancel</a><button class="btn primary">${submit}</button></div>
    </form>`;
  }

  const formInput = (b) => {
    const out = {};
    for (const k of ['company_name', 'legal_name', 'category', 'contact_person', 'email', 'phone', 'website', 'address', 'country', 'gst_number', 'pan_number',
      'registration_number', 'bank_verification_status', 'onboarding_date', 'risk', 'notes', 'status']) {
      if (k in b) out[k] = typeof b[k] === 'string' ? b[k] : '';
    }
    if ('manager_id' in b) out.manager_id = b.manager_id || undefined;
    return out;
  };

  // ---------- list ----------
  router.get('/vendors', W.auth(async (req, res) => {
    const q = req.query;
    const filters = { q: q.q, status: q.status || 'active', category: q.category, risk: q.risk, compliance: q.compliance, sort: q.sort || 'newest', page: Number(q.page) || 1, page_size: 20 };
    const r = svc.vendors.list(req.ctx, filters);
    const cats = svc.vendors.categories(req.ctx);
    const canWrite = can(req.ctx, P.VENDOR_WRITE);
    const exportQs = new URLSearchParams(Object.entries({ ...q, page: '' }).filter(([, v]) => v)).toString();
    const body = html`
      ${L.pageHeader('Vendors', `${r.total} vendor${r.total === 1 ? '' : 's'}`, html`<a class="btn" href="/vendors/export.csv?${exportQs}">${L.icon('download')}Export CSV</a>${canWrite ? html`<a class="btn primary" href="/vendors/new">${L.icon('plus')}Add vendor</a>` : ''}`)}
      <form class="filters" method="get">
        <input name="q" value="${q.q || ''}" placeholder="Search name, ID, contact, GSTIN" aria-label="Search">
        <select name="status" aria-label="Status">${L.options([['active', 'All active'], ...D.VENDOR_STATUSES.map((s) => [s, D.VENDOR_STATUS_LABELS[s]]), ['all', 'Including archived']], filters.status)}</select>
        <select name="category" aria-label="Category"><option value="">All categories</option>${L.options(cats, q.category)}</select>
        <select name="compliance" aria-label="Compliance"><option value="">Any compliance</option>${L.options([['compliant', 'Fully compliant'], ['partial', 'Partially compliant'], ['non_compliant', 'Non-compliant'], ['no_checklist', 'No checklist']], q.compliance)}</select>
        <select name="risk" aria-label="Risk"><option value="">Any risk</option>${L.options(D.RISK_LEVELS, q.risk)}</select>
        <select name="sort" aria-label="Sort">${L.options([['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'], ['code', 'Vendor ID'], ['compliance', 'Least compliant'], ['risk', 'Highest risk'], ['status', 'Status']], filters.sort)}</select>
        <button class="btn">Apply</button>${Object.keys(q).length ? html`<a class="btn ghost" href="/vendors">Reset</a>` : ''}
      </form>
      <div class="card">
      ${r.vendors.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Vendor</th><th>Category</th><th>Status</th><th>Compliance</th><th>Risk</th><th>Manager</th><th>Added</th></tr></thead>
        <tbody>${r.vendors.map((v) => html`<tr>
          <td><a class="strong" href="/vendors/${v.vendor_id}">${v.company_name}</a><div class="muted small">${v.vendor_id}${v.contact_person ? ` · ${v.contact_person}` : ''}${v.is_demo ? html` · <span class="chip demo">demo</span>` : ''}</div></td>
          <td>${v.category}</td><td>${L.vendorBadge(v.status)}</td><td>${L.progress(v.compliance?.percent, v.compliance?.status)}</td>
          <td>${L.riskBadge(v.risk)}</td><td>${v.manager?.name || html`<span class="muted">—</span>`}</td><td class="muted small">${L.fmtDate(v.created_at)}</td></tr>`)}
        </tbody></table></div>${L.pagination('/vendors', q, r.page, r.pages)}`
    : L.emptyState(q.q || q.category || q.compliance ? 'No vendors match these filters' : 'No vendors yet', q.q ? 'Try a different search.' : 'Add one here, or ask Claude to create it.', canWrite ? html`<a class="btn primary" href="/vendors/new">Add vendor</a>` : '')}
      </div>`;
    W.render(req, res, { title: 'Vendors', active: 'vendors', body });
  }));

  router.get('/vendors/export.csv', W.auth(async (req, res) => {
    const q = req.query;
    const r = svc.vendors.list(req.ctx, { q: q.q, status: q.status || 'active', category: q.category, risk: q.risk, compliance: q.compliance, sort: q.sort || 'code', page_size: 200, page: 1 });
    let all = r.vendors;
    for (let p = 2; p <= r.pages; p++) all = all.concat(svc.vendors.list(req.ctx, { ...q, status: q.status || 'active', sort: q.sort || 'code', page: p, page_size: 200 }).vendors);
    const csv = toCsv([
      { label: 'Vendor ID', key: 'vendor_id' }, { label: 'Company name', key: 'company_name' }, { label: 'Legal name', key: 'legal_name' }, { label: 'Category', key: 'category' },
      { label: 'Status', value: (v) => v.status_label }, { label: 'Risk', key: 'risk' }, { label: 'Compliance %', value: (v) => v.compliance?.percent ?? '' },
      { label: 'Compliance status', value: (v) => v.compliance?.status }, { label: 'Contact person', key: 'contact_person' }, { label: 'Email', key: 'email' }, { label: 'Phone', key: 'phone' },
      { label: 'GSTIN', key: 'gst_number' }, { label: 'PAN', key: 'pan_number' }, { label: 'Registration no.', key: 'registration_number' }, { label: 'Bank verification', key: 'bank_verification_status' },
      { label: 'Country', key: 'country' }, { label: 'Manager', value: (v) => v.manager?.name }, { label: 'Onboarding date', key: 'onboarding_date' }, { label: 'Created at', key: 'created_at' },
      { label: 'Demo record', value: (v) => (v.is_demo ? 'yes' : 'no') },
    ], all);
    send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vendors-${new Date().toISOString().slice(0, 10)}.csv"` });
  }));

  // ---------- create ----------
  router.get('/vendors/new', W.auth(async (req, res) => {
    W.render(req, res, { title: 'Add vendor', active: 'vendors', body: html`${L.pageHeader('Add vendor', 'Create a vendor record. You can add the compliance checklist next.')}
      ${vendorForm(req.ctx, { category: req.query.category || '' }, { action: '/vendors', submit: 'Create vendor', csrf: req.session.csrf })}` });
  }));
  router.post('/vendors', W.auth(async (req, res) => {
    const v = svc.vendors.create(req.ctx, formInput(req.body));
    W.flash(res, 'success', `${v.company_name} created as ${v.vendor_id}. Add a compliance checklist next.`);
    redirect(res, `/vendors/${v.vendor_id}?tab=compliance`);
  }));

  // ---------- profile ----------
  const TABS = [['overview', 'Overview'], ['documents', 'Documents'], ['compliance', 'Compliance'], ['tasks', 'Tasks'], ['approvals', 'Approvals'], ['activity', 'Activity']];

  router.get('/vendors/:code', W.auth(async (req, res) => {
    const ctx = req.ctx;
    const v = svc.vendors.get(ctx, req.params.code);
    const row = svc.vendors.resolve(ctx, v.vendor_id);
    const comp = svc.compliance.forVendor(ctx, row.id);
    const tab = TABS.some(([k]) => k === req.query.tab) ? req.query.tab : 'overview';
    const csrf = req.session.csrf;
    const docs = svc.documents.list(ctx, { vendorId: row.id });
    const tasks = svc.tasks.list(ctx, { vendorId: row.id, status: 'all' });
    const approvals = svc.approvals.list(ctx, { vendorId: row.id });
    const counts = { documents: docs.length, tasks: tasks.filter((t) => ['todo', 'in_progress', 'blocked'].includes(t.status)).length, approvals: approvals.filter((a) => a.status === 'pending').length };

    let content;
    if (tab === 'overview') content = overviewTab(ctx, v, comp, tasks, csrf, req.query.edit === '1');
    else if (tab === 'documents') content = documentsTab(ctx, v, docs, comp, csrf);
    else if (tab === 'compliance') content = complianceTab(ctx, v, comp, csrf);
    else if (tab === 'tasks') content = tasksTab(ctx, v, tasks, csrf);
    else if (tab === 'approvals') content = approvalsTab(ctx, v, approvals, comp, csrf);
    else content = activityTab(ctx, row);

    const statusActions = can(ctx, P.VENDOR_WRITE) && v.status !== 'archived' && !counts.approvals ? D.VENDOR_TRANSITIONS[v.status].filter((s) => s !== 'approved' && s !== 'archived' && !(s === 'rejected' && v.status === 'under_review')) : [];
    const body = html`
      <nav class="crumbs"><a href="/vendors">Vendors</a> / ${v.vendor_id}</nav>
      <div class="page-head vendor-head">
        <div><h1>${v.company_name} ${v.is_demo ? html`<span class="chip demo">demo record</span>` : ''}</h1>
          <p class="muted">${v.vendor_id} · ${v.category}${v.legal_name ? ` · ${v.legal_name}` : ''}</p>
          <div class="row gap wrap">${L.vendorBadge(v.status)}${L.riskBadge(v.risk)}${comp.status !== 'no_checklist' ? L.complianceBadge(comp.status) : ''}</div></div>
        <div class="row gap wrap">
          ${statusActions.map((s) => html`<form method="post" action="/vendors/${v.vendor_id}/status"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="${s}"><button class="btn sm">Move to ${D.VENDOR_STATUS_LABELS[s]}</button></form>`)}
          ${can(ctx, P.VENDOR_ARCHIVE) && v.status !== 'archived' ? html`<form method="post" action="/vendors/${v.vendor_id}/status" data-confirm="Archive ${v.company_name}? Pending approvals and open tasks will be cancelled. Records are kept for audit."><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="archived"><button class="btn sm danger-outline">Archive</button></form>` : ''}
          ${v.status === 'archived' && can(ctx, P.VENDOR_ARCHIVE) ? html`<form method="post" action="/vendors/${v.vendor_id}/status"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="draft"><button class="btn sm">Restore as draft</button></form>` : ''}
        </div>
      </div>
      <nav class="tabs" role="tablist">${TABS.map(([k, label]) => html`<a role="tab" aria-selected="${tab === k}" class="${tab === k ? 'active' : ''}" href="/vendors/${v.vendor_id}?tab=${k}">${label}${counts[k] ? html`<span class="count">${counts[k]}</span>` : ''}</a>`)}</nav>
      ${content}`;
    W.render(req, res, { title: v.company_name, active: 'vendors', body });
  }));

  function overviewTab(ctx, v, comp, tasks, csrf, editing) {
    if (editing && can(ctx, P.VENDOR_WRITE)) return vendorForm(ctx, v, { action: `/vendors/${v.vendor_id}`, submit: 'Save changes', csrf, isEdit: true });
    const kv = (k, val) => html`<div class="kv"><span>${k}</span><span>${val || html`<span class="muted">—</span>`}</span></div>`;
    const upcoming = [
      ...tasks.filter((t) => ['todo', 'in_progress', 'blocked'].includes(t.status) && t.due_date).map((t) => ({ date: t.due_date, label: `Task: ${t.title}`, overdue: t.overdue })),
      ...comp.items.filter((i) => i.document?.expiry_date && ['verified', 'pending'].includes(i.state)).map((i) => ({ date: i.document.expiry_date, label: `${i.name} expires`, overdue: false })),
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
    return html`<div class="grid-profile">
      <div class="card"><div class="card-head"><h2>Vendor information</h2>${can(ctx, P.VENDOR_WRITE) ? html`<a class="btn sm" href="/vendors/${v.vendor_id}?tab=overview&edit=1">Edit</a>` : ''}</div>
        <div class="pad kv-list">${kv('Company name', v.company_name)}${kv('Legal name', v.legal_name)}${kv('Category', v.category)}${kv('GSTIN', v.gst_number && html`<code>${v.gst_number}</code>`)}
        ${kv('PAN', v.pan_number && html`<code>${v.pan_number}</code>`)}${kv('Registration no.', v.registration_number)}${kv('Registered address', v.address)}${kv('Country', v.country)}
        ${kv('Website', v.website && html`<a href="${v.website}" target="_blank" rel="noopener noreferrer">${v.website}</a>`)}${kv('Bank verification', v.bank_verification_status.replace(/_/g, ' '))}
        ${kv('Onboarding date', L.fmtDate(v.onboarding_date))}${kv('Internal notes', v.notes)}</div></div>
      <div class="stack">
        <div class="card pad compliance-hero"><span class="muted small">Compliance</span>
          ${comp.percent === null ? html`<p class="big muted">No checklist</p><a class="btn sm" href="/vendors/${v.vendor_id}?tab=compliance">Create checklist</a>`
    : html`<p class="big">${comp.percent}%</p>${L.progress(comp.percent, comp.status)}<p class="muted small">${comp.mandatoryMet} of ${comp.mandatoryTotal} mandatory requirements verified</p>`}</div>
        <div class="card"><div class="card-head"><h2>Contact</h2></div><div class="pad kv-list">${kv('Contact person', v.contact_person)}${kv('Email', v.email && html`<a href="mailto:${v.email}">${v.email}</a>`)}${kv('Phone', v.phone)}${kv('Assigned manager', v.manager?.name)}</div></div>
        <div class="card"><div class="card-head"><h2>Upcoming deadlines</h2></div>
          ${upcoming.length ? html`<ul class="list">${upcoming.map((u) => html`<li><span>${u.label}</span><span class="${u.overdue ? 'text-critical' : 'muted'} small">${L.fmtDate(u.date)}</span></li>`)}</ul>` : L.emptyState('No upcoming deadlines', null)}</div>
      </div></div>`;
  }

  function documentsTab(ctx, v, docs, comp, csrf) {
    const canUpload = can(ctx, P.DOCUMENT_UPLOAD) && v.status !== 'archived';
    const canVerify = can(ctx, P.DOCUMENT_VERIFY);
    const missing = comp.items.filter((i) => i.state === 'missing');
    return html`<div class="grid-docs">
      <div class="card">
        <div class="card-head"><h2>Documents</h2><span class="muted small">Files are private; links are permission-checked.</span></div>
        ${docs.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Document</th><th>Status</th><th>Expiry</th><th>File</th><th>Actions</th></tr></thead>
          <tbody>${docs.map((d) => html`<tr id="doc-${d.document_id}">
            <td><strong>${d.name}</strong><div class="muted small">${d.name !== d.category_label ? d.category_label : ''}${d.source === 'mcp' ? html` · <span class="chip claude">${L.icon('claude')}registered via Claude</span>` : ''}</div>
              ${d.rejection_reason ? html`<div class="small text-critical">Rejected: ${d.rejection_reason}</div>` : ''}</td>
            <td>${L.docBadge(d.status)}${d.verified_by ? html`<div class="muted small">by ${d.verified_by}</div>` : ''}</td>
            <td>${d.expiry_date ? html`${L.fmtDate(d.expiry_date)}<div class="muted small ${d.days_to_expiry < 0 ? 'text-critical' : d.days_to_expiry <= 30 ? 'text-serious' : ''}">${d.days_to_expiry < 0 ? `${-d.days_to_expiry}d ago` : `in ${d.days_to_expiry}d`}</div>` : html`<span class="muted">—</span>`}</td>
            <td>${d.has_file ? html`<a href="/documents/${d.document_id}/file?inline=1" target="_blank" rel="noopener">Preview</a> · <a href="/documents/${d.document_id}/file">Download</a><div class="muted small">${d.original_filename} · ${L.fmtBytes(d.file_size)}</div>` : html`<span class="muted small">No file yet</span>`}</td>
            <td><div class="row gap wrap">
              ${canVerify && d.has_file && ['pending_verification', 'uploaded', 'rejected'].includes(d.status) ? html`<form method="post" action="/documents/${d.document_id}/status"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="verified"><button class="btn sm success">Verify</button></form>` : ''}
              ${canVerify && d.has_file && ['pending_verification', 'uploaded', 'verified'].includes(d.status) ? html`<details class="pop"><summary class="btn sm">Reject</summary><form method="post" action="/documents/${d.document_id}/status" class="pop-body stack"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="status" value="rejected"><label class="field"><span>Reason</span><input name="reason" required maxlength="500" placeholder="e.g. Name does not match"></label><button class="btn sm danger">Reject document</button></form></details>` : ''}
              ${canUpload ? html`<details class="pop"><summary class="btn sm">${d.has_file ? 'Replace' : 'Upload'}</summary><form method="post" action="/documents/${d.document_id}/${d.has_file ? 'replace' : 'attach'}" enctype="multipart/form-data" class="pop-body stack"><input type="hidden" name="csrf" value="${csrf}"><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required><button class="btn sm primary">Upload file</button></form></details>` : ''}
              ${canUpload ? html`<details class="pop"><summary class="btn sm ghost">Dates</summary><form method="post" action="/documents/${d.document_id}/dates" class="pop-body stack"><input type="hidden" name="csrf" value="${csrf}"><label class="field"><span>Issue date</span><input type="date" name="issue_date" value="${d.issue_date || ''}"></label><label class="field"><span>Expiry date</span><input type="date" name="expiry_date" value="${d.expiry_date || ''}"></label><button class="btn sm">Save</button></form></details>` : ''}
              ${can(ctx, P.DOCUMENT_DELETE) ? html`<form method="post" action="/documents/${d.document_id}/delete" data-confirm="Delete ${d.name}? It will no longer count toward compliance."><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm ghost danger-text" aria-label="Delete">${L.icon('x')}</button></form>` : ''}
            </div></td></tr>`)}</tbody></table></div>` : L.emptyState('No documents yet', 'Upload the vendor\'s certificates here.')}
      </div>
      ${canUpload ? html`<div class="card"><div class="card-head"><h2>Upload document</h2></div>
        <form method="post" action="/vendors/${v.vendor_id}/documents" enctype="multipart/form-data" class="pad stack">
          <input type="hidden" name="csrf" value="${csrf}">
          <label class="field"><span>Category <em class="req">*</em></span><select name="category" required>${L.options(D.DOC_CATEGORIES, missing[0]?.doc_category, D.DOC_CATEGORY_LABELS)}</select></label>
          <label class="field"><span>Name</span><input name="name" maxlength="160" placeholder="Defaults to the category"></label>
          <div class="row gap"><label class="field"><span>Issue date</span><input type="date" name="issue_date"></label><label class="field"><span>Expiry date</span><input type="date" name="expiry_date"></label></div>
          <label class="field"><span>File <em class="req">*</em></span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required><small class="muted">PDF, JPG, PNG or WEBP · max ${Math.round(W.config.maxUploadBytes / 1048576)} MB</small></label>
          <button class="btn primary">${L.icon('upload')}Upload</button>
          ${missing.length ? html`<p class="muted small">Still missing: ${missing.map((m) => m.name).join(', ')}</p>` : ''}
        </form></div>` : ''}
    </div>`;
  }

  function complianceTab(ctx, v, comp, csrf) {
    const canEdit = can(ctx, P.CHECKLIST_WRITE) && v.status !== 'archived';
    const STATE = { missing: 'Missing', pending: 'Uploaded – awaiting verification', verified: 'Verified', rejected: 'Rejected', expired: 'Expired' };
    const STATE_TONE = { missing: 'critical', pending: 'warning', verified: 'good', rejected: 'critical', expired: 'serious' };
    const used = new Set(comp.items.map((i) => i.doc_category));
    return html`<div class="grid-docs">
      <div class="card">
        <div class="card-head"><h2>Compliance checklist</h2>${comp.percent !== null ? html`<div class="row gap">${L.progress(comp.percent, comp.status)}</div>` : ''}</div>
        ${comp.items.length ? html`<p class="pad-x muted small">Compliance % = verified, unexpired mandatory requirements ÷ all mandatory requirements. A record alone never counts: the file must be uploaded and verified.</p>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Requirement</th><th>Type</th><th>State</th><th>Document</th><th></th></tr></thead>
          <tbody>${comp.items.map((i) => html`<tr>
            <td><strong>${i.name}</strong><div class="muted small">${D.DOC_CATEGORY_LABELS[i.doc_category]}</div></td>
            <td>${i.mandatory ? 'Mandatory' : html`<span class="muted">Optional</span>`}</td>
            <td>${L.badge(STATE_TONE[i.state], STATE[i.state])}${i.expiring_soon ? html`<div class="small text-serious">Expires ${L.fmtDate(i.document.expiry_date)}</div>` : ''}</td>
            <td>${i.document ? html`<a href="/vendors/${v.vendor_id}?tab=documents#doc-${i.document.id}">${i.document.name}</a>` : html`<a href="/vendors/${v.vendor_id}?tab=documents">Upload</a>`}</td>
            <td>${canEdit ? html`<form method="post" action="/vendors/${v.vendor_id}/checklist/${i.id}/delete" data-confirm="Remove ${i.name} from the checklist?"><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm ghost" aria-label="Remove requirement">${L.icon('x')}</button></form>` : ''}</td>
          </tr>`)}</tbody></table></div>`
    : L.emptyState('No compliance checklist yet', 'Apply your organisation\'s template for this category, or add requirements one by one. Claude can also do this: "Create a mandatory checklist for this vendor with GST, PAN and bank verification."',
      canEdit ? html`<form method="post" action="/vendors/${v.vendor_id}/checklist/template"><input type="hidden" name="csrf" value="${csrf}"><button class="btn primary">Apply ${v.category} template</button></form>` : '')}
      </div>
      ${canEdit ? html`<div class="card"><div class="card-head"><h2>Add requirement</h2></div>
        <form method="post" action="/vendors/${v.vendor_id}/checklist" class="pad stack">
          <input type="hidden" name="csrf" value="${csrf}">
          <label class="field"><span>Document</span><select name="category" required>${L.options(D.DOC_CATEGORIES.filter((c) => !used.has(c)), '', D.DOC_CATEGORY_LABELS)}</select></label>
          <label class="field"><span>Label</span><input name="name" maxlength="120" placeholder="Defaults to the document name"></label>
          <label class="check"><input type="checkbox" name="mandatory" value="true" checked> Mandatory</label>
          <button class="btn primary">Add to checklist</button>
          ${comp.items.length ? html`<button class="btn ghost" formaction="/vendors/${v.vendor_id}/checklist/template" formnovalidate>Apply ${v.category} template</button>` : ''}
        </form></div>` : ''}
    </div>`;
  }

  function tasksTab(ctx, v, tasks, csrf) {
    const members = svc.members.list(ctx);
    return html`<div class="grid-docs">
      <div class="card"><div class="card-head"><h2>Tasks</h2></div>
        ${tasks.length ? html`<ul class="list">${tasks.map((t) => html`<li><div><a href="/tasks?highlight=${t.task_id}&status=all">${t.title}</a><div class="muted small">${t.assignee?.name || 'Unassigned'} · ${t.due_date ? (t.overdue ? html`<span class="text-critical">overdue (${L.fmtDate(t.due_date)})</span>` : `due ${L.fmtDate(t.due_date)}`) : 'no deadline'}</div></div><div class="row gap">${L.priorityBadge(t.priority)}${L.taskBadge(t.status)}</div></li>`)}</ul>` : L.emptyState('No tasks for this vendor', null)}
      </div>
      ${can(ctx, P.TASK_WRITE) && v.status !== 'archived' ? html`<div class="card"><div class="card-head"><h2>Assign a task</h2></div>
        <form method="post" action="/tasks" class="pad stack"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="vendor" value="${v.vendor_id}">
          <label class="field"><span>Title <em class="req">*</em></span><input name="title" required minlength="3" maxlength="160" value="Compliance review – ${v.company_name}"></label>
          <label class="field"><span>Assignee</span><select name="assignee_email" required>${members.map((m) => html`<option value="${m.email}" ${v.manager?.id === m.id ? 'selected' : ''}>${m.name} (${m.role_label})</option>`)}</select></label>
          <div class="row gap"><label class="field"><span>Priority</span><select name="priority">${L.options(D.TASK_PRIORITIES, 'medium')}</select></label><label class="field"><span>Deadline</span><input type="date" name="due_date"></label></div>
          <label class="field"><span>Description</span><textarea name="description" rows="2" maxlength="2000"></textarea></label>
          <button class="btn primary">Assign task</button></form></div>` : ''}
    </div>`;
  }

  function approvalsTab(ctx, v, approvals, comp, csrf) {
    const approvers = svc.members.list(ctx).filter((m) => ['owner', 'admin', 'compliance_manager', 'reviewer'].includes(m.role));
    const canRequest = can(ctx, P.APPROVAL_REQUEST) && ['draft', 'pending_onboarding', 'under_review', 'suspended'].includes(v.status) && !approvals.some((a) => a.status === 'pending');
    return html`<div class="grid-docs">
      <div class="card"><div class="card-head"><h2>Approval history</h2></div>
        ${approvals.length ? html`<ul class="list">${approvals.map((a) => html`<li><div><strong>${a.type === 'vendor_reactivation' ? 'Reactivation' : 'Onboarding'} approval</strong> ${L.approvalBadge(a.status)}
          <div class="muted small">Approver ${a.approver.name} · requested by ${a.requested_by || '—'} ${L.fmtRelative(a.created_at)}${a.decided_at ? ` · decided by ${a.decided_by} ${L.fmtRelative(a.decided_at)}` : ''}</div>
          ${a.notes ? html`<div class="small">${a.notes}</div>` : ''}${a.decision_reason ? html`<div class="small"><strong>Reason:</strong> ${a.decision_reason}</div>` : ''}</div>
          ${a.status === 'pending' ? html`<a class="btn sm" href="/approvals?highlight=${a.approval_id}">Open in queue</a>` : ''}</li>`)}</ul>` : L.emptyState('No approval requests yet', null)}
      </div>
      ${canRequest ? html`<div class="card"><div class="card-head"><h2>Request approval</h2></div>
        <form method="post" action="/approvals" class="pad stack"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="vendor" value="${v.vendor_id}">
          ${comp.status !== 'compliant' ? html`<div class="alert warning">${v.company_name} is ${comp.percent ?? 0}% compliant. Approvers will need every mandatory document verified (or an owner/admin override).</div>` : ''}
          <label class="field"><span>Approver</span><select name="approver_email" required>${approvers.map((m) => html`<option value="${m.email}" ${m.role === 'compliance_manager' ? 'selected' : ''}>${m.name} (${m.role_label})</option>`)}</select></label>
          <label class="field"><span>Notes for approver</span><textarea name="notes" rows="3" maxlength="1000"></textarea></label>
          <button class="btn primary">Send for approval</button></form></div>` : ''}
    </div>`;
  }

  function activityTab(ctx, row) {
    const { rows } = svc.activity.list(ctx, { vendorId: row.id, limit: 100 });
    return html`<div class="card">${rows.length ? html`<ul class="timeline">${rows.map((a) => html`<li><span class="t-dot ${a.actor_type}"></span><div><div>${a.summary}</div><div class="muted small">${a.actor_label} · ${L.fmtDate(a.created_at)} ${new Date(a.created_at).toISOString().slice(11, 16)} UTC ${L.actorChip(a)}</div></div></li>`)}</ul>` : L.emptyState('No activity yet', null)}</div>`;
  }

  // ---------- actions ----------
  router.post('/vendors/:code', W.auth(async (req, res) => {
    const v = svc.vendors.update(req.ctx, req.params.code, formInput(req.body));
    W.flash(res, 'success', 'Vendor details saved.');
    redirect(res, `/vendors/${v.vendor_id}`);
  }));
  router.post('/vendors/:code/status', W.auth(async (req, res) => {
    const v = svc.vendors.changeStatus(req.ctx, req.params.code, req.body.status);
    W.flash(res, 'success', `${v.company_name} is now ${v.status_label}.`);
    redirect(res, `/vendors/${v.vendor_id}`);
  }));
  router.post('/vendors/:code/checklist', W.auth(async (req, res) => {
    const cat = req.body.category;
    const r = svc.compliance.createChecklist(req.ctx, { vendor: req.params.code, requirements: [{ name: req.body.name || D.DOC_CATEGORY_LABELS[cat] || cat, category: cat, mandatory: req.body.mandatory === 'true' }] });
    W.flash(res, 'success', `Requirement added. ${r.company_name} is ${r.compliance_percent}% compliant.`);
    redirect(res, `/vendors/${r.vendor_id}?tab=compliance`);
  }));
  router.post('/vendors/:code/checklist/template', W.auth(async (req, res) => {
    const r = svc.compliance.createChecklist(req.ctx, { vendor: req.params.code });
    W.flash(res, 'success', `Template applied (${r.added} added). ${r.company_name} is ${r.compliance_percent}% compliant.`);
    redirect(res, `/vendors/${r.vendor_id}?tab=compliance`);
  }));
  router.post('/vendors/:code/checklist/:item/delete', W.auth(async (req, res) => {
    svc.compliance.removeItem(req.ctx, req.params.code, req.params.item);
    W.flash(res, 'success', 'Requirement removed.');
    redirect(res, `/vendors/${req.params.code}?tab=compliance`);
  }));
  router.post('/vendors/:code/documents', W.auth(async (req, res) => {
    const d = svc.documents.upload(req.ctx, req.params.code, req.body, req.files.file);
    W.flash(res, 'success', `${d.name} uploaded and awaiting verification.`);
    redirect(res, `/vendors/${d.vendor_id}?tab=documents`);
  }));
};

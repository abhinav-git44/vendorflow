'use strict';
const { redirect, send } = require('../../lib/http');
const { toCsv } = require('../../lib/csv');
const { can, P } = require('../../auth/permissions');
const D = require('../../domain');

module.exports = function adminPages(router, W) {
  const { svc, config, layout: L, html, db } = W;

  // ======================= REPORTS =======================
  router.get('/reports', W.auth(async (req, res) => {
    const ctx = req.ctx;
    const q = req.query;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null;
    const members = svc.members.list(ctx);
    const where = ['org_id = ?'];
    const params = [ctx.orgId];
    if (from) { where.push('substr(created_at,1,10) >= ?'); params.push(from); }
    if (to) { where.push('substr(created_at,1,10) <= ?'); params.push(to); }
    if (q.category) { where.push('category = ?'); params.push(q.category); }
    if (q.manager) { where.push('manager_id = ?'); params.push(q.manager); }
    if (q.status) { where.push('status = ?'); params.push(q.status); }
    const vendors = db.all(`SELECT * FROM vendors WHERE ${where.join(' AND ')}`, ...params);
    const comp = svc.compliance.forOrg(ctx);
    const scoped = q.compliance ? vendors.filter((v) => comp.get(v.id).status === q.compliance) : vendors;
    const ids = new Set(scoped.map((v) => v.id));
    const byStatus = D.VENDOR_STATUSES.map((s) => ({ label: D.VENDOR_STATUS_LABELS[s], value: scoped.filter((v) => v.status === s).length }));
    const byMonth = {};
    for (const v of scoped) byMonth[v.created_at.slice(0, 7)] = (byMonth[v.created_at.slice(0, 7)] || 0) + 1;
    const months = Object.keys(byMonth).sort().slice(-12).map((k) => ({ label: new Date(k + '-01T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }), count: byMonth[k] }));
    const expiring = svc.documents.expiring(ctx, { days: 60 }).filter((d) => ids.has(svc.vendors.resolve(ctx, d.vendor_id).id));
    const approvals = svc.approvals.list(ctx, { status: 'pending' }).filter((a) => ids.has(svc.vendors.resolve(ctx, a.vendor_id).id));
    const overdue = svc.tasks.list(ctx, { status: 'open', overdue: true }).filter((t) => !t.vendor_id || ids.has(svc.vendors.resolve(ctx, t.vendor_id).id));
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const body = html`
      ${L.pageHeader('Reports', 'Operational reports. All figures are calculated from live records; values typed by people (e.g. risk) are labelled as entered.')}
      <form class="filters" method="get">
        <label class="inline-field"><span>Added from</span><input type="date" name="from" value="${from || ''}"></label>
        <label class="inline-field"><span>to</span><input type="date" name="to" value="${to || ''}"></label>
        <select name="category" aria-label="Category"><option value="">All categories</option>${L.options(svc.vendors.categories(ctx), q.category)}</select>
        <select name="status" aria-label="Vendor status"><option value="">Any status</option>${L.options(D.VENDOR_STATUSES, q.status, D.VENDOR_STATUS_LABELS)}</select>
        <select name="compliance" aria-label="Compliance"><option value="">Any compliance</option>${L.options([['compliant', 'Fully compliant'], ['partial', 'Partial'], ['non_compliant', 'Non-compliant'], ['no_checklist', 'No checklist']], q.compliance)}</select>
        <select name="manager" aria-label="Manager"><option value="">Any manager</option>${L.options(members.map((m) => [m.id, m.name]), q.manager)}</select>
        <button class="btn">Apply</button>${qs ? html`<a class="btn ghost" href="/reports">Reset</a>` : ''}
      </form>
      <section class="grid-2">
        <div class="card"><div class="card-head"><h2>Vendor status distribution</h2><span class="muted small">${scoped.length} vendors · calculated</span></div><div class="pad">${L.hbarChart(byStatus)}</div></div>
        <div class="card"><div class="card-head"><h2>Vendor onboarding</h2><span class="muted small">Vendors added per month</span></div><div class="pad">${months.length ? L.columnChart(months, { label: 'Vendors added' }) : L.emptyState('No vendors in range', null)}</div></div>
      </section>
      <section class="grid-3">
        <div class="card"><div class="card-head"><h2>Expiring documents</h2><a class="btn sm" href="/reports/expiring.csv">${L.icon('download')}CSV</a></div>
          ${expiring.length ? html`<ul class="list">${expiring.slice(0, 8).map((d) => html`<li><div><a href="/vendors/${d.vendor_id}?tab=documents">${d.name}</a><div class="muted small">${d.company_name}</div></div><span class="small ${d.days_to_expiry < 0 ? 'text-critical' : 'text-serious'}">${d.days_to_expiry < 0 ? 'expired' : `${d.days_to_expiry}d`}</span></li>`)}</ul>` : L.emptyState('Nothing expiring in 60 days', null)}</div>
        <div class="card"><div class="card-head"><h2>Pending approvals</h2><a class="small" href="/approvals">Queue</a></div>
          ${approvals.length ? html`<ul class="list">${approvals.slice(0, 8).map((a) => html`<li><div><a href="/approvals?highlight=${a.approval_id}">${a.company_name}</a><div class="muted small">${a.approver.name} · ${L.fmtRelative(a.created_at)}</div></div></li>`)}</ul>` : L.emptyState('None pending', null)}</div>
        <div class="card"><div class="card-head"><h2>Overdue reviews</h2><a class="btn sm" href="/reports/overdue.csv">${L.icon('download')}CSV</a></div>
          ${overdue.length ? html`<ul class="list">${overdue.slice(0, 8).map((t) => html`<li><div><a href="/tasks?highlight=${t.task_id}">${t.title}</a><div class="muted small">${t.assignee?.name || '—'} · due ${L.fmtDate(t.due_date)}</div></div>${L.priorityBadge(t.priority)}</li>`)}</ul>` : L.emptyState('No overdue reviews', null)}</div>
      </section>
      <div class="card pad"><h2>Exports</h2><div class="row gap wrap">
        <a class="btn" href="/vendors/export.csv?status=all">${L.icon('download')}All vendors</a>
        <a class="btn" href="/compliance/export.csv">${L.icon('download')}Compliance report</a>
        <a class="btn" href="/reports/expiring.csv">${L.icon('download')}Expiring documents</a>
        <a class="btn" href="/reports/overdue.csv">${L.icon('download')}Overdue reviews</a>
        <a class="btn" href="/activity/export.csv">${L.icon('download')}Audit log</a></div>
        <p class="muted small">Columns marked "calculated" are derived by VendorFlow; all others are values entered by your team or via Claude.</p></div>`;
    W.render(req, res, { title: 'Reports', active: 'reports', body });
  }));

  const csvResponse = (res, name, csv) => send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"` });
  router.get('/reports/expiring.csv', W.auth(async (req, res) => {
    csvResponse(res, 'expiring-documents', toCsv([
      { label: 'Vendor ID', key: 'vendor_id' }, { label: 'Vendor', key: 'company_name' }, { label: 'Document', key: 'name' }, { label: 'Type', key: 'category_label' },
      { label: 'Status (calculated)', key: 'status' }, { label: 'Expiry date', key: 'expiry_date' }, { label: 'Days to expiry (calculated)', key: 'days_to_expiry' },
    ], svc.documents.expiring(req.ctx, { days: 90 })));
  }));
  router.get('/reports/overdue.csv', W.auth(async (req, res) => {
    csvResponse(res, 'overdue-reviews', toCsv([
      { label: 'Task', key: 'title' }, { label: 'Vendor ID', key: 'vendor_id' }, { label: 'Vendor', key: 'company_name' }, { label: 'Assignee', value: (t) => t.assignee?.name },
      { label: 'Priority', key: 'priority' }, { label: 'Due date', key: 'due_date' }, { label: 'Status', key: 'status' },
    ], svc.tasks.list(req.ctx, { status: 'open', overdue: true })));
  }));

  // ======================= ACTIVITY =======================
  router.get('/activity', W.auth(async (req, res) => {
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const { total, rows } = svc.activity.list(req.ctx, { actorType: q.actor || undefined, entityType: q.entity || undefined, limit: 50, offset: (page - 1) * 50 });
    const body = html`
      ${L.pageHeader('Activity log', 'Append-only audit trail of every change, whether made in the app, through Claude, or by the scheduler.', html`<a class="btn" href="/activity/export.csv">${L.icon('download')}Export CSV</a>`)}
      <form class="filters" method="get">
        <select name="actor" aria-label="Source">${L.options([['', 'Any source'], ['user', 'People (web app)'], ['mcp', 'Claude (MCP)'], ['system', 'Automated']], q.actor)}</select>
        <select name="entity" aria-label="Record type">${L.options([['', 'Any record'], ['vendor', 'Vendors'], ['document', 'Documents'], ['checklist', 'Checklists'], ['task', 'Tasks'], ['approval', 'Approvals'], ['member', 'Team'], ['credential', 'Connections']], q.entity)}</select>
        <button class="btn">Apply</button>
      </form>
      <div class="card">${rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Record</th></tr></thead>
        <tbody>${rows.map((a) => html`<tr><td class="small nowrap">${a.created_at.slice(0, 10)} ${a.created_at.slice(11, 16)}</td><td class="small">${a.actor_label}<div>${L.actorChip(a)}</div></td>
          <td>${a.summary}<div class="muted small"><code>${a.action}</code></div></td><td class="small">${a.vendor_code ? html`<a href="/vendors/${a.vendor_code}?tab=activity">${a.vendor_code}</a>` : a.entity_type}</td></tr>`)}</tbody></table></div>
        ${L.pagination('/activity', q, page, Math.max(1, Math.ceil(total / 50)))}` : L.emptyState('No activity matches', null)}</div>`;
    W.render(req, res, { title: 'Activity log', active: 'activity', body });
  }));
  router.get('/activity/export.csv', W.auth(async (req, res) => {
    const { rows } = svc.activity.list(req.ctx, { limit: 10000 });
    csvResponse(res, 'audit-log', toCsv([
      { label: 'Timestamp (UTC)', key: 'created_at' }, { label: 'Actor', key: 'actor_label' }, { label: 'Source', key: 'actor_type' }, { label: 'Action', key: 'action' },
      { label: 'Record type', key: 'entity_type' }, { label: 'Record ID', key: 'entity_id' }, { label: 'Vendor ID', key: 'vendor_code' }, { label: 'Summary', key: 'summary' },
    ], rows));
  }));

  // ======================= NOTIFICATIONS =======================
  router.get('/notifications', W.auth(async (req, res) => {
    const list = svc.notifications.list(req.ctx, { limit: 100 });
    const csrf = req.session.csrf;
    const body = html`
      ${L.pageHeader('Notifications', null, list.some((n) => !n.read_at) ? html`<form method="post" action="/notifications/read-all"><input type="hidden" name="csrf" value="${csrf}"><button class="btn">Mark all as read</button></form>` : '')}
      <div class="card">${list.length ? html`<ul class="list">${list.map((n) => html`<li class="${n.read_at ? '' : 'unread'}">
        <div><strong>${n.title}</strong><div class="muted small">${n.body || ''} · ${L.fmtRelative(n.created_at)}</div></div>
        <form method="post" action="/notifications/${n.id}/open"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="to" value="${n.link || '/'}"><button class="btn sm">Open</button></form></li>`)}</ul>`
    : L.emptyState("You're all caught up", 'You\'ll be notified about assignments, approvals, uploads and upcoming expiries.')}</div>`;
    W.render(req, res, { title: 'Notifications', active: '', body });
  }));
  router.post('/notifications/read-all', W.auth(async (req, res) => { svc.notifications.markAllRead(req.ctx); redirect(res, '/notifications'); }));
  router.post('/notifications/:id/open', W.auth(async (req, res) => { svc.notifications.markRead(req.ctx, req.params.id); redirect(res, W.safeNext(req.body.to)); }));

  // ======================= TEAM =======================
  router.get('/team', W.auth(async (req, res) => {
    const members = svc.members.list(req.ctx);
    const manage = can(req.ctx, P.MEMBER_MANAGE);
    const csrf = req.session.csrf;
    const roleChoices = D.ROLES.filter((r) => r !== 'owner' || req.ctx.role === 'owner');
    const body = html`
      ${L.pageHeader('Team members', `${members.length} member${members.length === 1 ? '' : 's'} in this organisation`)}
      <div class="grid-docs">
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
        <tbody>${members.map((m) => html`<tr><td><span class="avatar sm">${L.initials(m.name)}</span> ${m.name}${m.id === req.ctx.userId ? html` <span class="chip">you</span>` : ''}</td><td>${m.email}</td>
          <td>${manage && m.id !== req.ctx.userId ? html`<form method="post" action="/team/${m.id}/role" class="inline"><input type="hidden" name="csrf" value="${csrf}"><select name="role" data-autosubmit aria-label="Role for ${m.name}">${L.options(roleChoices.includes(m.role) ? roleChoices : [m.role, ...roleChoices], m.role, D.ROLE_LABELS)}</select></form>` : m.role_label}</td>
          <td class="muted small">${L.fmtDate(m.created_at)}</td></tr>`)}</tbody></table></div></div>
      ${manage ? html`<div class="card"><div class="card-head"><h2>Add member</h2></div>
        <form method="post" action="/team" class="pad stack"><input type="hidden" name="csrf" value="${csrf}">
          <label class="field"><span>Name</span><input name="name" required minlength="2" maxlength="80"></label>
          <label class="field"><span>Email</span><input type="email" name="email" required></label>
          <label class="field"><span>Role</span><select name="role">${L.options(roleChoices, 'reviewer', D.ROLE_LABELS)}</select></label>
          <label class="field"><span>Initial password</span><input type="password" name="password" minlength="10" autocomplete="new-password"><small class="muted">Needed for people without a VendorFlow account. Share it securely.</small></label>
          <button class="btn primary">Add member</button></form>
        <div class="pad-x pad-b small muted"><strong>Role permissions</strong><ul class="perm-list">
          <li><strong>Owner / Administrator</strong> — everything, incl. team, settings and compliance overrides</li>
          <li><strong>Procurement Manager</strong> — vendors, uploads, checklists, tasks, request approvals</li>
          <li><strong>Compliance Manager</strong> — plus verify/reject documents and decide approvals</li>
          <li><strong>Reviewer</strong> — verify documents, decide assigned approvals, update own tasks</li>
          <li><strong>Read-only Viewer</strong> — view only</li></ul></div></div>` : ''}
      </div>`;
    W.render(req, res, { title: 'Team members', active: 'team', body });
  }));
  router.post('/team', W.auth(async (req, res) => {
    const u = svc.members.add(req.ctx, { name: req.body.name, email: req.body.email, role: req.body.role, password: req.body.password || undefined });
    W.flash(res, 'success', `${u.name} added.`);
    redirect(res, '/team');
  }));
  router.post('/team/:id/role', W.auth(async (req, res) => {
    svc.members.changeRole(req.ctx, req.params.id, req.body.role);
    W.flash(res, 'success', 'Role updated.');
    redirect(res, '/team');
  }));

  // ======================= SETTINGS =======================
  router.get('/settings', W.auth(async (req, res) => {
    const ctx = req.ctx;
    const org = svc.members.getOrg(ctx.orgId);
    const csrf = req.session.csrf;
    const manage = can(ctx, P.SETTINGS_MANAGE);
    const creds = svc.credentials.listForUser(ctx);
    const keys = creds.filter((c) => c.kind === 'api_key');
    const connections = creds.filter((c) => c.kind === 'oauth_refresh');
    const templates = svc.compliance.listTemplates(ctx);
    const grouped = templates.reduce((m, t) => ((m[t.vendor_category] = m[t.vendor_category] || []).push(t), m), {});
    const newKey = req.newKey;
    const mcpUrl = `${config.appUrl}/mcp`;
    const body = html`
      ${L.pageHeader('Settings', org.name)}
      <nav class="tabs"><a href="#claude">Claude connection</a><a href="#org">Organisation</a><a href="#requirements">Compliance requirements</a><a href="#profile">Profile</a></nav>

      <section class="card" id="claude"><div class="card-head"><h2>${L.icon('claude')} Claude connection (MCP)</h2></div><div class="pad stack">
        <p>Your team uses <strong>their own Claude plan</strong> to work in VendorFlow. VendorFlow contains no AI and pays for no AI: Claude reads and writes, VendorFlow stores, checks permissions and keeps everything live.</p>
        <ol class="steps">
          <li>In Claude: <strong>Settings → Connectors → Add custom connector</strong>.</li>
          <li>Name: <strong>VendorFlow</strong>. URL:<div class="copy-row"><code id="mcp-url">${mcpUrl}</code><button class="btn sm" type="button" data-copy="#mcp-url">Copy</button></div></li>
          <li>Click <strong>Connect</strong>, sign in here and pick <strong>${org.name}</strong>. Done: no keys to paste.</li>
          <li>Try: <em>"Show me the compliance summary of all active vendors and which have missing documents."</em></li>
        </ol>
        ${connections.length ? html`<h3>Active Claude connections</h3><ul class="list">${connections.map((c) => html`<li><div><strong>${c.client_name || 'Claude'}</strong><div class="muted small">${c.user_name} · connected ${L.fmtRelative(c.created_at)}${c.last_used_at ? ` · last used ${L.fmtRelative(c.last_used_at)}` : ''}</div></div>
          <form method="post" action="/settings/credentials/${c.id}/revoke" data-confirm="Disconnect this Claude connection? Claude will need to reconnect."><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm danger-outline">Disconnect</button></form></li>`)}</ul>` : ''}
        <details class="advanced" ${newKey ? 'open' : ''}><summary>Advanced: personal API keys (MCP Inspector & other clients)</summary>
          <p class="muted small">For MCP clients that can't do OAuth, send <code>Authorization: Bearer &lt;key&gt;</code> to ${mcpUrl}. Keys act as you, with your role's permissions. Only a hash is stored; we show the key once.</p>
          ${newKey ? html`<div class="alert success"><strong>Copy your new key now. You won't see it again.</strong><div class="copy-row"><code id="new-key">${newKey}</code><button class="btn sm" type="button" data-copy="#new-key">Copy</button></div></div>` : ''}
          ${keys.length ? html`<ul class="list">${keys.map((k) => html`<li><div><strong>${k.name}</strong> <code>${k.prefix}…</code><div class="muted small">${k.user_name} · created ${L.fmtRelative(k.created_at)} · ${k.last_used_at ? `last used ${L.fmtRelative(k.last_used_at)}` : 'never used'}</div></div>
            <div class="row gap"><form method="post" action="/settings/credentials/${k.id}/rotate"><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm">Rotate</button></form>
            <form method="post" action="/settings/credentials/${k.id}/revoke" data-confirm="Revoke ${k.name}? Clients using it will stop working."><input type="hidden" name="csrf" value="${csrf}"><button class="btn sm danger-outline">Revoke</button></form></div></li>`)}</ul>` : ''}
          ${can(ctx, P.CREDENTIAL_MANAGE) ? html`<form method="post" action="/settings/credentials" class="row gap"><input type="hidden" name="csrf" value="${csrf}"><input name="name" placeholder="Key name, e.g. MCP Inspector" maxlength="60" required><button class="btn">Create API key</button></form>` : ''}
        </details>
      </div></section>

      <section class="card" id="org"><div class="card-head"><h2>Organisation profile</h2></div>
        <form method="post" action="/settings/org" class="pad form-grid"><input type="hidden" name="csrf" value="${csrf}">
          <label class="field"><span>Organisation name</span><input name="name" value="${org.name}" required ${manage ? '' : 'disabled'}></label>
          <label class="field"><span>Legal name</span><input name="legal_name" value="${org.legal_name || ''}" ${manage ? '' : 'disabled'}></label>
          <label class="field"><span>Country</span><input name="country" value="${org.country || ''}" ${manage ? '' : 'disabled'}></label>
          <label class="field"><span>Tax ID (GSTIN)</span><input name="tax_id" value="${org.tax_id || ''}" ${manage ? '' : 'disabled'}></label>
          <label class="field span-2"><span>Address</span><textarea name="address" rows="2" ${manage ? '' : 'disabled'}>${org.address || ''}</textarea></label>
          ${manage ? html`<div class="span-2 row end"><button class="btn primary">Save organisation</button></div>` : ''}
        </form></section>

      <section class="card" id="requirements"><div class="card-head"><h2>Compliance requirements by vendor category</h2></div><div class="pad">
        <p class="muted small">Templates applied when a checklist is created without explicit requirements (from the vendor page or by Claude).</p>
        <div class="req-grid">${Object.entries(grouped).map(([cat, items]) => html`<div class="req-group"><h3>${cat}</h3><ul>${items.map((t) => html`<li>${t.name} ${t.mandatory ? '' : html`<span class="muted small">(optional)</span>`}
          ${manage ? html`<form method="post" action="/settings/requirements/${t.id}/delete" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button class="btn xs ghost" aria-label="Remove ${t.name} from ${cat}">${L.icon('x')}</button></form>` : ''}</li>`)}</ul></div>`)}</div>
        ${manage ? html`<form method="post" action="/settings/requirements" class="row gap wrap"><input type="hidden" name="csrf" value="${csrf}">
          <input name="vendor_category" list="cat-list2" placeholder="Vendor category" required><datalist id="cat-list2">${svc.vendors.categories(ctx).map((c) => html`<option value="${c}">`)}</datalist>
          <select name="doc_category">${L.options(D.DOC_CATEGORIES, '', D.DOC_CATEGORY_LABELS)}</select>
          <label class="check"><input type="checkbox" name="mandatory" value="true" checked> Mandatory</label><button class="btn">Add requirement</button></form>` : ''}
      </div></section>

      <section class="card" id="profile"><div class="card-head"><h2>Your profile</h2></div><div class="pad form-grid">
        <div class="kv-list span-2"><div class="kv"><span>Name</span><span>${req.session.user.name}</span></div><div class="kv"><span>Email</span><span>${req.session.user.email}</span></div><div class="kv"><span>Role</span><span>${D.ROLE_LABELS[ctx.role]}</span></div></div>
        <form method="post" action="/settings/password" class="span-2 row gap wrap"><input type="hidden" name="csrf" value="${csrf}">
          <input type="password" name="current" placeholder="Current password" required autocomplete="current-password"><input type="password" name="next" placeholder="New password (10+ chars)" required minlength="10" autocomplete="new-password"><button class="btn">Change password</button></form>
        <p class="muted small span-2">Notification preferences and email delivery are not yet available; all notifications are in-app.</p>
      </div></section>`;
    W.render(req, res, { title: 'Settings', active: 'settings', body });
  }));

  router.post('/settings/org', W.auth(async (req, res) => { svc.members.updateOrg(req.ctx, req.body); W.flash(res, 'success', 'Organisation saved.'); redirect(res, '/settings#org'); }));
  router.post('/settings/requirements', W.auth(async (req, res) => {
    svc.compliance.addTemplate(req.ctx, { vendor_category: req.body.vendor_category, doc_category: req.body.doc_category, mandatory: req.body.mandatory === 'true' });
    W.flash(res, 'success', 'Requirement added to template.'); redirect(res, '/settings#requirements');
  }));
  router.post('/settings/requirements/:id/delete', W.auth(async (req, res) => { svc.compliance.removeTemplate(req.ctx, req.params.id); redirect(res, '/settings#requirements'); }));
  router.post('/settings/password', W.auth(async (req, res) => {
    svc.members.changePassword(req.ctx, req.body.current, req.body.next);
    W.sessions.destroy(req, res);
    W.flash(res, 'success', 'Password changed. Please sign in again.');
    redirect(res, '/login');
  }));

  const showSettingsWithKey = async (req, res, key) => {
    req.newKey = key;
    const handler = router.match('GET', '/settings').handler;
    req.method = 'GET';
    return handler(req, res);
  };
  router.post('/settings/credentials', W.auth(async (req, res) => showSettingsWithKey(req, res, svc.credentials.createApiKey(req.ctx, req.body.name).token)));
  router.post('/settings/credentials/:id/rotate', W.auth(async (req, res) => showSettingsWithKey(req, res, svc.credentials.rotate(req.ctx, req.params.id).token)));
  router.post('/settings/credentials/:id/revoke', W.auth(async (req, res) => { svc.credentials.revoke(req.ctx, req.params.id); W.flash(res, 'success', 'Revoked.'); redirect(res, '/settings#claude'); }));
};

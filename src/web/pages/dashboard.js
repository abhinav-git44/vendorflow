'use strict';

module.exports = function dashboardPages(router, W) {
  const { svc, layout: L, html } = W;

  const kpi = (label, value, href, sub, tone) => html`<a class="kpi ${tone || ''}" href="${href}"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span>${sub ? html`<span class="kpi-sub">${sub}</span>` : ''}</a>`;
  const mini = (label, value, href) => html`<a class="mini-stat" href="${href}"><span>${label}</span><strong>${value}</strong></a>`;

  router.get('/', W.auth(async (req, res) => {
    const ctx = req.ctx;
    const o = svc.dashboard.overview(ctx);
    const k = o.kpis;
    const hour = new Date().getUTCHours() + 5.5; // greet in IST by default
    const greet = hour % 24 < 12 ? 'Good morning' : hour % 24 < 17 ? 'Good afternoon' : 'Good evening';
    const notes = svc.notifications.list(ctx, { limit: 5 });
    const org = svc.members.getOrg(ctx.orgId);
    const empty = k.total_vendors === 0;

    const body = html`
      ${L.pageHeader(`${greet}, ${req.session.user.name.split(' ')[0]}`, `${org.name} · vendor compliance overview`,
    html`<a class="btn" href="/reports">${L.icon('reports')}Reports</a><a class="btn primary" href="/vendors/new">${L.icon('plus')}Add vendor</a>`)}
      ${empty ? html`<div class="card pad onboarding">
          <h2>Get started</h2>
          <p class="muted">Add vendors yourself, or connect Claude and just ask: <em>"Create a vendor called ABC Technologies, category Technology, and add a GST, PAN and bank checklist."</em></p>
          <div class="row gap"><a class="btn primary" href="/settings#claude">${L.icon('claude')}Connect Claude</a><a class="btn" href="/vendors/new">Add a vendor manually</a></div>
        </div>` : ''}
      <section class="kpis">
        ${kpi('Total vendors', k.total_vendors, '/vendors', `${k.active_vendors} approved · ${k.pending_onboarding} onboarding`)}
        ${kpi('Fully compliant', k.fully_compliant, '/compliance?compliance=compliant', `${k.partially_compliant} partial · ${k.non_compliant} non-compliant`)}
        ${kpi('Pending approvals', k.pending_approvals, '/approvals', k.pending_approvals ? 'Awaiting a decision' : 'Queue is clear')}
        ${kpi('Expiring in 30 days', k.documents_expiring_30d, '/documents?status=expiring', `${k.documents_expired} already expired`, k.documents_expired ? 'warn' : '')}
      </section>
      <section class="mini-stats">
        ${mini('Active vendors', k.active_vendors, '/vendors?status=approved')}
        ${mini('Pending onboarding', k.pending_onboarding, '/vendors?status=pending_onboarding')}
        ${mini('Partially compliant', k.partially_compliant, '/compliance?compliance=partial')}
        ${mini('Non-compliant', k.non_compliant, '/compliance?compliance=non_compliant')}
        ${mini('Docs awaiting verification', k.documents_awaiting_verification, '/documents?status=pending')}
        ${mini('Open review tasks', k.open_tasks, '/tasks')}
        ${mini('Overdue reviews', k.overdue_tasks, '/tasks?overdue=1')}
      </section>

      <section class="grid-3">
        <div class="card"><div class="card-head"><h2>Vendor registrations</h2><span class="muted small">Last 6 months</span></div>
          <div class="pad">${L.columnChart(o.charts.monthly, { label: 'New vendors' })}</div></div>
        <div class="card"><div class="card-head"><h2>Compliance distribution</h2><a class="small" href="/compliance">Details</a></div>
          <div class="pad">${L.stackedStatusBar([
    { label: 'Fully compliant', value: o.charts.compliance.compliant, tone: 'good' },
    { label: 'Partially compliant', value: o.charts.compliance.partial, tone: 'warning' },
    { label: 'Non-compliant', value: o.charts.compliance.non_compliant, tone: 'critical' },
    { label: 'No checklist', value: o.charts.compliance.no_checklist, tone: 'neutral' },
  ], { label: 'Vendors by compliance status' })}</div></div>
        <div class="card"><div class="card-head"><h2>Document status</h2><a class="small" href="/documents">All documents</a></div>
          <div class="pad">${L.hbarChart([
    { label: 'Verified', value: o.charts.documents.verified, tone: 'good' },
    { label: 'Pending verification', value: o.charts.documents.pending_verification, tone: 'warning' },
    { label: 'Awaiting file', value: o.charts.documents.awaiting_file, tone: 'neutral' },
    { label: 'Rejected', value: o.charts.documents.rejected, tone: 'critical' },
    { label: 'Expired', value: o.charts.documents.expired, tone: 'serious' },
  ])}
          <div class="review-split"><span>Review tasks</span><strong>${o.charts.reviews.completed}</strong> completed · <strong>${o.charts.reviews.open}</strong> open${o.charts.reviews.overdue ? html` · <span class="text-critical"><strong>${o.charts.reviews.overdue}</strong> overdue</span>` : ''}</div></div></div>
      </section>

      <section class="grid-2">
        <div class="card"><div class="card-head"><h2>Pending approvals</h2><a class="small" href="/approvals">Approval queue</a></div>
          ${o.lists.approvals.length ? html`<ul class="list">${o.lists.approvals.map((a) => html`<li><div><a href="/vendors/${a.vendor_id}">${a.company_name}</a><span class="muted small"> · ${a.vendor_id}</span><div class="muted small">Approver: ${a.approver.name} · requested ${L.fmtRelative(a.created_at)}</div></div>${L.approvalBadge(a.status)}</li>`)}</ul>`
    : L.emptyState('No pending approvals', 'Requests sent from Claude or the vendor page appear here.')}
        </div>
        <div class="card"><div class="card-head"><h2>Upcoming document expiries</h2><a class="small" href="/documents?status=expiring">See all</a></div>
          ${o.lists.expiring.length ? html`<ul class="list">${o.lists.expiring.map((d) => html`<li><div><a href="/vendors/${d.vendor_id}?tab=documents">${d.name}</a><div class="muted small">${d.company_name} · ${d.days_to_expiry < 0 ? `expired ${-d.days_to_expiry}d ago` : `in ${d.days_to_expiry} days`} (${L.fmtDate(d.expiry_date)})</div></div>${L.docBadge(d.status)}</li>`)}</ul>`
    : L.emptyState('Nothing expiring in the next 30 days', null)}
        </div>
        <div class="card"><div class="card-head"><h2>Assigned to me</h2><a class="small" href="/tasks?mine=1">My tasks</a></div>
          ${o.lists.myTasks.length ? html`<ul class="list">${o.lists.myTasks.map((t) => html`<li><div><a href="/tasks?highlight=${t.task_id}">${t.title}</a><div class="muted small">${t.company_name || 'General'} · ${t.due_date ? (t.overdue ? html`<span class="text-critical">overdue since ${L.fmtDate(t.due_date)}</span>` : `due ${L.fmtDate(t.due_date)}`) : 'no deadline'}</div></div>${L.priorityBadge(t.priority)}</li>`)}</ul>`
    : L.emptyState('No open tasks assigned to you', null)}
        </div>
        <div class="card"><div class="card-head"><h2>Recently added vendors</h2><a class="small" href="/vendors">All vendors</a></div>
          ${o.lists.recentVendors.length ? html`<ul class="list">${o.lists.recentVendors.map((v) => html`<li><div><a href="/vendors/${v.vendor_id}">${v.company_name}</a><div class="muted small">${v.vendor_id} · ${v.category} · added ${L.fmtRelative(v.created_at)}</div></div>${L.progress(v.compliance?.percent, v.compliance?.status)}</li>`)}</ul>`
    : L.emptyState('No vendors yet', null, html`<a class="btn sm" href="/vendors/new">Add vendor</a>`)}
        </div>
        <div class="card"><div class="card-head"><h2>Recent activity</h2><a class="small" href="/activity">Audit log</a></div>
          ${o.lists.recentActivity.length ? html`<ul class="list activity">${o.lists.recentActivity.map((a) => html`<li><div><span>${a.summary}</span><div class="muted small">${a.actor_label} · ${L.fmtRelative(a.created_at)} ${L.actorChip(a)}</div></div></li>`)}</ul>` : L.emptyState('No activity yet', null)}
        </div>
        <div class="card"><div class="card-head"><h2>Notifications</h2><a class="small" href="/notifications">View all</a></div>
          ${notes.length ? html`<ul class="list">${notes.map((n) => html`<li class="${n.read_at ? '' : 'unread'}"><div><a href="${n.link || '/notifications'}">${n.title}</a><div class="muted small">${n.body || ''} · ${L.fmtRelative(n.created_at)}</div></div></li>`)}</ul>` : L.emptyState("You're all caught up", null)}
        </div>
      </section>`;
    W.render(req, res, { title: 'Overview', active: 'overview', body });
  }));
};

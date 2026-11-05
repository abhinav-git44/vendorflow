'use strict';
const { today, addDays } = require('../lib/util');
const { effectiveDocStatus } = require('./compliance');

/** Every number on the dashboard is computed from live records. Nothing is hard-coded. */
module.exports = function dashboardService({ db, svc }) {
  function overview(ctx) {
    const t = today();
    const soon = addDays(t, 30);
    const vendors = db.all("SELECT id, status, created_at FROM vendors WHERE org_id = ? AND status != 'archived'", ctx.orgId);
    const comp = svc.compliance.forOrg(ctx);
    const compCounts = { compliant: 0, partial: 0, non_compliant: 0, no_checklist: 0 };
    for (const v of vendors) compCounts[comp.get(v.id).status]++;

    const docs = db.all(`SELECT d.* FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
                         WHERE d.org_id = ? AND d.deleted_at IS NULL AND v.status != 'archived'`, ctx.orgId);
    const docStatus = { awaiting_file: 0, pending_verification: 0, verified: 0, rejected: 0, expired: 0 };
    let expiringSoon = 0;
    for (const d of docs) {
      const s = effectiveDocStatus(d, t);
      docStatus[s === 'uploaded' ? 'pending_verification' : s]++;
      if (['verified', 'pending_verification', 'uploaded'].includes(s) && d.expiry_date && d.expiry_date <= soon) expiringSoon++;
    }

    const count = (sql, ...p) => db.get(sql, ...p).n;
    const openTasks = count("SELECT COUNT(*) AS n FROM review_tasks WHERE org_id = ? AND status IN ('todo','in_progress','blocked')", ctx.orgId);
    const overdueTasks = count("SELECT COUNT(*) AS n FROM review_tasks WHERE org_id = ? AND status IN ('todo','in_progress','blocked') AND due_date < ?", ctx.orgId, t);
    const completedTasks = count("SELECT COUNT(*) AS n FROM review_tasks WHERE org_id = ? AND status = 'completed'", ctx.orgId);
    const pendingApprovals = count("SELECT COUNT(*) AS n FROM approval_requests WHERE org_id = ? AND status = 'pending'", ctx.orgId);

    // Monthly registrations: last 6 calendar months, including zero months.
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), count: 0 });
    }
    const all = db.all('SELECT created_at FROM vendors WHERE org_id = ?', ctx.orgId);
    for (const v of all) { const m = months.find((x) => x.key === v.created_at.slice(0, 7)); if (m) m.count++; }

    return {
      kpis: {
        total_vendors: vendors.length,
        active_vendors: vendors.filter((v) => v.status === 'approved').length,
        pending_onboarding: vendors.filter((v) => ['draft', 'pending_onboarding', 'under_review'].includes(v.status)).length,
        fully_compliant: compCounts.compliant, partially_compliant: compCounts.partial, non_compliant: compCounts.non_compliant, no_checklist: compCounts.no_checklist,
        documents_awaiting_verification: docStatus.pending_verification, documents_expiring_30d: expiringSoon, documents_expired: docStatus.expired,
        overdue_tasks: overdueTasks, open_tasks: openTasks, completed_tasks: completedTasks, pending_approvals: pendingApprovals,
      },
      charts: { compliance: compCounts, documents: docStatus, monthly: months, reviews: { open: openTasks, completed: completedTasks, overdue: overdueTasks } },
      lists: {
        recentActivity: svc.activity.list(ctx, { limit: 8 }).rows,
        expiring: svc.documents.expiring(ctx, { days: 30 }).slice(0, 6),
        approvals: svc.approvals.list(ctx, { status: 'pending' }).slice(0, 5),
        myTasks: svc.tasks.list(ctx, { status: 'open', assigneeId: ctx.userId }).slice(0, 6),
        recentVendors: svc.vendors.list(ctx, { sort: 'newest', page_size: 5 }).vendors,
      },
    };
  }

  return { overview };
};

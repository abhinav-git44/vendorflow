'use strict';
const { nowIso, today, addDays } = require('../lib/util');

/**
 * Scheduled checks — the part of the business that keeps working after the chat ends.
 * Idempotent: safe to run on every boot and every hour.
 */
module.exports = function jobService({ db, svc }) {
  function runChecks(onDate = today()) {
    const result = { expired: 0, expiryReminders: 0, overdueReminders: 0 };
    const orgs = db.all('SELECT id FROM organizations');
    for (const { id: orgId } of orgs) {
      const ctx = { orgId, userId: null, role: 'owner', actor: { type: 'system', id: null, label: 'VendorFlow scheduler' } };
      const complianceTeam = svc.notifications.usersWithRoles(orgId, ['compliance_manager']);

      db.tx(() => {
        // 1. Expire documents past their expiry date.
        const toExpire = db.all(`SELECT d.*, v.company_name, v.vendor_code, v.manager_id FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
          WHERE d.org_id = ? AND d.deleted_at IS NULL AND d.expiry_date < ? AND d.status IN ('uploaded','pending_verification','verified')`, orgId, onDate);
        for (const d of toExpire) {
          db.run("UPDATE vendor_documents SET status = 'expired', updated_at = ? WHERE id = ?", nowIso(), d.id);
          svc.activity.log(ctx, { action: 'document.expired', entityType: 'document', entityId: d.id, vendorId: d.vendor_id, summary: `${d.name} for ${d.company_name} expired on ${d.expiry_date}` });
          svc.notifications.notify(ctx, [d.manager_id, ...complianceTeam], { type: 'document.expired', title: `Expired: ${d.name}`, body: `${d.company_name} (${d.vendor_code}) — expired ${d.expiry_date}`, link: `/vendors/${d.vendor_code}?tab=documents`, dedupeKey: `doc:${d.id}:expired:${d.expiry_date}` });
          result.expired++;
        }

        // 2. Remind about documents expiring within 30 days.
        const soon = db.all(`SELECT d.*, v.company_name, v.vendor_code, v.manager_id FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
          WHERE d.org_id = ? AND d.deleted_at IS NULL AND v.status != 'archived' AND d.expiry_date BETWEEN ? AND ? AND d.status IN ('verified','pending_verification','uploaded')`,
        orgId, onDate, addDays(onDate, 30));
        for (const d of soon) {
          const before = db.get('SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE ?', `doc:${d.id}:expiring:${d.expiry_date}:%`).n;
          svc.notifications.notify(ctx, [d.manager_id, ...complianceTeam], { type: 'document.expiring', title: `Expiring soon: ${d.name}`, body: `${d.company_name} — expires ${d.expiry_date}`, link: `/vendors/${d.vendor_code}?tab=documents`, dedupeKey: `doc:${d.id}:expiring:${d.expiry_date}` });
          if (!before) result.expiryReminders++;
        }

        // 3. Overdue task reminders.
        const overdue = db.all("SELECT * FROM review_tasks WHERE org_id = ? AND status IN ('todo','in_progress','blocked') AND due_date < ? AND assignee_id IS NOT NULL", orgId, onDate);
        for (const t of overdue) {
          const before = db.get('SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = ?', `task:${t.id}:overdue:${t.due_date}:${t.assignee_id}`).n;
          svc.notifications.notify(ctx, [t.assignee_id], { type: 'task.overdue', title: 'Overdue task', body: `${t.title} — was due ${t.due_date}`, link: `/tasks?highlight=${t.id}`, dedupeKey: `task:${t.id}:overdue:${t.due_date}` });
          if (!before) result.overdueReminders++;
        }
      });
    }
    return result;
  }

  return { runChecks };
};

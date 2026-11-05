'use strict';
const { uuid, nowIso } = require('../lib/util');

module.exports = function notificationService({ db }) {
  /**
   * Send an in-app notification to each user (never to the actor themself).
   * dedupeKey makes scheduled reminders idempotent.
   */
  function notify(ctx, userIds, { type, title, body, link, dedupeKey }) {
    const unique = [...new Set(userIds.filter(Boolean))].filter((id) => id !== ctx.userId);
    for (const userId of unique) {
      const key = dedupeKey ? `${dedupeKey}:${userId}` : null;
      db.run(
        `INSERT INTO notifications (id, org_id, user_id, type, title, body, link, dedupe_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
        uuid(), ctx.orgId, userId, type, title, body || null, link || null, key, nowIso(),
      );
    }
  }

  /** Users in the org holding any of the given roles. */
  function usersWithRoles(orgId, roles) {
    return db.all(`SELECT user_id FROM organization_members WHERE org_id = ? AND role IN (${roles.map(() => '?').join(',')})`, orgId, ...roles)
      .map((r) => r.user_id);
  }

  function list(ctx, { unreadOnly = false, limit = 50 } = {}) {
    return db.all(
      `SELECT * FROM notifications WHERE org_id = ? AND user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC LIMIT ?`, ctx.orgId, ctx.userId, limit,
    );
  }

  const unreadCount = (ctx) =>
    db.get('SELECT COUNT(*) AS n FROM notifications WHERE org_id = ? AND user_id = ? AND read_at IS NULL', ctx.orgId, ctx.userId).n;

  function markRead(ctx, id) {
    db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND org_id = ? AND user_id = ? AND read_at IS NULL', nowIso(), id, ctx.orgId, ctx.userId);
  }
  function markAllRead(ctx) {
    db.run('UPDATE notifications SET read_at = ? WHERE org_id = ? AND user_id = ? AND read_at IS NULL', nowIso(), ctx.orgId, ctx.userId);
  }

  return { notify, usersWithRoles, list, unreadCount, markRead, markAllRead };
};

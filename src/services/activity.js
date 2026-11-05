'use strict';
const { uuid, nowIso } = require('../lib/util');

module.exports = function activityService({ db }) {
  /** Append an audit record. Called inside the same transaction as the change it describes. */
  function log(ctx, { action, entityType, entityId, vendorId, summary, metadata }) {
    db.run(
      `INSERT INTO activity_logs (id, org_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, vendor_id, summary, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      uuid(), ctx.orgId, ctx.actor.type, ctx.actor.id || null, ctx.actor.label, action, entityType, entityId || null,
      vendorId || null, summary, metadata ? JSON.stringify(metadata) : null, nowIso(),
    );
  }

  function list(ctx, { vendorId, entityId, actorType, entityType, limit = 50, offset = 0 } = {}) {
    const where = ['a.org_id = ?'];
    const params = [ctx.orgId];
    if (vendorId) { where.push('a.vendor_id = ?'); params.push(vendorId); }
    if (entityId) { where.push('a.entity_id = ?'); params.push(entityId); }
    if (actorType) { where.push('a.actor_type = ?'); params.push(actorType); }
    if (entityType) { where.push('a.entity_type = ?'); params.push(entityType); }
    const total = db.get(`SELECT COUNT(*) AS n FROM activity_logs a WHERE ${where.join(' AND ')}`, ...params).n;
    const rows = db.all(
      `SELECT a.*, v.vendor_code, v.company_name FROM activity_logs a LEFT JOIN vendors v ON v.id = a.vendor_id
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    return { total, rows: rows.map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })) };
  }

  return { log, list };
};

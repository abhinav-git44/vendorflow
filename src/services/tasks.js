'use strict';
const { uuid, nowIso, today } = require('../lib/util');
const { E } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { P, can, requirePerm } = require('../auth/permissions');
const D = require('../domain');

const OPEN = ['todo', 'in_progress', 'blocked'];

const assignSchema = {
  type: 'object', additionalProperties: false, required: ['title'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 160, description: 'Short task title, e.g. "Compliance review – ABC Technologies".' },
    vendor: { type: 'string', description: 'Vendor ID (VF-1001) or company name this task is about.' },
    description: { type: 'string', maxLength: 2000 },
    assignee_email: { type: 'string', format: 'email', description: 'Assignee email.' },
    assignee_name: { type: 'string', maxLength: 80, description: 'Assignee name (if email unknown).' },
    assignee_role: { type: 'string', maxLength: 40, description: 'Assign to whoever holds this role, e.g. "procurement manager". Fails if several people hold it.' },
    priority: { type: 'string', enum: D.TASK_PRIORITIES, description: 'Default medium.' },
    due_date: { type: 'string', format: 'date', description: 'Deadline, YYYY-MM-DD.' },
  },
};
const statusSchema = {
  type: 'object', additionalProperties: false, required: ['task_id', 'status'],
  properties: {
    task_id: { type: 'string', description: 'Task ID.' },
    status: { type: 'string', enum: D.TASK_STATUSES },
    note: { type: 'string', maxLength: 500, description: 'Optional note recorded in the activity log.' },
  },
};
const editSchema = {
  type: 'object', properties: {
    title: assignSchema.properties.title, description: assignSchema.properties.description, priority: assignSchema.properties.priority,
    due_date: assignSchema.properties.due_date, status: { type: 'string', enum: D.TASK_STATUSES }, assignee_id: { type: 'string', maxLength: 64 },
  },
};

module.exports = function taskService({ db, config, svc }) {
  function dto(row) {
    const overdue = OPEN.includes(row.status) && row.due_date && row.due_date < today();
    return {
      task_id: row.id, title: row.title, description: row.description, priority: row.priority, status: row.status, status_label: D.TASK_STATUS_LABELS[row.status],
      due_date: row.due_date, overdue: Boolean(overdue), vendor_id: row.vendor_code || null, company_name: row.company_name || null,
      assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, email: row.assignee_email } : null,
      completed_at: row.completed_at, created_at: row.created_at,
      app_url: `${config.appUrl}/tasks?highlight=${row.id}`,
    };
  }
  const SELECT = `SELECT t.*, v.vendor_code, v.company_name, p.name AS assignee_name, p.email AS assignee_email
                  FROM review_tasks t LEFT JOIN vendors v ON v.id = t.vendor_id LEFT JOIN profiles p ON p.id = t.assignee_id`;

  function getRow(ctx, id) {
    const row = db.get(`${SELECT} WHERE t.id = ? AND t.org_id = ?`, id, ctx.orgId);
    if (!row) throw E.notFound('Task not found.');
    return row;
  }

  function assign(ctx, input) {
    requirePerm(ctx, P.TASK_WRITE, 'create tasks');
    const v = validate(assignSchema, input, { stripUnknown: ctx.actor.type === 'user' });
    const vendor = v.vendor ? svc.vendors.resolve(ctx, v.vendor) : null;
    if (vendor && vendor.status === 'archived') throw E.state(`${vendor.company_name} is archived.`);
    let assignee;
    if (v.assignee_email || v.assignee_name || v.assignee_role) assignee = svc.members.resolve(ctx, { email: v.assignee_email, name: v.assignee_name, role: v.assignee_role });
    else if (vendor && vendor.manager_id) assignee = { id: vendor.manager_id };
    else throw E.validation('Say who the task is for (assignee_email, assignee_name or assignee_role).');
    if (v.due_date && v.due_date < today()) throw E.validation(`The deadline ${v.due_date} is in the past.`);
    return db.tx(() => {
      const id = uuid();
      const ts = nowIso();
      db.run(`INSERT INTO review_tasks (id, org_id, vendor_id, title, description, assignee_id, priority, status, due_date, created_by, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?, 'todo', ?,?,?,?)`, id, ctx.orgId, vendor?.id || null, v.title, v.description, assignee.id, v.priority || 'medium', v.due_date, ctx.userId || null, ts, ts);
      const row = getRow(ctx, id);
      svc.activity.log(ctx, { action: 'task.assigned', entityType: 'task', entityId: id, vendorId: vendor?.id,
        summary: `Assigned ${row.priority}-priority task "${v.title}" to ${row.assignee_name}${v.due_date ? `, due ${v.due_date}` : ''}` });
      svc.notifications.notify(ctx, [assignee.id], { type: 'task.assigned', title: `New ${row.priority}-priority task`, body: `${v.title}${v.due_date ? ` — due ${v.due_date}` : ''}`, link: `/tasks?highlight=${id}` });
      return dto(row);
    });
  }

  function canTouch(ctx, row) {
    if (can(ctx, P.TASK_WRITE)) return;
    if (can(ctx, P.TASK_UPDATE_OWN) && row.assignee_id === ctx.userId) return;
    throw E.forbidden('You can only update tasks assigned to you.');
  }

  function updateStatus(ctx, input) {
    const v = validate(statusSchema, input);
    const row = getRow(ctx, v.task_id);
    canTouch(ctx, row);
    if (row.status === v.status) return dto(row);
    return db.tx(() => {
      const ts = nowIso();
      db.run('UPDATE review_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', v.status, v.status === 'completed' ? ts : null, ts, row.id);
      svc.activity.log(ctx, { action: 'task.status_changed', entityType: 'task', entityId: row.id, vendorId: row.vendor_id,
        summary: `Task "${row.title}": ${D.TASK_STATUS_LABELS[row.status]} → ${D.TASK_STATUS_LABELS[v.status]}${v.note ? ` — ${v.note}` : ''}`, metadata: { from: row.status, to: v.status, note: v.note || null } });
      if (v.status === 'completed' && row.created_by) {
        svc.notifications.notify(ctx, [row.created_by], { type: 'task.completed', title: 'Task completed', body: row.title, link: `/tasks?highlight=${row.id}` });
      }
      return dto(getRow(ctx, row.id));
    });
  }

  function edit(ctx, id, input) {
    requirePerm(ctx, P.TASK_WRITE, 'edit tasks');
    const row = getRow(ctx, id);
    const v = validate(editSchema, input, { stripUnknown: true });
    if (v.assignee_id && !svc.members.membership(v.assignee_id, ctx.orgId)) throw E.validation('Assignee is not a member of this organisation.');
    return db.tx(() => {
      const ts = nowIso();
      const next = { title: v.title ?? row.title, description: v.description ?? null, priority: v.priority ?? row.priority, due_date: v.due_date ?? null,
        assignee_id: v.assignee_id ?? row.assignee_id, status: v.status ?? row.status };
      db.run('UPDATE review_tasks SET title=?, description=?, priority=?, due_date=?, assignee_id=?, status=?, completed_at=?, updated_at=? WHERE id=?',
        next.title, next.description, next.priority, next.due_date, next.assignee_id, next.status, next.status === 'completed' ? (row.completed_at || ts) : null, ts, row.id);
      svc.activity.log(ctx, { action: 'task.updated', entityType: 'task', entityId: row.id, vendorId: row.vendor_id, summary: `Updated task "${next.title}"` });
      if (next.assignee_id !== row.assignee_id) {
        svc.notifications.notify(ctx, [next.assignee_id], { type: 'task.assigned', title: 'Task assigned to you', body: next.title, link: `/tasks?highlight=${row.id}` });
      }
      return dto(getRow(ctx, row.id));
    });
  }

  function list(ctx, f = {}) {
    const where = ['t.org_id = ?'];
    const params = [ctx.orgId];
    const status = f.status || 'open';
    if (status === 'open') where.push("t.status IN ('todo','in_progress','blocked')");
    else if (status !== 'all') { where.push('t.status = ?'); params.push(status); }
    if (f.assigneeId) { where.push('t.assignee_id = ?'); params.push(f.assigneeId); }
    if (f.vendorId) { where.push('t.vendor_id = ?'); params.push(f.vendorId); }
    if (f.priority) { where.push('t.priority = ?'); params.push(f.priority); }
    if (f.overdue) { where.push("t.due_date < ? AND t.status IN ('todo','in_progress','blocked')"); params.push(today()); }
    return db.all(`${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN t.status IN ('completed','cancelled') THEN 1 ELSE 0 END, t.due_date IS NULL, t.due_date,
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 500`, ...params).map(dto);
  }

  /** MCP list_pending_tasks: friendly filters. */
  function listPending(ctx, input = {}) {
    const v = validate({ type: 'object', additionalProperties: false, properties: {
      assignee_email: { type: 'string', format: 'email' }, vendor: { type: 'string' }, overdue_only: { type: 'boolean' }, priority: { type: 'string', enum: D.TASK_PRIORITIES },
      mine: { type: 'boolean', description: 'Only tasks assigned to the connected user.' },
    } }, input);
    const assigneeId = v.mine ? ctx.userId : v.assignee_email ? svc.members.resolve(ctx, { email: v.assignee_email }).id : undefined;
    const vendorId = v.vendor ? svc.vendors.resolve(ctx, v.vendor).id : undefined;
    const tasks = list(ctx, { status: 'open', assigneeId, vendorId, overdue: v.overdue_only, priority: v.priority });
    return { count: tasks.length, overdue: tasks.filter((t) => t.overdue).length, tasks };
  }

  return { assign, updateStatus, edit, list, listPending, getRow, dto, schemas: { assignSchema, statusSchema } };
};

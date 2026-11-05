'use strict';
const { uuid, nowIso } = require('../lib/util');
const { E } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { hashPassword, verifyPassword, validatePasswordStrength } = require('../auth/passwords');
const { P, requirePerm } = require('../auth/permissions');
const { ROLES, ROLE_LABELS, DEFAULT_VENDOR_CATEGORIES, normaliseRole } = require('../domain');

const signupSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'email', 'password', 'org_name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 },
    email: { type: 'string', format: 'email', maxLength: 160 },
    password: { type: 'string', maxLength: 200 },
    org_name: { type: 'string', minLength: 2, maxLength: 120 },
  },
};
const addMemberSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'email', 'role'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 80 },
    email: { type: 'string', format: 'email', maxLength: 160 },
    role: { type: 'string', enum: ROLES },
    password: { type: 'string', maxLength: 200 },
  },
};
const orgSchema = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    legal_name: { type: 'string', maxLength: 200 },
    country: { type: 'string', maxLength: 80 },
    address: { type: 'string', maxLength: 400 },
    tax_id: { type: 'string', maxLength: 40 },
  },
};

const DEFAULT_TEMPLATE = [
  ['gst', 'GST Certificate', 1], ['pan', 'PAN Card', 1], ['bank', 'Bank Verification', 1], ['business_registration', 'Business Registration', 1],
];

module.exports = function memberService({ db, svc }) {
  function authenticate(email, password) {
    const user = db.get('SELECT * FROM profiles WHERE email = ?', String(email || '').trim());
    // Always run a hash to keep timing similar whether or not the user exists.
    const ok = verifyPassword(password, user ? user.password_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return ok && user ? user : null;
  }

  function signup(input) {
    const v = validate(signupSchema, input);
    const weak = validatePasswordStrength(v.password);
    if (weak) throw E.validation(weak);
    if (db.get('SELECT 1 FROM profiles WHERE email = ?', v.email)) throw E.conflict('An account with that email already exists.');
    return db.tx(() => {
      const userId = uuid();
      db.run('INSERT INTO profiles (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', userId, v.email.toLowerCase(), v.name, hashPassword(v.password), nowIso());
      const orgId = createOrg({ name: v.org_name, ownerId: userId, ownerName: v.name });
      return { userId, orgId };
    });
  }

  function createOrg({ name, ownerId, ownerName, isDemo = false, orgId = uuid() }) {
    const ts = nowIso();
    db.run('INSERT INTO organizations (id, name, is_demo, created_at, updated_at) VALUES (?,?,?,?,?)', orgId, name, isDemo, ts, ts);
    db.run('INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?,?,?,?,?)', uuid(), orgId, ownerId, 'owner', ts);
    for (const cat of DEFAULT_VENDOR_CATEGORIES) {
      for (const [doc, label, mandatory] of DEFAULT_TEMPLATE) {
        db.run('INSERT INTO compliance_requirements (id, org_id, vendor_category, name, doc_category, mandatory, created_at) VALUES (?,?,?,?,?,?,?)',
          uuid(), orgId, cat, label, doc, mandatory, ts);
      }
    }
    svc.activity.log({ orgId, actor: { type: 'user', id: ownerId, label: ownerName } },
      { action: 'organization.created', entityType: 'organization', entityId: orgId, summary: `Created organisation ${name}` });
    return orgId;
  }

  const getUser = (id) => db.get('SELECT id, email, name, is_demo, created_at FROM profiles WHERE id = ?', id);
  const membership = (userId, orgId) => db.get('SELECT role FROM organization_members WHERE user_id = ? AND org_id = ?', userId, orgId);
  const orgsForUser = (userId) => db.all(
    `SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name`, userId);
  const getOrg = (orgId) => db.get('SELECT * FROM organizations WHERE id = ?', orgId);

  function list(ctx) {
    return db.all(
      `SELECT p.id, p.name, p.email, m.role, m.id AS membership_id, m.created_at FROM organization_members m
       JOIN profiles p ON p.id = m.user_id WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, p.name`, ctx.orgId,
    ).map((m) => ({ ...m, role_label: ROLE_LABELS[m.role] }));
  }

  /**
   * Resolve a person in this org from an email, a name, or a role
   * ("the procurement manager"). Ambiguity is an error, never a guess.
   */
  function resolve(ctx, { email, name, role }, purpose = 'assign') {
    const members = list(ctx);
    if (email) {
      const m = members.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
      if (!m) throw E.notFound(`No team member with email ${email} in this organisation.`);
      return m;
    }
    if (name) {
      const n = String(name).toLowerCase().trim();
      const exact = members.filter((x) => x.name.toLowerCase() === n);
      const partial = exact.length ? exact : members.filter((x) => x.name.toLowerCase().includes(n));
      if (partial.length === 1) return partial[0];
      if (!partial.length) throw E.notFound(`No team member named "${name}".`);
      throw E.ambiguous(`More than one team member matches "${name}": ${partial.map((x) => `${x.name} <${x.email}>`).join(', ')}. Specify an email.`);
    }
    if (role) {
      const r = normaliseRole(role);
      if (!r) throw E.validation(`Unknown role "${role}". Roles: ${ROLES.join(', ')}.`);
      const holders = members.filter((x) => x.role === r);
      if (holders.length === 1) return holders[0];
      if (!holders.length) throw E.notFound(`Nobody in this organisation has the ${ROLE_LABELS[r]} role.`);
      throw E.ambiguous(`Several people are ${ROLE_LABELS[r]}s: ${holders.map((x) => `${x.name} <${x.email}>`).join(', ')}. Say who to ${purpose}.`);
    }
    throw E.validation('Specify a team member by email, name or role.');
  }

  function add(ctx, input) {
    requirePerm(ctx, P.MEMBER_MANAGE, 'manage team members');
    const v = validate(addMemberSchema, input);
    if (v.role === 'owner' && ctx.role !== 'owner') throw E.forbidden('Only an owner can add another owner.');
    return db.tx(() => {
      let user = db.get('SELECT * FROM profiles WHERE email = ?', v.email);
      if (!user) {
        const weak = validatePasswordStrength(v.password || '');
        if (weak) throw E.validation(`Set an initial password for the new user. ${weak}`);
        const id = uuid();
        db.run('INSERT INTO profiles (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', id, v.email.toLowerCase(), v.name, hashPassword(v.password), nowIso());
        user = { id, name: v.name, email: v.email };
      }
      if (membership(user.id, ctx.orgId)) throw E.conflict(`${v.email} is already a member of this organisation.`);
      db.run('INSERT INTO organization_members (id, org_id, user_id, role, created_at) VALUES (?,?,?,?,?)', uuid(), ctx.orgId, user.id, v.role, nowIso());
      svc.activity.log(ctx, { action: 'member.added', entityType: 'member', entityId: user.id, summary: `Added ${user.name} as ${ROLE_LABELS[v.role]}` });
      return user;
    });
  }

  function changeRole(ctx, userId, role) {
    requirePerm(ctx, P.MEMBER_MANAGE, 'manage team members');
    if (!ROLES.includes(role)) throw E.validation('Unknown role.');
    const current = membership(userId, ctx.orgId);
    if (!current) throw E.notFound('Member not found.');
    if ((role === 'owner' || current.role === 'owner') && ctx.role !== 'owner') throw E.forbidden('Only an owner can change owner roles.');
    if (current.role === 'owner' && role !== 'owner') {
      const owners = db.get("SELECT COUNT(*) AS n FROM organization_members WHERE org_id = ? AND role = 'owner'", ctx.orgId).n;
      if (owners <= 1) throw E.state('An organisation must keep at least one owner.');
    }
    db.tx(() => {
      db.run('UPDATE organization_members SET role = ? WHERE user_id = ? AND org_id = ?', role, userId, ctx.orgId);
      const u = getUser(userId);
      svc.activity.log(ctx, { action: 'member.role_changed', entityType: 'member', entityId: userId, summary: `Changed ${u.name}'s role to ${ROLE_LABELS[role]}`, metadata: { from: current.role, to: role } });
    });
  }

  function updateOrg(ctx, input) {
    requirePerm(ctx, P.SETTINGS_MANAGE, 'change organisation settings');
    const v = validate(orgSchema, input, { stripUnknown: true });
    db.tx(() => {
      db.run('UPDATE organizations SET name=?, legal_name=?, country=?, address=?, tax_id=?, updated_at=? WHERE id = ?',
        v.name, v.legal_name, v.country, v.address, v.tax_id, nowIso(), ctx.orgId);
      svc.activity.log(ctx, { action: 'organization.updated', entityType: 'organization', entityId: ctx.orgId, summary: 'Updated organisation profile' });
    });
  }

  function changePassword(ctx, current, next) {
    const user = db.get('SELECT * FROM profiles WHERE id = ?', ctx.userId);
    if (!verifyPassword(current, user.password_hash)) throw E.validation('Current password is incorrect.');
    if (user.is_demo) throw E.forbidden('The shared demo accounts cannot change their password.');
    const weak = validatePasswordStrength(next);
    if (weak) throw E.validation(weak);
    db.run('UPDATE profiles SET password_hash = ? WHERE id = ?', hashPassword(next), ctx.userId);
    db.run('DELETE FROM sessions WHERE user_id = ?', ctx.userId);
  }

  return { authenticate, signup, createOrg, getUser, membership, orgsForUser, getOrg, list, resolve, add, changeRole, updateOrg, changePassword };
};

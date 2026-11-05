'use strict';
const { nowIso, sha256, randomToken } = require('../lib/util');
const { parseCookies, serializeCookie } = require('../lib/http');

const COOKIE = 'vf_session';

/** Server-side sessions: the cookie holds a random token; only its hash is stored. */
module.exports = function sessionStore({ db, config, svc }) {
  function create(res, userId, orgId) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    db.run('INSERT INTO sessions (id_hash, user_id, org_id, csrf_token, expires_at, created_at) VALUES (?,?,?,?,?,?)',
      sha256(token), userId, orgId, csrf, new Date(Date.now() + config.sessionTtlSec * 1000).toISOString(), nowIso());
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, { maxAge: config.sessionTtlSec, secure: config.secureCookies }));
    return { csrf };
  }

  /** Resolve the session → { user, orgId, role, csrf, ctx } or null. */
  function load(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = db.get('SELECT * FROM sessions WHERE id_hash = ?', sha256(token));
    if (!s || s.expires_at < nowIso()) return null;
    const user = svc.members.getUser(s.user_id);
    if (!user) return null;
    let orgId = s.org_id;
    let m = orgId && svc.members.membership(user.id, orgId);
    if (!m) {
      const orgs = svc.members.orgsForUser(user.id);
      orgId = orgs[0]?.id || null;
      m = orgs[0] || null;
      db.run('UPDATE sessions SET org_id = ? WHERE id_hash = ?', orgId, s.id_hash);
    }
    const ctx = orgId ? { orgId, userId: user.id, role: m.role, actor: { type: 'user', id: user.id, label: user.name }, user } : null;
    return { idHash: s.id_hash, user, orgId, role: m && m.role, csrf: s.csrf_token, ctx };
  }

  function switchOrg(session, orgId) {
    if (!svc.members.membership(session.user.id, orgId)) return false;
    db.run('UPDATE sessions SET org_id = ? WHERE id_hash = ?', orgId, session.idHash);
    return true;
  }

  function destroy(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(token));
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0, secure: config.secureCookies }));
  }

  function purgeExpired() { db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso()); }

  return { create, load, switchOrg, destroy, purgeExpired };
};

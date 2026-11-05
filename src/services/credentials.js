'use strict';
const { uuid, nowIso, sha256, randomToken } = require('../lib/util');
const { E } = require('../lib/errors');
const { P, requirePerm } = require('../auth/permissions');

/**
 * MCP credentials. Two kinds:
 *  - OAuth access/refresh tokens, issued when a user connects Claude via the OAuth flow (preferred).
 *  - Personal API keys, for MCP clients that send a static Bearer header (e.g. MCP Inspector).
 * Only SHA-256 hashes are stored; plaintext is shown exactly once.
 */
module.exports = function credentialService({ db, config, svc }) {
  function insert({ orgId, userId, kind, name, clientId, ttlSec, prefix }) {
    const token = `${prefix}_${randomToken(32)}`;
    const id = uuid();
    db.run(`INSERT INTO mcp_credentials (id, org_id, user_id, kind, name, token_hash, prefix, client_id, expires_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, id, orgId, userId, kind, name || null, sha256(token), token.slice(0, prefix.length + 7), clientId || null,
    ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null, nowIso());
    return { id, token };
  }

  function createApiKey(ctx, name) {
    requirePerm(ctx, P.CREDENTIAL_MANAGE, 'create API keys');
    const clean = String(name || '').trim().slice(0, 60) || 'MCP key';
    const active = db.get("SELECT COUNT(*) AS n FROM mcp_credentials WHERE org_id = ? AND user_id = ? AND kind = 'api_key' AND revoked_at IS NULL", ctx.orgId, ctx.userId).n;
    if (active >= 10) throw E.state('You already have 10 active API keys. Revoke one first.');
    return db.tx(() => {
      const res = insert({ orgId: ctx.orgId, userId: ctx.userId, kind: 'api_key', name: clean, prefix: 'vf_key' });
      svc.activity.log(ctx, { action: 'credential.created', entityType: 'credential', entityId: res.id, summary: `Created MCP API key "${clean}"` });
      return res;
    });
  }

  function listForUser(ctx) {
    const admin = ['owner', 'admin'].includes(ctx.role);
    return db.all(`SELECT c.id, c.kind, c.name, c.prefix, c.client_id, c.expires_at, c.last_used_at, c.revoked_at, c.created_at, p.name AS user_name, o.client_name
                   FROM mcp_credentials c JOIN profiles p ON p.id = c.user_id LEFT JOIN oauth_clients o ON o.client_id = c.client_id
                   WHERE c.org_id = ? AND c.kind IN ('api_key','oauth_refresh') AND c.revoked_at IS NULL ${admin ? '' : 'AND c.user_id = ?'}
                   AND (c.expires_at IS NULL OR c.expires_at > ?) ORDER BY c.created_at DESC`, ...(admin ? [ctx.orgId] : [ctx.orgId, ctx.userId]), nowIso());
  }

  function revoke(ctx, id) {
    const row = db.get('SELECT * FROM mcp_credentials WHERE id = ? AND org_id = ?', id, ctx.orgId);
    if (!row) throw E.notFound('Credential not found.');
    if (row.user_id !== ctx.userId && !['owner', 'admin'].includes(ctx.role)) throw E.forbidden();
    db.tx(() => {
      const ts = nowIso();
      db.run('UPDATE mcp_credentials SET revoked_at = ? WHERE id = ?', ts, id);
      if (row.kind === 'oauth_refresh' && row.client_id) {
        // Disconnecting a Claude connection kills its live access tokens too.
        db.run("UPDATE mcp_credentials SET revoked_at = ? WHERE user_id = ? AND org_id = ? AND client_id = ? AND revoked_at IS NULL", ts, row.user_id, row.org_id, row.client_id);
      }
      svc.activity.log(ctx, { action: 'credential.revoked', entityType: 'credential', entityId: id, summary: `Revoked ${row.kind === 'api_key' ? `API key "${row.name}"` : 'a Claude connection'}` });
    });
  }

  function rotate(ctx, id) {
    const row = db.get("SELECT * FROM mcp_credentials WHERE id = ? AND org_id = ? AND kind = 'api_key' AND revoked_at IS NULL", id, ctx.orgId);
    if (!row) throw E.notFound('API key not found.');
    return db.tx(() => {
      revoke(ctx, id);
      return createApiKey(ctx, row.name);
    });
  }

  function issueOAuthTokens({ userId, orgId, clientId }) {
    return db.tx(() => {
      const access = insert({ orgId, userId, kind: 'oauth_access', clientId, ttlSec: config.accessTokenTtlSec, prefix: 'vf_at' });
      const refresh = insert({ orgId, userId, kind: 'oauth_refresh', name: 'Claude connection', clientId, ttlSec: config.refreshTokenTtlSec, prefix: 'vf_rt' });
      return { access_token: access.token, refresh_token: refresh.token, expires_in: config.accessTokenTtlSec, token_type: 'Bearer' };
    });
  }

  function exchangeRefresh(refreshToken, clientId) {
    const row = db.get("SELECT * FROM mcp_credentials WHERE token_hash = ? AND kind = 'oauth_refresh'", sha256(refreshToken));
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < nowIso())) return null;
    if (row.client_id && clientId && row.client_id !== clientId) return null;
    if (!svc.members.membership(row.user_id, row.org_id)) return null;
    return db.tx(() => {
      db.run('UPDATE mcp_credentials SET revoked_at = ? WHERE id = ?', nowIso(), row.id); // rotation: refresh tokens are single-use
      return issueOAuthTokens({ userId: row.user_id, orgId: row.org_id, clientId: row.client_id });
    });
  }

  /** Validate a Bearer token. Returns an MCP request context or null. */
  function authenticate(token) {
    if (!token || token.length > 200) return null;
    const row = db.get("SELECT * FROM mcp_credentials WHERE token_hash = ? AND kind IN ('api_key','oauth_access')", sha256(token));
    if (!row || row.revoked_at) return null;
    if (row.expires_at && row.expires_at < nowIso()) return null;
    const m = svc.members.membership(row.user_id, row.org_id);
    if (!m) return null;
    const user = svc.members.getUser(row.user_id);
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60000) {
      db.run('UPDATE mcp_credentials SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
    }
    return {
      orgId: row.org_id, userId: row.user_id, role: m.role, credentialId: row.id,
      actor: { type: 'mcp', id: row.user_id, label: `${user.name} via Claude` }, user,
    };
  }

  return { createApiKey, listForUser, revoke, rotate, issueOAuthTokens, exchangeRefresh, authenticate };
};

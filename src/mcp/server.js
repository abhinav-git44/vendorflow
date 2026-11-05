'use strict';
const crypto = require('node:crypto');
const { AppError, fromDbError } = require('../lib/errors');
const { validate, toJsonSchema } = require('../lib/validate');
const { json, send, readBody, RateLimiter, clientIp } = require('../lib/http');
const { buildTools, SERVER_INSTRUCTIONS } = require('./tools');

/**
 * Remote MCP server over the Streamable HTTP transport (stateless mode).
 * POST /mcp carries JSON-RPC 2.0; responses are application/json.
 * Every request must carry a valid Bearer token (OAuth access token or API key).
 * This server never calls an AI model: it only executes deterministic tools.
 */
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'vendorflow', title: 'VendorFlow', version: '1.0.0' };

function createMcpHandler({ svc, config, logger = console }) {
  const tools = buildTools(svc, config);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const perCredential = new RateLimiter({ windowMs: 60_000, max: 120 });
  const perIp = new RateLimiter({ windowMs: 60_000, max: 60 });

  const toolList = tools.map((t) => ({
    name: t.name, title: t.title, description: t.description, inputSchema: toJsonSchema(t.inputSchema), annotations: { title: t.title, ...t.annotations },
  }));

  function unauthorized(res, hadToken) {
    const meta = `${config.appUrl}/.well-known/oauth-protected-resource`;
    const challenge = `Bearer realm="VendorFlow", resource_metadata="${meta}"${hadToken ? ', error="invalid_token", error_description="The access token is invalid or expired"' : ''}`;
    json(res, 401, { error: hadToken ? 'invalid_token' : 'unauthorized', error_description: 'Connect VendorFlow through Claude\'s connector settings to authorise.' },
      { 'WWW-Authenticate': challenge });
  }

  const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

  function callTool(ctx, name, args) {
    const tool = byName.get(name);
    if (!tool) return null;
    try {
      const input = validate(tool.inputSchema, args || {});
      const result = tool.handler(ctx, input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
    } catch (err) {
      const appErr = err instanceof AppError ? err : fromDbError(err);
      if (appErr) {
        return { content: [{ type: 'text', text: `Error (${appErr.code}): ${appErr.message}` }], isError: true };
      }
      const ref = crypto.randomBytes(4).toString('hex');
      logger.error(`[mcp] tool ${name} failed (ref ${ref}):`, err);
      return { content: [{ type: 'text', text: `Internal error while running ${name} (reference ${ref}). Nothing was saved.` }], isError: true };
    }
  }

  function handleMessage(ctx, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        const requested = p.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
        return rpcResult(msg.id, {
          protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: toolList });
      case 'tools/call': {
        if (typeof p.name !== 'string') return rpcError(msg.id, -32602, 'Invalid params: name is required');
        const out = callTool(ctx, p.name, p.arguments);
        if (!out) return rpcError(msg.id, -32602, `Unknown tool: ${p.name}`);
        return rpcResult(msg.id, out);
      }
      case 'resources/list': return rpcResult(msg.id, { resources: [] });
      case 'prompts/list': return rpcResult(msg.id, { prompts: [] });
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  return async function handle(req, res) {
    if (req.method === 'GET' || req.method === 'DELETE') {
      // Stateless server: no server-initiated SSE stream and no sessions to delete.
      return send(res, 405, 'Method Not Allowed', { Allow: 'POST', 'Content-Type': 'text/plain' });
    }
    if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed', { Allow: 'POST' });

    const auth = String(req.headers.authorization || '');
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    if (!token) {
      if (!perIp.check(`noauth:${clientIp(req)}`).ok) return json(res, 429, { error: 'rate_limited' });
      return unauthorized(res, false);
    }
    const ctx = svc.credentials.authenticate(token);
    if (!ctx) {
      if (!perIp.check(`badauth:${clientIp(req)}`).ok) return json(res, 429, { error: 'rate_limited' });
      return unauthorized(res, true);
    }
    const rl = perCredential.check(ctx.credentialId);
    if (!rl.ok) return json(res, 429, rpcError(null, -32000, 'Rate limit exceeded. Try again shortly.'), { 'Retry-After': String(rl.retryAfter) });

    let body;
    try {
      const raw = await readBody(req, 1024 * 1024);
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, rpcError(null, -32700, 'Parse error'));
    }

    const messages = Array.isArray(body) ? body : [body];
    if (!messages.length) return json(res, 400, rpcError(null, -32600, 'Invalid Request'));
    const responses = messages.map((m) => handleMessage(ctx, m)).filter(Boolean);
    if (!responses.length) return send(res, 202, ''); // only notifications/responses were sent
    return json(res, 200, Array.isArray(body) ? responses : responses[0]);
  };
}

module.exports = { createMcpHandler, SUPPORTED_VERSIONS };

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Database } = require('./db');
const { createServices } = require('./services');
const { AppError, fromDbError } = require('./lib/errors');
const { Router, readBody, parseForm, parseMultipart, html: sendHtml, json, redirect, send, serializeCookie, parseCookies, clientIp, RateLimiter } = require('./lib/http');
const { safeEqual } = require('./lib/util');
const { createMcpHandler } = require('./mcp/server');
const { registerOAuthRoutes } = require('./mcp/oauth');
const { html } = require('./web/html');
const layout = require('./web/layout');

const STATIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; object-src 'self'; frame-ancestors 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'",
};

function createApp({ config, db: existingDb, logger = console }) {
  const db = existingDb || new Database(config.dbPath);
  db.migrate();
  const svc = createServices({ db, config });
  const sessions = require('./auth/sessions')({ db, config, svc });
  const router = new Router();
  const mcp = createMcpHandler({ svc, config, logger });
  const loginLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 20 });

  // ---------- helpers shared by page modules ----------
  const FLASH = 'vf_flash';
  const W = {
    svc, config, db, sessions, layout, html, loginLimiter,
    flash(res, type, msg) {
      const prev = res.getHeader('Set-Cookie');
      const c = serializeCookie(FLASH, JSON.stringify({ type, msg: String(msg).slice(0, 400) }), { maxAge: 60, secure: config.secureCookies });
      res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
    },
    render(req, res, { title, active, body, status = 200 }) {
      const s = req.session;
      const out = layout.shell({
        title, session: s, active, body, flash: req.flash, unread: svc.notifications.unreadCount(s.ctx),
        orgs: svc.members.orgsForUser(s.user.id), demoMode: config.demoMode,
      });
      sendHtml(res, status, out, req.clearFlash ? { 'Set-Cookie': [].concat(res.getHeader('Set-Cookie') || [], serializeCookie(FLASH, '', { maxAge: 0 })) } : {});
    },
    back(req, res, fallback = '/') {
      const ref = req.headers.referer;
      let target = fallback;
      if (ref) { try { const u = new URL(ref); if (u.host === req.headers.host) target = u.pathname + u.search; } catch { /* ignore */ } }
      return redirect(res, target);
    },
    safeNext(next) { return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'; },
  };

  /** Wrap a page/action handler: require a session, check CSRF on POST, turn AppErrors into flashes. */
  W.auth = (handler) => async (req, res) => {
    if (!req.session || !req.session.ctx) {
      if (req.method === 'GET') return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
      return redirect(res, '/login');
    }
    req.ctx = req.session.ctx;
    if (req.method === 'POST') {
      try { await parseRequestBody(req); } catch (err) { W.flash(res, 'error', err.message); return W.back(req, res); }
      const token = req.body.csrf || req.headers['x-csrf-token'];
      if (!token || !safeEqual(token, req.session.csrf)) { W.flash(res, 'error', 'Your session expired. Please try again.'); return W.back(req, res); }
    }
    try {
      return await handler(req, res);
    } catch (err) {
      const appErr = err instanceof AppError ? err : fromDbError(err);
      if (!appErr) throw err;
      if (req.method === 'POST') { W.flash(res, 'error', appErr.message); return W.back(req, res); }
      return W.render(req, res, { title: 'Not available', status: appErr.status, body: html`${layout.pageHeader(appErr.code === 'NOT_FOUND' ? 'Not found' : 'Not allowed')}
        <div class="card pad"><p>${appErr.message}</p><p><a class="btn" href="/">Back to overview</a></p></div>` });
    }
  };

  async function parseRequestBody(req) {
    if (req.body) return;
    const ct = String(req.headers['content-type'] || '');
    const buf = await readBody(req, ct.startsWith('multipart/') ? config.maxUploadBytes + 1024 * 1024 : 256 * 1024);
    if (ct.startsWith('multipart/form-data')) {
      const { fields, files } = parseMultipart(buf, ct);
      req.body = fields; req.files = files;
    } else {
      req.body = parseForm(buf); req.files = {};
    }
  }
  W.parseRequestBody = parseRequestBody;

  // ---------- routes ----------
  router.get('/healthz', (req, res) => {
    let dbOk = true;
    try { db.get('SELECT 1 AS ok'); } catch { dbOk = false; }
    json(res, dbOk ? 200 : 503, { status: dbOk ? 'ok' : 'degraded', db: dbOk, time: new Date().toISOString(), version: '1.0.0' });
  });
  registerOAuthRoutes(router, { db, config, svc, sessions });
  require('./web/pages/auth')(router, W);
  require('./web/pages/dashboard')(router, W);
  require('./web/pages/vendors')(router, W);
  require('./web/pages/work')(router, W);
  require('./web/pages/admin')(router, W);

  // ---------- request entry ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    req.pathname = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    if (req.pathname === '/mcp' || req.pathname === '/mcp/') {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version' });
      return mcp(req, res);
    }
    if (req.method === 'OPTIONS' && (req.pathname.startsWith('/oauth/') || req.pathname.startsWith('/.well-known/'))) {
      return send(res, 204, '', { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version' });
    }
    if (req.pathname.startsWith('/static/')) return serveStatic(req, res);

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[FLASH]) { try { req.flash = JSON.parse(cookies[FLASH]); req.clearFlash = true; } catch { /* ignore */ } }
    req.session = sessions.load(req);

    const match = router.match(req.method, req.pathname);
    if (!match) {
      if (req.session && req.session.ctx) return W.render(req, res, { title: 'Not found', status: 404, body: html`${layout.pageHeader('Page not found')}<div class="card pad"><a class="btn" href="/">Back to overview</a></div>` });
      return sendHtml(res, 404, layout.bare('Not found', html`<h1 class="auth-title">Page not found</h1><p><a href="/">Go to VendorFlow</a></p>`));
    }
    if (match.methodNotAllowed) return send(res, 405, 'Method Not Allowed');
    req.params = match.params;
    return match.handler(req, res);
  }

  function serveStatic(req, res) {
    const rel = path.normalize(req.pathname.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(STATIC_DIR, rel);
    if (!abs.startsWith(STATIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    fs.createReadStream(abs).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const ref = crypto.randomBytes(4).toString('hex');
      logger.error(`[http] ${req.method} ${req.url} failed (ref ${ref}):`, err);
      if (!res.headersSent) {
        if (String(req.headers.accept || '').includes('text/html')) sendHtml(res, 500, layout.bare('Error', html`<h1 class="auth-title">Something went wrong</h1><p class="muted">Reference ${ref}. Nothing was saved.</p><p><a href="/">Back</a></p>`));
        else json(res, 500, { error: 'internal_error', reference: ref });
      }
    });
  });
  server.requestTimeout = 60_000;

  let jobTimer = null;
  function startJobs() {
    const run = () => {
      try {
        const r = svc.jobs.runChecks();
        sessions.purgeExpired();
        if (r.expired || r.expiryReminders || r.overdueReminders) logger.log('[jobs]', JSON.stringify(r));
      } catch (err) { logger.error('[jobs] failed', err); }
    };
    run();
    jobTimer = setInterval(run, config.jobIntervalMs);
    jobTimer.unref();
  }
  function stop() { if (jobTimer) clearInterval(jobTimer); server.close(); }

  return { server, db, svc, sessions, startJobs, stop, clientIp };
}

module.exports = { createApp };

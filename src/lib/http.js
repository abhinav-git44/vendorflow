'use strict';
const { E } = require('./errors');

/** Minimal router + request helpers on top of node:http. */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(E.validation(`Request body is too large (limit ${Math.round(limit / 1048576)} MB).`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Form bodies: repeated keys become arrays. */
function parseForm(buf) {
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
    if (k in out) out[k] = [].concat(out[k], v); else out[k] = v;
  }
  return out;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw E.validation('Malformed upload.');
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = {};
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 45 && buf[pos + 1] === 45) break; // closing --
    pos += 2; // CRLF
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = buf.subarray(pos, headerEnd).toString('utf8');
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next === -1) break;
    const body = buf.subarray(headerEnd + 4, next - 2);
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name) {
      if (filename !== undefined) {
        if (filename) files[name] = { filename, buffer: Buffer.from(body), mimeType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] };
      } else fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  res.end(body);
}
const html = (res, status, body, headers = {}) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
const redirect = (res, location, headers = {}) => send(res, 303, '', { Location: location, ...headers });

/** Fixed-window in-memory rate limiter (single instance deployment). */
class RateLimiter {
  constructor({ windowMs, max }) { this.windowMs = windowMs; this.max = max; this.hits = new Map(); }
  check(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset < now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    return { ok: e.count <= this.max, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

module.exports = { Router, parseCookies, serializeCookie, readBody, parseForm, parseMultipart, send, html, json, redirect, RateLimiter, clientIp };

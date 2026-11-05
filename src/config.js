'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Central configuration. Validated once at startup so the app fails fast
 * with a clear message instead of misbehaving later.
 */
function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const isProd = env.NODE_ENV === 'production';
  const errors = [];

  if (!/^https?:\/\/[^/]+/.test(appUrl)) errors.push('APP_URL must be an absolute http(s) URL');
  if (isProd && !appUrl.startsWith('https://')) errors.push('APP_URL must use https:// in production (Claude connectors require HTTPS)');
  if (isProd && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    errors.push('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (!Number.isInteger(port) || port <= 0) errors.push('PORT must be a positive integer');
  if (errors.length) {
    const err = new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
    err.code = 'CONFIG';
    throw err;
  }

  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    port,
    appUrl,
    isProd,
    secureCookies: appUrl.startsWith('https://'),
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    dataDir,
    dbPath: env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, 'vendorflow.db'),
    uploadDir: path.join(dataDir, 'uploads'),
    demoMode: env.DEMO_MODE !== 'false',
    demoPassword: env.DEMO_PASSWORD || 'VendorFlow-Demo-2026',
    seedOnEmpty: env.SEED_ON_EMPTY !== 'false',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
    accessTokenTtlSec: 60 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    sessionTtlSec: 7 * 24 * 60 * 60,
    jobIntervalMs: Number(env.JOB_INTERVAL_MS || 60 * 60 * 1000),
  };
}

module.exports = { loadConfig };

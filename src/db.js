'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Thin wrapper around node:sqlite with migrations and nested transactions.
 * A single Node process owns the database file; WAL mode keeps reads
 * non-blocking while a write transaction runs.
 */
class Database {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (dbPath !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this._stmts = new Map();
    this._txDepth = 0;
  }

  _stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  get(sql, ...params) { return this._stmt(sql).get(...params.map(norm)); }
  all(sql, ...params) { return this._stmt(sql).all(...params.map(norm)); }
  run(sql, ...params) { return this._stmt(sql).run(...params.map(norm)); }
  exec(sql) { this.raw.exec(sql); }

  /** Run fn atomically. Nested calls become savepoints. */
  tx(fn) {
    const depth = this._txDepth;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this._txDepth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('db.tx callbacks must be synchronous');
      }
      this._txDepth--;
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this._txDepth--;
      try {
        this.raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch { /* already rolled back */ }
      throw err;
    }
  }

  migrate(dir = path.join(__dirname, 'migrations')) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
      });
    }
  }

  close() { this.raw.close(); }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

module.exports = { Database };

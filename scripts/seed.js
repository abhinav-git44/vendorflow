'use strict';
// Usage: npm run seed            → add demo data if missing
//        npm run seed -- --reset → delete the database and uploads, then seed
const fs = require('node:fs');
const { loadConfig } = require('../src/config');
const { Database } = require('../src/db');
const { createServices } = require('../src/services');
const { seedDemo } = require('../src/seed');

const config = loadConfig();
if (process.argv.includes('--reset')) {
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(config.uploadDir, { recursive: true, force: true });
  console.log('Database and uploads removed.');
}
const db = new Database(config.dbPath);
db.migrate();
const svc = createServices({ db, config });
const r = seedDemo({ db, svc, config, log: console.log });
if (r.skipped) console.log('Demo organisation already exists; nothing to do. Use --reset to start over.');
db.close();

'use strict';
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');
const { seedDemo } = require('./src/seed');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = createApp({ config });
if (config.seedOnEmpty && config.demoMode) {
  try { seedDemo({ db: app.db, svc: app.svc, config, log: console.log }); } catch (err) { console.error('[seed] failed:', err); }
}
app.startJobs();
app.server.listen(config.port, () => {
  console.log(`VendorFlow listening on ${config.appUrl} (port ${config.port})`);
  console.log(`MCP endpoint: ${config.appUrl}/mcp`);
});

const shutdown = () => { app.stop(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

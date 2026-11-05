'use strict';
/**
 * The business service layer. The web app and the MCP server both call these
 * functions, so there is exactly one implementation of every business rule.
 */
function createServices({ db, config }) {
  const svc = {};
  const deps = { db, config, svc };
  svc.activity = require('./activity')(deps);
  svc.notifications = require('./notifications')(deps);
  svc.members = require('./members')(deps);
  svc.vendors = require('./vendors')(deps);
  svc.compliance = require('./compliance')(deps);
  svc.documents = require('./documents')(deps);
  svc.tasks = require('./tasks')(deps);
  svc.approvals = require('./approvals')(deps);
  svc.credentials = require('./credentials')(deps);
  svc.dashboard = require('./dashboard')(deps);
  svc.jobs = require('./jobs')(deps);
  return svc;
}

module.exports = { createServices };

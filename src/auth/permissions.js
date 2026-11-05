'use strict';
const { E } = require('../lib/errors');

/**
 * Role → permission matrix. The single source of truth for authorisation;
 * the web UI and MCP tools both call can()/require().
 */
const P = {
  VENDOR_WRITE: 'vendor.write',
  VENDOR_ARCHIVE: 'vendor.archive',
  DOCUMENT_UPLOAD: 'document.upload',
  DOCUMENT_VERIFY: 'document.verify',
  DOCUMENT_DELETE: 'document.delete',
  CHECKLIST_WRITE: 'checklist.write',
  TASK_WRITE: 'task.write',
  TASK_UPDATE_OWN: 'task.update_own',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_DECIDE: 'approval.decide',
  MEMBER_MANAGE: 'member.manage',
  SETTINGS_MANAGE: 'settings.manage',
  CREDENTIAL_MANAGE: 'credential.manage',
};

const ALL = Object.values(P);
const MATRIX = {
  owner: ALL,
  admin: ALL,
  procurement_manager: [P.VENDOR_WRITE, P.VENDOR_ARCHIVE, P.DOCUMENT_UPLOAD, P.CHECKLIST_WRITE, P.TASK_WRITE, P.TASK_UPDATE_OWN,
    P.APPROVAL_REQUEST, P.CREDENTIAL_MANAGE],
  compliance_manager: [P.VENDOR_WRITE, P.DOCUMENT_UPLOAD, P.DOCUMENT_VERIFY, P.DOCUMENT_DELETE, P.CHECKLIST_WRITE, P.TASK_WRITE,
    P.TASK_UPDATE_OWN, P.APPROVAL_REQUEST, P.APPROVAL_DECIDE, P.CREDENTIAL_MANAGE],
  reviewer: [P.DOCUMENT_VERIFY, P.TASK_UPDATE_OWN, P.APPROVAL_DECIDE, P.CREDENTIAL_MANAGE],
  viewer: [],
};

const can = (ctx, perm) => Boolean(ctx && MATRIX[ctx.role] && MATRIX[ctx.role].includes(perm));

function requirePerm(ctx, perm, what) {
  if (!can(ctx, perm)) {
    throw E.forbidden(`Your role (${ctx.role.replace(/_/g, ' ')}) is not allowed to ${what || perm}.`);
  }
}

module.exports = { P, MATRIX, can, requirePerm };

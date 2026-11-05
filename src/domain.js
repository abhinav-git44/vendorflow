'use strict';
/** Shared enums and labels: one definition used by DB, services, MCP and UI. */

const ROLES = ['owner', 'admin', 'procurement_manager', 'compliance_manager', 'reviewer', 'viewer'];
const ROLE_LABELS = {
  owner: 'Owner', admin: 'Administrator', procurement_manager: 'Procurement Manager',
  compliance_manager: 'Compliance Manager', reviewer: 'Reviewer', viewer: 'Read-only Viewer',
};

const VENDOR_STATUSES = ['draft', 'pending_onboarding', 'under_review', 'approved', 'rejected', 'suspended', 'archived'];
const VENDOR_STATUS_LABELS = {
  draft: 'Draft', pending_onboarding: 'Pending Onboarding', under_review: 'Under Review',
  approved: 'Approved', rejected: 'Rejected', suspended: 'Suspended', archived: 'Archived',
};
/** Allowed manual status transitions. Approval decisions drive under_review → approved/rejected. */
const VENDOR_TRANSITIONS = {
  draft: ['pending_onboarding', 'archived'],
  pending_onboarding: ['draft', 'under_review', 'archived'],
  under_review: ['pending_onboarding', 'approved', 'rejected', 'archived'],
  approved: ['suspended', 'archived'],
  rejected: ['pending_onboarding', 'archived'],
  suspended: ['approved', 'archived'],
  archived: ['draft'],
};

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const BANK_STATUSES = ['not_started', 'pending', 'verified', 'failed'];
const DEFAULT_VENDOR_CATEGORIES = ['Technology', 'Logistics', 'Raw Materials', 'Facilities', 'Professional Services', 'Marketing', 'Manufacturing', 'Other'];

const DOC_CATEGORIES = ['gst', 'pan', 'bank', 'business_registration', 'incorporation', 'tax_registration', 'insurance', 'quality', 'other'];
const DOC_CATEGORY_LABELS = {
  gst: 'GST Certificate', pan: 'PAN Card', bank: 'Bank Verification', business_registration: 'Business Registration',
  incorporation: 'Certificate of Incorporation', tax_registration: 'Tax Registration', insurance: 'Insurance Certificate',
  quality: 'Quality Certificate', other: 'Other Supporting Document',
};
/** Loose aliases so Claude (and people) can say "GST" or "bank letter". */
const DOC_CATEGORY_ALIASES = {
  gst: ['gst', 'gstin', 'gst certificate', 'gst registration'],
  pan: ['pan', 'pan card', 'permanent account number'],
  bank: ['bank', 'bank verification', 'bank letter', 'cancelled cheque', 'bank account', 'bank details'],
  business_registration: ['business registration', 'registration', 'msme', 'udyam', 'shop and establishment', 'trade license', 'trade licence'],
  incorporation: ['incorporation', 'certificate of incorporation', 'coi', 'moa', 'aoa'],
  tax_registration: ['tax registration', 'tax', 'tan', 'vat', 'tax id'],
  insurance: ['insurance', 'insurance certificate', 'liability insurance'],
  quality: ['quality', 'quality certificate', 'iso', 'iso 9001', 'iso 27001', 'soc 2', 'soc2'],
  other: ['other', 'supporting', 'other supporting document', 'nda', 'contract'],
};
const DOC_STATUSES = ['awaiting_file', 'uploaded', 'pending_verification', 'verified', 'rejected', 'expired'];
const DOC_STATUS_LABELS = {
  missing: 'Missing', awaiting_file: 'Awaiting File', uploaded: 'Uploaded', pending_verification: 'Pending Verification',
  verified: 'Verified', rejected: 'Rejected', expired: 'Expired',
};
const ALLOWED_MIME = {
  'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'],
};

const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const TASK_STATUSES = ['todo', 'in_progress', 'completed', 'blocked', 'cancelled'];
const TASK_STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', completed: 'Completed', blocked: 'Blocked', cancelled: 'Cancelled' };

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

function normaliseDocCategory(input) {
  if (!input) return null;
  const s = String(input).toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (DOC_CATEGORIES.includes(s.replace(/ /g, '_'))) return s.replace(/ /g, '_');
  for (const [cat, aliases] of Object.entries(DOC_CATEGORY_ALIASES)) {
    if (aliases.includes(s)) return cat;
  }
  for (const [cat, aliases] of Object.entries(DOC_CATEGORY_ALIASES)) {
    if (aliases.some((a) => a.length > 2 && s.includes(a))) return cat;
  }
  return null;
}

function normaliseRole(input) {
  if (!input) return null;
  const s = String(input).toLowerCase().replace(/[\s-]+/g, '_').replace(/^the_/, '');
  if (ROLES.includes(s)) return s;
  const map = { administrator: 'admin', procurement: 'procurement_manager', compliance: 'compliance_manager', read_only_viewer: 'viewer', read_only: 'viewer' };
  return map[s] || null;
}

module.exports = {
  ROLES, ROLE_LABELS, VENDOR_STATUSES, VENDOR_STATUS_LABELS, VENDOR_TRANSITIONS, RISK_LEVELS, BANK_STATUSES,
  DEFAULT_VENDOR_CATEGORIES, DOC_CATEGORIES, DOC_CATEGORY_LABELS, DOC_STATUSES, DOC_STATUS_LABELS, ALLOWED_MIME,
  TASK_PRIORITIES, TASK_STATUSES, TASK_STATUS_LABELS, APPROVAL_STATUSES, normaliseDocCategory, normaliseRole,
};

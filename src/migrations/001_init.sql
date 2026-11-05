-- VendorFlow schema v1
-- Every tenant-owned table carries org_id; every service query filters on it.
-- IDs are UUIDv4 text. Timestamps are ISO-8601 UTC text. Dates are YYYY-MM-DD.

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  legal_name    TEXT,
  country       TEXT,
  address       TEXT,
  tax_id        TEXT,
  vendor_seq    INTEGER NOT NULL DEFAULT 1000,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- "profiles" in the spec: application users
CREATE TABLE profiles (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE organization_members (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','admin','procurement_manager','compliance_manager','reviewer','viewer')),
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, user_id)
);
CREATE INDEX idx_members_user ON organization_members(user_id);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id      TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  csrf_token  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE vendors (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_code               TEXT NOT NULL,
  company_name              TEXT NOT NULL,
  company_key               TEXT NOT NULL,
  legal_name                TEXT,
  category                  TEXT NOT NULL,
  contact_person            TEXT,
  email                     TEXT,
  phone                     TEXT,
  website                   TEXT,
  address                   TEXT,
  country                   TEXT,
  gst_number                TEXT,
  pan_number                TEXT,
  registration_number       TEXT,
  bank_verification_status  TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (bank_verification_status IN ('not_started','pending','verified','failed')),
  onboarding_date           TEXT,
  manager_id                TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  status                    TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','pending_onboarding','under_review','approved','rejected','suspended','archived')),
  risk                      TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high','critical')),
  notes                     TEXT,
  is_demo                   INTEGER NOT NULL DEFAULT 0,
  created_by                TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (org_id, vendor_code),
  UNIQUE (org_id, company_key)
);
CREATE UNIQUE INDEX idx_vendors_gst ON vendors(org_id, gst_number) WHERE gst_number IS NOT NULL;
CREATE INDEX idx_vendors_org_status ON vendors(org_id, status);
CREATE INDEX idx_vendors_org_category ON vendors(org_id, category);
CREATE INDEX idx_vendors_org_created ON vendors(org_id, created_at);

CREATE TABLE vendor_documents (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id          TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL CHECK (category IN ('gst','pan','bank','business_registration','incorporation','tax_registration','insurance','quality','other')),
  file_path          TEXT,
  original_filename  TEXT,
  mime_type          TEXT,
  file_size          INTEGER,
  issue_date         TEXT,
  expiry_date        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('awaiting_file','uploaded','pending_verification','verified','rejected','expired')),
  rejection_reason   TEXT,
  source             TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','mcp','seed')),
  uploaded_by        TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  verified_by        TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  verified_at        TEXT,
  uploaded_at        TEXT,
  deleted_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_docs_vendor ON vendor_documents(vendor_id, category);
CREATE INDEX idx_docs_org_status ON vendor_documents(org_id, status);
CREATE INDEX idx_docs_org_expiry ON vendor_documents(org_id, expiry_date);

-- Org-level templates: which documents a vendor category must provide.
CREATE TABLE compliance_requirements (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_category  TEXT NOT NULL,
  name             TEXT NOT NULL,
  doc_category     TEXT NOT NULL,
  mandatory        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  UNIQUE (org_id, vendor_category, doc_category)
);

CREATE TABLE compliance_checklists (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id   TEXT NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE compliance_checklist_items (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  checklist_id  TEXT NOT NULL REFERENCES compliance_checklists(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  doc_category  TEXT NOT NULL,
  mandatory     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (checklist_id, doc_category)
);

CREATE TABLE review_tasks (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id     TEXT REFERENCES vendors(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  assignee_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  priority      TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','completed','blocked','cancelled')),
  due_date      TEXT,
  created_by    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_tasks_org_status ON review_tasks(org_id, status);
CREATE INDEX idx_tasks_assignee ON review_tasks(assignee_id, status);

CREATE TABLE approval_requests (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id        TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type             TEXT NOT NULL DEFAULT 'vendor_onboarding' CHECK (type IN ('vendor_onboarding','vendor_reactivation')),
  notes            TEXT,
  approver_id      TEXT NOT NULL REFERENCES profiles(id),
  requested_by     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decision_reason  TEXT,
  decided_by       TEXT,
  decided_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_approvals_org_status ON approval_requests(org_id, status);
-- At most one pending approval per vendor
CREATE UNIQUE INDEX idx_approvals_one_pending ON approval_requests(vendor_id) WHERE status = 'pending';

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  dedupe_key  TEXT UNIQUE,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, org_id, read_at);

CREATE TABLE activity_logs (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('user','mcp','system')),
  actor_id     TEXT,
  actor_label  TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  vendor_id    TEXT,
  summary      TEXT NOT NULL,
  metadata     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activity_org ON activity_logs(org_id, created_at);
CREATE INDEX idx_activity_vendor ON activity_logs(vendor_id, created_at);

-- Append-only audit log: normal workflows can never rewrite history.
CREATE TRIGGER activity_logs_no_update BEFORE UPDATE ON activity_logs
BEGIN SELECT RAISE(ABORT, 'activity_logs is append-only'); END;
CREATE TRIGGER activity_logs_no_delete BEFORE DELETE ON activity_logs
WHEN (SELECT COUNT(*) FROM organizations WHERE id = OLD.org_id) > 0
BEGIN SELECT RAISE(ABORT, 'activity_logs is append-only'); END;

-- API keys and OAuth tokens. Only SHA-256 hashes are stored.
CREATE TABLE mcp_credentials (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('api_key','oauth_access','oauth_refresh')),
  name          TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  client_id     TEXT,
  expires_at    TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_credentials_org ON mcp_credentials(org_id, kind);

CREATE TABLE oauth_clients (
  client_id           TEXT PRIMARY KEY,
  client_secret_hash  TEXT,
  client_name         TEXT,
  redirect_uris       TEXT NOT NULL,
  auth_method         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  created_at      TEXT NOT NULL
);

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uuid, nowIso, today, addDays, daysBetween } = require('../lib/util');
const { E } = require('../lib/errors');
const { validate } = require('../lib/validate');
const { P, requirePerm } = require('../auth/permissions');
const D = require('../domain');
const { effectiveDocStatus } = require('./compliance');

/** Identify the real file type from its first bytes. The client's claimed type is ignored. */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const metaFields = {
  name: { type: 'string', maxLength: 160, description: 'Document name. Defaults to the category name.' },
  category: { type: 'string', maxLength: 60, description: `One of: ${D.DOC_CATEGORIES.join(', ')} (aliases like "GST", "PAN", "bank letter", "ISO" work).` },
  issue_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
  expiry_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
};
const registerSchema = {
  type: 'object', additionalProperties: false, required: ['vendor', 'category'],
  properties: { vendor: { type: 'string', description: 'Vendor ID (VF-1001) or company name.' }, ...metaFields },
};
const statusSchema = {
  type: 'object', additionalProperties: false, required: ['status'],
  properties: {
    document_id: { type: 'string', description: 'Document ID. Alternatively give vendor + category.' },
    vendor: { type: 'string', description: 'Vendor ID or company name (used with category).' },
    category: { type: 'string', description: 'Document category (used with vendor), e.g. "GST".' },
    status: { type: 'string', enum: ['verified', 'rejected', 'pending_verification'], description: 'New verification status.' },
    reason: { type: 'string', maxLength: 500, description: 'Required when rejecting.' },
    expiry_date: { type: 'string', format: 'date', description: 'Optionally set/confirm the expiry date while verifying.' },
  },
};

module.exports = function documentService({ db, config, svc }) {
  const docLink = (code) => `${config.appUrl}/vendors/${code}?tab=documents`;

  function dto(row) {
    const effective = effectiveDocStatus(row);
    const name = (id) => (id ? db.get('SELECT name FROM profiles WHERE id = ?', id)?.name || null : null);
    return {
      document_id: row.id, vendor_id: row.vendor_code, company_name: row.company_name, name: row.name, category: row.category,
      category_label: D.DOC_CATEGORY_LABELS[row.category], status: effective, status_label: D.DOC_STATUS_LABELS[effective],
      has_file: Boolean(row.file_path), original_filename: row.original_filename, file_type: row.mime_type, file_size: row.file_size,
      issue_date: row.issue_date, expiry_date: row.expiry_date, days_to_expiry: row.expiry_date ? daysBetween(today(), row.expiry_date) : null,
      rejection_reason: row.rejection_reason, source: row.source, uploaded_by: name(row.uploaded_by), verified_by: name(row.verified_by),
      uploaded_at: row.uploaded_at, verified_at: row.verified_at, created_at: row.created_at,
      app_url: row.vendor_code ? docLink(row.vendor_code) : undefined,
    };
  }

  function getRow(ctx, id) {
    const row = db.get(`SELECT d.*, v.vendor_code, v.company_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
                        WHERE d.id = ? AND d.org_id = ? AND d.deleted_at IS NULL`, id, ctx.orgId);
    if (!row) throw E.notFound('Document not found.');
    return row;
  }

  function findByVendorCategory(ctx, vendorRef, categoryInput) {
    const vendor = svc.vendors.resolve(ctx, vendorRef);
    const category = D.normaliseDocCategory(categoryInput);
    if (!category) throw E.validation(`Unknown document category "${categoryInput}". Use one of: ${D.DOC_CATEGORIES.join(', ')}.`);
    const rows = db.all(`SELECT d.*, v.vendor_code, v.company_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
                         WHERE d.vendor_id = ? AND d.org_id = ? AND d.category = ? AND d.deleted_at IS NULL ORDER BY d.created_at DESC`, vendor.id, ctx.orgId, category);
    if (!rows.length) {
      throw E.notFound(`${vendor.company_name} has no ${D.DOC_CATEGORY_LABELS[category]} on file. The vendor's documents must be uploaded in VendorFlow first: ${docLink(vendor.vendor_code)}`);
    }
    // Prefer the record awaiting a decision, else the newest.
    return rows.find((r) => ['pending_verification', 'uploaded'].includes(r.status)) || rows[0];
  }

  function storeFile(ctx, vendorId, file) {
    if (!file || !file.buffer || !file.buffer.length) throw E.validation('Choose a file to upload.');
    if (file.buffer.length > config.maxUploadBytes) throw E.validation(`File is larger than ${Math.round(config.maxUploadBytes / 1048576)} MB.`);
    const mime = sniffMime(file.buffer);
    if (!mime) throw E.validation('Unsupported file. Upload a PDF, JPG, PNG or WEBP.');
    const ext = D.ALLOWED_MIME[mime][0];
    const rel = path.join(ctx.orgId, vendorId, `${uuid()}${ext}`);
    const abs = path.join(config.uploadDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer, { mode: 0o600 });
    const original = String(file.filename || `document${ext}`).replace(/[^\w.\- ()]+/g, '_').slice(0, 150);
    return { rel, mime, size: file.buffer.length, original };
  }

  function notifyReviewers(ctx, vendor, docName) {
    const reviewers = svc.notifications.usersWithRoles(ctx.orgId, ['compliance_manager', 'reviewer']);
    svc.notifications.notify(ctx, [...reviewers, vendor.manager_id], {
      type: 'document.submitted', title: `Document to verify: ${vendor.company_name}`, body: `${docName} was uploaded by ${ctx.actor.label}.`,
      link: `/vendors/${vendor.vendor_code}?tab=documents`,
    });
  }

  /** Real upload through the web UI (multipart). */
  function upload(ctx, vendorRef, meta, file) {
    requirePerm(ctx, P.DOCUMENT_UPLOAD, 'upload documents');
    const vendor = svc.vendors.resolve(ctx, vendorRef);
    if (vendor.status === 'archived') throw E.state(`${vendor.company_name} is archived.`);
    const m = validate({ type: 'object', properties: metaFields }, meta, { stripUnknown: true });
    const category = D.normaliseDocCategory(m.category);
    if (!category) throw E.validation('Choose a document category.');
    if (m.issue_date && m.expiry_date && m.expiry_date <= m.issue_date) throw E.validation('Expiry date must be after the issue date.');
    const stored = storeFile(ctx, vendor.id, file);
    return db.tx(() => {
      const ts = nowIso();
      const placeholder = db.get("SELECT * FROM vendor_documents WHERE vendor_id = ? AND org_id = ? AND category = ? AND status = 'awaiting_file' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", vendor.id, ctx.orgId, category);
      const name = m.name || placeholder?.name || D.DOC_CATEGORY_LABELS[category];
      let id;
      if (placeholder) {
        id = placeholder.id;
        db.run(`UPDATE vendor_documents SET name=?, file_path=?, original_filename=?, mime_type=?, file_size=?, issue_date=COALESCE(?, issue_date),
                expiry_date=COALESCE(?, expiry_date), status='pending_verification', uploaded_by=?, uploaded_at=?, updated_at=? WHERE id=?`,
        name, stored.rel, stored.original, stored.mime, stored.size, m.issue_date, m.expiry_date, ctx.userId, ts, ts, id);
      } else {
        id = uuid();
        db.run(`INSERT INTO vendor_documents (id, org_id, vendor_id, name, category, file_path, original_filename, mime_type, file_size, issue_date, expiry_date,
                status, source, uploaded_by, uploaded_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending_verification', 'web', ?,?,?,?)`,
        id, ctx.orgId, vendor.id, name, category, stored.rel, stored.original, stored.mime, stored.size, m.issue_date, m.expiry_date, ctx.userId, ts, ts, ts);
      }
      svc.activity.log(ctx, { action: 'document.uploaded', entityType: 'document', entityId: id, vendorId: vendor.id,
        summary: `Uploaded ${name} for ${vendor.company_name} (${stored.original}, ${Math.ceil(stored.size / 1024)} KB)` });
      notifyReviewers(ctx, vendor, name);
      return dto(getRow(ctx, id));
    });
  }

  /** Replace the file of an existing document; it returns to pending verification. */
  function replace(ctx, documentId, file) {
    requirePerm(ctx, P.DOCUMENT_UPLOAD, 'replace documents');
    const row = getRow(ctx, documentId);
    const vendor = svc.vendors.rowById(ctx, row.vendor_id);
    const stored = storeFile(ctx, vendor.id, file);
    return db.tx(() => {
      const ts = nowIso();
      db.run(`UPDATE vendor_documents SET file_path=?, original_filename=?, mime_type=?, file_size=?, status='pending_verification', rejection_reason=NULL,
              verified_by=NULL, verified_at=NULL, uploaded_by=?, uploaded_at=?, updated_at=? WHERE id=?`,
      stored.rel, stored.original, stored.mime, stored.size, ctx.userId, ts, ts, row.id);
      svc.activity.log(ctx, { action: row.file_path ? 'document.replaced' : 'document.uploaded', entityType: 'document', entityId: row.id, vendorId: vendor.id,
        summary: row.file_path ? `Replaced file for ${row.name} (${vendor.company_name}); awaiting verification` : `Uploaded ${row.name} for ${vendor.company_name} (${stored.original}); awaiting verification`,
        metadata: { previous_status: row.status } });
      notifyReviewers(ctx, vendor, row.name);
      return dto(getRow(ctx, row.id));
    });
  }

  /**
   * MCP add_document: registers a document the vendor owes (metadata only).
   * It stays "awaiting file" and does NOT count toward compliance until a real file is uploaded in the app.
   */
  function register(ctx, input) {
    requirePerm(ctx, P.DOCUMENT_UPLOAD, 'register documents');
    const v = validate(registerSchema, input);
    const vendor = svc.vendors.resolve(ctx, v.vendor);
    const category = D.normaliseDocCategory(v.category);
    if (!category) throw E.validation(`Unknown document category "${v.category}". Use one of: ${D.DOC_CATEGORIES.join(', ')}.`);
    if (v.issue_date && v.expiry_date && v.expiry_date <= v.issue_date) throw E.validation('expiry_date must be after issue_date.');
    return db.tx(() => {
      const existing = db.get("SELECT id FROM vendor_documents WHERE vendor_id = ? AND category = ? AND status = 'awaiting_file' AND deleted_at IS NULL", vendor.id, category);
      if (existing) {
        db.run('UPDATE vendor_documents SET name = COALESCE(?, name), issue_date = COALESCE(?, issue_date), expiry_date = COALESCE(?, expiry_date), updated_at = ? WHERE id = ?',
          v.name || null, v.issue_date || null, v.expiry_date || null, nowIso(), existing.id);
        return { ...dto(getRow(ctx, existing.id)), note: 'A document of this category was already registered and awaiting its file; its details were updated.' };
      }
      const id = uuid();
      const ts = nowIso();
      const name = v.name || D.DOC_CATEGORY_LABELS[category];
      db.run(`INSERT INTO vendor_documents (id, org_id, vendor_id, name, category, issue_date, expiry_date, status, source, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?, 'awaiting_file', ?, ?, ?)`, id, ctx.orgId, vendor.id, name, category, v.issue_date, v.expiry_date,
      ctx.actor.type === 'mcp' ? 'mcp' : 'web', ts, ts);
      svc.activity.log(ctx, { action: 'document.registered', entityType: 'document', entityId: id, vendorId: vendor.id,
        summary: `Registered ${name} for ${vendor.company_name} (awaiting file upload)` });
      return { ...dto(getRow(ctx, id)), note: `Registered. The file itself must be uploaded in VendorFlow before it can be verified: ${docLink(vendor.vendor_code)}` };
    });
  }

  function setStatus(ctx, input) {
    const v = validate(statusSchema, input);
    requirePerm(ctx, v.status === 'pending_verification' ? P.DOCUMENT_UPLOAD : P.DOCUMENT_VERIFY, 'verify or reject documents');
    let row;
    if (v.document_id) row = getRow(ctx, v.document_id);
    else if (v.vendor && v.category) row = findByVendorCategory(ctx, v.vendor, v.category);
    else throw E.validation('Provide document_id, or vendor and category.');
    const vendor = svc.vendors.rowById(ctx, row.vendor_id);
    const expiry = v.expiry_date || row.expiry_date;
    if (v.status === 'verified') {
      if (!row.file_path) throw E.state(`${row.name} for ${vendor.company_name} has no uploaded file yet, so it cannot be verified. Upload it here: ${docLink(vendor.vendor_code)}`);
      if (expiry && expiry < today()) throw E.state(`${row.name} expired on ${expiry}; an expired document cannot be verified. Ask the vendor for a renewed document.`);
    }
    if (v.status === 'rejected' && !v.reason) throw E.validation('A reason is required when rejecting a document.');
    if (v.status === 'pending_verification' && !row.file_path) throw E.state('This document has no file yet.');
    return db.tx(() => {
      const ts = nowIso();
      if (v.status === 'verified') {
        db.run("UPDATE vendor_documents SET status='verified', verified_by=?, verified_at=?, rejection_reason=NULL, expiry_date=?, updated_at=? WHERE id=?",
          ctx.userId, ts, expiry, ts, row.id);
      } else if (v.status === 'rejected') {
        db.run("UPDATE vendor_documents SET status='rejected', verified_by=?, verified_at=?, rejection_reason=?, updated_at=? WHERE id=?", ctx.userId, ts, v.reason, ts, row.id);
      } else {
        db.run("UPDATE vendor_documents SET status='pending_verification', verified_by=NULL, verified_at=NULL, rejection_reason=NULL, updated_at=? WHERE id=?", ts, row.id);
      }
      const label = D.DOC_STATUS_LABELS[v.status];
      svc.activity.log(ctx, { action: 'document.status_changed', entityType: 'document', entityId: row.id, vendorId: vendor.id,
        summary: `${row.name} for ${vendor.company_name}: ${D.DOC_STATUS_LABELS[effectiveDocStatus(row)]} → ${label}${v.reason ? ` (${v.reason})` : ''}`,
        metadata: { from: row.status, to: v.status, reason: v.reason || null } });
      svc.notifications.notify(ctx, [row.uploaded_by, vendor.manager_id], {
        type: `document.${v.status}`, title: `${row.name} ${label.toLowerCase()}`, body: `${vendor.company_name}${v.reason ? ` — ${v.reason}` : ''}`,
        link: `/vendors/${vendor.vendor_code}?tab=documents`,
      });
      const comp = svc.compliance.forVendor(ctx, vendor.id);
      return { document: dto(getRow(ctx, row.id)), vendor_compliance_percent: comp.percent, vendor_compliance_status: comp.status };
    });
  }

  function setDates(ctx, documentId, input) {
    requirePerm(ctx, P.DOCUMENT_UPLOAD, 'edit documents');
    const row = getRow(ctx, documentId);
    const v = validate({ type: 'object', properties: { issue_date: metaFields.issue_date, expiry_date: metaFields.expiry_date, name: metaFields.name } }, input, { stripUnknown: true });
    if (v.issue_date && v.expiry_date && v.expiry_date <= v.issue_date) throw E.validation('Expiry date must be after the issue date.');
    db.tx(() => {
      const revert = row.status === 'expired' && v.expiry_date && v.expiry_date >= today() ? 'pending_verification' : row.status;
      db.run('UPDATE vendor_documents SET issue_date = ?, expiry_date = ?, name = COALESCE(?, name), status = ?, updated_at = ? WHERE id = ?',
        v.issue_date ?? null, v.expiry_date ?? null, v.name || null, revert, nowIso(), row.id);
      svc.activity.log(ctx, { action: 'document.updated', entityType: 'document', entityId: row.id, vendorId: row.vendor_id,
        summary: `Updated dates for ${row.name} (${row.company_name}): expiry ${v.expiry_date || 'none'}`, metadata: { from: { issue: row.issue_date, expiry: row.expiry_date }, to: v } });
    });
  }

  function remove(ctx, documentId) {
    requirePerm(ctx, P.DOCUMENT_DELETE, 'delete documents');
    const row = getRow(ctx, documentId);
    db.tx(() => {
      db.run('UPDATE vendor_documents SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), row.id);
      svc.activity.log(ctx, { action: 'document.deleted', entityType: 'document', entityId: row.id, vendorId: row.vendor_id, summary: `Deleted ${row.name} for ${row.company_name}` });
    });
  }

  function list(ctx, f = {}) {
    const where = ['d.org_id = ?', 'd.deleted_at IS NULL', "v.status != 'archived'"];
    const params = [ctx.orgId];
    if (f.vendorId) { where.push('d.vendor_id = ?'); params.push(f.vendorId); }
    if (f.category && D.DOC_CATEGORIES.includes(f.category)) { where.push('d.category = ?'); params.push(f.category); }
    if (f.q) { where.push('(d.name LIKE ? OR v.company_name LIKE ? OR v.vendor_code LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    let rows = db.all(`SELECT d.*, v.vendor_code, v.company_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
                       WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC`, ...params).map(dto);
    if (f.status) rows = rows.filter((r) => r.status === f.status || (f.status === 'pending' && ['pending_verification', 'uploaded'].includes(r.status)));
    return rows;
  }

  function expiring(ctx, { days = 30, include_expired = true } = {}) {
    const until = addDays(today(), days);
    return db.all(`SELECT d.*, v.vendor_code, v.company_name FROM vendor_documents d JOIN vendors v ON v.id = d.vendor_id
                   WHERE d.org_id = ? AND d.deleted_at IS NULL AND v.status != 'archived' AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?
                   AND d.status IN ('uploaded','pending_verification','verified','expired') ORDER BY d.expiry_date`, ctx.orgId, until)
      .map(dto).filter((d) => include_expired || d.status !== 'expired');
  }

  function fileFor(ctx, documentId) {
    const row = getRow(ctx, documentId);
    if (!row.file_path) throw E.notFound('This document has no file.');
    const abs = path.resolve(config.uploadDir, row.file_path);
    if (!abs.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(abs)) throw E.notFound('File not found.');
    return { abs, mime: row.mime_type, filename: row.original_filename || `${row.name}`, row };
  }

  return { dto, getRow, upload, replace, register, setStatus, setDates, remove, list, expiring, fileFor, findByVendorCategory, schemas: { registerSchema, statusSchema } };
};

module.exports.sniffMime = sniffMime;

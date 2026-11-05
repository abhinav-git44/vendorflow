'use strict';
const D = require('../domain');

/**
 * MCP tool catalogue. Every handler is a thin adapter over the shared
 * service layer; no business logic lives here. Input schemas are published
 * to Claude and enforced by the services' validator.
 */
const vendorRef = { type: 'string', description: 'Vendor ID (e.g. VF-1001) or exact/partial company name.' };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function slimVendor(v) {
  return {
    vendor_id: v.vendor_id, company_name: v.company_name, category: v.category, status: v.status, risk: v.risk,
    contact_person: v.contact_person, email: v.email, manager: v.manager?.name || null,
    compliance_percent: v.compliance?.percent ?? null, compliance_status: v.compliance?.status, app_url: v.app_url,
  };
}

function buildTools(svc, config) {
  const vs = svc.vendors.schemas;
  const updateProps = { ...vs.updateSchema.properties };
  delete updateProps.manager_id;
  const createProps = { ...vs.createSchema.properties };
  delete createProps.manager_id;

  return [
    // ---------------- Workspace ----------------
    {
      name: 'get_workspace_summary', title: 'Workspace summary', annotations: RO,
      description: 'Headline numbers for the connected VendorFlow organisation: vendor counts, compliance distribution, documents awaiting verification or expiring, overdue tasks and pending approvals. Use this first to orient yourself.',
      inputSchema: obj({}),
      handler: (ctx) => {
        const o = svc.dashboard.overview(ctx);
        const org = svc.members.getOrg(ctx.orgId);
        return { organisation: org.name, connected_as: { name: ctx.user.name, role: D.ROLE_LABELS[ctx.role] }, ...o.kpis, dashboard_url: `${config.appUrl}/` };
      },
    },
    {
      name: 'list_team_members', title: 'List team members', annotations: RO,
      description: 'List people in the organisation with their roles and emails. Use this to find the right assignee or approver.',
      inputSchema: obj({}),
      handler: (ctx) => ({ members: svc.members.list(ctx).map((m) => ({ name: m.name, email: m.email, role: m.role, role_label: m.role_label })) }),
    },

    // ---------------- Vendors ----------------
    {
      name: 'create_vendor', title: 'Create vendor', annotations: WRITE,
      description: 'Create a vendor record in VendorFlow. Only company_name is required; include any other details the user gave. GST/PAN must be valid Indian formats if provided. Duplicate names or GSTINs are rejected. Returns the saved vendor with its vendor ID and a link to open it in the app.',
      inputSchema: obj(createProps, ['company_name']),
      handler: (ctx, a) => svc.vendors.create(ctx, a),
    },
    {
      name: 'list_vendors', title: 'List vendors', annotations: RO,
      description: 'Search and filter vendors. By default excludes archived vendors. Returns vendor IDs, status, risk and compliance percentage.',
      inputSchema: obj({
        query: { type: 'string', maxLength: 100, description: 'Search name, vendor ID, contact, email or GSTIN.' },
        status: { type: 'string', enum: [...D.VENDOR_STATUSES, 'active', 'all'], description: '"active" (default) = everything except archived.' },
        category: { type: 'string', maxLength: 60 },
        risk: { type: 'string', enum: D.RISK_LEVELS },
        compliance_status: { type: 'string', enum: ['compliant', 'partial', 'non_compliant', 'no_checklist'] },
        sort: { type: 'string', enum: ['name', 'newest', 'oldest', 'code', 'status', 'compliance', 'risk'] },
        page: { type: 'integer', minimum: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100 },
      }),
      handler: (ctx, a) => {
        const r = svc.vendors.list(ctx, { q: a.query, status: a.status, category: a.category, risk: a.risk, compliance: a.compliance_status, sort: a.sort, page: a.page, page_size: a.page_size || 50 });
        return { total: r.total, page: r.page, pages: r.pages, vendors: r.vendors.map(slimVendor) };
      },
    },
    {
      name: 'get_vendor', title: 'Get vendor', annotations: RO,
      description: 'Full vendor profile: details, compliance checklist state, documents, open tasks and approval requests.',
      inputSchema: obj({ vendor: vendorRef }, ['vendor']),
      handler: (ctx, a) => {
        const v = svc.vendors.get(ctx, a.vendor);
        const row = svc.vendors.resolve(ctx, v.vendor_id);
        return {
          ...v,
          compliance: svc.compliance.complianceDto(svc.compliance.forVendor(ctx, row.id)),
          documents: svc.documents.list(ctx, { vendorId: row.id }).map(({ app_url, ...d }) => d),
          open_tasks: svc.tasks.list(ctx, { vendorId: row.id, status: 'open' }),
          approvals: svc.approvals.list(ctx, { vendorId: row.id }).slice(0, 5),
        };
      },
    },
    {
      name: 'update_vendor', title: 'Update vendor', annotations: { ...WRITE, idempotentHint: true },
      description: `Update fields on a vendor. Only provided fields change. Status changes must follow the workflow (${Object.entries(D.VENDOR_TRANSITIONS).map(([f, t]) => `${f}→${t.join('/')}`).join('; ')}); vendors under review are approved via decide_approval.`,
      inputSchema: obj({ vendor: vendorRef, ...updateProps }, ['vendor']),
      handler: (ctx, { vendor, ...rest }) => svc.vendors.update(ctx, vendor, rest),
    },
    {
      name: 'archive_vendor', title: 'Archive vendor', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'Archive a vendor. Their records are kept for audit, but pending approvals and open tasks are cancelled. Confirm with the user before calling.',
      inputSchema: obj({ vendor: vendorRef }, ['vendor']),
      handler: (ctx, a) => svc.vendors.archive(ctx, a.vendor),
    },

    // ---------------- Documents ----------------
    {
      name: 'add_document', title: 'Register required document', annotations: WRITE,
      description: 'Register a document a vendor must provide (metadata only, e.g. expected GST certificate with its expiry date). It is recorded as "awaiting file" and does NOT count toward compliance until the actual file is uploaded in the VendorFlow web app and verified. Share the returned app_url so the user can upload the file.',
      inputSchema: svc.documents.schemas.registerSchema,
      handler: (ctx, a) => svc.documents.register(ctx, a),
    },
    {
      name: 'set_document_status', title: 'Verify / reject document', annotations: { ...WRITE, idempotentHint: true },
      description: 'Mark a vendor document as verified, rejected (reason required) or back to pending verification. Identify it by document_id, or by vendor + category (e.g. vendor "ABC Technologies", category "GST"). Verification is refused if no file has been uploaded or the document has expired. Returns the vendor\'s updated compliance percentage.',
      inputSchema: svc.documents.schemas.statusSchema,
      handler: (ctx, a) => svc.documents.setStatus(ctx, a),
    },
    {
      name: 'list_vendor_documents', title: 'List vendor documents', annotations: RO,
      description: 'List all documents on file for a vendor with status, expiry and whether a file has been uploaded.',
      inputSchema: obj({ vendor: vendorRef }, ['vendor']),
      handler: (ctx, a) => {
        const v = svc.vendors.resolve(ctx, a.vendor);
        return { vendor_id: v.vendor_code, company_name: v.company_name, documents: svc.documents.list(ctx, { vendorId: v.id }) };
      },
    },
    {
      name: 'get_expiring_documents', title: 'Expiring documents', annotations: RO,
      description: 'Documents expiring within the next N days (default 30), across all active vendors, including already-expired ones unless excluded.',
      inputSchema: obj({ days: { type: 'integer', minimum: 1, maximum: 365 }, include_expired: { type: 'boolean' } }),
      handler: (ctx, a) => {
        const docs = svc.documents.expiring(ctx, { days: a.days || 30, include_expired: a.include_expired !== false });
        return { window_days: a.days || 30, count: docs.length, documents: docs };
      },
    },

    // ---------------- Compliance ----------------
    {
      name: 'create_checklist', title: 'Create compliance checklist', annotations: WRITE,
      description: 'Create or extend a vendor\'s compliance checklist (required documents). Requirements are merged with any existing ones unless replace=true. If no requirements are given, the organisation\'s template for the vendor\'s category is applied. Returns the checklist with the calculated compliance percentage.',
      inputSchema: svc.compliance.schemas.checklistSchema,
      handler: (ctx, a) => svc.compliance.createChecklist(ctx, a),
    },
    {
      name: 'get_vendor_compliance', title: 'Vendor compliance', annotations: RO,
      description: 'Compliance status of one vendor: percentage, and each requirement as missing / pending verification / verified / rejected / expired.',
      inputSchema: obj({ vendor: vendorRef }, ['vendor']),
      handler: (ctx, a) => svc.compliance.getVendorCompliance(ctx, a.vendor),
    },
    {
      name: 'compliance_report', title: 'Compliance report', annotations: RO,
      description: 'Compliance summary across vendors with the gaps for each (missing, pending, rejected, expired, expiring soon). Filter by vendor status, compliance status or category; only_with_gaps=true lists only vendors that are not fully compliant.',
      inputSchema: obj({
        vendor_status: { type: 'string', enum: [...D.VENDOR_STATUSES, 'active', 'all'], description: '"active" (default) excludes archived; use "approved" for approved vendors only.' },
        compliance_status: { type: 'string', enum: ['compliant', 'partial', 'non_compliant', 'no_checklist'] },
        only_with_gaps: { type: 'boolean' },
        category: { type: 'string', maxLength: 60 },
      }),
      handler: (ctx, a) => ({ ...svc.compliance.report(ctx, a), report_url: `${config.appUrl}/compliance` }),
    },

    // ---------------- Tasks ----------------
    {
      name: 'assign_task', title: 'Assign review task', annotations: WRITE,
      description: 'Create a task (e.g. a compliance review) and assign it to a team member by email, name or role (e.g. assignee_role "procurement manager"). If a role is held by several people the call fails and lists them — ask the user who. Defaults to the vendor\'s manager if no assignee is given.',
      inputSchema: svc.tasks.schemas.assignSchema,
      handler: (ctx, a) => svc.tasks.assign(ctx, a),
    },
    {
      name: 'update_task_status', title: 'Update task status', annotations: { ...WRITE, idempotentHint: true },
      description: 'Move a task to todo, in_progress, completed, blocked or cancelled. Use list_pending_tasks to find task IDs.',
      inputSchema: svc.tasks.schemas.statusSchema,
      handler: (ctx, a) => svc.tasks.updateStatus(ctx, a),
    },
    {
      name: 'list_pending_tasks', title: 'List open tasks', annotations: RO,
      description: 'Open tasks (to do, in progress, blocked), soonest deadline first. Filter by assignee, vendor, priority, overdue, or mine=true for the connected user.',
      inputSchema: obj({
        assignee_email: { type: 'string', format: 'email' }, vendor: vendorRef, overdue_only: { type: 'boolean' },
        priority: { type: 'string', enum: D.TASK_PRIORITIES }, mine: { type: 'boolean' },
      }),
      handler: (ctx, a) => svc.tasks.listPending(ctx, a),
    },

    // ---------------- Approvals ----------------
    {
      name: 'request_approval', title: 'Request vendor approval', annotations: WRITE,
      description: 'Send a vendor for onboarding approval (or reactivation if suspended), routed to an approver by email, name or role (default: the compliance manager). Moves the vendor to Under Review. Warns if the vendor is not yet fully compliant.',
      inputSchema: svc.approvals.schemas.requestSchema,
      handler: (ctx, a) => svc.approvals.request(ctx, a),
    },
    {
      name: 'decide_approval', title: 'Approve / reject vendor', annotations: WRITE,
      description: 'Approve or reject a pending approval request (by approval_id or vendor). Only the assigned approver or an owner/admin may decide, and you cannot decide a request you raised. Approval requires the vendor to be 100% compliant unless an owner/admin supplies override_reason. Rejection requires a reason. Confirm the decision with the user before calling.',
      inputSchema: svc.approvals.schemas.decideSchema,
      handler: (ctx, a) => svc.approvals.decide(ctx, a),
    },
    {
      name: 'list_pending_approvals', title: 'List pending approvals', annotations: RO,
      description: 'Pending approval requests with each vendor\'s compliance percentage. mine=true for requests assigned to the connected user.',
      inputSchema: obj({ mine: { type: 'boolean' }, vendor: vendorRef }),
      handler: (ctx, a) => svc.approvals.listPending(ctx, a),
    },
  ];
}

const SERVER_INSTRUCTIONS = `VendorFlow is the connected user's vendor compliance workspace (a live web app). You do the thinking; VendorFlow stores and enforces.
- Refer to vendors by vendor ID (VF-1234) when known; company names also work.
- Every write is permission-checked against the user's role and recorded in an audit log as "<user> via Claude".
- Document FILES cannot be sent through this connector. add_document only registers an expected document; the user uploads the file in the app (share the app_url). Only uploaded, verified, unexpired documents count toward compliance.
- When a tool returns an app_url, share it so the user can open and edit the record in VendorFlow.
- If a tool reports an ambiguous person or vendor, ask the user rather than guessing.`;

module.exports = { buildTools, SERVER_INSTRUCTIONS };

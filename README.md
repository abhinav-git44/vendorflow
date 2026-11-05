# VendorFlow

**Vendor compliance & operations for SMEs, run from your own Claude.**
Claude does the thinking. VendorFlow does the work. The business continues after the chat ends.

- **No AI inside.** There are no OpenAI, Anthropic or other AI keys or calls anywhere in this codebase (`grep -ri "openai\|anthropic\|api_key" src` finds only the word "API key" for VendorFlow's own MCP keys).
- **Zero npm dependencies.** It runs on the Node.js 22 standard library (`node:http`, `node:sqlite`, `node:crypto`).
- **One service layer** shared by the web app, the remote MCP server and the scheduler.

| | |
|---|---|
| Live app | `https://<your-deployment>` *(fill in after deploying, see §14)* |
| MCP endpoint | `https://<your-deployment>/mcp` |
| Demo login | `demo@vendorflow.example` / `VendorFlow-Demo-2026` (Owner) |
| Other demo roles | `rohan.admin@`, `arjun.procurement@`, `neha.compliance@`, `vikram.reviewer@`, `ananya.viewer@` + `vendorflow.example`, same password |

---

## 1. Product overview

VendorFlow is a multi-tenant workspace where procurement, finance and compliance teams onboard vendors, collect and verify their documents, track compliance and expiries, assign reviews and approve vendors, with a full audit trail.

Users work in two ways that hit the same database and rules:
1. **The web dashboard**, for people.
2. **Their own Claude**, connected over MCP. *"Create ABC Technologies and give it the standard checklist"*, *"Which vendors have missing documents?"*, *"Send Lotus for approval to the compliance manager."*

## 2. Business problem

Vendor information is fragmented across email, drives and spreadsheets. Certificates expire unnoticed, approvals stall, nobody owns the review, and audits are painful. See [docs/BUSINESS.md](docs/BUSINESS.md).

## 3. Solution

A system of record with real rules:
- Compliance % is calculated from **verified, unexpired, uploaded** documents, never from a record merely existing.
- Vendors are **approved only through an approval request**, at 100% compliance (or an audited owner/admin override), and **never by the person who requested it**.
- An hourly **scheduler** expires certificates and sends reminders 30 days ahead and for overdue tasks.
- Every change is in an **append-only activity log**, attributed to a person, "*person* via Claude", or the scheduler.

## 4. Features

| Module | What's there |
|---|---|
| Auth & orgs | Sign-up creates an organisation; login/logout; hashed server-side sessions; org switcher; 6 roles with a central permission matrix; team management; password change |
| Dashboard | 4 KPIs + 7 secondary stats, vendor-registration chart, compliance distribution, document-status chart, review split, pending approvals, upcoming expiries, my tasks, recent vendors, activity, notifications, all from live data |
| Vendors | Create/edit/archive/restore, search, filters (status, category, compliance, risk), sort, pagination, CSV export, human-readable IDs (VF-1001), duplicate prevention (name, GSTIN), GSTIN/PAN format validation, status workflow |
| Vendor profile | Tabs: Overview (editable), Documents, Compliance, Tasks, Approvals, Activity |
| Documents | Real uploads (PDF/JPG/PNG/WEBP, verified by magic bytes, 10 MB), private storage, permission-checked preview/download, replace, verify, reject with reason, issue/expiry dates, soft delete, MCP-registered "awaiting file" placeholders |
| Compliance | Per-vendor checklists, org templates per vendor category, mandatory/optional, states (missing / pending / verified / rejected / expired), expiring-soon flags, org-wide report + CSV |
| Approvals | Request, route by person or role, queue, approve/reject with reason, compliance gate, override, cancel, history |
| Tasks | Create/assign by person or role, priorities, deadlines, status changes, overdue view, own-task permissions |
| Notifications | In-app centre with unread count: assignments, approvals, uploads, verifications, expiries, overdue tasks |
| Activity log | Append-only (DB triggers), filter by source (people / Claude / automated) and record type, CSV export |
| Reports | Status distribution, onboarding trend, expiring documents, pending approvals, overdue reviews, with filters (date range, category, status, compliance, manager) and CSV exports |
| Settings | Organisation profile, compliance templates, Claude connection (OAuth connections and personal API keys: create / rotate / revoke) |

## 5. Technology stack

Node.js ≥ 22.13 · `node:sqlite` (SQLite, WAL) · server-rendered HTML + hand-written CSS + SVG charts · ~120 lines of progressive-enhancement JS · node:test.
Why not the Next.js/Supabase stack from the original brief? The build environment had no package-registry access, so every layer was implemented on the standard library and **tested end to end** instead of shipped untested. The mapping and the scale path are in [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-deviations-from-the-original-brief-and-why).

## 6. Architecture

```
Claude ──MCP (Streamable HTTP + OAuth 2.1)──▶ /mcp ─┐
People ──HTTPS (sessions + CSRF)──────────────▶ web ─┼─▶ service layer ─▶ permissions + validation ─▶ SQLite + private files
Scheduler (hourly) ─────────────────────────────────┘
```
Diagrams (system, MCP sequence, OAuth flow, ER, deployment): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
server.js                 entry: config validation, seed-on-empty, scheduler, HTTP
src/app.js                router, security headers, session/CSRF wrapper, static files
src/services/*            ALL business logic (vendors, documents, compliance, tasks, approvals, members,
                          credentials, notifications, activity, dashboard, jobs)
src/mcp/server.js         MCP JSON-RPC over Streamable HTTP (stateless)
src/mcp/tools.js          20 tool definitions → thin adapters over services
src/mcp/oauth.js          OAuth 2.1 AS: metadata, DCR, authorize (+consent), token, revoke
src/web/pages/*           server-rendered pages
src/migrations/*.sql      schema
src/seed.js               fictional demo organisation
tests/*.test.js           28 tests: unit, service, MCP protocol/auth, HTTP end-to-end
```

## 7. Database structure

13 tables as specified (organizations, profiles, organization_members, vendors, vendor_documents, compliance_requirements, compliance_checklists, compliance_checklist_items, review_tasks, approval_requests, notifications, activity_logs, mcp_credentials) plus sessions, oauth_clients and oauth_codes. UUID keys, foreign keys, CHECK constraints on every enum, unique and partial-unique indexes, append-only audit triggers. See [`src/migrations/001_init.sql`](src/migrations/001_init.sql).

## 8. Installation

```bash
git clone <repo> vendorflow && cd vendorflow
node --version   # must be ≥ 22.13
npm start        # nothing to install
```

## 9. Environment variables

See [`.env.example`](.env.example). In production, `APP_URL` (public https URL) and `SESSION_SECRET` (32+ chars) are required. The app refuses to start without them. `DATA_DIR` must sit on a persistent volume.

## 10. Local development

```bash
npm run dev                      # auto-restart on change, http://localhost:3000
npm run seed -- --reset          # wipe local data and re-create the demo org
```
The demo organisation is seeded automatically on first boot (`DEMO_MODE=true`). Its 12 vendors cover every state: fully compliant, insurance expiring in 12 days, GST expired after approval, under review, PAN rejected, suspended, rejected, documents awaiting upload, a draft created "via Claude", and more. All demo data is fictional and flagged `is_demo`.

## 11. MCP setup

The endpoint is `POST {APP_URL}/mcp`, using Streamable HTTP (stateless JSON responses) and protocol versions 2024-11-05 to 2025-11-25. Auth is OAuth 2.1 + PKCE with Dynamic Client Registration, or a personal API key as a `Bearer` header. Tools are listed in [docs/MCP_SETUP.md §5](docs/MCP_SETUP.md#5-tool-inventory).

## 12. Claude connection

**Settings → Connectors → Add custom connector →** URL `https://<host>/mcp` → **Connect** → sign in → choose the org → **Allow**. Full guide with example prompts and troubleshooting: [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

## 13. Testing

```bash
npm test
```
28 tests, all passing (see [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md)):
- **Unit:** validation, compliance maths, file sniffing, permissions, transitions, CSV injection, password hashing.
- **Service:** vendor IDs & duplicates, role limits, document rules, approval rules, tenant isolation, append-only audit, scheduler idempotency.
- **MCP:** 401 discovery, OAuth (single-use codes, PKCE, refresh rotation, redirect validation), initialize/tools/list/ping/batch/notifications/errors, invalid/revoked/expired tokens, API-key lifecycle, validation, role permissions over MCP, per-org token binding.
- **End-to-end over HTTP:** Claude creates → dashboard shows → human edits → upload → Claude verifies → compliance updates → approval → reviewer decides in UI → activity has both channels → persistence on disk. Also CSRF, viewer write attempts, cross-org page/file access, and every page for 4 roles.

A real Claude connector test needs the public deployment (§14). Run it with the prompts in docs/MCP_SETUP.md §4 before recording.

## 14. Deployment

VendorFlow needs **one Node 22 container and a persistent volume** (for SQLite and uploads). Free tiers without persistent disks lose data on restart.

**Render (simplest):** push to GitHub → New → Blueprint → select the repo (uses [`render.yaml`](render.yaml): Docker, Starter instance, 1 GB disk at `/data`, health check `/healthz`). After the first deploy, set `APP_URL` to the service URL (e.g. `https://vendorflow.onrender.com`) and `DEMO_PASSWORD`, then redeploy.

**Fly.io:** see the comments at the top of [`fly.toml`](fly.toml) (volume + secrets + `fly deploy`).

**Any Docker host:** `docker build -t vendorflow . && docker run -p 3000:3000 -v vf:/data -e NODE_ENV=production -e APP_URL=https://… -e SESSION_SECRET=… vendorflow`

**Post-deploy checklist:** `GET /healthz` returns ok → log in with the demo account → upload a document → `GET /.well-known/oauth-authorization-server` shows your https issuer → add the connector in Claude and run prompts 1–6 → refresh the dashboard to confirm persistence.

## 15. Demo credentials

| Role | Email | Password |
|---|---|---|
| Owner | demo@vendorflow.example | `VendorFlow-Demo-2026` (or your `DEMO_PASSWORD`) |
| Administrator | rohan.admin@vendorflow.example | same |
| Procurement Manager | arjun.procurement@vendorflow.example | same |
| Compliance Manager | neha.compliance@vendorflow.example | same |
| Reviewer | vikram.reviewer@vendorflow.example | same |
| Read-only Viewer | ananya.viewer@vendorflow.example | same |

Organisation: **Acme Manufacturing (Demo)**. Demo accounts can't change their passwords. Anyone can also sign up and get an empty, isolated workspace.

---
Business plan: [docs/BUSINESS.md](docs/BUSINESS.md) · Pitch script: [docs/PITCH.md](docs/PITCH.md)

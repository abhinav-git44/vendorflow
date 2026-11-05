# Connecting Claude to VendorFlow (MCP)

VendorFlow exposes a **remote MCP server** over the **Streamable HTTP** transport at:

```
https://<your-vendorflow-host>/mcp
```

It runs inside the same Node process as the web app and calls the **same service layer**, so a record created by Claude is identical to one created in the UI, with the same validation, permissions and audit trail. The server never calls an AI model.

## 1. Requirements

- A Claude plan that supports custom connectors (Pro, Max, Team or Enterprise, per Anthropic's help centre).
- A VendorFlow account. For evaluation, use the demo account shown on the login page (`demo@vendorflow.example`).

## 2. Add the connector (claude.ai or Claude Desktop)

1. Open **Settings → Connectors → Add custom connector**.
2. Name: `VendorFlow`. URL: `https://<your-vendorflow-host>/mcp`. Leave the advanced OAuth fields empty: VendorFlow supports Dynamic Client Registration.
3. Click **Add**, then **Connect**. A VendorFlow window opens:
   - Sign in (e.g. `demo@vendorflow.example` / the demo password).
   - Choose the organisation to connect and click **Allow access**.
4. You're returned to Claude and the connector shows as connected. In a chat, open the tools menu and make sure **VendorFlow** is enabled.

Team/Enterprise: an owner may need to add the connector for the organisation first; members then connect individually.

### What happens under the hood

| Step | Endpoint | Standard |
|---|---|---|
| Claude calls `/mcp` without a token → `401` + `WWW-Authenticate: Bearer resource_metadata=…` | `POST /mcp` | MCP auth (2025-06-18) |
| Discovers the resource and authorization server | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | RFC 9728, RFC 8414 |
| Registers itself as a client | `POST /oauth/register` | RFC 7591 |
| User signs in and consents, choosing the organisation | `GET/POST /oauth/authorize` | OAuth 2.1 + PKCE (S256 only) |
| Exchanges the code; refreshes hourly with single-use, rotating refresh tokens | `POST /oauth/token` | OAuth 2.1 |

Access tokens last 1 hour and refresh tokens 30 days. Only SHA-256 hashes are stored. Tokens are bound to **one user in one organisation**, and every tool call runs with that user's role permissions. To disconnect, use **Settings → Claude connection → Disconnect** in VendorFlow, which revokes immediately.

### Other MCP clients (MCP Inspector, scripts)

Create a personal API key in **Settings → Claude connection → Advanced** and send it as a header:

```bash
npx @modelcontextprotocol/inspector   # Transport: Streamable HTTP, URL: https://<host>/mcp
# Header:  Authorization: Bearer vf_key_…
```

```bash
curl -s https://<host>/mcp -H "Authorization: Bearer vf_key_…" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_workspace_summary","arguments":{}}}'
```

Keys can be rotated or revoked at any time. Credentials are never accepted in query strings.

## 3. Verify the tools

Ask Claude: *"What VendorFlow tools do you have?"* or *"Give me a summary of my VendorFlow workspace."* You should see `get_workspace_summary` run and return your organisation name.

## 4. Example prompts (the demo script)

| # | Prompt | Tool(s) Claude uses | What to check in VendorFlow |
|---|---|---|---|
| 1 | "Create a vendor called **ABC Technologies**. Contact person is Rahul Sharma. Category is Technology." | `create_vendor` | Dashboard → *Recently added vendors*; Vendors list. Activity shows "via Claude". |
| 2 | "Create a mandatory compliance checklist for ABC Technologies containing GST Certificate, PAN Card, Bank Verification and Business Registration." | `create_checklist` | Vendor → Compliance tab: 4 requirements, 0%. |
| 3 | "Assign a high-priority compliance review for ABC Technologies to the procurement manager with a deadline of 30 November 2026." | `assign_task` | Tasks page: assigned to Arjun Mehta (the only procurement manager). |
| 4 | *(Upload a GST PDF in the app first.)* "Mark the GST certificate for ABC Technologies as verified." | `set_document_status` | Documents tab: Verified; compliance 25%. Without an upload, Claude is told it can't verify. |
| 5 | "Show me the compliance summary of all active vendors and identify vendors with missing documents." | `compliance_report` | Compliance page shows the same numbers. |
| 6 | "Create an approval request for ABC Technologies and assign it to the compliance manager." | `request_approval` | Approvals queue: routed to Neha Kapoor; vendor is *Under Review*. |
| 7 | Edit the vendor's contact details in the app, save and refresh. Then ask Claude "What's ABC Technologies' contact email?" | `get_vendor` | Claude reads the human edit, because there is one database. |

More: *"Which documents expire in the next 45 days?"*, *"What's overdue for Arjun?"*, *"Approve Lotus Facility Management"* (refused while it isn't 100% compliant, which is correct).

## 5. Tool inventory

Bold parameters are required. All inputs are validated server-side against the published JSON Schema (unknown fields are rejected).

| Tool | Kind | Parameters | Purpose |
|---|---|---|---|
| `get_workspace_summary` | read | — | Headline numbers for the connected VendorFlow organisation: vendor counts, compliance distribution, documents awaiting verification or expiring, overdue tasks and pending approvals. |
| `list_team_members` | read | — | List people in the organisation with their roles and emails. |
| `create_vendor` | write | **company_name**, legal_name, category, contact_person, email, phone, website, address, country, gst_number, pan_number, registration_number, bank_verification_status, onboarding_date, risk, notes, manager_email, status | Create a vendor record in VendorFlow. |
| `list_vendors` | read | query, status, category, risk, compliance_status, sort, page, page_size | Search and filter vendors. |
| `get_vendor` | read | **vendor** | Full vendor profile: details, compliance checklist state, documents, open tasks and approval requests.. |
| `update_vendor` | write | **vendor**, company_name, legal_name, category, contact_person, email, phone, website, address, country, gst_number, pan_number, registration_number, bank_verification_status, onboarding_date, risk, notes, manager_email, status | Update fields on a vendor. |
| `archive_vendor` | write (destructive) | **vendor** | Archive a vendor. |
| `add_document` | write | **vendor**, name, **category**, issue_date, expiry_date | Register a document a vendor must provide (metadata only, e.g. |
| `set_document_status` | write | document_id, vendor, category, **status**, reason, expiry_date | Mark a vendor document as verified, rejected (reason required) or back to pending verification. |
| `list_vendor_documents` | read | **vendor** | List all documents on file for a vendor with status, expiry and whether a file has been uploaded.. |
| `get_expiring_documents` | read | days, include_expired | Documents expiring within the next N days (default 30), across all active vendors, including already-expired ones unless excluded.. |
| `create_checklist` | write | **vendor**, name, requirements, replace | Create or extend a vendor's compliance checklist (required documents). |
| `get_vendor_compliance` | read | **vendor** | Compliance status of one vendor: percentage, and each requirement as missing / pending verification / verified / rejected / expired.. |
| `compliance_report` | read | vendor_status, compliance_status, only_with_gaps, category | Compliance summary across vendors with the gaps for each (missing, pending, rejected, expired, expiring soon). |
| `assign_task` | write | **title**, vendor, description, assignee_email, assignee_name, assignee_role, priority, due_date | Create a task (e.g. |
| `update_task_status` | write | **task_id**, **status**, note | Move a task to todo, in_progress, completed, blocked or cancelled. |
| `list_pending_tasks` | read | assignee_email, vendor, overdue_only, priority, mine | Open tasks (to do, in progress, blocked), soonest deadline first. |
| `request_approval` | write | **vendor**, approver_email, approver_name, approver_role, notes | Send a vendor for onboarding approval (or reactivation if suspended), routed to an approver by email, name or role (default: the compliance manager). |
| `decide_approval` | write | approval_id, vendor, **decision**, reason, override_reason | Approve or reject a pending approval request (by approval_id or vendor). |
| `list_pending_approvals` | read | mine, vendor | Pending approval requests with each vendor's compliance percentage. |


Every result includes an `app_url` deep link so Claude can hand the user straight to the record.

### Business rules Claude cannot bypass

- Vendors become **Approved** only via `request_approval` → `decide_approval`; editing the status to approved is refused.
- Approval requires **100% compliance** (verified, unexpired mandatory documents) unless an owner/admin gives an `override_reason`, which is audited.
- The approver must be the assigned person or an owner/admin, and **nobody can decide their own request**.
- **Files cannot be sent over MCP.** `add_document` only registers an expected document ("awaiting file"); it does not count toward compliance until a real PDF/JPG/PNG/WEBP is uploaded in the app and verified.
- Ambiguous people or vendors (e.g. two procurement managers) produce an error listing the candidates rather than a guess.
- Role permissions apply: a Read-only Viewer's Claude can read but not write.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| "Couldn't reach the MCP server" | The URL must be public **https** and end in `/mcp`. Check `https://<host>/healthz` returns `{"status":"ok"}`. Free hosting tiers that sleep can time out on the first request; open the site once, then retry. |
| Sign-in window says "unknown client" or "redirect address does not match" | Remove the connector in Claude and add it again (Claude re-registers). Make sure `APP_URL` exactly matches the public URL, with no trailing slash. |
| "Authorization with the MCP server failed" after approving | Confirm `APP_URL` is the https URL Claude used (it is the OAuth issuer). Check the server logs for `POST /oauth/token`. If there was no token request, retry; Anthropic's issue tracker reports intermittent callback problems on their side. |
| Tools appear but every call says "Connect VendorFlow…" | The token expired and couldn't refresh (e.g. revoked). Disconnect and reconnect the connector. |
| `FORBIDDEN` errors | The connected user's role doesn't allow the action. Connect as a different user or change the role in Team Members. |
| `429` | More than 120 tool calls per minute per connection. Wait a minute. |

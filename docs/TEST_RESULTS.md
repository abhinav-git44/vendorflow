# Test results

Command: `npm test` (Node v22.23.4, 2026-11-05T19:46Z)

```
ok 1 - core workflow: Claude → VendorFlow → people → Claude
ok 2 - web security: CSRF, roles, cross-org pages, login throttling
ok 3 - every page renders for every role without errors
ok 4 - discovery: 401 challenge points at protected-resource metadata
ok 5 - OAuth: codes are single-use, PKCE enforced, refresh tokens rotate
ok 6 - protocol: initialize, notifications, tools/list, ping, batch, errors
ok 7 - auth: invalid, revoked and expired tokens are rejected
ok 8 - tools validate input and return clear errors (nothing saved on failure)
ok 9 - role permissions apply through MCP too
ok 10 - MCP tokens are bound to one organisation
ok 11 - vendor IDs are sequential and human-readable; duplicates are rejected
ok 12 - viewers cannot write; reviewers only touch their own tasks
ok 13 - documents: registration ≠ upload; verify needs a real, unexpired file
ok 14 - approvals: routing, compliance gate, override, no self-approval, vendor status follows
ok 15 - vendors cannot be approved by editing status
ok 16 - tenant isolation: another organisation cannot see or touch records
ok 17 - audit log is append-only and records MCP actors
ok 18 - scheduler expires documents and sends idempotent reminders
ok 19 - member resolution refuses to guess when a role is ambiguous
ok 20 - validator: required, formats, enums and unknown fields
ok 21 - compliance: % counts only verified, unexpired mandatory requirements
ok 22 - compliance: edge cases (no checklist, all verified, best document wins, expiring soon)
ok 23 - file type sniffing ignores names and claimed types
ok 24 - role permissions are defined centrally and least-privilege
ok 25 - vendor status transitions never allow skipping approval
ok 26 - document category and role aliases
ok 27 - CSV escapes quotes and blocks spreadsheet formula injection
ok 28 - passwords are salted scrypt hashes
# tests 28
# pass 28
# fail 0
# duration_ms 5582.138211
```

In addition, verified manually during the build:
- Full OAuth 2.1 connector flow against a running server, the same sequence Claude performs (401 → metadata → DCR → login → consent → code → PKCE token → refresh rotation → MCP calls).
- Production mode refuses to start without SESSION_SECRET or with a non-https APP_URL; with valid config it sets Secure/HttpOnly cookies and HSTS, and publishes an https issuer.
- Every page screenshotted at desktop (1440px) and mobile (390px) in Chromium, with no console errors.

Not verified here: a live Claude.ai connector session, which needs the public https deployment. Run docs/MCP_SETUP.md §4 after deploying.

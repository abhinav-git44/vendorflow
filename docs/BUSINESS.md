# VendorFlow business plan

> Every figure here is a **proposed assumption or illustrative projection**, not validated market data or actual performance. Third-party prices were checked in November 2026 and change. Re-check them before quoting.

## 1. Problem

Indian SMEs and mid-market companies onboard dozens to hundreds of vendors. Each vendor owes GST, PAN, bank proof, registration and often insurance or quality certificates. Today that lives in email threads, shared drives and a spreadsheet nobody trusts. The result: payments released to vendors with lapsed certificates, slow onboarding, unclear ownership of reviews, and a scramble before every audit.

## 2. Why VendorFlow (and not just Claude)

| Claude alone | VendorFlow + the customer's Claude |
|---|---|
| Can draft a checklist in a chat | Stores it, tracks it per vendor, calculates compliance continuously |
| Forgets when the chat ends | Persistent system of record with an append-only audit trail |
| One person's conversation | Shared workspace: roles, assignments, approval routing, notifications |
| Can't enforce anything | Enforces rules: no approval below 100% compliance, no self-approval, files must exist to be verified |
| Doesn't run at 3 a.m. | Scheduler expires certificates and reminds owners 30 days ahead |

Claude makes VendorFlow *fast to use* ("onboard these 5 vendors from this email"). VendorFlow makes Claude's output *trustworthy and durable*.

## 3. Pricing (proposed)

| Plan | Price / month | For | Limits (proposed) |
|---|---|---|---|
| Starter | ₹999 | Small businesses | 50 active vendors, 3 users, 1 organisation, document tracking, basic reports |
| Growth | ₹2,499 | Growing procurement/finance teams | 300 vendors, 10 users, approvals, tasks, advanced reports, CSV exports |
| Business | ₹5,999 | Multi-site companies, accounting firms | 2,000 vendors, 25 users, all roles, extended audit history, priority support |

14-day free trial; annual billing at 2 months free. Customers bring their own Claude plan. **VendorFlow never charges for or pays for AI.**

## 4. Unit economics (per customer, per month, at ~100 customers)

| Cost line | Assumption | ₹ / customer / month |
|---|---|---|
| **AI inference** | Customer's own Claude plan | **₹0** |
| Compute | One ~$25/mo instance plus a ~$7/mo staging instance, shared by 100 customers; ₹88/USD | ~₹28 |
| Database | SQLite on the same volume (no separate DB bill at this scale) | ₹0 |
| Document storage | ~150 MB per customer (50 vendors × 6 docs × 0.5 MB) at ~$0.25/GB-month for persistent disk | ~₹3 |
| Backups & monitoring | ~$20/mo shared | ~₹18 |
| Transactional email (future) | ~1,000 emails per customer per month | ~₹5 |
| Payment processing | ~2% gateway fee + 18% GST ≈ 2.36% of a ₹2,499 Growth plan | ~₹59 |
| **Total** | | **≈ ₹113** |
| **Gross margin on Growth (₹2,499)** | | **≈ 95%** |
| Gross margin on Starter (₹999) | (payment fee ≈ ₹24) | ≈ 92% |

Infrastructure is not zero. It's simply small and flat, because no tokens are bought: a heavy user costs about the same as a light one. The biggest variable cost is payment processing, not compute.

## 5. First 100 customers

1. **Accounting and CA firms as a channel (target 40).** One firm manages vendor compliance for 20–50 SME clients. Offer a partner plan with a workspace per client, and a revenue share.
2. **Founder-led LinkedIn outreach (target 25).** Procurement heads and finance controllers at 50–500-employee manufacturers. Hook: a 3-minute Loom showing "Claude onboarded 5 vendors from an email thread, VendorFlow caught the expired GST certificate."
3. **Procurement and finance communities (target 15).** Free "GST vendor compliance checklist" template, webinars with compliance consultants.
4. **Claude power users (target 10).** List in MCP/connector directories; publish the connector as an example of "bring-your-own-AI" SaaS.
5. **Early-adopter programme and referrals (target 10).** 50% off for 6 months in exchange for weekly feedback; one free month per referral.

## 6. Illustrative projections

**Assumptions:** 30% trial→paid conversion; 3% monthly logo churn in year 1, falling to 2%; blended ARPA ₹2,000 in year 1, rising to ₹3,000 by year 3 as plans move up; infrastructure scales roughly linearly at ~₹100 per customer; team grows from 1 founder to ~8.

| Milestone | Paying customers | MRR | ARR | Gross margin | Notes |
|---|---|---|---|---|---|
| First 100 customers (~month 7) | 100 | ₹2.0 L | ₹24 L | ~94% | Founder-led sales + CA partners |
| End of year 1 | 160 | ₹3.4 L | ₹41 L | ~94% | 2 hires (support/success, engineer) |
| End of year 3 | 1,200 | ₹36 L | ₹4.3 Cr | ~90% | Postgres + object storage, SOC 2, vendor self-service portal, ERP/Tally integrations, team of ~8 |

**Year-1 operating costs (illustrative):** infrastructure ~₹2 L/yr; salaries ~₹30 L; marketing and events ~₹6 L. Break-even at roughly ₹3.5 L MRR, around the end of year 1.

**Product roadmap that drives ARPA:** vendor self-service upload portal (vendors upload their own documents through a link), email/WhatsApp reminders, GSTIN live-validation via government APIs, Tally/Zoho/SAP export, multi-entity groups.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Customers without a Claude plan | The web app is fully usable on its own; Claude makes it faster |
| Claude connector availability or OAuth changes | Standards-based (MCP, OAuth 2.1); API-key fallback for other MCP clients |
| Large incumbents (procurement suites) | Focus on SMEs priced out of SAP Ariba/Coupa; 10-minute setup |
| Data sensitivity (bank proofs, PAN) | Private storage, role-based access, audit log; roadmap: encryption at rest, SOC 2 |

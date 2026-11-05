# Five-minute founder pitch: VendorFlow

Timing is fixed by the brief and adds up to exactly 5:00, so rehearse to **4:40**. Fill in the **[bracketed]** parts with your own facts. Don't invent numbers.

---

## 0:00–0:45 · Who I am (45 s)

> "Hi, I'm **[Your name]**, founder of VendorFlow. I'm a product manager. **[One line: where you've worked / what you've owned, e.g. 'I've spent N years building B2B fintech products at …']**. **[One line connecting you to the problem, e.g. 'I've watched finance teams chase vendor GST certificates over email every quarter.']** VendorFlow is the product I wished those teams had."

## 0:45–1:15 · My best work (30 s)

> "The thing I'm proudest of: **[project]**. **[Your role, in one sentence.]** The result was **[metric: e.g. 'onboarding time down from 9 days to 2', '₹X crore processed', 'N customers']**." *(Show one slide or screenshot as proof.)*

## 1:15–2:15 · Why VendorFlow will win (60 s)

> "Every growing company in India onboards vendors, and every vendor owes documents: GST, PAN, bank proof, registration, insurance. Today that's spreadsheets and email. Certificates expire silently, approvals stall, and audits become a fire drill.
>
> VendorFlow is a vendor-compliance workspace with one twist: **the customer's own Claude is the interface.** They tell Claude 'onboard these vendors from this email' and Claude does the reading and writing. VendorFlow does everything Claude can't: it **remembers**, **enforces rules** (no approval below 100% compliance, no self-approval), **routes work to people**, and **keeps running after the chat ends**. Expiries are caught at 3 a.m. with nobody chatting.
>
> Why not just Claude? Claude can draft a checklist, but it can't be the system of record your auditor trusts. And why us over procurement suites? They cost lakhs and take months. We're ₹999 a month and live in ten minutes. And because the customer brings their own AI, **we pay nothing for AI**, so our margins are software margins."

## 2:15–4:15 · Live demo (2 min)

Set up beforehand: the connector is connected in Claude, the demo login is open in a second tab, and a sample GST PDF is on the desktop.

| Time | Do | Say |
|---|---|---|
| 2:15 | **Claude:** "Create a vendor called ABC Technologies. Contact person is Rahul Sharma. Category is Technology. Then create a mandatory checklist with GST Certificate, PAN Card, Bank Verification and Business Registration." | "I'm just talking to Claude…" |
| 2:35 | Show the tool calls (`create_vendor`, `create_checklist`) and the returned VF-ID and link. | "…and it's calling VendorFlow's tools. These are real writes." |
| 2:45 | **VendorFlow:** refresh the dashboard. ABC Technologies is under *Recently added*. Open it: 0% compliant, 4 missing. Open the Activity tab: "Priya Nair **via Claude**". | "Same database, same audit trail." |
| 3:00 | **Claude:** "Assign a high-priority compliance review to the procurement manager, due 30 November." | "Claude resolves 'the procurement manager' to Arjun. If there were two, it would ask." |
| 3:15 | **Claude:** "Mark ABC's GST certificate as verified." It's **refused**: no file. | "Claude can't fake compliance. A record isn't a document." |
| 3:25 | **VendorFlow:** Documents tab → upload the GST PDF. Edit the contact email on the Overview, save, refresh. | "A person uploads the real file and edits the details." |
| 3:45 | **Claude:** "Now verify the GST certificate, and show me the compliance summary of all active vendors with missing documents." | |
| 4:00 | Show 25%, then the report naming BrightPath (expired GST) and Kaveri (missing docs). Optional: "Approve ABC" is refused at 25%. | "And this is the part that runs without anyone: expired documents are flagged automatically." |

## 4:15–5:00 · The money (45 s)

> "**Cost to run:** zero AI cost, because customers bring their own Claude. Infrastructure is about ₹30–50 per customer per month, and the biggest cost line is payment processing at about 2.4%. Gross margin is around 95%.
>
> **Price:** ₹999, ₹2,499 and ₹5,999 a month, by vendor count and team size.
>
> **First 100 customers:** CA and accounting firms as a channel, since each one manages compliance for dozens of SMEs. Plus founder-led LinkedIn outreach to procurement heads, and an early-adopter programme.
>
> **One year:** about 160 customers and ₹40 lakh ARR. **Three years:** about 1,200 customers and ₹4 crore-plus ARR, with a vendor self-service portal and ERP integrations. These are projections, not results.
>
> **Claude does the thinking. VendorFlow does the work.** Thank you."

---

### Recording checklist

- [ ] Fresh browser profile; demo data reset (`npm run seed -- --reset` locally, or redeploy).
- [ ] Zoom the browser to 110–125% so the text is legible on video.
- [ ] Connector already connected. Don't spend demo time on OAuth; mention it in one line.
- [ ] Practise the Claude prompts so tool approvals don't stall. Pre-approve "always allow" for read tools if your client offers it.
- [ ] Hard stop at 4:55.

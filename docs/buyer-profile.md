# Buyers and Credit

## Navigation and layout

BUYERS AND CREDIT contains BUYER PROFILES and CREDIT REQUESTS. Credit History is a standalone section in each selected buyer's Overview. The portfolio searches standard name, customer ID, group and person in charge, filters by office or My portfolio, and pages 25 rows. Selecting a buyer opens the same profile used in Enquiries. Buyer links in Credit Requests open the associated profile.

The compact profile header contains the selected buyer's standard name, customer ID, group, credit manager and status. Person in charge, office and country remain in Company Information. Button tabs sit directly below: Overview, Stem Records, Credit Requests and Company Information. Overview uses narrow columns: credit information; Competition above Performance and trends; Credit History and Remarks. It keeps its editors mounted during tab switches.

Credit usage shares a labeled used/available amount display, solid two-color bar and percentage legend with the enquiry sidebar. Temporary facilities remain separate from the permanent limit. The credit panel omits duplicate Credit Status and Risk Category. Risk Rating highlights its recorded position on a five-step scale, labeled lower to higher risk; missing/invalid ratings remain unknown. Volume labels in the trend chart include MT.

## Credit and requests

Workflow reference: [CMP2 User Manual](https://docs.google.com/document/d/1_qtk5offW-pub8keINOqaLEA1IP2I2MawkizsTxwACI/edit?usp=sharing), URGENT pp. 3–8, P1 pp. 12–13, leads pp. 9 and 18, appendix pp. 21–22. The demo uses its field and workflow structure with browser-local persistence.

Company and group limits are explicitly stored. Group available is the explicit group limit minus the recorded exposures of its members; member limits are never added to manufacture group credit. Current credit values are a demo account snapshot, not an invoice ledger reconstructed from historical stems.

New requests use two explicit workflows:

- URGENT requests an additional one-off overage, with vessel, seven-digit IMO, port, ETA, expiry and reason. Approval creates a separate temporary facility and leaves the permanent limit unchanged. Effective credit includes only currently active facilities.
- P1 requests the expected total permanent credit limit, including initial credit for a lead. Approving USD 800,000 sets the permanent limit to USD 800,000; it does not add USD 800,000 to the existing limit.

Legacy requests keep their original semantics: an increase adds to the permanent limit, initial approval sets the limit, and a temporary approval creates a separate facility. A legacy P1 priority label alone does not change an additive request into a total-limit request.

Credit/Admin can acknowledge and decide requests; traders can request but cannot approve. A requester who is not the buyer's person in charge must confirm before submission. Request, acknowledgement, closure and decision metadata remain available together. Credit History separates effective date from recorded date and links decisions to their requests.

New companies start as leads, with a standard customer ID, person in charge and office. Exact normalized names or aliases are blocked as duplicates; similar legal names require confirmation that this is a separate legal entity. No records are merged. Credit approval changes the lead to a buyer.

New requests snapshot the requester, requester office, buyer PIC office and Credit/Admin recipients, deduplicated by actor. The browser-local notification ledger records submission, acknowledgement and decision events. Credit/Admin attention counts open requests; trader attention counts requests with their own unread notifications. Expanding request details marks only that actor's notifications read.

Supporting files are saved with the request in this browser: PDF, PNG, JPG, TXT, CSV, DOCX or XLSX, up to five files, 512 KB each and 1.5 MB total. File format and size validation runs before saving; preview/download controls retain the original file data.

STEM rejects unapproved, suspended, on-hold or closed accounts. A priced fixture checks its selling exposure. An unpriced STEM checks the maximum requested quantity times buy price as a conservative known cost; it does not invent a selling price or book an invented receivable. Existing manual compliance/credit confirmations remain required.

## Performance and records

Performance defaults to the last 12 months, inclusive of today, using Hong Kong reporting dates. This year and All records are also available. Overview shows performance metrics and trends without a STEM preview. The Stem Records tab searches and pages all records, 25 at a time. Credit history and request tables mount 15 rows per page.

- Number of stem counts one fixture per enquiry booked in the period, including a commercial STEM awaiting actual volume.
- Stem delayed counts late-paid stems and unpaid stems already past due among known payment records. Missing records remain unknown.
- Average Payment day is invoice-to-payment days for paid stems with both dates.
- Average Delay is nonnegative days past due for paid stems; early/on-time payments count as zero. Unpaid invoices are excluded from both averages.
- Hit Rate compares converted enquiries against confirmed enquiries in the same reporting cohort. Drafts and older enquiry cohorts do not inflate conversion.
- Trends show the latest six calendar months: known volume and volume-weighted margin in USD/MT. Pending ranges never become invented exact volume or margin.

## Remarks

The standalone Credit History section shows recent shared credit events and its current credit text is editable by Credit/Admin. Overview shows the latest three credit events. All History opens the restored Credit History tab with the searchable, filtered history table. Saving creates an immutable Credit History entry and makes it active. Credit/Admin can select an earlier remark as active without rewriting its author, dates, history or financial values. Existing legacy remarks are imported once; their author and effective date remain unknown, and the recorded date identifies the import. The Remarks section in Overview contains Team Remarks and Private Remarks. Team Remarks are staff-shared notes about the selected buyer, not remarks belonging to the buyer’s customer group. The old customer-group label is removed. Legacy group notes remain visible until that buyer’s Team Remarks list is first saved, and subsequent edits affect only the selected buyer; users can add, revise or remove entries. Each real list revision publishes immediately and awards one Gold without changing financial approval. Previous publications remain intact; stale and unchanged drafts cannot publish. Private Remarks use the same list editor and dated entries, scoped to one demo actor and buyer. Existing single notes migrate on first edit; private revisions never enter shared contributions, audit text or Gold rewards. Editors open only when their buttons are selected.

## Competition

Competition appears above Performance in Overview. Traders and managers use Update to edit the current list, add competitors or remove obsolete entries. Existing approved contributions populate the first edit without rewriting their authors or dates. Unchanged entries retain attribution; edited entries show their latest editor and date. Each real list revision awards one Gold, regardless of the number of edited rows. Blank/duplicate entries, cosmetic-only retries and stale drafts are rejected. Current lists page 25 entries at a time and survive reload. Group membership does not broaden Competition to other buyers.

All reward-eligible update controls use the shared green Gold Update button, including profile/section updates, Key Info, information editors, tab saves, extraction publication, feedback and shared buyer lists. Private/credit remarks retain their existing reward rules.

## Demo boundary and verification

The app persists records in browser localStorage with selectable demo identities. Data, private notes, requests, approvals, notifications and request attachments are local to the browser. These flows do not write to CUP or send email. Production use requires authenticated shared storage and server-side permissions. No live CUP or Qlik records were imported. Their rendered field labels informed the design.

Unit tests cover cohort/payment calculations, credit lifecycle and expiry, P1 total versus legacy additive approval, immutable decisions, role checks, lead duplicates, attachment validation, recipient/read isolation and active remarks. Isolated browser tests cover the portfolio, both profile entry points, all tabs, request workflows, remarks persistence, temporary credit expiry, requests/history and mobile/desktop themes.

Buyer text uses the same 13px body and bold section-label standard as knowledge profiles. Working windows share opaque, stronger border tokens in both themes. Competition keeps name and attribution on one row where space permits.

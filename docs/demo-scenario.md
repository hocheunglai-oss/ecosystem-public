# Commercial demo scenarios

The demo uses fictional commercial data. CUP and Qlik informed the field structure; no private customer or financial records were imported.

## Navigation

- TRADING: ENQUIRIES, FIXTURES and LOST RECORDS.
- PORTS & SUPPLIERS: COUNTRIES & PORTS and SUPPLIER PROFILES.
- BUYERS AND CREDIT: BUYER PROFILES and CREDIT REQUESTS. Credit History remains inside each buyer profile.

Global search opens buyers, suppliers, locations, the current trader's enquiries, and shared fixture/lost records. Enquiry and credit attention badges open the corresponding filtered workspace.

## Dataset

Sixteen buyers have standard ECO customer IDs, person in charge and office, group membership, credit and insurance amounts, guarantees, risk information, ownership history and contacts. New fictional names retain the previous synthetic names as aliases so existing enquiry references remain useful. Relative-date historical stems include volumes, margins, payment dates and lost outcomes. Current examples include active, credit-constrained, overdue, suspended and onboarding buyers.

Credit data demonstrates requests awaiting acknowledgement, acknowledged requests, approvals, declines, active one-off overages, expired overages, annual reviews and ownership records. Generated decisions agree with their linked history. An actual local demo attachment is provided for the sample buyer.

Country, area, port and supplier profiles include titled sample prose and tables for delivery planning, specifications, contacts and desk handover. Sample commercial content is marked as fictional. Existing refinery references and SPC supplier-ranking snapshots stay separate from fabricated records.

## Incoming scenario picker

WHATSAPP (DEMO) and EMAIL (DEMO) each open a picker:

1. Normal enquiry
2. Insufficient credit
3. Same enquiry, another trader
4. Same account, another trader
5. Unknown port
6. Unknown buyer
7. Suspended buyer
8. Overdue payment
9. Three grades, split suppliers
10. Buyer awaiting credit approval

Selection uses the existing verified demo inbox routing, opens the message in Enquiries and follows the normal parser and enquiry workflow. Unknown buyer/port text is retained and shown for resolution. Peer enquiries are regular records owned by another demo trader; the existing conflict checks remain authoritative.

## Credit walkthrough

Use URGENT for additional temporary overage and enter vessel, IMO, port, ETA, expiry and reason. Use P1 for the expected total permanent limit. P1 approval replaces that limit; URGENT approval adds an expiring facility. Credit/Admin can acknowledge, approve or decline. Legacy requests retain their original initial, additive-increase or temporary semantics, even if an old request carries a P1 priority label.

New Lead creates a pending lead and its initial P1 request. Exact normalized company names or aliases cannot be duplicated; similar legal entities require explicit confirmation. A non-PIC requester must confirm before submitting. Approval changes the lead to a buyer.

Submission, acknowledgement and decision notifications remain in this browser, with deduplicated recipient snapshots for the requester, requester office, PIC office and Credit/Admin. Reviewers see pending-request attention; traders see their own unread request events. Opening request details reads only the current actor's notifications.

Requests can include up to five supported documents, with a 512 KB per-file and 1.5 MB combined limit. Files persist locally with the request and can be previewed or downloaded. Saving a Credit Remark creates a history entry; Credit/Admin can make an earlier remark active without changing credit amounts or rewriting history. Imported legacy remarks retain unknown author/effective-date attribution.

## Existing browser data

`demoScenarioVersion` makes the upgrade run once. Exact previous synthetic names may change while their aliases and IDs remain. Missing synthetic profile fields and demo lifecycle examples are added. User-created names, edited records, knowledge documents, contributions, Hats, rewards and dispatch history are preserved. No complete automatic reset occurs.

An Admin can use Reset Demo → Load new demo to deliberately replace the browser's saved demo data with the latest complete sample dataset and current dates. The existing explicit reset confirmation remains. Ordinary reloads retain saved dates and edits. Office transport reset still affects only that office.

## Storage and calculations

All data, request attachments and notification events remain browser-local. Credit actions do not write to CUP or send email. Exposure is an illustrative account snapshot, not an invoice ledger inferred from the generated stems. Private notes are separated by demo actor in the UI, not protected by a production authentication boundary. Current synthetic country/port statuses are illustrative and should not be used as operational guidance.

Record tables are paginated with independently scrolling headers. Group/private editors open on demand; group updates award one Gold immediately. Theme changes use the existing coordinated light/dark transition. Closing a workspace from its backdrop preserves the draft.

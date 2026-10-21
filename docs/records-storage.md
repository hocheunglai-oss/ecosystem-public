# Fixtures and Lost Records: interface and storage

## Source review — 2 October 2026

Inspected the signed-in SPC pages in the user-authorized Chrome session and read the relevant source/API code and Supabase schema. Only the automation-created SPC tab was closed. No source records or database schemas were changed, and no credentials were copied into Ecosystem.

- Fixtures: https://spc.fcuno.com/fixtures. Excel-like columns include date, supplier/buyer traders, account, ETA, vessel, IMO, three grades, supplier, price and barging. Pending stems are separated from completed fixtures.
- Its API requests `/api/spc/fixtures?limit=5000`, selects full records and an enquiry join, then sorts/maps on the server. The observed response was 842,300 decoded bytes and approximately 1.5 seconds. This is a single observation, not a performance SLA.
- Lost Record: https://spc.fcuno.com/lost-record. Date, buyer trader, vessel, IMO, ETA, buyer reason, supplier reason, SPC comments and save action. It requests cancelled enquiries with `limit=250&scope=records`.
- Verified project: bunker-map / `gglyugbrnyvyfktgwert`. At inspection there were 872 fixture rows (869 completed, 3 pending), and 907 enquiries including 8 cancelled records. Table-list estimates reported zero; explicit read-only counts provided the actual totals.
- Fixtures have a unique `enquiry_id` constraint and indexes on status/created time, supplier key, trader identities and IMO. Existing lost-review updates compare `updated_at`, which protects against overwriting a concurrent edit.

## Implemented in Ecosystem

Simple record sheets replace the previous dashboard cards and open-enquiry tables. Search and period/port filters apply before sorting and pagination. The default page has 50 rows; 25 and 100 are also available. Stable ID tie-breaking prevents records changing position unpredictably when dates match. Date boundaries use Hong Kong time.

The current demo keeps its existing storage and role scope. A memoized search index avoids repeated company/port lookup for every table cell; deferred search keeps typing responsive. Only the current page is rendered. CSV export explicitly exports the page, not an ambiguous subset of all results; it excludes private notes and neutralizes spreadsheet formulas. Quantity ranges remain ranges. Actual-volume recording and enquiry details remain accessible.

This is a bounded-rendering improvement, not a claim that browser localStorage supports production-scale history. The 20,000-row test measures in-memory indexing/querying only, not network or database persistence. Demo state is still loaded and persisted as a whole; cross-user delivery, durable server storage and production authentication are not connected by this change.

## Recommended live storage and query contract

Use Supabase Postgres as the canonical record store behind an authenticated application API. Retain source ownership in SPC; do not embed service credentials, copy sessions between apps, or bulk-copy live trade history into a publicly downloadable frontend bundle. Ecosystem must obtain its own authorized identity before consuming live records.

1. **Records and products:** one immutable record ID per outcome, enquiry reference, kind, recorded timestamp, buyer/port/trader IDs and revision number. Store multiple product lines in a child table with explicit quantities or minimum/maximum quantities and decimal prices. Separate private notes by authenticated owner. Keep an audit trail of edits and idempotency keys for saves/imports. Preserve the source fixture/enquiry IDs for deduplication.
2. **Bounded reads:** select only the displayed columns, filter by permitted scope, date, port and status in SQL, fetch 51 rows for a 50-row page, and return `hasNextPage` plus an opaque cursor. Fetch full details only when a row opens. Do not query an entire table or apply a permanent 250/5,000-row cap.
3. **Cursor ordering:** default order `(recorded_at DESC, id DESC)` with the same columns in the cursor predicate. Each permitted sort gets a matching cursor shape; do not silently sort only the loaded page. Avoid large OFFSET values. Changing filters/sort invalidates the cursor stack.
4. **Indexes:** measure with EXPLAIN ANALYZE, then add appropriate compound indexes such as `(kind, recorded_at DESC, id DESC)` and role/port/status variants for actual workload. For SPC fixtures the natural default is `(fixture_status, fixture_date DESC, id DESC)`. These are proposals, not migrations applied to the source system.
5. **Search:** indexed, normalized vessel/IMO/buyer/supplier text; debounce remote requests, cancel obsolete requests and ignore late responses. Avoid fetching all records to search in the browser. Fetch select-option dictionaries independently and cache them with a version.
6. **Reliable writes:** validate on the server, transact record/products/audit together, use unique idempotency keys, and reject stale revisions with a conflict response. Keep unsaved input on network failure; report saved only after acknowledgement. Authorize access server-side and keep RLS enabled. UI role filters alone are not authorization.
7. **Caching and counts:** short-lived, user/scope-specific page cache; invalidate on successful writes. Return loading/error/retry states without presenting a failure as zero records. Use an optional cached count for totals; deep browsing must not depend on repeated full COUNT scans. Never cache private responses publicly.
8. **Exports and recovery:** large all-filtered exports should be streamed or handled by an authenticated background job with an expiring download. Verify backups and recovery separately from UI testing.

First-page contract: `{ rows, nextCursor, hasNextPage, snapshotAt, totalEstimate? }`; request includes kind, date bounds, port/status/search, sort and page size, while viewer identity comes from the server session. Existing demo page-number UI can translate Previous/Next to a cursor stack when that adapter is implemented.

References: [Supabase pagination](https://supabase.com/docs/guides/database/pagination), [Postgres multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

# Fixtures and lost records

## Current interface and boundary

Record sheets provide search, period/port filters, sorting and pagination. Filters apply before pagination; stable ID tie-breaking keeps equal-date rows ordered. Date boundaries use Hong Kong time. Render only the current page and preserve quantity ranges instead of inventing exact values. Page CSV export excludes private notes and neutralizes spreadsheet formulas.

The existing browser record projection is separate from authenticated enquiry intake and shared supplier services. Its bounded rendering and in-memory indexing do not establish shared, durable production history. Do not embed private trading records in public fixtures or silently promote legacy browser records. Cross-application records require explicit source mappings and authorized ingestion; no passwords, sessions or service credentials move between applications.

Historical source inspection and operational measurements remain in private records. Public examples and performance checks must use synthetic data and identify what they actually measure.

## Future durable history contract

A shared records service remains a separately verified integration. Use ECO's authenticated API and live database with explicit ownership and row-level access controls. Preserve original source IDs for deduplication and internal immutable IDs for references.

- Read bounded, permission-filtered pages with only the displayed fields; fetch full details when requested. Changing search, filter or sort invalidates the cursor. Do not fetch all history or silently apply a permanent result cap.
- Use stable date-plus-ID ordering and an opaque cursor. Measure actual workloads before adding indexes. In-memory tests do not establish database or network performance.
- Validate writes on the server, transact records and audit together, retain immutable request IDs, and reject stale revisions. Keep drafts on failure and report saved only after acknowledgement.
- Keep private notes separate by authenticated owner. Cache only within the permitted user/scope and distinguish unavailable data from an empty result.
- Define page-only versus all-filtered exports clearly. Large exports require a bounded authenticated job or stream with an expiring download.

A proposed page response is `{ rows, nextCursor, hasNextPage, snapshotAt, totalEstimate? }`. Viewer identity comes from the server session. This is a future contract, not a claim that a new records adapter or migration has been deployed.

## Storage and recovery

Supabase is ECO's live database and protected document store. Browser file storage and legacy record projections retain their existing scope until separately migrated. Independent encrypted Google Drive backups are planned, not operational or restore-tested. Recovery evidence, destination identities and operator procedures remain private; UI tests do not establish backup recoverability.

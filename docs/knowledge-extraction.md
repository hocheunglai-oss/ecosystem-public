# Country and port information extraction

## Interaction

Open INFORMATION EXTRACTOR from the country/port toolbar when needed. Paste an email or notes, optionally choose the location and record its source/date, then extract. Review destinations, text, tables, Key Info and source excerpts. Warnings and unresolved destinations start unselected. Opening or running extraction creates a draft; only an explicit SAVE applies eligible selected changes. The green SAVE action shows CONTRIBUTION +1 on hover or keyboard focus.

Existing information stays unless the user explicitly chooses a block to replace. Closing/cancelling discards the extraction draft. Stale records, duplicates and replayed batches fail without partial publication or duplicate contributions. Keep retained sources and previous versions. Preserve URL/link values in their original case.

Key Info uses multiline fields with a 1,000-character limit per field. Existing values and line breaks remain intact; clearing a field saves an unknown value. Extraction proposals require a nonblank value and an excerpt present in the pasted text. Saves retain per-field authorship, unchanged-field timestamps and concurrent-edit protection. Historical dropdown values remain compatibility data only.

## Current service boundary

The current client in `src/lib/knowledgeExtractionApi.ts` calls `https://spc.fcuno.com/api/ecosystem/knowledge-extract`. This is a retained FCUNO/SPC service dependency, separate from ECO's independent password authentication. An authenticated ECO account does not establish a session with that service. Keep provider credentials on its server and never copy authentication material between applications. VIEW AS and TEST must not call the live extraction service.

The client sends bounded text and location references and validates returned proposals against the shared extraction contract. Source excerpts must match the input. The service returns a draft; it does not publish country/port knowledge or modify FCUNO/SPC business records. Preserve pasted input on a retryable service/sign-in failure. Do not add automatic paid retries or an unreviewed fallback model.

Local and staged browser verification uses intercepted responses. Provider configuration, allowed production origins, usage accounting and live authentication are owned by the service and must be checked separately before a live integration claim. The future parser/API strategy remains explicit in [the roadmap](development-roadmap.md).

## Persistence and verification

Confirmed country/port knowledge and its history retain their current browser persistence. API-backed supplier data and owner-private profile tabs have separate storage contracts. Extraction does not make local knowledge a shared multi-user database.

`pnpm test` covers atomic multi-location publication, duplicate/replay/stale protection, evidence and contribution eligibility. The isolated extraction browser harness checks review and publication with controlled API responses. A mocked browser pass does not establish a working live provider session or successful paid extraction.

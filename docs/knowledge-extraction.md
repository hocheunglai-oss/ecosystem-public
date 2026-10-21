# Country and port information extraction

Open **Intelligence → Country and Port Data → Paste information**. Paste an email or notes, optionally select a location and record the source/date, then select **Extract**. Review destinations, text, tables, Key Info and source excerpts. Items with a warning or unresolved destination start unselected. **Update** publishes selected changes together and awards one Gold; the mobile business interface omits the reward decoration.

Existing information is retained unless the user explicitly chooses a block under **Replace**. Extraction does not change records or earn a reward. Closing/cancelling discards the draft. Stale records, duplicate information and replayed batches fail without partial saves or rewards. Sources and previous versions remain in record history.

Key Info uses multiline text fields in both its editor and extraction review, with a shared limit of 1,000 characters per field. Values are not restricted to a fixed list or administrator options. Existing values and line breaks remain intact; clearing a field saves an unknown value. Extraction proposals still require a nonblank value and source excerpt. Saves retain per-field authorship, unchanged-field timestamps, and concurrent-edit protection. The old dropdown values are retained only as private compatibility data for recognizing historical extraction source blocks.

## API and sign-in

- Endpoint: `https://spc.fcuno.com/api/ecosystem/knowledge-extract`.
- Server implementation lives in FCUNO's `app/api/ecosystem/knowledge-extract/route.ts` and `lib/ecosystemKnowledgeExtraction.ts`.
- Reuses FCUNO's server-side `OPENAI_API_KEY`; no key is shipped to ECO.
- Model: `OPENAI_KNOWLEDGE_MODEL`, default `gpt-6-luna`, low reasoning effort, strict Structured Outputs, no external tools.
- Requires an existing authenticated FC UNO or SPC session with no password reset pending. The ECO demo profile is not API authentication. The user can sign in at `https://spc.fcuno.com/`, then retry without losing pasted text.
- Credentialed CORS accepts only `https://eco.fcuno.com`. Localhost and preview extraction calls are intentionally not allowed; browser tests mock the endpoint.
- Input: 30,000 characters, at most 1,000 location references. Up to 40 proposals, 30 columns/200 rows per table. Source excerpts must occur in the pasted text.
- Failures are bounded and retryable; there is no automatic fallback model or retry that incurs additional API charges.
- Usage accounting uses `ecosystem-country-port` / `knowledge-extraction` and records token/cost metadata, never pasted text or extracted contents.

## Current storage boundary

ECO remains a browser-local demo. Confirmed information, history and rewards use its existing local storage. The extraction endpoint only returns a draft and does not write to the FC UNO/SPC database. Shared, multi-user knowledge persistence will need a separate authenticated storage integration.

## Verification

- `pnpm test` includes atomic multi-location updates, duplicate/replay/stale guards, provenance and rewards.
- `node tests/knowledge-extraction.e2e.mjs` checks the browser flow with controlled API responses in isolated contexts.
- FCUNO's `tests/ecosystem-knowledge-extraction.test.ts` checks authentication, origin checks, schema/evidence validation, timeouts and provider failures.
- A signed-in live API check is separate from mocked browser/provider tests.

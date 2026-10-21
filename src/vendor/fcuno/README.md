# FCUNO parser reuse

ECO uses the **same pinned pure FCUNO parsing modules**, plus an ECO adapter. It is not a live copy of whichever FCUNO version happens to be deployed. The SPC parser is a wrapper over the FCUNO core, with Singapore defaults and buyer detection disabled; ECO enables buyer detection and requires an explicit delivery-port match instead.

`version.json` records the source repository, full commit and SHA-256 of every original/vendor file. The original source commit is `8d6b20f9255d42c13ac926c417083248a1b46c82`. The six modules also matched FCUNO commit `335b60d884eb6a99b7512ed4b5881931a64daecd` when checked on 15 October 2026. Only relative import paths differ in the vendored modules. The `relative-imports-explicit-ts-v2` adaptation adds explicit `.ts` extensions, which the server compiler rewrites to `.js` for native Node ESM; the upstream commit and source hashes are unchanged. Changes specific to ECO belong in `src/lib/parser.ts`; do not silently patch or overwrite the pinned core.

The allowlisted files are `lib/enquiryWorksheetParser.ts`, `lib/enquiryPortIndex.ts`, `lib/enquiryShortener.ts`, `lib/spcEnquiryText.ts`, `data/priceSetterTabs.ts` and `data/reportSections.ts`. No customer, contact, credit, transaction, session or credential data is included. The pure adapter makes no HTTP, database, AI or dispatch call.

## Checking an upstream update

Every `pnpm test` run verifies local vendor hashes through `tests/parser-provenance.test.ts`. This is part of ECO CI. A standalone local verification is:

```sh
node scripts/check-fcuno-parser.mjs
```

When FCUNO development produces a candidate, compare an explicitly selected full commit from the verified FCUNO checkout:

```sh
node scripts/check-fcuno-parser.mjs --source /absolute/path/to/bunker-map --revision FULL_40_CHARACTER_COMMIT_SHA
```

The checker verifies the repository origin, reads immutable Git blobs, ignores uncommitted working-tree changes and lists changed modules. It does not fetch, copy files, alter the pin or deploy. Exit status 1 signals upstream differences or invalid evidence; this is a review trigger, not an automatic upgrade.

To adopt an upstream change, review the six allowlisted modules and corresponding regression changes, apply the import-only adaptation, deliberately update the manifest to the reviewed commit/hashes, run the upstream parser regressions in an isolated source checkout, then run ECO's adapter regressions and normal staged release checks. Keep the previous pin in Git for rollback. Never copy credentials, private reports, source fixtures containing customer messages, or application integrations into the vendor directory.

## ECO behavior

ECO's adapter uniquely matches explicitly labelled buyer text against the supplied directory and rejects conflicting buyer/port evidence. A company mentioned only in a signature or vessel name does not become the legal buyer. Matching remains a suggestion for trader review; the current prototype directory is not an authoritative external buyer-ID integration.

The adapter rejects unsupported units and conflicting quantities, does not invent Singapore when a port is absent, and keeps internal buyer/commercial fields out of the standard supplier enquiry. It clears unsafe ambiguous/missing-month or invalid delivery dates for review and preserves explicit years. Dates with an explicit month but no year remain supported as display text without an invented year. Full structured schedule/identity integration remains separate work.

FCUNO can continue developing independently. ECO upgrades are deliberate and regression-tested; updates never alter ongoing ECO enquiries or production parsing automatically. AI integration, when connected, remains an ECO-owned service outside these pinned deterministic modules.

# Country and port data

## Navigation and profile identity

The landing page offers Recently viewed, Add location, Country Index and Port Index. Information Extractor opens on demand from the toolbar. Countries and ports are the only active location levels; historical Area records remain available only for migration and recovery. Every port requires a country, and its country is visible in the port index.

Retain every country in the country index. When a country has exactly one registered port, both index entries open the same combined profile. This is a presentation rule based on registered records, not a claim about the country's physical ports. Keep the original country and port IDs, content, histories, attachment references and private collections. Edits save to their original source. Adding a second registered port restores independent views without moving or discarding either source's data.

A country with more than one registered port has a dedicated PORTS tab containing its port list. Do not repeat the list below the profile or inside port entries. A country with no registered ports retains its own profile. Generated tabs must not collide with saved custom tab IDs.

Port headings show the local clock using a recorded IANA zone, including daylight saving, or an explicitly recorded UTC offset. Countries have no clock; an unknown port time zone remains unknown. Country/port headers expose public holidays from dated official sources, including observed dates and jurisdiction coverage. Unavailable dates must not be invented.

## Tabs and editing

Country defaults include Suppliers, Refineries, Grades and delivery modes, Tax and regulations, Trader's Remarks, and Uploaded Documents. Port profiles also include Port Information and Price History. Stable semantic roles keep renamed defaults functional; a similar title does not grant a custom tab that role. Saved layout versions preserve removed defaults and existing blocks on reload.

Use the shared profile tab strip and one Manage Tabs dialog. Private tabs appear first with a lock and PRIVATE label; + PRIVATE TAB creates a draft in the same manager. Reorder only within a visibility/source group and show the exact drop destination before dropping. Combined profiles retain both original owner-private collections and route each save to its original target. New private tabs use the selected primary profile scope.

Manage Tabs supports add, rename, remove, restore and reorder. Confirm content removal, retain historical snapshots, recover removed content when restoring within an unsaved draft, and restore a previously deleted default as an empty functional tab. Shared combined-source changes retain the existing atomic save contract; separate private/shared scope requests retain revisions and completed receipts across retries.

Edit information beside the selected content in one text/table editor. Use the main tab strip and its manager action; do not repeat an Edit tab selector or Manage Tabs button inside the editor. Switching profiles, tabs or indices with unsaved work requires the existing discard guard. Cancellation keeps the editor and draft. Enlarged windows retain compact working widths and preserve drafts when resized.

Text remains text; tables retain stable row/cell IDs. Table controls act on the focused row/column and accept pasted spreadsheet cells. Links preserve their original URL and case. Publication retains existing sources and records automatic change descriptions. Each shared tab has one green EDIT action and a green SAVE action in its editor, with CONTRIBUTION +1 on hover or keyboard focus. Private saves remain neutral; private, layout-only changes and no-op retries do not create contributions. Per-entry attribution comes from the authenticated actor and publication time; unchanged entries keep their prior attribution.

## Storage and verification

LIVE country/port records, rich knowledge, layouts and history use the authenticated location-knowledge API. The server derives the current actor, validates source documents and commits each change with its revision, receipt and audit event. Another active account receives the same shared information. Current records exclude archived revisions and publication payloads. Append-only history and full contribution details are loaded on demand with bounded pages; contribution totals are calculated from the complete compact publication archive. Exact retries retain a compact receipt and return the current envelope with the original committed revision acknowledgment. Repeated edits must not increase current snapshot or receipt size merely by appending history. TEST remains isolated and cannot publish to this API. Private tabs keep their separate owner-only API and never enter the shared snapshot.

Existing owner-scoped browser data is retained byte-for-byte as a recovery archive. An administrator can review an import of meaningful country/port content; the server rejects conflicting records rather than overwriting either source. Imported free-text publications are materialized into the current document before their full detail is archived. Imported history retains its original provenance and does not award new contributions. Previously imported canonical source digests are recognized by the server. Unknown save responses retain the exact request and draft for retry; concurrent changes require reconciliation. See [profile data access](profile-data-access.md) for ownership and recovery. The extraction service retains its separate authentication boundary; [information extraction](knowledge-extraction.md) describes it.

General country/port and supplier uploads use protected shared storage, with authenticated metadata and short-lived downloads. Browser originals are retained until an explicit migration succeeds; only files assigned to the current real owner and a known active shared target are eligible. Unassigned or unsupported records remain local. The independent encrypted backup captures database records and verified stored object bytes; an older daily archive does not retroactively include later publications.

Verify location modelling and migration with `tests/locations.test.ts`. Browser CI includes `tests/location-flattening.e2e.mjs`, `tests/country-port-profiles.e2e.mjs` and `tests/private-profile-tabs.e2e.mjs` (the unified profile harness), at 1440, 320 and 390 pixels, light/dark, Chromium/WebKit. Preserve same-titled country/port private tabs, original save targets, dirty guards, VIEW AS restrictions and unavailable holiday states. Emulation does not establish physical-device or native Safari coverage.

## Future port imports

Use official UN/LOCODE as an external location mapping while preserving internal immutable IDs. Keep country and location codes separately, review source releases and changed/duplicate codes, and distinguish maritime ports from other location functions. Facilities may belong to a location without having a separate UN/LOCODE. Import identity remains independent of the registered-port count used to combine profile views. A worldwide import is a separate reviewed task, not part of this presentation rule.

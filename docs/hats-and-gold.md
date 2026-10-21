# Contribution Activity and Hats

This document keeps its historical filename so existing references remain valid. Contribution Activity replaces the Gold interface as of 13 October 2026.

## Hats

ECO sign-in uses authenticated accounts. Hats and local knowledge activity retain browser-local storage separated by signed-in user ID. Supplier and feedback publications also have authenticated shared contribution records; the account total combines available local activity with the server summary. These are different sources: do not describe all activity as local or imply that a shared contribution total makes the Hats ranking company-wide. Shared Hats would require a separately implemented ledger with a unique reader plus canonical-entry identity.

`set-hat` records a reader, stable entry target, recipient, publication timestamp, award timestamp and (for knowledge blocks) document version. The target is a port Key Info field, a knowledge block or a table row. Country/port aliases resolve to the same entry identity.

Only the latest recorded contributor can receive a new Hat. The action checks the displayed author's identity and update timestamp again before saving. Existing awards keep the original recipient when another contributor edits the entry. Each reader owns one award slot per entry, including after edits. Undo retains that slot; restoring it cannot transfer it to a different contributor. Unknown authors, missing entries and self-awards are rejected. Hats do not create Gold or contributions.

The Hat engine recognizes known legacy actors and signed-in profile IDs for both readers and recipients. Real account UUIDs receive the same self-award, duplicate, stale-attribution and ownership checks. A UUID-shaped ID with no known profile is still ineligible. Counts refresh when the known profile directory changes without rewriting the award's original recipient or received date.

The contributor/date stamp reveals the Hats action on mouse hover or keyboard focus. Touch layouts expose the action directly. Awarded entries show a checkmark; clicking again removes an accidental award without a separate undo label. History remains available in the profile header. The HATS OFF account panel always shows the all-time ranking from active awards. At zero personal Hats it explains earning Hats through useful contributions; otherwise it shows the five most recent valid givers and their award dates. Empty rankings contain no invented awards. Achievements and Office Performance entry points are removed.

## Contribution Activity

The account contribution status covers today and the previous six Hong Kong calendar days. Opening it shows its count, encouragement, thresholds and counting method. The control is hidden for the effective CREDIT office. Counts refresh on publications, every minute, and when returning to the tab.

### Status and contribution guide

| Contributions in the seven-day period | Status |
| --- | --- |
| 0 | INACTIVE |
| 1–10 | ACTIVE |
| 11 or more | OUTSTANDING |

Hats never affect the contribution tier. When contributions leave the seven-day window, the status changes with the available count; it is not a permanent rank.

Only the privately configured active owner administrator has APPEARANCE PREVIEW controls in the Contribution and HATS OFF panels. Contribution examples use counts 0, 5 and 11. Hat examples show no personal Hats or five received Hats, with explicitly labelled sample people. Preview state is temporary, resets on closing/switching panels, and does not write records or permissions. Other administrators cannot enable it by changing browser-local profile data.

Only actual published contributions count. Repeated edits by the same person to the same entry on one Hong Kong calendar day form one contribution; a save touching overlapping entries joins those groups. A Key Info save counts once regardless of the number of changed fields. One AI import batch counts once and displays its number of distinct updated profiles. Original publications remain available through expandable history details. Activity counts are not a judgement of accuracy or contribution quality.

Unchanged content, duplicates, empty scaffolds, formatting/layout-only edits, tab organisation, private remarks, pending/declined records and future timestamps do not count. New valid contributions publish immediately; no additional approval step is introduced. Historical records with explicit contribution evidence count once each. Existing Gold amounts and synthetic grants are never converted into activity, and there is no spendable balance or reward promise. Legacy Gold storage/helpers remain only for saved-state compatibility.

Hats remain a separate appreciation signal with an all-time count/ranking. Their browser-local limitation remains. Shared contribution totals do not establish a shared company-wide Hats ranking; local charts/history must remain labelled separately from the authenticated shared count.

### Identity and administrator reporting

Contribution history recognizes legacy demo actor IDs, IDs present in the current state's authenticated profile records, and an explicit trusted directory supplied by the caller. The administrator view can supply IDs from the authenticated user roster. An unfamiliar author is not accepted merely because its ID has the shape of a UUID. Original author IDs and publication records remain intact; selecting a reporting period does not rewrite ownership or activity dates. These reporting rules do not grant access or replace authentication and authorization.

Administrator reporting must distinguish a known zero from missing records. A roster establishes identity and office, not complete activity. Shared contribution counts come from the authenticated service; a pending or failed response must remain CHECKING or UNAVAILABLE rather than an invented zero. Local charts/history cover only their available records. Personal history remains limited to its signed-in owner, and administrator reporting remains restricted to administrators. Do not describe either view as complete company-wide performance without verified coverage of its publication sources and the separate Hat ledger.

Oil, total-volume reward indicators, transported volume, GP/MR/Aframax purchases, escalating prices, dispatch, transport history and annual transport rewards are retired. The saved-state upgrade preserves historical contribution evidence, Hats and operational business records while removing retired transport state. Fixture quantities and actual traded volumes retain their commercial meaning and do not create game currency.

Stationary Fratelli Cosulich bunker barges are decorative harbour artwork. They have no reward or transport controls. See [Barge artwork](cosulich-barge-assets.md).

## Shared knowledge UI

The profile-header search covers all tabs in the current country, port or supplier profile, including inherited country information and generated price/fixture data. Fixture searching uses the existing actor-filtered index. Results are grouped by source tab; selecting a group opens that tab, and clearing search retains the earlier selected tab. It does not search other location or supplier profiles.

Compact coloured title rows distinguish the profile and information sections. Key Info has a transparent body with bold facts. Each shared tab has one green EDIT action; its editor uses green SAVE. These controls show CONTRIBUTION +1 on hover or keyboard focus and use the shared compact style in both themes. Private saves remain neutral and do not promise contributions.

Every knowledge block requires a nonblank title. Existing untitled content receives a section-based title, preserving IDs, contents, attribution, Hats, sources and immutable history. This migration does not create a revision or reward. Drafts opened before the migration retain compatible fallback titles, while new entries and edits cannot save blank titles. AI extraction uses the same fallback for untitled text or tables.

## Verification

Unit coverage includes award ownership, stale attribution, undo/replay handling, preserved author credit, ranking, search, saved-state compatibility and activity date/grouping rules. Status tests cover 0, 1, 10 and 11 contributions, Hats below the contribution threshold, lifetime versus selected-period Hats, next-status requirements, authenticated profile IDs and trusted roster IDs while rejecting unknown authors. Isolated browser checks exercise period counts, retained history, AI batches, office aggregation, mobile access and country/port/supplier publishing. Transport-pricing, dispatch and voyage tests are retired with their features; regression checks confirm that those controls cannot reappear and that operational records survive the activity change.

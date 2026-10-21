# Development roadmap

## ECO 1.0 — SPC ready

Support the established SPC trading tasks with shared, authenticated persistence and verified access boundaries. Supplier profiles, Singapore comparison, country/port knowledge, enquiry parsing and review must remain consistent. Buyers and credit show `UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0` to non-administrators, including VIEW AS; real administrators retain access.

Keep countries and ports as the location model. Shared profile actions, tab management and private owner-only tabs use the same design language. Only administrators and SPC traders may change Singapore supplier information.

## Current refinement requirements

Use compact, deliberate reading and editing widths throughout ECO. Preserve URL/link values in their original case while keeping interface labels in CAPS. Information Extractor opens on demand from the country/port toolbar. Documents need accessible previews and a clear download fallback. Detailed privacy information belongs inside authenticated Settings.

Keep users signed in until manual logout while their browser retains its persistent cookies, with no fixed or inactivity timeout. Preserve token rotation, password-change and administrator revocation. Transient provider/network failures must permit recovery without treating an otherwise valid session as signed out. These are acceptance requirements; release evidence must establish which fixes have been verified.

The 21 October refinements require flat workspace surfaces, a stable-width local clock, today's confirmed public-holiday status with the next holiday available on hover/focus/touch, and whole-table paste into the shared editor. The owner approved one green EDIT button per shared tab, with CONTRIBUTION +1 on hover or keyboard focus. Feedback uses the same treatment; credited SAVE actions are green and private uncredited actions remain neutral. Keep visible field and outline boundaries, readable prose widths, right-aligned attachment actions, and source-aware editing when a port tab includes country information. Search results must not include empty supplier directories.

The owner approved automatic table updates from approved sources, starting with official MPA pages and registers for Singapore's alternative-fuel supply table. The implementation uses authenticated shared factual snapshots and a daily source check. Activation requires a verified migration, the production feature flag and a successful staged refresh. The subsequent shared-storage step moves general country/port knowledge and manual commercial implications to authenticated server records, with explicit review of retained browser archives and no new credit for historical imports. General profile files use protected storage and are included in the encrypted backup inventory. Deployment and actual content-import evidence remain separate. Keep publication dates, exact source links, retrieved timestamps and prior verified values; retain the last verified result when a source fails, changes structure or no longer covers a missed publication period. A missed period beyond the available source feed requires an operator review before freshness is restored. Separate official factual extracts from editorial commercial implications, preserve manual content, and never count an automated refresh as a user's contribution. The dated LNG supplier register takes precedence over an older general overview count. Do not import MPA contacts or addresses.

## ECO 2.0 — all ports ready

Receive eligible staff-forwarded enquiries through configured email and WhatsApp intake. Resolve ownership from the approved user directory. Show notifications, retain source lineage, and require review before commercial confirmation. Singapore enquiries route to the purchasing-centre queue; other ports follow the all-port workflow. Outbound notifications and dispatcher activation remain separately controlled integrations.

Use the pinned all-port parser with explicit buyer and port review. AI FIX is an optional, evidence-backed suggestion that users apply deliberately. Parser reports retain the original parse, AI attempts, corrections and administrator review. Proposed parser improvements require representative regression checks before replacing the pinned version.

Plan future buyer and supplier master-data imports around stable IDs and external mappings. Credit checks require an authoritative source with visible freshness, shared exposure accounting and explicit reservation/release rules. Market-price estimates must remain distinct from confirmed commercial values. Do not claim planned integrations are delivered.

## Source and data separation

The public source includes application behaviour and synthetic test fixtures. Staff provisioning, supplier commercial data, reports, routing records and historical operational evidence remain private. Serve authorized business data through authenticated APIs; never inject it into public frontend assets.

The original development history is retained privately. The public source starts from a reviewed clean snapshot. Subsequent releases retain full tests, precise source/deployment evidence and staged verification before promotion.

Supabase remains the live database and protected document store. The independent encrypted Google Drive backup workflow is implemented. Activation requires a verified complete cloud run and recovery check; current run and recovery evidence determines operational status. Keep destination identities, keys and recovery procedures private. Availability monitoring runs from the canonical public source repository; preserve its independent checks and do not reactivate the retired private-repository schedule.

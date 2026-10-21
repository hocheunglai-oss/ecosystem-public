# Development roadmap

## ECO 1.0 — SPC ready

Support the established SPC trading tasks with shared, authenticated persistence and verified access boundaries. Supplier profiles, Singapore comparison, country/port knowledge, enquiry parsing and review must remain consistent. Buyers and credit show `UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0` to non-administrators, including VIEW AS; real administrators retain access.

Keep countries and ports as the location model. Shared profile actions, tab management and private owner-only tabs use the same design language. Only administrators and SPC traders may change Singapore supplier information.

## ECO 2.0 — all ports ready

Receive eligible staff-forwarded enquiries through configured email and WhatsApp intake. Resolve ownership from the approved user directory. Show notifications, retain source lineage, and require review before commercial confirmation. Singapore enquiries route to the purchasing-centre queue; other ports follow the all-port workflow. Outbound notifications and dispatcher activation remain separately controlled integrations.

Use the pinned all-port parser with explicit buyer and port review. AI FIX is an optional, evidence-backed suggestion that users apply deliberately. Parser reports retain the original parse, AI attempts, corrections and administrator review. Proposed parser improvements require representative regression checks before replacing the pinned version.

Plan future buyer and supplier master-data imports around stable IDs and external mappings. Credit checks require an authoritative source with visible freshness, shared exposure accounting and explicit reservation/release rules. Market-price estimates must remain distinct from confirmed commercial values. Do not claim planned integrations are delivered.

## Source and data separation

The public source includes application behaviour and synthetic test fixtures. Staff provisioning, supplier commercial data, reports, routing records and historical operational evidence remain private. Serve authorized business data through authenticated APIs; never inject it into public frontend assets.

The original development history is retained privately. The public source starts from a reviewed clean snapshot. Subsequent releases retain full tests, precise source/deployment evidence and staged verification before promotion.

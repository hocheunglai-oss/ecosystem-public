# ECOSYSTEM project preferences

## Development roadmap

Read `docs/development-roadmap.md` before planning or building ECO features. It records the owner's ECO 1.0 SPC-ready and ECO 2.0 all-ports release direction and applies to continual-development and UI-refinement work. Prioritize verified SPC task parity for 1.0. Buyer/credit workflows must show non-admins `UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0`; administrators retain access. Apply gates across entry points, preserve read-only VIEW AS and existing data permissions, and do not describe planned integrations or gates as already delivered. Track operational parity and the FCUNO/SPC parser distinction in private operator records. ECO already uses the FCUNO-derived all-port core; retain explicit port/buyer review and do not inherit the SPC missing-port Singapore default. Keep parser/API strategy, live credit sources, external notification channels and future master-data imports explicit in the roadmap until resolved. Later explicit owner decisions take precedence and should update the roadmap.

## Interface wording

Present interface text in CAPS sitewide. Preserve the case of email addresses and credential values, including revealed passwords. Apply exceptions to the values, never to an entire form or panel.

## Desktop and mobile verification

Every interface or visual change must be checked on desktop and mobile in both day/light and night/dark modes, including affected signed-out and signed-in screens. Verify narrow and representative phone widths, screenshot appearance, artwork colour, contrast, clipping, overlap and horizontal overflow. Use mobile WebKit as well as Chromium where available; state any untested browser/device. Keep shared artwork, scale, shadows and loading behaviour consistent across desktop and mobile.

For every ECO fix, verify its affected user flow in dark mode as well as light mode before calling it complete. This is a standing project rule, not limited to colour changes. Use the shared theme variables for surfaces, text, borders, focus and disabled states; do not combine a hard-coded light fallback with theme-dependent text.

The user explicitly requires: "DO NOT add words that I didn't ask for this project."

Use the user's supplied wording for visible interface text. Do not invent slogans, taglines, promotional headings, welcome copy, explanatory captions or decorative labels. Keep requested forms to the necessary functional labels and actions. Do not reintroduce copy the user removed.

## Shared interface design

Use `src/design-system.css` and `docs/ui-design-system.md` for every new or changed ECO interface. The existing Feedback for Ecosystem button is the reference for ordinary action shape and colour. Reuse the shared primary, secondary, destructive and icon-button variants, radius, spacing, focus/disabled states and desktop/mobile target sizes. Do not invent one-off lime blocks, pill shapes, shadows or button sizes.

Use the documented font families, weights and finite title/section/body/label/metadata scale. Preserve email and credential case. Forms and multi-column screens need deliberate reading widths and balanced space; do not stretch one directory column across an ultrawide screen while compressing the editor. Custom artwork, charts and record rows may retain their purposeful geometry, but their ordinary actions use the shared controls. Verify broader affected screens when changing shared tokens.

## Shared knowledge interface

Keep Country and Port Data and Supplier Data as close in design and interaction as possible, so users do not need to learn two interfaces. Use the shared profile, tab management, information editor, table controls and entry attribution components for both. Their record types and default tabs may differ; shared actions, placement and editing behavior should stay consistent.

## Browser isolation

Use a dedicated headless browser and isolated context for verification. For requested repairs, the user's standing permission allows relevant personal-browser and computer access without asking again; keep access limited to the repair and use verified connectors, then target-locked CLI, before the browser fallback. Non-repair personal-browser access still requires task-specific authorization. Do not steal focus or automatically open preview panels. Close only automation-created tabs and contexts.

## Window sizing

Application dialogs and workspace windows open enlarged by default. Every window has a visible shrink/expand control, including Update Information. Resizing preserves the current form, selection and unsaved work.

## Drag and drop

Always show a clear insertion indicator before an item is dropped. Its exact position must match where the item lands, including before/after and first/last positions. Apply this to sections, tabs, table rows and columns, and all future drag-and-drop interfaces.

## ECO authentication and access

- ECO uses independent password authentication, as requested on 13 October 2026. Keep future two-factor support available. Do not reuse FCUNO/SPC/FCOS passwords, hashes, sessions or service credentials.
- Provision the approved staff directory privately, grouped by office. Preserve existing role assignments; do not derive administrator authority from display names or email patterns.
- SPC Trader and Manager are separate profile options; neither grants administrator access. Manager performance access is limited to the assigned office unless a later explicit permission allows more.
- Users & Access belongs inside Settings and is visible only to administrators. Enforce the same restriction at the API and database layers.
- CREDIT is an office grouping. Its members use the ordinary trader interface and permissions for now; office membership alone grants no credit approval authority.
- VIEW AS is an administrator-only, read-only role/office preview that retains the real signed-in identity. Keep preview state separate from account permissions, block writes in the server and local workflows, clearly indicate preview mode, and provide a direct return to the real account. Never restore a browser-only profile selector as authentication.
- New users, including new administrators, receive the same owner-configured server-only initial password. Never bundle that credential or allow a browser payload to override it. Existing users are not reset.
- Normalize phone formatting to the leading plus and international digits; reject ambiguous extensions or letters.
- Members request contact phone changes from Personal Details; an administrator approves or declines through Notifications or Users & Access. Keep the current phone until approval, retain the audit, and supersede stale requests when an administrator edits the number directly. Contact approval must not alter authentication. As directed on 20 October 2026, WhatsApp and email enquiry ownership follows the approved/current phone and email in Users & Access. Pending phone requests do not change routing. Require one eligible active account, preserve historical receipt ownership, and reject ambiguous matches; do not maintain a separate stale production sender directory.
- The account contribution tier uses today plus the previous six Hong Kong calendar days: INACTIVE at 0, ACTIVE at 1–10, OUTSTANDING at 11+. Hats do not affect it. Hide it for the effective CREDIT office. Contribution and Hats appearance previews belong only to the privately configured, real active owner administrator; keep them labelled, temporary and unable to change records. Other administrators must not see them.
- Use HATS OFF for the account panel. Always show the Hats ranking, explain earning Hats through useful contributions when the user has none, and show the five most recent valid givers when Hats have been received. Do not restore Achievements or Office Performance entry points without a new request.
- Do not restore Reset Demo controls, entry points or browser reset operations; the owner will request operator maintenance if needed.
- Never restore the demo profile selector or browser-stored identity as an authentication bypass. On 14 October 2026 the owner explicitly requested one initial password for administrators and another for other users, with an optional first-login password change. Apply that exception only through a verified operator action; never commit the credentials, ship them to the browser, or reset passwords automatically when roles change. Keep password changes available to every signed-in user.
- The owner approved an eight-character minimum with uppercase letters, lowercase letters and numbers, and no ECO two-factor requirement. Record authentication exceptions honestly in the internal security assessment. Do not disable existing security on cloud-provider, source-control or email accounts.
- Keep users signed in as long as their browser retains its persistent cookies: no fixed or inactivity session timeout. Preserve explicit logout, password-change and administrator revocation. Keep short-lived access tokens and rotation; never implement persistent login by accepting stale browser identity.
- `config/ecoConnections.ts` owns ECO's non-secret target identities. Verify these exact targets before external operations. ECO's Singapore project was provisioned on 13 October 2026; never substitute FCUNO or FCOS projects.
- Account cleanup is limited to ECO. Do not delete or change SPC/FCUNO/FCOS users when working on this migration. Exclude test identities only when explicitly identified; SECURITY is retained.

## Purchasing-centre routing

The owner will supply named WhatsApp groups for operator-maintained configuration. Do not add routine route-management controls to Users & Access without a further request. Contact phone numbers are separate from enquiry destinations and access permissions. Plan Singapore and future Korea purchasing centres with separate route assignments, extension connections and queue claims; a Korea connection must never replace Singapore's dispatcher or consume its jobs. Keep configuration in private server-managed storage, never a public bundle. See the private operational record; this design is not a claim that live dispatch is implemented.

## Internal security baseline

Maintain evidence for the internal security baseline; do not present it as certification. Prioritize speed, reliability and overall performance. Prefer automated checks and background controls over extra steps in routine trading. Distinguish implemented controls, untested plans, external provider evidence and owner-approved exceptions. Keep assigned operational ownership in private records.

## Source and production releases

- The clean public source repository is the canonical `ecoConnections.githubRepository`; preserve the original repository and historical records privately; verify the authenticated GitHub account is `hocheunglai-oss` before mutations. Use `codex/` branches for subsequent changes. Preserve private credentials, cookies, test fixtures and generated artifacts outside version control.
- Generate System Information on every build. Keep shared status contracts, permission tests, desktop/mobile light/dark browser checks and independent monitoring current when adding features.
- Before a production release, verify the intended source commit has passed all ECO quality jobs. Stage with production configuration and no live-domain assignment, verify the staged API/data/user flow and affected responsive layouts, then promote that exact deployment. Keep the compatible previous deployment for rollback. Do not enable unchecked Git auto-production deployment.
- Automated checks are evidence, not proof of an enforced merge restriction. Verify current branch protection and recovery controls before describing them as enforced.
- Use additive migrations and separate provenance for client-reported import outcomes versus actual server publication. Missing or stale monitoring evidence stays UNKNOWN.

## Supplier and profile consistency

Supplier Profiles opens a centered name-only table with aligned search and pagination. The owner's latest 15 October direction replaces the Singapore-only toggle with SPC VIEW: a compact Singapore comparison using short names, header PIC/grade filters, quick PIC contribution, aligned coloured grades, and BDN/contact/barge/fixture quick views. Dim empty information actions; preserve their empty-state access. Display supplier company names without periods. Preserve the operational fields and the existing permission, private-tab, source and country/port rules below.

Follow the profile rules in `docs/ui-design-system.md` for every supplier, buyer, country and port screen. Supplier headings show the full legal name once and the SPC short name separately. Use KEY INFO, including BDN, and simple SALES/OPERATION contact rows. MPA and Infospectrum addresses/contacts must not be imported. Preserve source provenance internally without showing the retired SPC database as a source.

Only real administrators and SPC traders may add, edit or remove Singapore supplier information. Enforce this in the API and database, and keep VIEW AS read-only. Private tabs belong exclusively to their authenticated owner, including against other administrators; do not leak their titles/content into shared history, search, exports or contribution counts. Active location navigation uses countries and ports only.

## Enquiry integrations and test data

ECO intake uses its own verified email and WhatsApp connections. Keep routing and mailbox access operational records private. Contact ownership follows Users & Access. Preserve existing external callbacks and consumer compatibility; never copy credentials between applications.

Keep FCUNO parser modules pinned in src/vendor/fcuno/version.json. Review newer immutable FCUNO revisions through scripts/check-fcuno-parser.mjs and representative regression tests; do not silently follow a moving branch. AI FIX is optional, evidence-backed and explicitly applied; fail closed when its separate server key or selected model is absent. Parser reports use the authenticated parser service and retain source/correction lineage.

Fictional buyers/enquiries belong only to the privately configured active owner administrator's explicit TEST DATA mode. Default to LIVE, isolate every persistence mechanism by owner/mode/generation or block it in TEST, and keep VIEW AS read-only. No shared publication, outbound dispatch or cross-account test access. Never restore automatic fictional seed data for ordinary users or import legacy prototype state into live. Owner-requested cleanup uses the documented operator procedure; do not add Reset Demo controls.

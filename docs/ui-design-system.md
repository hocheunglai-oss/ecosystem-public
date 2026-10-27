# ECO interface rules

**Flowing Water**, approved by the owner on 26 October 2026, is ECO's canonical design language. `src/design-system.css` provides the shared palette, readable type scale and ordinary controls; new screens use its tokens and existing semantic classes instead of adding another local system. The owner-approved pill-shaped actions replace the previous 5 px action radius and no-pill restriction. The owner’s 27 October 2026 refinement reserves blue buttons exclusively for contribution actions; ordinary actions stay neutral.

## Colour and surfaces

Day mode combines warm cream and mist surfaces with dark teal text. Night mode uses deep charcoal/plum surfaces, warm neutral accents and soft, high-contrast light text, matching the darker sunset colours of the shared entry artwork. `--ui-canvas`, `--ui-surface`, `--ui-raised`, `--ui-field`, `--ui-ink`, `--ui-muted`, `--ui-line`, `--ui-boundary` and `--ui-accent` are the canonical shared palette; existing working-surface and dark-theme aliases resolve to them. Reading panels, forms, tables and menus remain opaque, stationary and clearly bounded. A background animation belongs only to entry screens. Keep error, warning, private-scope, grade and contribution colours meaningful; do not recolour business status merely to match the backdrop.

## Typography

| Purpose | Token | Size | Weight |
| --- | --- | --- | --- |
| Metadata, dates, badges, attribution | `--ui-text-meta` | 11 px | 450 |
| Form labels, tabs, table cells | `--ui-text-label` | 13 px | 600 for labels/tabs |
| Ordinary action labels | `--ui-text-action` | 14 px | 600 |
| Dense table action labels | `--ui-text-action-compact` | 13 px | 600 |
| Body and input values | `--ui-text-body` | 14 px | 450 |
| Section/window headings | `--ui-text-section` | 15 px | 700 |
| Page and dialog titles | `--ui-text-title` | 22 px | 700 |
| Homepage entry actions | Homepage entry scale | 16 px | 600 |

Use DM Sans for working content and Manrope for headings, with the existing system fallbacks. Body line height is 1.5; headings are 1.35. Phone input values are 16 px to prevent iOS focus zoom. Present interface text in ALL CAPS sitewide, including homepage and sign-in. Preserve the original case of emails, URLs, link values and credentials, including revealed passwords; apply an exception to the value rather than its whole form. Displayed hyperlinks use theme-aware blue and their destinations retain case-sensitive paths and query strings. Do not resize the root rem scale. Financial metrics and custom chart annotations retain their purposeful local scale.

## Actions and fields

- Standard actions: `.button.secondary` or `.ui-button` / `.ui-button--secondary`. Use the current theme's field surface, ink and boundary.
- Primary actions: `.button.primary`, `.lime-control` or `.ui-button.ui-button--primary`. Ordinary working actions use neutral or teal treatment. Flowing Water's TRADING and sign-in primary actions use soft white pills with teal ink by day and warm cream with plum ink at night. Blue is reserved exclusively for contribution +1 buttons, including homepage Feedback. Use `--ui-contribution` (#006fee), `--ui-contribution-hover` (#005bcc), `--ui-contribution-border` and white `--ui-contribution-ink`. Ordinary `--ui-primary` and `.ui-button--entry` remain neutral; administrative saves, password changes, parser confirmation, navigation and private edits must not acquire a blue button treatment.
- Editing actions use EDIT to open an editor and SAVE to publish changes. Use `KnowledgeUpdateButton` for credited actions. It supplies the blue contribution treatment and replaces the visible text inside the button with CONTRIBUTION +1 on hover and keyboard focus. Keep its geometry stable and its accessible action name clear; do not show a separate tooltip. Private and uncredited profile edits/saves pass `contribution={false}` for the neutral treatment. Preserve meaningful feedback labels, including FEEDBACK FOR ECOSYSTEM and SUBMIT FEEDBACK. Administrative operations retain their own action labels and do not acquire a contribution hint.
- Each visible profile tab has one EDIT launcher for all its editable content. Do not repeat it on each text box or table. Editing stays inline; separate shared, private and credit stores may retain their own SAVE controls. Manage Tabs shows the credited SAVE treatment only when an editable shared scope has changed; private-only changes stay neutral. Actual contribution counting remains in the existing publication rules, including no-change checks and same-day deduplication.
- Destructive actions: `.button.danger` or `.ui-button.ui-button--danger`. Use the themed rose surface and border; do not use lime to signal deletion.
- Icon actions: `.icon-button` or `.ui-button.ui-button--icon`. Keep a circular visible control within a square target, a 16 px icon and an accessible name.
- Text actions use `--ui-radius-action` (999 px pill ends), a 6 px icon gap, at least 36 px height, 8 px by 14 px padding and 14 px/600 labels. Dense table actions use the 13 px compact action token. Long text can wrap and increase height; do not force it into a clipped fixed height. Homepage entry actions use 16 px labels and their larger entry geometry.
- Desktop fields are at least 40 px high and retain `--ui-radius-control` (8 px). Text areas, reading panels, tables and record rows never inherit pill geometry. On phones and coarse pointers, actions and fields are at least 44 px high. Checkbox inputs remain compact inside labels with a 44 px target.
- Use a visible 2 px theme-aware focus outline. Disabled controls preserve the same geometry and use the shared opacity. Reserve fixed widths for icon actions; text actions size to content unless the surrounding layout has a reason to stretch them.
- Do not add gradients, large shadows or full-width lime blocks to ordinary buttons. Use the shared pill shape consistently. Navigation keeps its existing selected-state indication while sharing the type and target sizes; no selected item gains contribution blue merely for being active.

## Homepage and sign-in

Both entry screens use one refined Flowing Water watercolour created on 27 October 2026: `public/flowing-water-day.png`, closely matching the owner’s original reference with soft horizontal teal and sea-glass washes, a moderately darker upper band and a pale-blue lower quarter. Keep the visual weight light and even; avoid dark upper-left masses, diagonal folds and rugged or turbulent detail. Preserve the approved gentle animation. The owner explicitly requires exactly the same picture and watercolour style in both modes, changing only its colours. Night mode applies a static SVG luminance-to-colour mapping to that same image, using darker charcoal/plum, copper and rose. Never substitute a separate night image or change its shapes, texture, crop or movement. This replaces the enlarged supplied screenshot, whose visible compression texture was rejected. Use the native PNG without adding coarse grain, block patterns, repeated hard stripes or synthetic sharpening. Generation provenance and actual native dimensions are recorded in `docs/watercolour-artwork.md`; never describe the asset as 4K or as a source website’s original video.

Use slight overscan and gentle image drift with a faint broad water sheen. Keep all content stationary. Reduced-motion preference, a hidden tab or an open working window freezes decorative movement. Both modes render the same image element and source, so switching themes changes colours without downloading another image. Keep the colour mapping static; animate only the existing gentle transforms. Both themes retain identical artwork geometry, the original logo and controls.

Preserve the original blended E/F letter geometry and original green stroke. Use the existing logo asset, never a font approximation. On desktop, restore the original left-hand composition: logo at the top-left, search beneath it, then stacked navigation with left-aligned labels and far-right arrows. Expanded menus stay in the stack without covering the following action. The account controls sit at top-right inside the explicitly requested translucent rounded panel. Keep enough contrast through its tinted surface; do not make ordinary working panels transparent. The homepage's three existing entry actions use readable 16 px labels: TRADING is soft white with teal ink by day and warm cream with plum ink at night, while the remaining entries use quiet translucent fills with theme-appropriate high-contrast text. Search, account controls, permission-gated menus and footer actions retain their function. Sign-in keeps its centered form with the same brand, background and soft white primary pill. Keep credential values in their actual case. Do not add greetings, slogans, words, boxes or buttons beyond the requested account-panel boundary. Earlier backgrounds remain recoverable from source history and the previous deployment if the owner prefers them again. Keep the logo’s original green stroke; the contribution-button colour change does not recolour the brand or business-status indicators. Hyperlinks retain accessible blue: this rule reserves blue button treatments, not every use of blue in content.

On phones, stack entry actions and keep account and footer controls reachable without horizontal overflow. Do not shrink desktop text to make the desktop composition fit a phone. Verify 320 px and representative 390 px widths, a desktop and a wide desktop, day/night, signed-out/sign-in and signed-in states, reduced motion, keyboard focus, and Chromium/mobile WebKit. Record any physical device or browser not tested.

## Layout and boundaries

Use shared `--surface`, `--ink`, `--muted`, `--line` and `--panel-boundary` tokens. A light fallback must never be paired with dark-mode text. Use compact reading and editing widths sitewide, including enlarged dialogs. Group related fields, align actions with their content and let dense comparison tables use the width their columns require. Knowledge cards fill the available width, with bounded readable prose inside; tables may use the full card. Resizing the shell preserves the draft and does not force ordinary forms or prose to fill an ultrawide display.

Small standard dialogs open compact and fit their content. Wide editors, full workspaces and document previews keep their enlarged default. Preserve shrink/expand controls and unsaved work in either size. This replaces the earlier all-dialogs-enlarged rule for small forms.

Users & Access is capped at 1480 px and centred. Its 180 px office column sits beside equally weighted directory and editor columns. At intermediate widths the editor follows the directory in the main column; on phones the office selector scrolls horizontally and the directory/editor stack without horizontal page overflow. Actions wrap; emails and long names may break within their container.

## Scope and exceptions

This layer covers working windows, dialogs, form actions, navigation, the sign-in form, and the shared Feedback action. Flowing Water entry composition, resource illustrations, custom charts, drag handles, and file/record rows retain their purposeful layout. Do not turn a whole content row or folder tile into a compact action button. The home interface can opt an ordinary action into this layer with `.ui-button`. Appearance changes must not alter permissions, intake routing, parser or contribution behaviour.

For every visual change, inspect desktop (including a wide display) and narrow/representative phone layouts in both themes, including affected signed-out screens. Use Chromium and mobile WebKit when available; verify focus, disabled controls, text contrast, overlap and overflow. Behaviour and permissions must remain unchanged by styling.

## Profiles

Supplier Profiles uses a centered name-only table with search and pagination aligned to the same width. Show legal names without periods, followed by `(SPC: SHORT NAME)` on the same row where space permits. SPC VIEW switches to the compact Singapore comparison: short names only, payment/claim numbers other than 30 in red, PIC and grade filters in the headers, a quick PIC picker, three aligned coloured grade slots, and BDN/contact/barge/fixture quick views. Empty information buttons are dimmed and remain available to inspect the empty state. Preserve full legal names in source provenance; normalize display punctuation. This owner direction supersedes the earlier Singapore-only toggle and no-filter rule.

Supplier detail headings show the full company name once and the SPC short name separately. Use KEY INFO for operational information, including FO and GO BDN. Contacts use compact role/name/phone rows with SALES or OPERATION labels; omit email and repeated identity panels. Do not add routine Refresh buttons where data reloads automatically.

Long legal names, short names and URLs must wrap within their container at 320 and 390 pixels. Keep directory links, profile actions and dialog controls reachable without page-level horizontal overflow; a preferred single-line layout must not clip content on phones.

Use the same tab strip, manager, focus styles and exact drag insertion indicator for supplier, buyer, country and port profiles. Private tabs appear first (leftmost), with a lock and a visible PRIVATE label. Manage Tabs lists private and shared tabs together, with + PRIVATE TAB creating a draft in the same view; reorder only within each visibility/source group. Profile content editing stays inline beside the selected content, with one text/table editor. Use the main tab strip and its Manage Tabs action; embedded editors do not repeat the tab selector or manager button. Private storage remains separate from shared history, search and contribution counts. Private content must be persisted through the authenticated API, never in shared browser state. Countries and ports are the only active location levels; retain historical Area data only for migration/recovery.

Every registered port belongs to a country, and the port index shows that country explicitly. Retain every country in the country index. When a country has exactly one registered port, both index entries open the same combined profile. Keep the original country and port IDs, shared information, private collections, histories and file references: combining the view must not transfer or overwrite their storage. Both original private collections remain accessible only to their owner and save to their original scope. Adding a second port restores separate country and port views with their existing information intact. Countries with more than one registered port show the port list in a dedicated PORTS tab; port entries do not show a port list. Countries with no ports retain their own profile. This 20 October direction replaces the former three-country exception list.

Country and port headers show public holidays from reviewed official publications with dated source links. Preserve observed dates and jurisdiction-specific coverage; do not invent Gregorian dates for unconfirmed holidays or claim an unavailable calendar is complete.

Sources show retained external evidence once; SPC import provenance stays internal. Reports belong in protected ECO storage with short-lived authenticated downloads. Do not extract addresses or contacts from MPA or Infospectrum. Use MPA for legal-name evidence and dated Infospectrum reports for concise company background.

## On-demand tools and documents

Information Extractor opens from the country/port toolbar when requested. Keep the landing page focused on navigation and recently viewed records. Extraction produces a reviewable draft and never publishes merely by opening or parsing it.

Document preview uses the existing file access boundary. PDF controls need accessible names, page navigation, zoom/fit controls, readable extracted text where available and a download fallback. Keep keyboard focus within an open dialog and restore it on close. Unavailable or unsupported files show an honest state; a failed preview must not lose the original file. Preserve source text and URL case.

The PDF reader processes bytes already available through ECO's existing file access path and loads its pinned renderer from the same site; it does not send private documents to an external viewer. Current local attachments retain their browser storage boundary. The renderer loads only on demand and has a separate optional bundle allowance; keep the core JavaScript ceiling unchanged and include the optional assets in source/build security scans and total build size checks.

Detailed privacy information is an authenticated Settings view. Signed-out screens and public assets must not contain its sensitive operational content. Theme, phone target sizes and keyboard access apply to these views as to the rest of ECO.

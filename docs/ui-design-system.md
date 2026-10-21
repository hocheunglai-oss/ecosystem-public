# ECO interface rules

The compact **Feedback for Ecosystem** action is the visual reference for ordinary actions. `src/design-system.css` is the final shared stylesheet imported by `src/main.tsx`; new screens should use its tokens and existing semantic classes instead of adding another local button or type scale.

## Typography

| Purpose | Token | Size | Weight |
| --- | --- | --- | --- |
| Metadata, dates, badges, attribution | `--ui-text-meta` | 11 px | 450 |
| Actions, form labels, tabs, table cells | `--ui-text-label` | 12 px | 600 for labels/actions |
| Body and input values | `--ui-text-body` | 13 px | 450 |
| Section/window headings | `--ui-text-section` | 14 px | 700 |
| Page and dialog titles | `--ui-text-title` | 20 px | 700 |

Use DM Sans for working content and Manrope for headings, with the existing system fallbacks. Body line height is 1.5; headings are 1.35. Phone input values are 16 px to prevent iOS focus zoom. Preserve CAPS labels and the original case of emails, URLs, link values and credentials. Displayed hyperlinks use theme-aware blue and their destinations retain case-sensitive paths and query strings. Do not resize the root rem scale: it also sizes the harbour artwork. Financial metrics and custom chart annotations retain their purposeful local scale.

## Actions and fields

- Standard actions: `.button.secondary` or `.ui-button` / `.ui-button--secondary`. Use the current theme's field surface, ink and boundary.
- Primary actions: `.button.primary`, `.lime-control` or `.ui-button.ui-button--primary`. Ordinary actions use neutral or blue treatment. Green is reserved for contribution +1 actions; the main screen and sign-in/sign-out actions may retain green. Administrative saves, password changes, parser confirmation and supplier navigation do not earn green merely by being primary actions.
- Editing actions use EDIT to open an editor and SAVE to publish changes. Use `KnowledgeUpdateButton` for credited actions. It supplies the green treatment and replaces the visible text inside the button with CONTRIBUTION +1 on hover and keyboard focus. Keep its geometry stable and its accessible action name clear; do not show a separate tooltip. Private and uncredited profile edits/saves pass `contribution={false}` for the neutral treatment. Preserve meaningful feedback labels, including FEEDBACK FOR ECOSYSTEM and SUBMIT FEEDBACK. Administrative operations retain their own action labels and do not acquire a contribution hint.
- Each visible profile tab has one EDIT launcher for all its editable content. Do not repeat it on each text box or table. Editing stays inline; separate shared, private and credit stores may retain their own SAVE controls. Manage Tabs shows the credited SAVE treatment only when an editable shared scope has changed; private-only changes stay neutral. Actual contribution counting remains in the existing publication rules, including no-change checks and same-day deduplication.
- Destructive actions: `.button.danger` or `.ui-button.ui-button--danger`. Use the themed rose surface and border; do not use lime to signal deletion.
- Icon actions: `.icon-button` or `.ui-button.ui-button--icon`. Keep a square target, a 16 px icon and an accessible name.
- All use a 5 px radius and 6 px icon gap. Desktop actions are at least 30 px high, with 5 px by 10 px padding and 12 px/600 labels. Long text can wrap and increase height; do not force it into a clipped fixed height.
- Desktop fields are at least 36 px high. On phones and coarse pointers, actions and fields are at least 44 px high. Checkbox inputs remain compact inside labels with a 44 px target.
- Use a visible 2 px theme-aware focus outline. Disabled controls preserve the same geometry and use the shared opacity. Reserve fixed widths for icon actions; text actions size to content unless the surrounding layout has a reason to stretch them.
- Do not add gradients, large shadows, pill radii or full-width lime blocks to ordinary buttons. Navigation keeps its existing selected-state indication while sharing the type and target sizes.

## Layout and boundaries

Use shared `--surface`, `--ink`, `--muted`, `--line` and `--panel-boundary` tokens. A light fallback must never be paired with dark-mode text. Use compact reading and editing widths sitewide, including enlarged dialogs. Group related fields, align actions with their content and let dense comparison tables use the width their columns require. Knowledge cards fill the available width, with bounded readable prose inside; tables may use the full card. Resizing the shell preserves the draft and does not force ordinary forms or prose to fill an ultrawide display.

Small standard dialogs open compact and fit their content. Wide editors, full workspaces and document previews keep their enlarged default. Preserve shrink/expand controls and unsaved work in either size. This replaces the earlier all-dialogs-enlarged rule for small forms.

Users & Access is capped at 1480 px and centred. Its 180 px office column sits beside equally weighted directory and editor columns. At intermediate widths the editor follows the directory in the main column; on phones the office selector scrolls horizontally and the directory/editor stack without horizontal page overflow. Actions wrap; emails and long names may break within their container.

## Scope and exceptions

This layer covers working windows, dialogs, form actions, navigation, the sign-in form, and the shared Feedback action. Illustrated home/HUD geometry, resource illustrations, custom charts, drag handles, and file/record rows retain their own layout. Do not turn a whole content row or folder tile into a compact action button. The home interface can opt an ordinary action into this layer with `.ui-button`.

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

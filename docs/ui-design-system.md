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

Use DM Sans for working content and Manrope for headings, with the existing system fallbacks. Body line height is 1.5; headings are 1.35. Phone input values are 16 px to prevent iOS focus zoom. Preserve CAPS labels and the original case of emails and credentials. Do not resize the root rem scale: it also sizes the harbour artwork. Financial metrics and custom chart annotations retain their purposeful local scale.

## Actions and fields

- Standard actions: `.button.secondary` or `.ui-button` / `.ui-button--secondary`. Use the current theme's field surface, ink and boundary.
- Primary actions: `.button.primary`, `.lime-control` or `.ui-button.ui-button--primary`. Use the Feedback lime fill, lighter border and dark ink; one principal action per action group. Knowledge Update actions retain this treatment.
- Destructive actions: `.button.danger` or `.ui-button.ui-button--danger`. Use the themed rose surface and border; do not use lime to signal deletion.
- Icon actions: `.icon-button` or `.ui-button.ui-button--icon`. Keep a square target, a 16 px icon and an accessible name.
- All use a 5 px radius and 6 px icon gap. Desktop actions are at least 30 px high, with 5 px by 10 px padding and 12 px/600 labels. Long text can wrap and increase height; do not force it into a clipped fixed height.
- Desktop fields are at least 36 px high. On phones and coarse pointers, actions and fields are at least 44 px high. Checkbox inputs remain compact inside labels with a 44 px target.
- Use a visible 2 px theme-aware focus outline. Disabled controls preserve the same geometry and use the shared opacity. Reserve fixed widths for icon actions; text actions size to content unless the surrounding layout has a reason to stretch them.
- Do not add gradients, large shadows, pill radii or full-width lime blocks to ordinary buttons. Navigation keeps its existing selected-state indication while sharing the type and target sizes.

## Layout and boundaries

Use shared `--surface`, `--ink`, `--muted`, `--line` and `--panel-boundary` tokens. A light fallback must never be paired with dark-mode text. Layouts should have a deliberate reading width instead of stretching forms across an ultrawide display.

Users & Access is capped at 1480 px and centred. Its 180 px office column sits beside equally weighted directory and editor columns. At intermediate widths the editor follows the directory in the main column; on phones the office selector scrolls horizontally and the directory/editor stack without horizontal page overflow. Actions wrap; emails and long names may break within their container.

## Scope and exceptions

This layer covers working windows, dialogs, form actions, navigation, the sign-in form, and the shared Feedback action. Illustrated home/HUD geometry, resource illustrations, custom charts, drag handles, and file/record rows retain their own layout. Do not turn a whole content row or folder tile into a compact action button. The home interface can opt an ordinary action into this layer with `.ui-button`.

For every visual change, inspect desktop (including a wide display) and narrow/representative phone layouts in both themes, including affected signed-out screens. Use Chromium and mobile WebKit when available; verify focus, disabled controls, text contrast, overlap and overflow. Behaviour and permissions must remain unchanged by styling.

## Profiles

Supplier Profiles uses a centered name-only table with search and pagination aligned to the same width. Show legal names without periods, followed by `(SPC: SHORT NAME)` on the same row where space permits. SPC VIEW switches to the compact Singapore comparison: short names only, payment/claim numbers other than 30 in red, PIC and grade filters in the headers, a quick PIC picker, three aligned coloured grade slots, and BDN/contact/barge/fixture quick views. Empty information buttons are dimmed and remain available to inspect the empty state. Preserve full legal names in source provenance; normalize display punctuation. This owner direction supersedes the earlier Singapore-only toggle and no-filter rule.

Supplier detail headings show the full company name once and the SPC short name separately. Use KEY INFO for operational information, including FO and GO BDN. Contacts use compact role/name/phone rows with SALES or OPERATION labels; omit email and repeated identity panels. Do not add routine Refresh buttons where data reloads automatically.

Use the same tab strip, manager, focus styles and exact drag insertion indicator for supplier, buyer, country and port profiles. Private tabs appear first (leftmost), with a lock and a visible PRIVATE label. Manage Tabs lists private and shared tabs together, with + PRIVATE TAB creating a draft in the same view; reorder only within each visibility/source group. Profile content editing stays inline beside the selected content, with one text/table editor. Use the main tab strip and its Manage Tabs action; embedded editors do not repeat the tab selector or manager button. Private storage remains separate from shared history, search and contribution counts. Private content must be persisted through the authenticated API, never in shared browser state. Countries and ports are the only active location levels; retain historical Area data only for migration/recovery.

Every registered port belongs to a country, and the port index shows that country explicitly. Retain every country in the country index. When a country has exactly one registered port, both index entries open the same combined profile. Keep the original country and port IDs, shared information, private collections, histories and file references: combining the view must not transfer or overwrite their storage. Both original private collections remain accessible only to their owner and save to their original scope. Adding a second port restores separate country and port views with their existing information intact. Countries with more than one registered port show the port list in a dedicated PORTS tab; port entries do not show a port list. Countries with no ports retain their own profile. This 20 October direction replaces the former three-country exception list.

Country and port headers show public holidays from reviewed official publications with dated source links. Preserve observed dates and jurisdiction-specific coverage; do not invent Gregorian dates for unconfirmed holidays or claim an unavailable calendar is complete.

Sources show retained external evidence once; SPC import provenance stays internal. Reports belong in protected ECO storage with short-lived authenticated downloads. Do not extract addresses or contacts from MPA or Infospectrum. Use MPA for legal-name evidence and dated Infospectrum reports for concise company background.

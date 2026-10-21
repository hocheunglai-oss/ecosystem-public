# Sculpted company flag

- Published scene patch: `public/marine/cosulich-hill-sculpture-v1.jpg` (1272 × 1236).
- Tool: built-in `image_gen.imagegen`, edit mode.
- Exact edit target: user screenshot `[original retained in the private asset archive]` (178 × 173).
- Pattern reference: `artifacts/flag-reference/cosulich-flag-original.png`, rendered from the [original company vectors](cosulich-flag-source.md).
- Generated source: `[original retained in the private asset archive]`.
- Delivery conversion: JPEG quality 96; generated original retained.

The user selected the earlier cartoon 3D sculpture's colour, angle, curved silhouette, thick rim and hillside supports, asking to correct only its painted pattern. This edit retains that sculptural treatment and maps the company pattern onto its face. It is a rendered interpretation of the pattern, not an unchanged vector reproduction.

`HilltopSign` maps the crop to world coordinates (1060,148), size178×173. A softly feathered106×107 patch at(1094,175) reveals only the sculpture, footings and nearby hillside. Still and animated water retain the cleaned v5 base; the edit cannot reintroduce the older yellow water columns or change other harbour colours. The previous synthetic SVG front, edge and legs are no longer rendered.

## Visual verification

- Four white band courses, including the top band's taper and reappearance at the raised fly tip.
- Nine alternating white hoist cells, starting and ending on the right column.
- Rounded red bevel, warm face shading, grey supports and contact shadows remain visible in the actual scene.
- Reviewed the integrated sign at native desktop scale and in a close-up; no rectangular backing or hard patch boundary.
- This flag edit did not alter the vessel artwork in use at the time. The former transport vessels and their shadow implementation are now retired; [current barge artwork](cosulich-barge-assets.md) documents the stationary replacement.

## Edit prompt

```text
Use case: precise-object-edit.
IMAGE1 IS THE EXACT EDIT TARGET. This close-up already has the PERFECT cartoon 3D rigid flag sculpture according to the user. Preserve its exact outer silhouette, sculpted curved solid shape, angle/perspective, paint colours, red beveled rim and thickness, sunlight and shadow, grey support legs, hillside, trees and full composition. The ONLY change is the pattern painted INSIDE the red front face.
IMAGE2 is the correct company flag artwork, used ONLY as the decal/pattern reference. Transfer that correct pattern onto the EXISTING curved 3D face in Image1; keep the existing dimensional form instead of replacing it with a flat logo.
Pattern requirements: FOUR distinct white flowing bands crossing the red field. Along the left hoist a two-column alternating red/white checker containing NINE white cells, with top and bottom white cells on the right column. The top band narrows across the curved fold and reappears at the raised fly tip, exactly as the reference. Preserve the exact arrangement of the reference white areas when mapped onto this curved front. Do not add extra bands, do not merge them, and no white ladder/continuous vertical stripe along the hoist. No new symbols, letters or border.
Treat it as repainting the existing sculpted flag, with warm creamy whites shaded naturally by the original 3D surface and original bright red material. Do NOT change the shape to match the reference's flat outline: only the internal graphic pattern transfers. Keep Image1's colour, angle, thickness, lighting, shadow, shape and scenery the same. Output an enlarged, sharp version of the SAME crop and aspect ratio178:173 for integration; no margins, no recrop, no new scene.
```

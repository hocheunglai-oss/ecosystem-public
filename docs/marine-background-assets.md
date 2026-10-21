# Marine background assets

> **Source artwork provenance.** This clean plate belongs to the earlier harbor-film renderer and supplied the later empty-harbor edit. The current homepage uses [Oil terminal background](oil-terminal-assets.md), with the stationary vessel documented in [current barge artwork](cosulich-barge-assets.md).

## Ocean clean plate

- File: `public/marine/ocean-plate.png`
- Dimensions: 1671 × 941 pixels.
- Mode: built-in `image_gen`, local image edit.
- Input: `public/world-v2.png` (1672 × 941 pixels).
- Generated source: `[original retained in the private asset archive]`.
- Purpose: remove underway vessels and baked wakes so the renderer can move independent vessels through clear water.
- Inspection: all five specified underway vessels and their trailing wakes are removed. The docked cargo ship, small moored boats, islands, harbor geometry, and framing are retained. The generative edit is visually close, but not pixel-identical: fine water, building, and ship details were regenerated and the output is one pixel narrower. Animated placement should use normalized coordinates.

### Final prompt

```text
Use case: precise-object-edit.
Asset type: clean background plate for seamless maritime animation.
Input image is the edit target. Preserve this image's exact framing, coastlines, entire islands, architecture, docks, mountains, sky, lighting, ocean colors, and semi-realistic 3D rendering aesthetic. Make only localized object removals: remove ALL five underway vessels from open water and every part of their wakes, replacing those regions with matching unbroken natural blue water. Specifically: (1) tiny white yacht at far left near x75 y166; (2) cargo ship at x212 y215 and its wake; (3) central cargo ship at x665 y440 and its entire diagonal wake extending to lower right near x970 y570; (4) sailboat at x150 y515 and its long white wake leading left; (5) small cargo ship in the upper right inlet near x1340 y207 and wake. Coordinates refer to 1672 by 941 original.
Keep the large docked cargo vessel at x1270 y495, all docks and piers, and the tiny moored boats at the bottom-left marina exactly in place. Keep natural water ripples but leave no straight vessel trails where removed. No replacement ships, no new objects. No text or UI. Do not shift, crop, reframe or redesign any land or port. Output the complete image at the same wide aspect ratio.
```

# Oil terminal background

Current background: `public/marine/destination-oil-terminal-clean-v7.jpg`, with `destination-oil-terminal-night-v2.jpg` for dark mode; see [LNG reflection cleanup](cosulich-lng-barge-assets.md). The user-selected [3D flag sculpture](flag-3d-pattern-assets.md) uses the [original company flag](cosulich-flag-source.md) as its pattern reference. The earlier billboard, direct-vector and COSULICH-letter variants below remain historical provenance, not the current sign composition.

Created on 30 September 2026 with the built-in `image_gen` tool, editing the original `public/marine/destination-harbour.jpg`. The original image and approved oil-terminal version `public/marine/destination-oil-terminal-v1.jpg` remain in the repository. Oil-terminal PNG: `[original retained in the private asset archive]`. The selected images were converted to JPEG at quality 90 using macOS `sips` for delivery, with no cropping or compositing.

The waterfront now contains marine oil loading arms, pipework, pump buildings and small onshore tanks integrated into the flat terminal grounds. These are part of the background; they do not unlock, count resources or change with performance. The stationary Cosulich barge and ambient water remain separate decorative layers.

## Oil-terminal prompt

```text
Use case: precise-object-edit. Asset type: full-width background plate for an existing interactive maritime island game.
Input image: the supplied Mediterranean island harbour is the EDIT TARGET.
Primary request: change the existing container-style waterfront into a believable elegant marine fuel/oil terminal. Remove ALL tall green container gantry cranes and container-handling equipment on the main island's two existing working piers. Replace them with small articulated marine oil loading arms, low pipe manifolds, neatly routed steel fuel pipelines along the EXISTING pier decks, a few low white industrial pump/control buildings, and a compact group of small pearl-white cylindrical storage tanks on the existing flat terminal ground, naturally grounded and scaled to nearby buildings. Industrial details should be modest and believable, visually integrated into the island.
Keep EXACTLY the same camera, 16:9 landscape framing, island positions, existing pier outlines, coastline, sea surface, foreground small island, mountains, sky, town architecture, lighthouse, late-afternoon light and blue/turquoise sea. Change ONLY container terminal equipment and the small waterfront industrial structures on the main island; retain the village/town behind it. Do not extend land or piers into water. Do not add new ships or boats; moving tankers will be drawn separately by code. Preserve broad empty water in the middle/lower half for sailing.
Style: same polished cinematic miniature architectural realism as the input. Retain all image detail. Tank roofs show realistic aerial perspective; tanks must have solid grounded foundations, no floating cutouts. Keep output close to the original 1671 by 941 framing and composition.
Avoid: text, labels, flags, UI, borders, logos, giant refinery towers, flares, smoke, oversized tanks, new islands, extra jetties, container cranes, floating overlays.
```

## COSULICH hillside sign

The approved oil-terminal PNG was edited with the built-in `image_gen` tool to add physical white **COSULICH** letters on the main hill, around the requested 70.5% horizontal / 22.7% vertical location. Generated result: `[original retained in the private asset archive]`. The sign uses grounded supports, aerial perspective and matching shadows. Both `MarineWorld` and `OceanSurface` reference the same final JPEG.

### Final sign-edit prompt

```text
Use case: precise-object-edit. Asset type: background plate for an existing maritime island game. The supplied image is the EDIT TARGET. Make ONE localized addition: install freestanding white hillside letters spelling exactly COSULICH (C O S U L I C H), in the style of the Hollywood hillside sign, on the main island's grassy/rocky hill around center x70.5% and y22.7% of the full image, approximately x1178,y214 in this 1671x941 composition. The complete word should be roughly 125–145 image pixels wide and letters about18–22 pixels high, readable but appropriately distant and secondary to the island. Use solid white bold upright sans-serif letters physically standing on small supports anchored into the hillside, with correct aerial perspective, warm upper-right sun illumination and subtle contact/cast shadows. Follow the hillside terrain naturally, without a billboard, banner or surrounding plaque. Keep the existing lighthouse visible and unchanged. Preserve absolutely EVERYTHING else: camera, exact framing/aspect ratio, entire oil terminal and storage tanks, loading arms/pipelines, all existing buildings and islands, mountains, sky, coastline, all pier/breakwater outlines, sea texture/colors/light, empty open water, and all original detail. No rescaling, recropping, new structures elsewhere, ships, birds, UI, borders or watermarks. Change ONLY the tiny specified hillside sign footprint and its physically necessary supports/shadows. This approved harbor artwork must otherwise remain unchanged.
```

## Subtle wildlife layer

Three small distant gull silhouettes glide and occasionally flap above open water. They are code-native SVG paths, not baked into the background. CSS animates only their transforms; there is no extra canvas, dependency or JavaScript animation loop. The layer is decorative and does not receive pointer events. Motion pauses while the document is hidden or application motion is disabled; reduced-motion uses still silhouettes. Visibility and media-query listeners are removed on unmount.

An isolated headless browser verified changing bird transforms during normal motion, paused animation when the page is hidden, and no CSS animation under reduced-motion. The final image and water shader use the same asset URL. Desktop/mobile dispatch checks confirmed unchanged harbor bounds, tanker start bounds and scroll position while the normal interface remains visible; screenshots are in `artifacts/inplace-{desktop,mobile}-{loading,sailing}.png`.

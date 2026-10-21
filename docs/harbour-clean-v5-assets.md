# Integrated hillside sign and clean harbour water

This records an earlier billboard composition. The later [3D flag sculpture](flag-3d-pattern-assets.md) replaced that sign, and the [LNG reflection cleanup](cosulich-lng-barge-assets.md) produced the current v7 daylight plate. Preserve the prompts below as provenance, not current placement instructions.

- Earlier plate: `public/marine/destination-oil-terminal-clean-v5.jpg` (1670 × 942).
- Generated using the built-in `image_gen.imagegen` tool in edit mode; saved as JPEG quality 94. Existing plates remain available.
- Source: `public/marine/destination-oil-terminal-v1.jpg`.
- First edit: `[original retained in the private asset archive]`.
- Final edit: `[original retained in the private asset archive]`.

## Visual corrections

The long yellow columns below the oil terminal were present in the still source, including when the animated water and all tanker sprites were hidden. The localized edit replaces them with blue water while retaining the turquoise shallows and natural sunset reflection on the far right. Both the still fallback and animated-water renderer use the same corrected plate.

The smaller blank enamel billboard, structural feet, material shading and hillside shadow are integrated into the artwork. `HilltopSign` places the unchanged official vector logo within the face using uniform scaling. Multiply blending makes the logo's white regions share the physical surface illumination; no vector paths are redrawn or reshaped. The final generated board is approximately 40 × 33 source pixels and the printed logo is 34 × 27.861327, substantially smaller than the previous 112px-wide freestanding mark.

## First edit prompt

```text
Use case: precise-object-edit. Edit the supplied approved oil-terminal island background with ONLY TWO small localized corrections. Preserve the exact full composition, original aspect ratio, all coastlines and oil loading piers, buildings, mountains, lighting, colour, islands, tanks, sky and original texture everywhere else.
1) CLEAN WATER REFLECTIONS: In the water just below the MAIN RIGHT ISLAND'S oil loading quay and nearby right lighthouse jetty, remove the unnatural long vertical YELLOW/GOLD shadow columns extending downward into the blue sea (rough region x850-1400,y400-660 on the 1670x942 source). Replace ONLY these isolated gold streaks with matching natural BLUE water texture and modest cool pier contact reflection. Keep the natural turquoise shallow water and far-right sunset sparkling reflection intact. Do not darken or recolour the whole ocean. No brown/yellow pillars in the central sea.
2) SMALL PHYSICAL HILLSIDE SIGN MOUNT: On the hill of the main island, centered approximately x1160,y230 (69.5% across,24.4% down), install a VERY SMALL solid architectural billboard face, about64 source pixels wide by53 high (roughly x1128-1192,y201-254). This will receive the company's original vector logo later. The face must be BLANK matte warm OFF-WHITE enamel, without text or logos. Keep the flat front almost directly facing the camera, level horizontal/vertical edges, with very subtle visible thickness at the top/right, realistic short dark bronze structural feet anchored into the rocky slope, a small contact/cast shadow following the hillside, slight environmental light/weathering so it is physically integrated in this Mediterranean diorama. It must look built into the scenery, not a floating screen or overlay. Make it suitably distant, not huge, retain the lighthouse above and all trees/rocks around it. No flagpole, no fabric, no flag, no lettering, no company logo of any kind.
Preserve everything outside those tiny sign/reflection footprints, especially original detailed shoreline geometry and the approved bright colours. No ships, no new buildings, no UI. Output same full composition and aspect ratio.
```

## Follow-up sign proportions prompt

```text
Use case: precise-object-edit. Edit target is the supplied clean ocean oil-terminal scene. Change ONLY the existing tiny blank hillside billboard near the main island lighthouse. Keep its existing center at approximately x1125,y211 on this1670x942 image, its naturally integrated mounting, correct hillside cast shadow and material style. Enlarge that blank enamel rectangular sign face to exactly about64 pixels WIDE and53 pixels HIGH (face bounding box approximately x1093-1157,y185-238). It needs to be a near-square 1.21:1 landscape panel, NOT the current wide shallow rectangle. Physical rigid metal face, not fabric or flying flag. Nearly front-facing flat face, level edges, very subtle right/top thickness; warm off-white material subtly shaded to match the afternoon light. Short feet anchored to the rocky hill and realistic contact shadow; the structure should be integrated naturally and distant. Leave the face completely blank: NO logo, text or symbol. A company logo will be inserted with exact original vector paths later, so do not draw any mark. Preserve ALL other scene pixels/design including the freshly cleaned blue water, original piers/terminal/coastline/rocks/buildings/sky, original bright colors, framing and aspect ratio. Do not add ships. Only resize the existing small sign and adapt its physically necessary supports and tiny local shadow.
```

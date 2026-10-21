# Stationary Cosulich barge

Asset: `public/marine/cosulich-barge-v2.png`.

Created 13 October 2026 with the built-in image generation tool. The original generated PNG and alpha are preserved. This is a reference-based illustration, not a technical drawing. The conventional bunker vessel is rendered in the harbour coordinate system on desktop and mobile; it has no animation, click target, rewards or transport state. A separate LNG barge is documented in `cosulich-lng-barge-assets.md`.

Official vessel reference: [Margherita Cosulich certificate announcement](https://cosulich.com/news/margherita-cosulich-achieves-metcore-international-s-certificate-of-conformity), using the page's green-hull photograph. Style reference: existing `destination-oil-terminal-clean-v5.jpg`. The hull colour, aft white bridge/red fascia, low working deck, hose crane follow the vessel reference. The final hull branding uses large FRATELLI COSULICH lettering, following the user’s Paolina Cosulich photo, and omits any individual vessel name.

## Generation prompt

Use case: stylized-concept.
Asset type: transparent cutout illustration of a stationary Fratelli Cosulich bunker barge for a professional harbour web interface.
Input image 1 is the PRIMARY VESSEL REFERENCE: the official photograph of MARGHERITA COSULICH. Input image 2 is STYLE AND CAMERA REFERENCE ONLY: the existing illustrated harbour, which must not be reproduced in the output.
Create ONE neat, detailed, physically plausible miniature 3D illustration of MARGHERITA COSULICH, preserving the reference vessel's actual identifying structure and colours: long green hull, narrow red antifouling strip at loaded waterline, white aft accommodation and bridge with red roof fascia, aft tall mast, orange/red hose handling crane, long low open working deck with organised realistic pipe runs, raised forecastle, slim foremast, black round rubber fenders along the hull. White vessel name “MARGHERITA COSULICH” accurately on forward green hull. Do not invent containers, giant storage cylinders, LNG tanks, cargo piles, extra bridges, ornamental equipment or new branding.
Match the harbour's polished restrained illustration and warm late-afternoon light from upper right. Camera is elevated three-quarter isometric looking down about 25 degrees; stern/accommodation on upper left, bow on lower right, long hull axis descends about 17 degrees left to right. Length to beam physical proportion around 6:1; the projected hull is slender rather than stubby. Full vessel framed with small transparent margin and not cut off.
At-rest loaded waterline, so do NOT expose underwater bulbous bow, propeller or tall red lower hull. Ship only, NO sea patch, NO wake, NO clouds, NO harbour, NO ground, NO cast shadow background. Clean true transparent alpha around all edges and railings. Wide landscape composition. Vessel sharp and readable at small web size; no poster captions or extra text. This is an illustration derived from references, not a technical drawing.

## Final branding edit

Use case: precise-object-edit.
Edit target: image 1, the transparent illustrated green bunker barge. Image 2 is a hull-branding reference only from the user.
Change only the vessel lettering. REMOVE the small text “MARGHERITA COSULICH” completely from the bow. Paint the exact words “FRATELLI COSULICH” in LARGE WHITE CAPITAL LETTERS across the long broad green SIDE OF THE HULL, like the prominent company lettering in reference image 2. Make this bold white company name occupy most of the available midship hull length and height, correctly following the hull perspective and sloping baseline. No vessel-specific name anywhere. No “LNG”, no “PAOLINA”, no other new words.
Keep the illustrated ship's hull shape, position, entire silhouette, green paint, red narrow waterline, white aft bridge, pipework, crane, masts, fenders, lighting, warm miniature-render style, camera angle, size, cropping and TRUE TRANSPARENCY exactly as in image 1. Do not change the vessel to the photographed LNG carrier. Do not add background, water, wake, shadow patch, reflections, labels or captions. This is only a legible hull-branding edit.

The user supplied `paolina_cosulich_big.webp` as the branding reference. Built-in image generation edited the illustration; no LNG claim or individual ship name is shown on the final conventional bunker barge.

## Verification

Inspected original transparent asset and the composed daylight/dark harbour. The vessel is stationary, passive and shares the same scene projection as the quay. Browser checks cover all demo roles, desktop/mobile, both themes, Gold/Hats history and office summaries. Generated artwork is illustrative; unphotographed deck details are reconstructed.

## Waterline and night treatment — 13 October 2026

The barge has a soft cast shadow and a closer contact shadow. After user feedback that the initial SVG ripple strokes looked artificial, they were removed entirely. The existing ocean renderer now uses subtle, irregular texture refraction and fragmented hull reflections around both moored vessels. The vessel images never move. Night mode uses a deeper blue shadow, dimmer water reflections and a subdued vessel treatment. The source conventional-barge PNG remains unchanged.

Waterline motion follows the existing ocean-motion switch, pauses in hidden tabs, and respects reduced-motion preferences. Mobile retains a static harbour with the same shadow and theme treatment. `tests/barge-water.e2e.mjs` compares rendered water near both hulls over time and verifies both themes, stationary hulls during water motion, reduced motion, hidden tabs and static mobile. Gold and Hats are unchanged; a rolling contribution-activity view remains a proposal.

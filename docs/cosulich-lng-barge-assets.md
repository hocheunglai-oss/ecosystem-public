# Cosulich LNG barge — 13 October 2026

Asset: `public/marine/cosulich-lng-barge-v1.png` (1774 × 887, original transparent alpha preserved).

Created with the built-in image-generation tool. User's `paolina_cosulich_big.webp` is the vessel reference; `destination-oil-terminal-clean-v5.jpg` supplies style and perspective. The LNG barge is stationary at the smaller berth to the left of the oil terminal, as requested. Large FRATELLI COSULICH LNG lettering; no individual vessel name. It supplements the conventional bunker barge, with matching shadows and night treatment. No transport, purchase or reward behavior is added.

The illustration follows the visible green hull, white accommodation, two red cranes and cryogenic deck equipment in the supplied photograph. Unphotographed details are reconstructed; it is not a technical drawing.

## Final generation prompt

Use case: stylized-concept.
Asset type: transparent cutout vessel illustration for an existing professional harbour interface.
Input image 1 is PRIMARY VESSEL REFERENCE: user photograph of PAOLINA COSULICH LNG bunker vessel. Input image 2 is STYLE AND CAMERA REFERENCE ONLY: the illustrated harbour; do not reproduce this background.
Create ONE neat and accurate reference-based illustration of the LNG bunkering vessel in image 1, matching the harbour's restrained polished miniature 3D rendering. Preserve its green elongated hull, narrow red antifouling band at the waterline, white aft bridge and accommodation, two distinctive red hose-handling cranes, silver/green organised cryogenic piping, raised green forecastle and covered LNG cargo deck arrangement from the reference. Do not substitute an ordinary oil barge, invent huge spherical LNG domes, stacks of shipping containers or extra funnels. Keep the deck physical and plausible.
Company hull lettering exactly "FRATELLI COSULICH LNG" in large bold white capitals along the long visible hull side. Omit small individual vessel names; no PAOLINA and no MARGHERITA. The company name is the only required text.
Camera: elevated three-quarter isometric view, looking down approximately 25 degrees, aligned to the diagonal front face of the small pier in the left middle of image 2. Stern and white bridge at upper left, bow at lower right. Long hull axis slopes down about 17 degrees left to right. Slender realistic proportions about 6:1, full vessel inside frame, small transparent margins. Wide 2:1 image.
Lighting: warm late-afternoon sunlight from upper right, light crisp enough to read at 190px web display width. Green paint, white accommodation, red cranes; realistic metal and glass.
SHIP ONLY on genuine transparent background. No water patch, wake, shadow patch, reflection, quay, sky, scenery, captions, people or UI. Do not cut off any mast or bow. No exposed underwater bulbous bow or propeller; at-rest loaded waterline.

## Integration and verification

The LNG image occupies harbour coordinates x=570, y=328, width=200, height=100, retaining its original approved size. Its position leaves the small pier visible behind the ship. A dark contact shadow follows the measured hull waterline, with a softer shadow immediately beneath it; a short, distorted reflection fades into the water. Two fine mooring lines connect the stationary vessel to the pier. The conventional bunker barge is unchanged.

Both vessels share the day/night treatment and stay stationary. Near-hull water effects are part of the existing ocean shader, with no second canvas or per-frame React updates. The LNG shader waterline runs from (578,378) to (763,426). Old SVG ripple strokes and keyframes were removed. The SVG reflection is static and uses the existing vessel image by reference. Mobile keeps its fixed company-flag crop; the LNG berth can be outside that crop.

Verified shader compilation/linking in WebGL 1; production build; moving water pixels near each hull with unchanged vessel positions; reduced-motion/hidden-tab pause; desktop/mobile theme transitions; role and contribution-history checks. The subsequent mooring adjustment was visually checked in isolated headless day/night views.

## Reflection cleanup and coordinated loading

The yellow water streak beneath the LNG berth was baked into the background. The built-in image-generation tool edited the original day and night plates, preserving their respective dimensions. The new project assets are `public/marine/destination-oil-terminal-clean-v7.jpg` (1670 × 942) and `public/marine/destination-oil-terminal-night-v2.jpg` (1671 × 941), converted from the generated PNGs to JPEG at quality 92 for delivery. Original versions remain available for comparison.

The final edit prompt for each original plate was: “Precise local edit of this existing day/night harbour background asset. Preserve the entire original composition, viewpoint, colours, texture, objects, shoreline, buildings, cranes, islands, lighting, sky and framing exactly. Keep the original landscape proportions with all coordinates aligned. Only remove the warm yellow/gold vertical reflected streaks on the water immediately beneath the small isolated LNG jetty near the horizontal centre-left, approximately x590–765, y375–475. Replace those streaks with naturally matching uninterrupted deep cobalt blue water for day or dark navy blue water for night, matching adjacent ripples. Leave the jetty, lights, cranes, structures and larger terminal untouched. Do not add ships, text, logos, shadows or other objects.”

Initial display and theme switches wait for the selected harbour, company flag and both vessel images to decode. Desktop and mobile reveal the complete scene together, preventing vessel artwork from appearing after the harbour. A failed load retains the previous complete scene or initial backdrop; business controls remain available.

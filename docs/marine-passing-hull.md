# Passing container vessel: oxide-red hull

> **Historical film asset.** This container vessel belongs to the offline film renderer and is not displayed by the current homepage. See [current barge artwork](cosulich-barge-assets.md) for the stationary Cosulich illustration; game tankers and departure controls are retired.

- Edited with the built-in image generation tool on 25 September 2026.
- Edit target: `public/marine/container-ship.png`.
- Final asset: `public/marine/passing-container-red.png`.
- Dimensions: 1563 × 1006 pixels, RGBA PNG, 884,729 fully transparent pixels. Interior alpha is predominantly 253/255, consistent with the source asset's soft alpha treatment.
- Original generated output: `[original retained in the private asset archive]`.
- Purpose: distinguish the travelling container vessel from the navy-hulled receiving vessel in the homepage harbour loop.
- The generated alpha channel is preserved. No recolouring or repainting was performed after generation.

## Prompt

Use case: precise-object-edit.
Asset type: transparent container-ship cutout for a moving maritime website scene.
Input image 1 is the edit target. Recolour ONLY the container ship's main navy-blue hull above the waterline to a tasteful muted oxide/burgundy red, approximately #A84435 under the existing warm natural sunlight. Make the thin lower waterline band a much darker charcoal-red.
Preserve the exact same ship silhouette, proportions, bow pointing lower-right, stern at upper-left, aerial three-quarter camera angle, all hull details, white stern bridge, cranes, railings, masts, green and navy shipping containers and their exact arrangement. The ship itself must remain geometrically identical apart from its hull colour.
The output must contain exactly ONE complete ship isolated on a genuinely transparent alpha background. Preserve crisp detailed hull edges, with no reflection, water, wake, ground, shadow outside the hull, other vessel fragment, background colour, checkerboard graphic, border or text. Existing hidden background pixels in the input are not part of the ship: discard them. Fit the whole ship within the canvas with only a small transparent margin. Do not crop any part of the ship.

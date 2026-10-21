# Marine vessel sprites

> **Historical film assets.** These vessels belong to the retained offline harbour-film renderer and are not the current homepage vessels. The current desktop/mobile harbour shows a stationary Fratelli Cosulich bunker-barge illustration documented in [current barge artwork](cosulich-barge-assets.md). GP/MR/Aframax gameplay and its sprites are retired.

Generated using the built-in image generation tool, with `public/world-v2.png` as the aesthetic and camera reference. The original atlas has genuine RGBA transparency. Individual assets are extracted from its alpha silhouettes; the vessel artwork is unchanged. The vessels have no baked-in water or wakes, so the animation renderer can place them on its own water surface.

## Assets

- `public/marine/container-ship.png` — large laden container vessel, bow toward lower right, approximately +25° from horizontal.
- `public/marine/bunker-barge.png` — bunker tanker with red pipework and side fenders, bow toward lower right, approximately +25°.
- `public/marine/coastal-ship.png` — coastal freighter, bow toward upper right, approximately −20°.
- `public/marine/pilot-launch.png` — small working launch, bow toward upper right, approximately −20°.

The renderer should scale each asset by physical vessel size rather than by the atlas quadrant size. Sprite bounds include superstructures and masts, so the lower hull center is a more natural waterline anchor than the geometric image center.

## Final generation prompt

```
Use case: stylized-concept
Asset type: transparent raster vessel sprite atlas for a polished maritime web animation.
Input image: aesthetic and camera-perspective reference ONLY, not a canvas to preserve. Create a NEW isolated vessel atlas.
Primary request: Four exceptionally realistic miniature ships in a spacious 2 by 2 atlas on a genuinely TRANSPARENT alpha background. Do not include ocean, land, ripples, foam, wakes, water-plane shadows, cast background shadows, labels or guides. Each ship must be complete, fully separate and surrounded by transparent padding, with no overlap between quadrants.
Style: refined photorealistic 3D architectural visualization matching the supplied sunlit Mediterranean maritime scene, detailed credible real commercial vessels rather than icons or toys.
Camera: fixed high three-quarter aerial view, looking down about 40 degrees, see decks and hull sides. Warm late afternoon sun from upper right, cooler navy shadows, consistent across all ships.
TOP LEFT: a large laden ocean-going container ship, navy blue hull, restrained red waterline, fine white stern superstructure, stacks of green and dark blue containers, maritime deck details. Stern is at upper left and pointed bow at lower right. Long axis slopes DOWN RIGHT at 24 degrees. Entire ship visible. This is the largest asset.
TOP RIGHT: a medium bunker delivery barge / bunker tanker, broad low dark navy hull, subtle red waterline, clearly visible red deck pipework, grey tanks and white compact stern wheelhouse. Stern upper left, pointed bow lower right, same 24 degree DOWN RIGHT axis as container ship. Distinct practical bunker vessel, about 40 percent the container ship's real length, but show generously sized in its quadrant for detail. No hose extending outside ship.
BOTTOM LEFT: a smaller cargo/coastal freighter with navy hull, grey hatch covers and white aft superstructure. Stern lower left, pointed bow upper right. Long axis slopes UP RIGHT at 24 degrees. Make it recognizably a cargo ship, not a yacht.
BOTTOM RIGHT: small working pilot launch with deep navy hull, crisp white cabin and tiny orange safety details. Stern lower left, pointed bow upper right, same UP RIGHT 24 degree axis.
Composition: four separate vessels centered in their own quadrants, clean silhouette edges with authentic alpha transparency. No text, logos, checkerboard baked into the pixels, circles, graphic shapes, borders or plates. TRANSPARENT BACKGROUND IS ESSENTIAL.
```

# Light and dark harbour modes

- Night scene: `public/marine/destination-oil-terminal-night-v1.jpg`, 1671 × 941, JPEG quality 94.
- Tool: built-in `image_gen.imagegen`, edit mode (`lighting-weather`).
- Edit target: `artifacts/approved-light-scene-source.png`, an isolated screenshot of the approved light harbour and flag without UI, vessels, water animation or birds.
- Generated original: `[original retained in the private asset archive]` (retained).

The night plate preserves the scene layout and adds warm house windows, road lights, terminal work lights and spotlights on the existing 3D flag. The approved light-mode base and localized flag patch remain unchanged. Dark mode does not render seagulls. A native SVG shading gradient now lowers the flag's night exposure, with darker upper areas and a lighter lower edge where the existing warm spotlights strike; the painted company pattern and sculpture geometry are unchanged.

`NightFlagLighting` also reuses two small foliage/ground fragments from the approved `cosulich-hill-sculpture-v1.jpg`, at their original coordinates, to match the daytime concealment of the support footings. Soft organic masks and an SVG night-tone filter blend these fragments into the existing spotlit hillside; separate shading darkens the exposed support poles. The flag face, shape and surrounding spotlight beams are untouched. Both themes preload the existing flag image before committing, so the localized base overlay appears together with the night plate on desktop and mobile; no new bitmap was generated.

Three code-rendered lighthouse beams rotate independently above the existing lanterns. Both the beams and ocean respect reduced motion and pause while the document is hidden. The water renderer samples the corresponding day/night plate, with softer cool glints at night. All overlays use the same 1671 × 941 world coordinates.

The [stationary Cosulich barge](cosulich-barge-assets.md) uses the same illustration and harbour coordinates in both themes. Night styling lowers its ambient exposure. It has no voyage animation, separate transport lamps or dispatch controls.

The mode control is available in the homepage footer. `ecosystem.theme.v1` persists the selected theme separately from business records, Gold, Hats and session. Default is Light mode. Dark workspace styles use navy panels, pale text, subdued borders and lime actions. Both target artwork layers decode before a requested mode is committed; the water texture initializes synchronously in that same layout commit. A single native View Transition crossfades the complete scene for 420ms. Unsupported/reduced-motion browsers switch atomically after readiness. Rapid reversals use a latest-request guard, and failed loads keep the current mode and data.

## Prompt

```text
Use case: lighting-weather.
Asset type: dark-mode night background for the same interactive 3D island harbour game.
Input Image1 is the EXACT approved daytime harbour to edit. Change ONLY time of day and lighting, preserving the precise same composition, framing, geometry, camera, shoreline, every island/building/road/pier/storage tank/lighthouse, and especially the solid red-and-white 3D company flag sculpture's exact silhouette and internal painted pattern. Output SAME 1671:941 wide landscape ratio, no recrop.
Turn the scene into a beautiful readable deep-blue evening/night harbour. Dark indigo/navy sky and water, cool moonlit details, still plenty of legible dimensional form. Warm small glowing windows in houses and offices, elegant warm road and pathway lights following the EXISTING roads, modest industrial task lighting on the existing oil terminal piers and tanks. Two small ground-mounted warm-white spotlights illuminate the EXISTING red/white hill flag sculpture and its existing grey supports, with gentle natural falloff and readable correct pattern. Keep flag the exact same size and location (around x1147,y220); no new flag or logo.
The three existing lighthouses are at about x530,y289 (left entrance), x1115,y137 (hilltop), x1496,y521 (right breakwater): their lanterns may glow softly but NO painted light-beam cones or long static beams, because the game will animate these beams separately. Keep these lighthouse locations and structures fixed.
No birds or seagulls. No ships or tankers (these are interactive separate sprites). No UI, controls, words, captions or added symbols. Avoid large circles or halos, glaring neon lighting, broad yellow shadows in sea, fireworks, or adding extra buildings. Water reflections should be short, subtle and naturally located below the existing actual lights. Preserve the approved stylized/cartoon 3D render quality and exact scene identity. Do not merely darken the original: make plausible illuminated windows and roads, with dark clean water and cohesive night lighting.
```

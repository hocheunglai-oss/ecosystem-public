# Flowing Water scene and reference provenance

The owner’s 28 October 2026, 11:19 Hong Kong direction supersedes the earlier hand-painted texture and image deformation. The requested result keeps the original reference’s smooth teal, sea-green and powder-blue bands while showing an evolving, calm fictional water surface. The camera, broad colour bands and foreground stay fixed. This document describes the current candidate and acceptance requirements; visual review and release verification are pending, and it does not claim deployment.

## Current scene and still fallback

`src/flowingWaterRenderer.ts` renders the surface procedurally. Ten analytic shallow-wave slopes change surface normals and broad reflected light. The near-horizontal colour fields remain anchored; they are not moved with the waves. This is a stylized fictional scene, not footage of real water or a full fluid-dynamics model. The renderer does not sample, pan, zoom, resize or distort an image’s texture coordinates to create motion.

- Still fallback: `public/flowing-water-smooth.png`.
- Native size: 2400 × 1132 pixels; 252,113 bytes.
- SHA-256: `c9c666850ac18602d5f420f085f66c3d20d54fb707b94adb77b0cf707c36d577`.
- Provenance: a code-rendered phase-zero screenshot from `src/flowingWaterRenderer.ts`. It is not AI-painted, not the original reference site’s image/video, and not native 4K.
- Role: the still displayed for reduced motion, unavailable/lost graphics and renderer initialization. It does not supply the animated surface’s colours through texture sampling.

Keep the fallback’s scene aspect and centered cover framing consistent with the renderer. A viewport resize may change the cover crop; elapsed animation must not move the camera, crop or foreground. Use `node scripts/render-flowing-water-poster.mjs` to regenerate the fallback from phase zero when the procedural scene changes, and update its dimensions, byte count and digest here. The generator requires Node 24 and the installed isolated Playwright Chromium browser. Retain the original supplied reference and earlier `flowing-water-reference.jpeg` and `flowing-water-day.png` only as archival references; the rejected `flowing-water-calm.png` remains in source history and is removed from the current public assets; do not restore them as the animation source without a later owner request.

## Motion, themes and branding

Integer temporal harmonics give the surface a seamless 48-second period with matching motion at the boundary. Keep reflections broad and gentle, without sharp glints, foam, sudden reversals or resets. Rendering is capped at 30 draws/second, device-pixel ratio 2 and about three million pixels. The live scene is procedural graphics, not an encoded video. Label any supplied video as a recording of the scene rather than the animation source.

Day and night share the same surface, framing and active clock. Night changes colour only, retaining distinct deep-plum, muted-copper and dusky-blue families. Apply the same static mapping to the still fallback. Do not add a separate night scene, spatial mask or image download. Hidden tabs and open workspaces freeze the active phase and stop rendering; returning resumes at that phase. Reduced motion uses the still image. Unsupported or lost graphics retains the fallback and usable foreground controls.

Keep the original blended E/F letter geometry and backing logo asset unchanged, including its continuous green lower bar and white letters. The owner’s later 28 October correction supersedes the striped version because it weakened recognition of the E. The matching code-SVG favicon uses a white F/E structure with a solid energy-green lower bar on a dark-teal rounded square. FRATELLI COSULICH MARINE ENERGY remains solid white in both modes, 22 px and weight 600 within the existing lockup, with no stroke, outline, shadow or new backing box. Layout, wording, CAPS and contribution-only blue are unchanged.

## Verification requirements

Verify desktop and 320/390 px phones in day/night, signed-in/out, Chromium and mobile WebKit. Inspect smooth anchored colour bands, visible but calm reflected-light movement, white lettering, green-stroke alignment, three distinct night families, contrast, clipping and overflow. Confirm that both themes share the same geometry and phase and that the still fallback matches the renderer’s phase-zero composition.

Use actual compositor captures to establish visible motion and frozen hidden/reduced/fallback states. Verify the exact 48-second recurrence and continuous boundary movement separately using synchronous GPU readback tied to actual draws; label that evidence as raw framebuffer verification, not composed-screen proof. Test pause/resume and lost-context fallback without weakening functional or privacy assertions. Keep native Safari and physical-device limitations explicit. Current source checks, visual review, quality jobs, staged verification and the exact deployed identity require fresh evidence; results from the superseded painted candidate do not verify this scene. Keep release reports and deployment identities in private operational records.

## Archived painted candidate

The superseded `public/flowing-water-calm.png`, retained in source history, is 1825 × 862 pixels, 2,161,500 bytes, SHA-256 `a0c4e996350605f0c178f12020dd3d4b989b02a639bccb27b3746d4df7b1708d`. It was created with the built-in image-generation tool from the supplied JPEG’s composition/colours and the earlier painted PNG’s pigment detail. Its fine watercolour texture and periodic texture-coordinate deformation belong to the earlier proposal. That provenance is retained for history only and must not be presented as the current smooth-water implementation or approval.

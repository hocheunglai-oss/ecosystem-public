# Flowing Water artwork and motion

Preserve the supplied watercolour style while the teal and pale-blue oceans gently meet. The owner’s latest 28 October 2026 direction is to preserve some original contours as the two water bodies approach one another. The original pigment, colours and layered contours are the visual source; a generic 3D ocean or blurred replacement is not an equivalent treatment.

## Original artwork

Use `public/flowing-water-day.png` unchanged in both the animated renderer and its static fallback.

- Dimensions: 1672 × 941 pixels.
- File size: 1,955,642 bytes.
- SHA-256: `365ee9400a431fdd03079e40bb86bec7f78e5f6fbe0555aaaa596145bcaaf59c`.

Do not repaint, blur or replace its pigment texture, teal/mint/pale-blue blending or broad contours. This source is a still painting, not native 4K or a recorded ocean video.

## Two painted surfaces

The corrected implementation follows the existing teal-to-blue crest with two separate depth-tested meshes. Source pixels remain attached to their respective surfaces. Their fronts approach one another and settle back; the broader interiors remain recognizable and largely still. Restrained variation along the shared crest avoids uniform whole-image movement. A narrow crease shadow retains depth without adding glossy reflections or changing the original palette.

The farther surface extends beneath the nearer one. Motion must not expose missing material beyond the original crest, introduce mirrored fibres, or leave a doubled painted edge. This is a layered painted animation, not a physical fluid simulation. Do not describe it as fluid dynamics or claim newly simulated texture.

The cycle is 48 seconds, using periodic motion with continuous velocity at the boundary. The camera, canvas, cover framing and foreground interface remain stationary. The renderer pauses when the tab is hidden or a working window is open and resumes at its retained phase. It caps decorative drawing at 30 frames per second and approximately three million canvas pixels. Loading, reduced motion and unavailable/lost graphics retain the exact original painting.

Day and night share the same image, geometry and phase. Night applies the original artwork’s colour-only sunset mapping: teal to plum, mint to copper and pale blue to dusky blue. Do not use an alternate night image or replace the three tonal regions with a flat tint.

## Branding and interface

Preserve the blended E/F logo with its continuous energy-green lower bar and white letters. The matching favicon uses the white E/F structure and solid green lower bar on a dark-teal rounded square. FRATELLI COSULICH MARINE ENERGY stays solid white in both modes, 22 px and weight 600 within the lockup, without outline, shadow or a new backing box. Preserve layout, wording, CAPS and contribution-only blue.

## Verification and release

Compare the actual composed frames against the selected PNG, including the resting frame, approaching fronts, peak overlap and return. Inspect texture retention and the full shared crest for gaps, duplicated edges or abrupt changes. Verify the exact 48-second recurrence and continuity on both sides of the loop boundary; equal endpoints alone do not establish a smooth loop.

Check desktop and 320/390 px phones, day/night, signed-in/out, Chromium and mobile WebKit. Verify contrast, clipping, horizontal overflow, logo/tagline, pause/resume, image loading, reduced motion and graphics-loss fallback. Native Safari and physical devices require separate evidence; automated WebKit emulation is not a physical-device check.

Application and hosted release checks must use the corrected source and original artwork contract. Keep operational release identities and test evidence private. Passing checks for an earlier candidate does not verify this implementation, and source implementation alone does not establish deployment. The owner’s standing deployment authorization remains in effect.

## Rejected and historical candidates

The generic 3D candidate `635d5a6d7c48f8a73ed0549fc3b65554d97b6ce4` lost the reference’s style and was withdrawn without deployment. Its release workspace remains blocked. Do not stage or promote it. The earlier smooth poster and other alternate artwork retained in history must not replace the selected original PNG or serve as the corrected renderer’s fallback.

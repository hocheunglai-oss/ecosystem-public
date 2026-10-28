# Flowing Water background comparison

The owner’s latest 28 October 2026 request restores the textured screenshot version alongside the faithful diffuse animation, so they can choose a final background. This supersedes the single smooth procedural proposal. The functional selector uses BACKGROUND with DIFFUSE and WATERCOLOUR, in the existing footer. DIFFUSE is the initial default; `ecosystem.background.v1` stores a browser-local choice independently of the theme. Sign-in, sign-out, navigation and reload must retain both choices.

## Diffuse

The animation uses the exact supplied `public/flowing-water-reference.jpeg` (1493 × 704), SHA-256 `96578f550faa3a003a89c672b24af6698e3188f97c23a1a3688761727fd4e1c0`. It is not a new generated painting. The original dark teal, sea-green and powder-blue arrangement, tonal depth and horizontal detail remain the source. The rejected generated cleanup is not used.

`scripts/artwork/diffuse-detail.js` preserves the accepted renderer: source material is sampled once at output, with separate broad pigment advection/diffusion and source detail reconstructed at unit gain. It does not add invented grain or sharpen the source. The encoded cycle contains 720 frames at 30 fps, lasting 24 seconds. It is a stylized source-based animation, not footage of real water or a full fluid simulation. The source renderer and encoding provenance are retained so future work must not substitute unrelated artwork.

The web renditions are `public/flowing-water-diffuse.mp4` for desktop and `public/flowing-water-diffuse-mobile.mp4` for phones. The corresponding source-derived still is `public/flowing-water-diffuse-poster.jpg`. Encoding is local and uses no paid generation service. Select the rendition once at entry (mobile through 760 px); keep it across orientation changes and theme changes. A fixed 1.5% inset crops the supplied photograph’s outer frame without animating scale or crop. Muted inline playback loops; no audio is included. Hidden tabs and workspaces pause it; reduced motion avoids loading the video, and blocked playback/media errors retain the poster.

Compression and colour conversion introduce small differences from the lossless frames. The loop is continuous in motion, not a claim that the final and first compressed frames are pixel-identical. Preserve the colour profile and inspect actual browser compositor output when changing an encoder. Regenerating from the original reference requires the same renderer, fixed dimensions/clock and lossless frame capture before encoding; do not re-encode the compressed web copy repeatedly.

## Watercolour

The restored artwork is `public/flowing-water-day.png` (1672 × 941), SHA-256 `365ee9400a431fdd03079e40bb86bec7f78e5f6fbe0555aaaa596145bcaaf59c`. It is the earlier generated watercolour artwork shown in the owner’s 11:19 screenshot. Do not substitute the superseded `flowing-water-calm.png` or smooth procedural still. `src/flowingWaterRenderer.ts` restores the corresponding single-image renderer, with bounded local texture-coordinate flow over a seamless 48-second period. This is a graphics effect applied to the painted source, not a physical ocean simulation. It does not pan or zoom the whole image or combine resized copies of it.

The canvas keeps fixed centered cover framing, capped at 30 frames/second and a bounded rendering resolution. Unsupported/lost graphics and reduced motion show the exact source still. Hidden tabs and open workspaces freeze active phase and rendering.

## Themes and branding

Both options use exactly the same source, framing and active phase in light and dark mode. Night applies the shared static colour mapping into distinct plum, muted copper and dusky blue. It must not download a separate night image/video or reset playback. The flowing interface commits theme selection during the user’s tap, without a deferred native whole-page transition that can retain an earlier animated frame. The saved theme must survive later touches, sign-in/out and reload.

Keep the original blended E/F mark with its continuous energy-green lower bar and matching favicon. FRATELLI COSULICH MARINE ENERGY stays solid white in both modes, with no outline, stroke, shadow or new backing box. Existing layout, wording, CAPS and contribution-only blue remain unchanged.

## Verification

Check both choices in day/night, signed-in/out, desktop and 320/390 px phones, Chromium and WebKit. Inspect actual compositor pixels after a theme tap and after subsequent touches, not just HTML attributes. Verify persistence, visible motion, stable framing, decode/loop behaviour, pause/resume, reduced motion, failure fallbacks, readable labels, contrast, clipping and overflow. Retain auth/access/gating and contribution checks. Physical phones and installed Safari require separate verification; headless mobile emulation does not establish those results. Exact source CI, staged deployment and production verification are recorded privately for each release.

## Encoded asset identity

| Asset | Dimensions | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| flowing-water-diffuse.mp4 | 1492 × 704 | 10,890,624 | `0770af0fee2b0c95be4f516618071e6b1a0b5483293158ced64289919eae0621` |
| flowing-water-diffuse-mobile.mp4 | 960 × 454 | 2,945,116 | `7c89cde66b676842448ba06ac1c6bd171a9ec11663aefdad9da2676e46c8a027` |
| flowing-water-diffuse-poster.jpg | 1492 × 704 | 144,241 | `930e622da7bea1a8a1c5fc623e284b6e7d2fa00e7a829ffe1681038d1a88c5c2` |

Encoding: software H.264 High, slow CRF 12 with grain tuning, YUV420P limited range, 30 fps, 24 seconds. Explicit VUI/container tags use BT.709 primaries/matrix and IEC 61966-2-1 (sRGB) transfer. These tags matter: relying on defaults lifted the artwork’s colours in browsers. The JPEG is a quality-95 format conversion of the first lossless source frame. Source-frame SHA, encoder comparisons, normal-rate playback and screenshot colour measurements are retained in private release evidence. The compressed wrap difference averages below 1/255 across RGB, although it exceeds ordinary adjacent predictive-codec texture differences; do not claim pixel-identical endpoints.

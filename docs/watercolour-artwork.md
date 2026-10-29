# Flowing Water background comparison

The owner’s 29 October 2026 request replaces WATERCOLOUR with the latest six-second directional-wave video from their “Continue Request” chat. DIFFUSE remains available and unchanged. This supersedes the former 48-second watercolour graphics effect, not the shared layout or display controls. The functional selector uses BACKGROUND with DIFFUSE and WATERCOLOUR in the existing footer. DIFFUSE remains the initial default; `ecosystem.background.v1` stores the browser-local choice independently of the theme. Sign-in, sign-out, navigation and reload retain both choices.

## Diffuse

The animation uses the exact supplied `public/flowing-water-reference.jpeg` (1493 × 704), SHA-256 `96578f550faa3a003a89c672b24af6698e3188f97c23a1a3688761727fd4e1c0`. It is not a new generated painting. The original dark teal, sea-green and powder-blue arrangement, tonal depth and horizontal detail remain the source. The rejected generated cleanup is not used.

`scripts/artwork/diffuse-detail.js` preserves the accepted renderer: source material is sampled once at output, with separate broad pigment advection/diffusion and source detail reconstructed at unit gain. It does not add invented grain or sharpen the source. The encoded cycle contains 720 frames at 30 fps, lasting 24 seconds. It is a stylized source-based animation, not footage of real water or a full fluid simulation. The source renderer and encoding provenance are retained so future work must not substitute unrelated artwork.

The web renditions are `public/flowing-water-diffuse.mp4` for desktop and `public/flowing-water-diffuse-mobile.mp4` for phones. The corresponding source-derived still is `public/flowing-water-diffuse-poster.jpg`. Encoding is local and uses no paid generation service. Select the rendition once at entry (mobile through 760 px); keep it across orientation changes and theme changes. A fixed 1.5% inset crops the supplied photograph’s outer frame without animating scale or crop. Muted inline playback loops; no audio is included. Hidden tabs and workspaces pause it; reduced motion avoids loading the video, and blocked playback/media errors retain the poster.

Compression and colour conversion introduce small differences from the lossless frames. The loop is continuous in motion, not a claim that the final and first compressed frames are pixel-identical. Preserve the colour profile and inspect actual browser compositor output when changing an encoder. Regenerating from the original reference requires the same renderer, fixed dimensions/clock and lossless frame capture before encoding; do not re-encode the compressed web copy repeatedly.

## Watercolour

The owner selected the latest directional-wave revision from “Continue Request” on 29 October 2026. Its source package is `ECO-directional-background-website-package.zip`; the desktop and mobile H.264 videos and JPEG poster are copied byte-for-byte into the public assets below. The video is 1440 × 810, 30 fps, six seconds and silent; its smaller rendition is 960 × 540. This is the rightward/slightly upward directional revision, not the earlier sixteen-second swirl. No generation service, re-encoding, blur, extra deformation, moving overlay or whole-image transform is added by ECO.

The package describes a fixed overall turquoise-to-blue composition with forward texture transport and staggered internal phase blending. This is an artistic animation, not physical ocean footage. A compressed loop is not a promise of pixel-identical endpoint frames or flawless scheduling on every device. Verify the actual browser wrap and movement rather than relying on the package’s validation claims.

Both choices use the shared inline video component. Only changing the background choice remounts it; theme changes retain the same element, source and playback time. WATERCOLOUR uses fixed centered cover framing with no extra inset. DIFFUSE alone retains its original frame-removal crop. Matching stills cover loading, reduced motion, failed playback and unsupported night compositing. Hidden tabs and open workspaces pause playback.

For recovery, the earlier `public/flowing-water-day.png` (1672 × 941, SHA-256 `365ee9400a431fdd03079e40bb86bec7f78e5f6fbe0555aaaa596145bcaaf59c`) and `src/flowingWaterRenderer.ts` remain in source history/current archived files. They are not used by the selected WATERCOLOUR entry background.

## Themes and branding

Both options use exactly the same source, framing and active phase in light and dark mode. Night applies the shared static colour mapping into distinct plum, muted copper and dusky blue. It must not download a separate night image/video or reset playback. The flowing interface commits theme selection during the user’s tap, without a deferred native whole-page transition that can retain an earlier animated frame. The saved theme must survive later touches, sign-in/out and reload.

Keep the original blended E/F mark with its continuous energy-green lower bar and matching favicon. FRATELLI COSULICH MARINE ENERGY stays solid white in both modes, with no outline, stroke, shadow or new backing box. Existing layout, wording, CAPS and contribution-only blue remain unchanged.

## Verification

Check both choices in day/night, signed-in/out, desktop and 320/390 px phones, Chromium and WebKit. Inspect actual compositor pixels after a theme tap and after subsequent touches, not just HTML attributes. Verify persistence, visible motion, stable framing, decode/loop behaviour, pause/resume, reduced motion, failure fallbacks, readable labels, contrast, clipping and overflow. Retain auth/access/gating and contribution checks. Physical phones and installed Safari require separate verification; headless mobile emulation does not establish those results. Exact source CI, staged deployment and production verification are recorded privately for each release.

The Administration CI group runs on the standard `macos-15-intel` runner, using its installed Google Chrome for the Chromium media checks and Playwright's WebKit. Its eleven scripts and all twenty Flowing Water cases remain required, including the unchanged actual loop, pixel, pause and phase checks. The other six quality jobs remain on Ubuntu. This changes the verification platform; it does not establish physical iPhone or installed Safari coverage.

The pinned Playwright 1.63.0 Linux WebKit revision 2359 has a reproduced media limitation with these supplied files: a bare MP4 video outside ECO resets before its six-second endpoint, across unrouted HTTP and routed HTTP; the alternative playbin3 backend also resets early. Blob and non-looping controls show other decoding/timing failures. These observations do not identify a specific upstream defect or establish that all Linux browsers fail. The original files, application playback and strict loop requirements remain unchanged. A bounded, non-gating native-player diagnostic stays in the Ubuntu Suppliers group, with frame clocks, media events and request evidence archived separately under `output/native-video-diagnostic`; diagnostic completion is not a playback pass.

## Encoded asset identity

| Asset | Dimensions | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| flowing-water-watercolour.mp4 | 1440 × 810 | 2,903,247 | `4f3f318280ad48e6bab0bdb9f84c09346a80c413fa1424fcbbaa9e14155143ef` |
| flowing-water-watercolour-mobile.mp4 | 960 × 540 | 801,408 | `428fd8fd05c42ac5d331e215dc2d2a056ff4b8b964a697d9d8256fb082e3e079` |
| flowing-water-watercolour-poster.jpg | 1440 × 810 | 202,411 | `b66d9f876c074587b33afce458fbb265832967942692a0f093144d104e1494ee` |
| flowing-water-diffuse.mp4 | 1492 × 704 | 10,890,624 | `0770af0fee2b0c95be4f516618071e6b1a0b5483293158ced64289919eae0621` |
| flowing-water-diffuse-mobile.mp4 | 960 × 454 | 2,945,116 | `7c89cde66b676842448ba06ac1c6bd171a9ec11663aefdad9da2676e46c8a027` |
| flowing-water-diffuse-poster.jpg | 1492 × 704 | 144,241 | `930e622da7bea1a8a1c5fc623e284b6e7d2fa00e7a829ffe1681038d1a88c5c2` |

WATERCOLOUR package SHA-256: `732782de1744823af6c4e99dd4780a9d75ab37cd88238345a3cf9d96c993b171`. Preserve these supplied compressed assets without repeated re-encoding; any future creative replacement needs the owner’s direction.

DIFFUSE encoding: software H.264 High, slow CRF 12 with grain tuning, YUV420P limited range, 30 fps, 24 seconds. Explicit VUI/container tags use BT.709 primaries/matrix and IEC 61966-2-1 (sRGB) transfer. These tags matter: relying on defaults lifted the artwork’s colours in browsers. The JPEG is a quality-95 format conversion of the first lossless source frame. Source-frame SHA, encoder comparisons, normal-rate playback and screenshot colour measurements are retained in private release evidence. The compressed wrap difference averages below 1/255 across RGB, although it exceeds ordinary adjacent predictive-codec texture differences; do not claim pixel-identical endpoints.

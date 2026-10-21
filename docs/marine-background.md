# ECOSYSTEM marine background

> **Archived film implementation.** The current homepage uses an oil-terminal background, independent animated water on desktop and a stationary Fratelli Cosulich bunker-barge illustration. The barge has no game controls or movement. See [current barge artwork](cosulich-barge-assets.md) and [harbour background](oil-terminal-assets.md). The offline film, renderer and notes below are historical references; the application does not play this film.

## Previous homepage film

A silent, two-minute looping film based on the approved coastal artwork. An oxide-red container ship crosses the foreground and a pilot launch passes through open water. A bunker tanker stays alongside a navy receiving container vessel, with a hose, mooring lines and fenders. The small outer-channel freighter has been removed following visual feedback. Continuous surface flow, stronger ripples and reflected sunlight move while the camera and coastline remain still.

This earlier design removed named port pins, the dotted route, the moving arrow and the selected-port panel from the hero. Current port information is available through Countries & Ports; the former group-mission interface is retired.

This is an authored 2.5D cinemagraph, built from generated raster layers and deterministic water/vessel animation. It is not filmed footage or a navigation simulation. The bunker delivery is continuously alongside; it does not show an arrival or departure. No external video-generation service was used.

## Playback and files

- `public/marine/harbour-loop.mp4`: 1672 × 940, H.264, 24 fps, 120 seconds, approximately 72 MB.
- `public/marine/harbour-loop-mobile.mp4`: 960 × 540, H.264, 24 fps, 120 seconds, approximately 30 MB.
- `public/marine/harbour-poster.jpg`: the matching opening frame.
- The former `src/MarineWorld.tsx` implementation used browser-native muted inline playback, persistent motion control, offscreen/tab-hidden pause and poster fallback. The current file renders the harbour background, ambient effects and stationary barge instead.

The MP4 index is at the start of each file, allowing playback before the full file downloads. The first visit can transfer the whole selected film during playback; subsequent looping reuses buffered media. Desktop uses a fullbleed composition. Smaller screens show a panoramic band so that the vessels remain visible rather than being cropped out.

## Rebuilding the film

1. Run `pnpm dev`.
2. Open `/scripts/marine-preview.html` on the local server. This workbench is excluded from deployment.
3. Edit choreography in `src/marine/scene.ts` and compositing in `src/marine/renderer.ts`.
4. Run `node scripts/render-marine.mjs --frames-only` and review the eight sampled frames before rendering.
5. Run `node scripts/render-marine.mjs` to regenerate both MP4s and the matching zero-second poster.
The retained `scripts/verify-marine.mjs` records the earlier film-playback checks; it targets the retired video homepage and is not a regression command for the current application.

The export tool uses [Mediabunny](https://mediabunny.dev/guide/writing-media-files) and the browser's WebCodecs encoder. The full film renderer is used offline. Its shoreline water-mask helper is also imported by the current ocean renderer; this shared dependency must be retained or extracted before the historical renderer can be removed. Vercel's SPA rewrite explicitly excludes `/marine/` so video byte-range requests reach real media files.

## Historical film validation

- Raw rendered frames at 0 and 120 seconds are pixel-identical.
- Vessel resets occur outside the frame; paths were reviewed against the shoreline and each other.
- The bunker barge was moved closer after checking actual hull silhouettes, with the hose and mooring positions adjusted.
- Actual MP4 playback and loop wrapping verified at desktop, wide desktop and mobile sizes.
- Pausing freezes playback; scrolling offscreen pauses it; reduced motion uses the poster without fetching MP4s.
- A failed video request retains the poster and usable homepage.
- Parser/model tests, business flows, reward feedback and responsive layouts were checked with the film implementation. These historical results do not verify the current application.

Generated-image prompts and provenance are in `marine-background-assets.md`, `marine-vessel-assets.md` and `marine-passing-hull.md`. The existing logo is unchanged.

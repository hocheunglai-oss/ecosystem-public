# Storage terminal asset

> **Retired:** This sprite and its storage-terminal scene are not part of the current build. The asset remains available in commit `a447543`. This document preserves its generation prompt, provenance and historical placement guidance.

## File and provenance

- Project asset: `public/marine/storage-terminal-tank-v1.png`
- Generated with the built-in `image_gen` tool, default mode, on 30 September 2026.
- Original tool output: `[original retained in the private asset archive]`
- Copied into the project without image processing. No existing image was overwritten.
- `public/marine/destination-harbour.jpg` was inspected as the visual reference for camera, material and lighting. It was not modified or submitted as an edit target; the tank was generated as a separate transparent sprite.
- No CLI/API fallback, stock asset or third-party image was used.

## Asset checks

- 1,254 × 1,254 pixels, RGBA PNG; 1,396,158 bytes.
- Actual transparent background, not a painted checkerboard: all four corner alpha values are zero and 846,468 pixels are fully transparent.
- Alpha content bounds: `(33, 53)` to `(1225, 1182)`. Most solid surfaces have alpha 253/255, with antialiased edge pixels retained from the generated output.
- One off-white cylindrical tank, compact concrete containment pad, ladder, roof railings, front-left pipe outlets and a physical front-right level gauge.
- Warm light comes from the upper right. There is no text, logo, scenery or full-image ground rectangle.

## Suggested scene placement

The harbour uses a `1671 × 941` world coordinate system. Start the sprite at **x=974, y=288, width=138, height=138**. Its opaque tank and pad then occupy approximately x=978–1109, y=294–418, with the bottom of the containment pad over the main island's terminal land. The tank is centered near x=1044, y=360; its front-left pipes face the working quay.

The placement is a starting point for visual scene review, not a validated collision mask. Keep the footprint fully on land and render the sprite behind foreground loading cranes where appropriate. A slightly smaller 120–130 world-unit footprint can reduce building overlap. Preserve the original harbour and water mask; use this separate sprite instead of replacing the background.

The small gauge baked into the sprite is decorative. A live resource-level indicator should be drawn by the scene/UI renderer and driven by the office's actual remaining Oil. No resource number or milestone is baked into the image.

## Final generation prompt

> Use case: stylized-concept. Asset type: transparent PNG game-world sprite for a polished Mediterranean marine-energy island viewed from an elevated aerial camera. Create ONE realistic white aboveground cylindrical oil storage tank on a SMALL low rectangular pale concrete containment pad, isolated on a genuinely transparent alpha background. This is an environment asset, not an icon or diagram. Match a refined cinematic miniature architectural render: off-white painted metal, subtle seams, realistic steel roof, tiny roof walkway and railing, ladder, two low steel pipes leading to the front-left edge of the pad, restrained engineering details. A narrow physical vertical level gauge is mounted on the near/front-right side of the tank, simple dark glass with a small cyan liquid indication and NO writing or digits; keep gauge visually small and mechanically plausible. Camera: elevated oblique three-quarter aerial view looking downward about 30 degrees, tank top visible as an ellipse, upright vertical cylinder, rectangular pad receding toward upper-right. Lighting: warm late-afternoon sun from upper-right, blue-grey shaded near/left side, restrained soft contact shadow ONLY on the concrete pad. Composition: entire one tank and entire compact pad centered in a square image with clear transparent margin on all sides, no clipping. The tank is a port-scale storage vessel, roughly one large warehouse footprint, wider than it is tall. Color palette: warm pearl-white metal, pale limestone concrete, muted dark steel piping. Constraints: real alpha transparency outside the tank and its pad, no background color, no checkerboard painted into the pixels, no water, no surrounding island, no buildings, no boats, no people, no vegetation, no typography, no text, no logos, no labels, no UI, no large cast-shadow rectangle. Generate only this one clean production sprite.

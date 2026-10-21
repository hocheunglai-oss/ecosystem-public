# Original Cosulich flag artwork

## Source

- Official Cosulich PDF: [C&C Transports press release](https://in.cosulich.com/storage/entity_press_release/8/files/d4f07c8569fc050a2d86308441d23a53.pdf), page 1, upper-right flag.
- Downloaded reference: `artifacts/flag-reference/company-press-release.pdf`.
- PDF SHA-256: `33946ae815fa9da085bdb2e899c92467dd39da5159379e62479bd3884516aa1d`.
- Published asset: `public/marine/cosulich-flag-original.svg`.

The SVG contains the original vector artwork, not an AI rendering, tracing, or reconstructed logo.

## Extraction

The PDF was inspected using bundled Poppler and `pypdf`. Its flag comprises one red compound path and fourteen explicit white paths. The original PDF path commands, numeric operands, individual translation matrices, and nonzero fill rule were copied directly into SVG. The PDF repeats the same flag later in its drawing stream; the asset retains one complete copy.

The source `/CS0` colour space embeds the **sRGB IEC61966-2.1** profile. The SVG preserves its original fills: `rgb(85%, 16%, 11%)` and `rgb(100%, 100%, 100%)`. No white regions were invented. The area outside the source artwork is transparent.

An outer `translate(0 841.89) scale(1 -1)` converts the PDF's upward Y coordinates to SVG's downward Y coordinates. This changes the coordinate convention, preserving the visible artwork's orientation. No path reshaping, skew, rotation, or colour replacement was applied.

## Dimensions and placement

- Tight viewBox: `487.71742774 62.07445289 50.86528489 41.68159959`.
- Intrinsic dimensions: `50.86528489 × 41.68159959`.
- Aspect ratio: approximately `1.22032948 : 1`.
- Previous direct-vector scene face width `80`, proportional height approximately `65.556065879`.

The viewBox includes only a `0.00001` coordinate-unit rounding guard on each edge. Use uniform scaling and `preserveAspectRatio`; do not crop or stretch the flag. The previous scene used this transparent silhouette directly with a shallow offset extrusion and posts. The user subsequently selected the earlier cartoon 3D sculpture instead. The current scene uses an image edit of that sculpture, with this source as its painted-pattern reference; it does not claim pixel-identical vector reproduction. See [current scene composition](flag-3d-pattern-assets.md).

## Verification

- All fifteen output paths and translation matrices match the original PDF operands.
- Original PDF and SVG renderings both produce solid red `RGB(217, 41, 28)`; no solid-colour fidelity loss was observed.
- The white stripes and checkered hoist are the source's original white paths.
- Isolated transparent PNG preview: `artifacts/flag-reference/cosulich-flag-original.png`.
- Full source page preview: `artifacts/flag-reference/company-page-1.png`.

The official PDF supplies the original vector paths; the rendered result was visually compared with the user's supplied flag reference.

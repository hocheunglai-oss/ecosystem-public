# Flowing Water artwork

Created on 27 October 2026 with the built-in image-generation tool. The owner requested smoother watercolour artwork to replace the visibly coarse source screenshot. Their final direction requires exactly the same picture in light and dark modes, changing only its colours. This is one original generated still image animated by the interface, not the reference website’s video.

The asset is a native 1672 × 941 PNG. The tool returned that resolution despite a larger requested size. No post-generation resizing, sharpening, compression or pixel editing was applied. The intended improvement is smoother organic colour detail without the screenshot’s compression blocks; do not claim 4K output.

- `public/flowing-water-day.png`: 1,673,897 bytes; SHA-256 `f0bd089570a0b549b58565afebf43b5674bf7dbef9e14310883eea3705ce074f`.

## Final generation prompt

Use case: stylized-concept. A pure abstract liquid-watercolour canvas for an elegant professional website, full bleed 16:9. Extremely refined smooth wet-on-wet colour suspended in water. Only FOUR broad soft flowing fields: a deep forest-jade upper wash, a sea-glass turquoise middle wash, a subtle luminous aqua lower-middle wash, and a very soft powder-blue lower quarter. Gently horizontal but organic, edges completely diffused with elegant cloudy translucency. Smooth continuous colour transitions, as if beautifully photographed translucent inks floating in water. It must read as an expensive contemporary colour-field painting, not paper or rugged landscape. Darker and quieter upper-left third, enough depth for white interface lettering but NO actual lettering. No obvious brush strokes, scalloped pigment edges, jagged boundaries, outlined bands, veins, cracks, texture grain, fibers, speckles, noise, tiles, rectangular shapes, pixelation, coarse mottling, blocks or compression artifacts. No literal water ripples, waves, clouds, sky, mountains, islands, objects, text, logos, UI, frames, borders or watermark. High native resolution requested: 3840 x 2160 pixels. Only finished background.

## Integration

`src/FlowingWaterBackground.tsx` renders the same image element and PNG source for both themes. A static SVG colour filter maps its luminance to dark charcoal/plum, rose and copper at night. It preserves the original alpha, every shape, watercolour detail, crop and movement; there is no separate night artwork or night image download. The filter changes colour only, without displacement, blur or geometry operations.

The interface preserves reduced-motion, hidden-tab and workspace pauses. The original E/F logo is a separate unchanged asset, including its original green stroke. The blue contribution token is independent of the artwork and must never recolour ordinary actions or the logo.

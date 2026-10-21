# Earlier flag-shaped hillside sign

This documents the previous direct-vector composition. The current user-selected 3D sculpture is documented in [Sculpted company flag](flag-3d-pattern-assets.md).

- Local hillside repair source: `public/marine/destination-oil-terminal-clean-v6.jpg` (1670 × 942).
- Built-in `image_gen.imagegen`, edit mode, removing only the previous rectangular billboard and restoring the hillside.
- Input: `public/marine/destination-oil-terminal-clean-v5.jpg`.
- Generated output: `[original retained in the private asset archive]`.
- Delivery JPEG: quality 94, no crop. Earlier assets remain available.

Still and animated layers retain the same cleaned v5 base plate. A softly masked patch from v6 repairs only the old billboard footprint; it preserves all unrelated artwork, including the cleaned ocean and original land brightness. The company sign is rendered separately from the exact original vector artwork, as a solid flag-shaped face with shallow depth and hillside supports. Its original checkered hoist, stripes and silhouette are preserved; no AI-generated logo is used.

## Background edit prompt

```text
Use case: precise-object-edit. Edit target is the supplied clean oil-terminal island background. Make ONLY ONE TINY removal: remove the small blank beige rectangular billboard and its two little feet/shadow from the main island hill, centered approximately x1126,y206 in this1670x942 image (rectangle roughlyx1104-1147,y190-223). Restore the underlying matching natural grassy rocky hillside and shrubs in only that little footprint. Do NOT add any other sign, logo, letters, flag, pole, buildings or objects. Preserve everything else, especially exact original framing and dimensions, bright original colours, all detailed oil-terminal piers and tanks, all coastlines, original lighthouses, buildings and mountains, and the cleaned BLUE ocean without yellow shadow columns. This is an inpainting removal of the little beige rectangle only; the rest of the entire image must remain visually unchanged. No ships/UI/text.
```

The logo's original source and path verification are documented in [Cosulich flag source](cosulich-flag-source.md).

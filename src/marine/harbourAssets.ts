export type HarbourTheme = "light" | "dark";
export const HARBOUR_ASSETS = {
  light: "/marine/destination-oil-terminal-clean-v7.jpg",
  dark: "/marine/destination-oil-terminal-night-v2.jpg",
  flag: "/marine/cosulich-hill-sculpture-v1.jpg",
  bunker: "/marine/cosulich-barge-v2.png",
  lng: "/marine/cosulich-lng-barge-v1.png",
} as const;

const decoded = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

/** Share decoded images with the GPU so a committed mode never needs another async load. */
export function loadHarbourImage(src: string): Promise<HTMLImageElement> {
  const ready = decoded.get(src);
  if (ready) return Promise.resolve(ready);
  const loading = pending.get(src);
  if (loading) return loading;
  const image = new Image();
  image.src = src;
  const result = image.decode().then(() => {
    decoded.set(src, image);
    pending.delete(src);
    return image;
  }, (error: unknown) => {
    pending.delete(src);
    throw error;
  });
  pending.set(src, result);
  return result;
}

export const decodedHarbourImage = (src: string) => decoded.get(src);

const themeAssets = (theme: HarbourTheme) => [
  HARBOUR_ASSETS[theme], HARBOUR_ASSETS.flag, HARBOUR_ASSETS.bunker, HARBOUR_ASSETS.lng,
];

export const isHarbourThemeReady = (theme: HarbourTheme) =>
  themeAssets(theme).every(src => decoded.has(src));

export async function prepareHarbourTheme(theme: HarbourTheme) {
  await Promise.all(themeAssets(theme).map(loadHarbourImage));
}

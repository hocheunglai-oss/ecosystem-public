import { useEffect, useState } from "react";
import { isHarbourThemeReady, prepareHarbourTheme, type HarbourTheme } from "./harbourAssets";

/** Reveal the harbour, flag and both vessels as one decoded scene. */
export function useHarbourArtwork(theme: HarbourTheme) {
  const [loadedTheme, setLoadedTheme] = useState<HarbourTheme | null>(() =>
    isHarbourThemeReady(theme) ? theme : null);
  // Theme switches prepare the complete scene before committing. Read the cache
  // in that same render so a transition cannot snapshot the previous artwork.
  const artworkTheme = isHarbourThemeReady(theme) ? theme : loadedTheme;
  useEffect(() => {
    let cancelled = false;
    void prepareHarbourTheme(theme).then(() => {
      if (!cancelled) setLoadedTheme(theme);
    }).catch(() => {
      // Keep the previous complete scene, or the plain initial backdrop, on failure.
    });
    return () => { cancelled = true; };
  }, [theme]);
  return artworkTheme;
}

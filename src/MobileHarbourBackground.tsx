import { useLayoutEffect, useRef, useState } from "react";
import { CosulichBarge } from "./marine/CosulichBarge";
import { HilltopSign } from "./marine/HilltopSign";
import { NightFlagLighting } from "./marine/NightFlagLighting";
import { HARBOUR_ASSETS, type HarbourTheme } from "./marine/harbourAssets";
import { useHarbourArtwork } from "./marine/useHarbourArtwork";

const scene = { width: 1671, height: 941, flagX: 1147, flagY: 228, lighthouseY: 134 };

/** Crop around the company flag instead of the centre of the original landscape. */
export function MobileHarbourBackground({ theme, signedIn }: { theme: HarbourTheme; signedIn: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [viewBox, setViewBox] = useState("900 0 494 941");
  const artworkTheme = useHarbourArtwork(theme);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      // Cover the viewport while retaining equal image space either side of the flag.
      let scale = Math.max(height / scene.height, width / (2 * (scene.width - scene.flagX)));
      let cropHeight = height / scale;
      let cropY = Math.max(0, Math.min(scene.height - cropHeight, scene.flagY - cropHeight * .24));
      const originalFlagBottom = (scene.flagY + 55 - cropY) * scale;
      const brand = element.parentElement?.querySelector(".brand-tagline");
      const brandBottom = brand ? brand.getBoundingClientRect().bottom + window.scrollY : 78;
      const lighthouseTop = (scene.lighthouseY - cropY) * scale;
      const gap = Math.max(0, lighthouseTop - brandBottom);
      if (gap > 0) {
        const targetTop = lighthouseTop - gap / 2;
        // Slightly enlarge the same still to move it up without exposing an empty strip below.
        scale = Math.max(scale, (height - targetTop) / (scene.height - scene.lighthouseY));
        cropHeight = height / scale;
        cropY = Math.max(0, Math.min(scene.height - cropHeight, scene.lighthouseY - targetTop / scale));
      }
      const cropWidth = width / scale;
      setViewBox(`${scene.flagX - cropWidth / 2} ${cropY} ${cropWidth} ${cropHeight}`);
      // The home menu begins below the flag so it stays visible behind the controls.
      element.parentElement?.style.setProperty("--mobile-flag-bottom", `${originalFlagBottom}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // The logo's intrinsic height arrives asynchronously on a fresh mobile visit.
    // Watch the lockup (not just the fixed-size tagline) so the crop is recomputed.
    const brand = element.parentElement?.querySelector(".brand-lockup");
    if (brand) observer.observe(brand);
    return () => observer.disconnect();
  }, [signedIn]);
  return <div ref={root} className="mobile-harbour-background" data-artwork-ready={Boolean(artworkTheme)} aria-hidden="true">
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid slice" focusable="false">
      {artworkTheme && <g data-mobile-artwork={artworkTheme}>
        <image href={HARBOUR_ASSETS[artworkTheme]} width={scene.width} height={scene.height} />
        {artworkTheme === "dark" ? <NightFlagLighting /> : <HilltopSign />}
        <CosulichBarge kind="lng" night={artworkTheme === "dark"} />
        <CosulichBarge night={artworkTheme === "dark"} />
      </g>}
      <rect data-mobile-flag-anchor x="1146" y="227" width="2" height="2" fill="none" />
      <rect data-mobile-lighthouse-anchor x="1115" y="134" width="2" height="1" fill="none" />
    </svg>
  </div>;
}

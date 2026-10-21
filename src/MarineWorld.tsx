import { useEffect, useRef } from "react";
import { CosulichBarge } from "./marine/CosulichBarge";
import { OceanSurface } from "./marine/OceanSurface";
import { HilltopSign } from "./marine/HilltopSign";
import { LighthouseLights } from "./marine/LighthouseLights";
import { NightFlagLighting } from "./marine/NightFlagLighting";
import { HARBOUR_ASSETS } from "./marine/harbourAssets";
import { useHarbourArtwork } from "./marine/useHarbourArtwork";
import "./marine/MarineWorld.css";
import "./marine/NightHarbour.css";

type Props = {
  theme?: "light" | "dark";
  motionEnabled?: boolean;
};

/** The stationary barge shares the harbour's coordinate system at every viewport. */
export function MarineWorld({ theme = "light", motionEnabled = true }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const artworkTheme = useHarbourArtwork(theme);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      if (root.current)
        root.current.dataset.ambientMotion =
          artworkTheme && motionEnabled && !document.hidden && !preference.matches
            ? "running"
            : "paused";
    };
    update();
    document.addEventListener("visibilitychange", update);
    preference.addEventListener("change", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      preference.removeEventListener("change", update);
    };
  }, [motionEnabled, artworkTheme]);
  const night = artworkTheme === "dark";
  const harbour = HARBOUR_ASSETS[artworkTheme ?? theme];
  return (
    <div
      ref={root}
      className="marine-world marine-world--destination"
      data-playback="destination"
      data-theme={artworkTheme ?? theme}
      data-artwork-ready={Boolean(artworkTheme)}
      data-motion={motionEnabled ? "on" : "off"}
      data-ambient-motion="paused"
    >
      {artworkTheme && <><img
        className="marine-world__harbour"
        src={harbour}
        alt=""
        fetchPriority="high"
      />
      <OceanSurface enabled={motionEnabled} src={harbour} night={night} />
      <svg
        className="marine-world__scene"
        viewBox="0 0 1671 941"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
        aria-hidden="true"
      >
        {night ? <><NightFlagLighting /><LighthouseLights /></> : <HilltopSign />}
        {!night && <g className="marine-birds">
          {[
            [896, 178],
            [912, 183],
            [927, 171],
          ].map(([x, y], index) => (
            <g key={index} transform={`translate(${x} ${y})`}>
              <g className={`marine-bird marine-bird--${index}`}>
                <path
                  className="marine-bird__wings"
                  d="M-4.5 0 Q-2.3 -2.9 0 0 Q2.3 -2.9 4.5 0"
                />
              </g>
            </g>
          ))}
        </g>}
        <CosulichBarge kind="lng" night={night} />
        <CosulichBarge night={night} />
      </svg></>}
    </div>
  );
}

import { useId } from "react";
import { HARBOUR_ASSETS } from "./harbourAssets";

/** Retain the approved face and spotlights; match the daytime foliage over the footings. */
export function NightFlagLighting() {
  const baseId = `night-flag-base-${useId()}`;
  return (
    <g
      className="marine-night-flag-lighting"
      pointerEvents="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="night-flag-shade"
          gradientUnits="userSpaceOnUse"
          x1="1147"
          y1="181"
          x2="1147"
          y2="264"
        >
          <stop offset="0" stopColor="#091326" stopOpacity=".34" />
          <stop offset=".5" stopColor="#0d1527" stopOpacity=".25" />
          <stop offset="1" stopColor="#291b16" stopOpacity=".08" />
        </linearGradient>
        <filter
          id="night-flag-soft-edge"
          x="-2%"
          y="-2%"
          width="104%"
          height="104%"
        >
          <feGaussianBlur stdDeviation=".35" />
        </filter>
        <filter id={`${baseId}-foliage-tone`} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values=".54 0 0 0 0  0 .54 0 0 0  0 0 .6 0 0  0 0 0 1 0"
          />
        </filter>
        <filter
          id={`${baseId}-feather`}
          x="-10%"
          y="-20%"
          width="120%"
          height="140%"
        >
          <feGaussianBlur stdDeviation="1.25" />
        </filter>
        <mask
          id={`${baseId}-foliage`}
          maskUnits="userSpaceOnUse"
          x="1092"
          y="259"
          width="96"
          height="28"
          style={{ maskType: "alpha" }}
        >
          <g fill="white" filter={`url(#${baseId}-feather)`}>
            <path d="M1101 266 Q1105 262 1109 264 Q1114 265 1115 270 L1117 278 Q1111 282 1103 280 Q1099 274 1101 266Z" />
            <path d="M1164 275 Q1167 270 1171 273 Q1175 272 1178 276 L1177 281 Q1170 283 1164 280Z" />
          </g>
        </mask>
      </defs>
      {/* The night still exposes taller pale footings. These organic fragments reuse
          only the approved daytime ground, in its exact original projection. */}
      <image
        data-night-flag-foliage="matched-day-base"
        href={HARBOUR_ASSETS.flag}
        x="1060"
        y="148"
        width="178"
        height="173"
        preserveAspectRatio="xMidYMid meet"
        mask={`url(#${baseId}-foliage)`}
        filter={`url(#${baseId}-foliage-tone)`}
      />
      <g
        data-night-flag-supports="shaded"
        fill="#111d2b"
        fillOpacity=".5"
        filter="url(#night-flag-soft-edge)"
      >
        <path d="M1106.8 247.2 L1110 247.8 L1109.4 264.2 L1106.1 264Z" />
        <path d="M1168.8 257.3 L1171.5 258.5 L1169.6 275.2 L1166.9 274.4Z" />
      </g>
      <path
        data-night-flag-shading="uplight"
        d="M1105 181 L1109 192 C1126 197 1148 212 1168 209 Q1180 208 1187 197 L1190 202 Q1193 212 1181 226 Q1178 230 1186 240 L1182 247 Q1173 248 1180 262 L1176 264 Q1170 250 1158 249 Q1131 251 1104 246 Q1110 216 1105 181Z"
        fill="url(#night-flag-shade)"
        filter="url(#night-flag-soft-edge)"
      />
    </g>
  );
}

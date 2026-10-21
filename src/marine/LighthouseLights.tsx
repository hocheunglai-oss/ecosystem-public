import type { CSSProperties } from "react";

const beacons = [
  { id: "entrance", x: 529, y: 285, length: 270, period: 19, phase: -3 },
  { id: "hill", x: 1117, y: 137, length: 350, period: 25, phase: -11 },
  { id: "breakwater", x: 1497, y: 520, length: 310, period: 22, phase: -17 },
];

/** Lighthouse beams rotate in a shallow perspective plane; the lanterns stay fixed. */
export function LighthouseLights() {
  return (
    <g className="marine-lighthouses" aria-hidden="true">
      <defs>
        <linearGradient id="lighthouse-beam" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#fff1c8" stopOpacity=".32" />
          <stop offset=".18" stopColor="#e9efff" stopOpacity=".16" />
          <stop offset="1" stopColor="#c9e2ff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="lighthouse-lantern">
          <stop offset="0" stopColor="#fff8e5" stopOpacity=".8" />
          <stop offset=".24" stopColor="#ffdf9b" stopOpacity=".3" />
          <stop offset="1" stopColor="#ffc985" stopOpacity="0" />
        </radialGradient>
      </defs>
      {beacons.map(({ id, x, y, length, period, phase }) => (
        <g key={id} data-lighthouse={id} transform={`translate(${x} ${y})`}>
          <g transform="scale(1 .24)">
            <g className="marine-lighthouse__beam" style={{ "--beam-period": `${period}s`, "--beam-phase": `${phase}s` } as CSSProperties}>
              <path d={`M0 0 L${length} -31 Q${length + 12} 0 ${length} 31Z`} fill="url(#lighthouse-beam)" />
            </g>
          </g>
          <circle r="7" fill="url(#lighthouse-lantern)" />
          <circle r="1.2" fill="#fff3ce" />
        </g>
      ))}
    </g>
  );
}

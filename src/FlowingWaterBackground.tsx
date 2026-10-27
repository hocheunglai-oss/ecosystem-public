import { useEffect, useState } from 'react';

/** Both modes share exactly the same artwork; night changes only its colours. */
export function FlowingWaterBackground({ paused = false }: { paused?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return <div className="flowing-water-background" aria-hidden="true" data-paused={paused || hidden}>
    <svg className="flowing-water-palette" width="0" height="0" focusable="false">
      <defs>
        <filter id="eco-watercolour-night" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          {/* Retain source hue: teal becomes plum, mint copper, and blue stays dusky blue. */}
          <feColorMatrix type="matrix" values="-0.315127 4.299968 -1.352730 0 -1.626157 0.626944 1.519584 0.002427 0 -0.794092 0.386135 -3.250374 1.438371 0 1.762207 0 0 0 1 0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0.035 0.540" />
            <feFuncG type="table" tableValues="0.025 0.300" />
            <feFuncB type="table" tableValues="0.065 0.440" />
            <feFuncA type="identity" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
    <img className="flowing-water-image" src="/flowing-water-day.png" alt="" decoding="async" fetchPriority="high" />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

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
          <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0.043 0.129 0.286 0.502 0.540" />
            <feFuncG type="table" tableValues="0.043 0.098 0.173 0.314 0.320" />
            <feFuncB type="table" tableValues="0.082 0.184 0.298 0.310 0.320" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
    <img className="flowing-water-image" src="/flowing-water-day.png" alt="" decoding="async" fetchPriority="high" />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

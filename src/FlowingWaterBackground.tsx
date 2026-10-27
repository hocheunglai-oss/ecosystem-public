import { useEffect, useState } from 'react';

/** The supplied water image with gentle motion; application content stays still. */
export function FlowingWaterBackground({ paused = false }: { paused?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return <div className="flowing-water-background" aria-hidden="true" data-paused={paused || hidden}>
    <img className="flowing-water-image" src="/flowing-water-reference.jpeg" alt="" decoding="async" fetchPriority="high" />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

import { useEffect, useState } from 'react';

/** Decorative, locally rendered water. Application content never moves with it. */
export function FlowingWaterBackground({ paused = false }: { paused?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return <div className="flowing-water-background" aria-hidden="true" data-paused={paused || hidden}>
    <div className="flowing-water-base" />
    <div className="flowing-water-glow" />
    <div className="flowing-water-ribbon" />
    <div className="flowing-water-blue" />
    <div className="flowing-water-shade" />
  </div>;
}

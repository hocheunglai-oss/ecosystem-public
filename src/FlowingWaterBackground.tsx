import { useEffect, useRef, useState } from 'react';
import { createFlowingWaterRenderer, FLOW_PERIOD_MS } from './flowingWaterRenderer';
import type { FlowingWaterRenderer } from './flowingWaterRenderer';

/** Both modes share exactly the same artwork; night changes only its colours. */
export function FlowingWaterBackground({ paused = false }: { paused?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [flowState, setFlowState] = useState<'running' | 'paused' | 'fallback'>('fallback');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const rendererRef = useRef<FlowingWaterRenderer | null>(null);
  const pausedRef = useRef(paused || hidden);
  pausedRef.current = paused || hidden;
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    let cancelled = false;
    void image.decode().then(() => {
      if (cancelled) return;
      rendererRef.current = createFlowingWaterRenderer(canvas, image, pausedRef.current, setFlowState);
      if (!rendererRef.current) setFlowState('fallback');
    }).catch(() => { if (!cancelled) setFlowState('fallback'); });
    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [reduced]);
  useEffect(() => {
    if (reduced) setFlowState('fallback');
    else rendererRef.current?.setPaused(paused || hidden);
  }, [paused, hidden, reduced]);
  return <div className="flowing-water-background" aria-hidden="true" data-paused={paused || hidden || reduced}
    data-renderer={flowState === 'fallback' || reduced ? 'fallback' : 'webgl'} data-flow-state={reduced ? 'fallback' : flowState}>
    <svg className="flowing-water-palette" width="0" height="0" focusable="false">
      <defs>
        <filter id="eco-watercolour-night" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          {/* Retain source hue: teal becomes plum, mint copper, and blue stays dusky blue. */}
          <feColorMatrix type="matrix" values="-1.638295 4.777670 -1.610852 0 -1.087327 -0.329489 2.599391 -0.074692 0 -1.115394 1.717764 -5.632004 1.595456 0 2.611673 0 0 0 1 0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0.10 0.43" />
            <feFuncG type="table" tableValues="0.07 0.28" />
            <feFuncB type="table" tableValues="0.13 0.38" />
            <feFuncA type="identity" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
    <img ref={imageRef} className="flowing-water-image" src="/flowing-water-reference.jpeg" alt="" decoding="async" fetchPriority="high" />
    <canvas key={String(reduced)} ref={canvasRef} className="flowing-water-canvas" data-flow-period-ms={FLOW_PERIOD_MS} />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

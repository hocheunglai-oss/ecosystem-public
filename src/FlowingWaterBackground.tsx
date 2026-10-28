import { useEffect, useRef, useState } from 'react';
import { createFlowingWaterRenderer, FLOW_PERIOD_MS } from './flowingWaterRenderer';
import type { FlowingWaterRenderer } from './flowingWaterRenderer';

/** Both modes share one smooth water surface and phase; night changes colour only. */
export function FlowingWaterBackground({ paused = false }: { paused?: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [flowState, setFlowState] = useState<'running' | 'paused' | 'fallback'>('fallback');
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    if (!canvas) return;
    rendererRef.current = createFlowingWaterRenderer(canvas, pausedRef.current, setFlowState);
    if (!rendererRef.current) setFlowState('fallback');
    return () => {
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
          <feColorMatrix type="matrix" values="-1.108980 3.778197 -1.176109 0 -0.945068 -0.253977 2.529681 -0.078967 0 -1.001579 1.125867 -3.343851 1.261540 0 1.509044 0 0 0 1 0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0.035 0.540" />
            <feFuncG type="table" tableValues="0.025 0.300" />
            <feFuncB type="table" tableValues="0.065 0.440" />
            <feFuncA type="identity" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
    <img className="flowing-water-image" src="/flowing-water-smooth.png" alt="" decoding="async" fetchPriority="high" />
    <canvas key={String(reduced)} ref={canvasRef} className="flowing-water-canvas" data-flow-period-ms={FLOW_PERIOD_MS} />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

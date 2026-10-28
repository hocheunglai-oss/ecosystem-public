import { useEffect, useRef, useState } from 'react';
import { createFlowingWaterRenderer, FLOW_PERIOD_MS } from './flowingWaterRenderer';
import type { FlowingWaterRenderer } from './flowingWaterRenderer';
import type { WaterBackground } from './backgroundPreference';

/** Both modes share exactly the same artwork; night changes only its colours. */
export function FlowingWaterBackground({ paused = false, background }: { paused?: boolean; background: WaterBackground }) {
  return background === 'diffuse' ? <DiffuseWaterBackground paused={paused} /> : <PaintedWaterBackground paused={paused} />;
}

function PaintedWaterBackground({ paused }: { paused: boolean }) {
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
  return <div className="flowing-water-background" data-background="watercolour" aria-hidden="true" data-paused={paused || hidden || reduced}
    data-renderer={flowState === 'fallback' || reduced ? 'fallback' : 'webgl'} data-flow-state={reduced ? 'fallback' : flowState}>
    <WaterNightPalette />
    <img ref={imageRef} className="flowing-water-image" src="/flowing-water-day.png" alt="" decoding="async" fetchPriority="high" />
    <canvas key={String(reduced)} ref={canvasRef} className="flowing-water-canvas" data-flow-period-ms={FLOW_PERIOD_MS} />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

function WaterNightPalette() {
  return <svg className="flowing-water-palette" width="0" height="0" focusable="false">
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
    </svg>;
}

function DiffuseWaterBackground({ paused }: { paused: boolean }) {
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keep the loaded rendition through rotation/resizes; changing theme must not
  // download a different movie or restart its phase.
  const [source] = useState(() => matchMedia('(max-width: 760px)').matches
    ? '/flowing-water-diffuse-mobile.mp4' : '/flowing-water-diffuse.mp4');
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopped = paused || hidden || reduced;
  const stoppedRef = useRef(stopped);
  stoppedRef.current = stopped;
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => {
      // Reduced motion removes the media element. Its eventual replacement must
      // keep the poster visible until that new element has a decoded frame.
      if (preference.matches) setReady(false);
      setReduced(preference.matches);
    };
    document.addEventListener('visibilitychange', visibility);
    preference.addEventListener('change', motion);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      preference.removeEventListener('change', motion);
    };
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    if (stopped) video.pause();
    else void video.play().catch(error => {
      if (!cancelled && !stoppedRef.current && error?.name !== 'AbortError') setFailed(true);
    });
    return () => { cancelled = true; video.pause(); };
  }, [stopped, reduced, failed]);
  const playing = ready && !failed && !reduced;
  return <div className="flowing-water-background" data-background="diffuse" aria-hidden="true"
    data-paused={stopped} data-renderer={playing ? 'video' : 'fallback'}
    data-flow-state={playing ? stopped ? 'paused' : 'running' : 'fallback'}>
    <WaterNightPalette />
    <img className="flowing-water-image" src="/flowing-water-diffuse-poster.jpg" alt="" decoding="async" fetchPriority="high" />
    {!reduced && !failed && <video ref={videoRef} className="flowing-water-video" src={source}
      muted loop playsInline preload="auto" disablePictureInPicture tabIndex={-1} data-flow-period-ms="24000"
      onPlaying={event => {
        const video = event.currentTarget;
        if (video !== videoRef.current) return;
        if (stoppedRef.current) video.pause();
        else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
      }}
      onError={event => { if (event.currentTarget === videoRef.current) setFailed(true); }} />}
  </div>;
}

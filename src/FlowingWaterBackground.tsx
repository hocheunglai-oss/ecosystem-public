import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { drawWaterNightStill } from './waterNightPalette';
import { createVideoNightPalette } from './flowingWaterVideoPalette';
import { createFlowingWaterRenderer, FLOW_PERIOD_MS } from './flowingWaterRenderer';
import type { FlowingWaterRenderer } from './flowingWaterRenderer';
import type { WaterBackground } from './backgroundPreference';

/** Both modes share exactly the same artwork; night changes only its colours. */
export function FlowingWaterBackground({ paused = false, background }: { paused?: boolean; background: WaterBackground }) {
  return background === 'diffuse' ? <DiffuseWaterBackground paused={paused} /> : <PaintedWaterBackground paused={paused} />;
}

function PaintedWaterBackground({ paused }: { paused: boolean }) {
  const night = useNightPalette();
  const nightRef = useRef(night); nightRef.current = night;
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
    update(); // Catch preference changes between the initial render and subscription.
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
      rendererRef.current = createFlowingWaterRenderer(canvas, image, pausedRef.current, setFlowState, nightRef.current);
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
  useLayoutEffect(() => { rendererRef.current?.setNight(night); }, [night]);
  return <div className="flowing-water-background" data-background="watercolour" aria-hidden="true" data-paused={paused || hidden || reduced}
    data-renderer={flowState === 'fallback' || reduced ? 'fallback' : 'webgl'} data-flow-state={reduced ? 'fallback' : flowState}>
    <img ref={imageRef} className="flowing-water-image" src="/flowing-water-day.png" alt="" decoding="async" fetchPriority="high" />
    <NightStill imageRef={imageRef} />
    <canvas key={String(reduced)} ref={canvasRef} className="flowing-water-canvas" data-flow-period-ms={FLOW_PERIOD_MS} />
    <div className="flowing-water-sheen" />
    <div className="flowing-water-shade" />
  </div>;
}

function subscribeNightPalette(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const nightSnapshot = () => document.documentElement.dataset.theme === 'dark';
function useNightPalette() { return useSyncExternalStore(subscribeNightPalette, nightSnapshot, () => false); }

function NightStill({ imageRef }: { imageRef: RefObject<HTMLImageElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const image = imageRef.current, canvas = canvasRef.current;
    if (!image || !canvas) return;
    let cancelled = false;
    void image.decode().then(() => {
      if (!cancelled) setReady(drawWaterNightStill(canvas, image));
    }).catch(() => {});
    return () => { cancelled = true; canvas.width = canvas.height = 0; };
  }, [imageRef]);
  return <canvas ref={canvasRef} className="flowing-water-night-still" data-ready={ready} />;
}

function DiffuseWaterBackground({ paused }: { paused: boolean }) {
  const night = useNightPalette();
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keep the loaded rendition through rotation/resizes; changing theme must not
  // download a different movie or restart its phase.
  const [source] = useState(() => matchMedia('(max-width: 760px)').matches
    ? '/flowing-water-diffuse-mobile.mp4' : '/flowing-water-diffuse.mp4');
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const paletteCanvasRef = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef<ReturnType<typeof createVideoNightPalette>>(null);
  const [paletteReady, setPaletteReady] = useState(false);
  const stopped = paused || hidden || reduced;
  const stoppedRef = useRef(stopped);
  stoppedRef.current = stopped;
  const paletteStateRef = useRef({ night, stopped });
  paletteStateRef.current = { night, stopped };
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
    motion(); // Catch preference changes between the initial render and subscription.
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
  useLayoutEffect(() => {
    const canvas = paletteCanvasRef.current, video = videoRef.current;
    setPaletteReady(false);
    if (!canvas || !video) return;
    let cancelled = false;
    // StrictMode can clean up a mount before its real setup. Defer allocation so
    // that rehearsal never loses the WebGL context of the still-mounted canvas.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      paletteRef.current = createVideoNightPalette(canvas, video, setPaletteReady);
      const current = paletteStateRef.current;
      paletteRef.current?.setActive(current.night && !current.stopped, current.night);
    });
    return () => { cancelled = true; paletteRef.current?.destroy(); paletteRef.current = null; };
  }, [reduced, failed]);
  useLayoutEffect(() => {
    paletteRef.current?.setActive(night && !stopped, night);
  }, [night, stopped, reduced, failed]);
  const playing = ready && !failed && !reduced && (!night || paletteReady);
  return <div className="flowing-water-background" data-background="diffuse" aria-hidden="true"
    data-paused={stopped} data-night-ready={paletteReady} data-renderer={playing ? 'video' : 'fallback'}
    data-flow-state={playing ? stopped ? 'paused' : 'running' : 'fallback'}>
    <img ref={imageRef} className="flowing-water-image" src="/flowing-water-diffuse-poster.jpg" alt="" decoding="async" fetchPriority="high" />
    <NightStill imageRef={imageRef} />
    {!reduced && !failed && <video ref={videoRef} className="flowing-water-video" src={source}
      muted loop playsInline preload="auto" disablePictureInPicture tabIndex={-1} data-flow-period-ms="24000"
      onPlaying={event => {
        const video = event.currentTarget;
        if (video !== videoRef.current) return;
        if (stoppedRef.current) video.pause();
        else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
      }}
      onError={event => { if (event.currentTarget === videoRef.current) setFailed(true); }} />}
    <canvas key={`${reduced}-${failed}`} ref={paletteCanvasRef} className="flowing-water-video-palette" />
  </div>;
}

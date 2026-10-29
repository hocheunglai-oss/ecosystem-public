import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { drawWaterNightStill } from './waterNightPalette';
import { createVideoNightPalette } from './flowingWaterVideoPalette';
import type { WaterBackground } from './backgroundPreference';

const backgroundMedia = {
  diffuse: {
    desktop: '/flowing-water-diffuse.mp4', mobile: '/flowing-water-diffuse-mobile.mp4',
    poster: '/flowing-water-diffuse-poster.jpg', periodMs: 24000,
  },
  watercolour: {
    desktop: '/flowing-water-watercolour.mp4', mobile: '/flowing-water-watercolour-mobile.mp4',
    poster: '/flowing-water-watercolour-poster.jpg', periodMs: 6000,
  },
} as const;

/** Each choice shares one video and playback phase between day and night. */
export function FlowingWaterBackground({ paused = false, background }: { paused?: boolean; background: WaterBackground }) {
  // Reset media and its matching still only when choosing different artwork.
  // A theme change must keep the existing element, rendition and playback time.
  return <VideoWaterBackground key={background} paused={paused} background={background} />;
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

function VideoWaterBackground({ paused, background }: { paused: boolean; background: WaterBackground }) {
  const media = backgroundMedia[background];
  const night = useNightPalette();
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keep the loaded rendition through rotation/resizes; changing theme must not
  // download a different movie or restart its phase.
  const [source] = useState(() => matchMedia('(max-width: 760px)').matches
    ? media.mobile : media.desktop);
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
  return <div className="flowing-water-background" data-background={background} aria-hidden="true"
    data-paused={stopped} data-night-ready={paletteReady} data-renderer={playing ? 'video' : 'fallback'}
    data-flow-state={playing ? stopped ? 'paused' : 'running' : 'fallback'}>
    <img ref={imageRef} className="flowing-water-image" src={media.poster} alt="" decoding="async" fetchPriority="high" />
    <NightStill imageRef={imageRef} />
    {!reduced && !failed && <video ref={videoRef} className="flowing-water-video" src={source}
      muted loop playsInline preload="auto" disablePictureInPicture tabIndex={-1} data-flow-period-ms={media.periodMs}
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

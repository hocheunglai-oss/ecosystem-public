import { WATER_NIGHT_GLSL } from './waterNightPalette';

/** Decorative only: one fixed picture, with a bounded periodic displacement inside it. */
export const FLOW_PERIOD_MS = 48_000;

type FlowState = 'running' | 'paused' | 'fallback';
export type FlowingWaterRenderer = { setPaused: (paused: boolean) => void; setNight: (night: boolean) => void; destroy: () => void };

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_image;
uniform vec2 u_cover;
uniform float u_phase;
uniform float u_night;
varying vec2 v_uv;
${WATER_NIGHT_GLSL}
void main() {
  vec2 p = v_uv;
  float s = sin(u_phase);
  float c = cos(u_phase) - 1.0;
  float s2 = sin(2.0 * u_phase);
  float c2 = cos(2.0 * u_phase) - 1.0;
  // Different points travel around small, smooth orbits, rather than panning a layer.
  vec2 flow = vec2(
    s * sin(6.0 * p.y + 1.2 * p.x) + c * 0.65 * cos(4.0 * p.y - 3.0 * p.x),
    c * sin(5.0 * p.x - 0.6 * p.y) - s * 0.65 * cos(4.0 * p.y + 2.0 * p.x)
  ) + 0.22 * vec2(s2 * sin(9.0 * p.y + 2.0 * p.x), c2 * cos(7.0 * p.x - 1.5 * p.y));
  // The outer frame never moves. All harmonics meet with matching velocity at 48s.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), p) * smoothstep(vec2(0.0), vec2(0.12), 1.0 - p);
  vec2 warped = p + edge.x * edge.y * vec2(0.018, 0.014) * flow;
  // Match the still image's centered cover crop without adding a zoom or inset.
  vec2 uv = 0.5 + (warped - 0.5) * u_cover;
  vec4 source = texture2D(u_image, uv);
  gl_FragColor = u_night > 0.5 ? waterNight(source) : source;
}`;

/** Returns null on unsupported graphics; the caller's original image stays visible. */
export function createFlowingWaterRenderer(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  initiallyPaused: boolean,
  onState: (state: FlowState) => void,
  initiallyNight = false,
): FlowingWaterRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'low-power',
  });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let texture: WebGLTexture | null = null;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  let stopped = true;
  let request = 0;
  let previousTimestamp: number | undefined;
  let elapsed = 0;
  let lastDrawTime = -Infinity;
  let frame = 0;

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(request);
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('webglcontextlost', lost);
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    // Release this decorative context rather than retaining GPU resources offscreen.
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  const lost = (event: Event) => {
    event.preventDefault();
    destroy();
    onState('fallback');
  };

  let phaseLocation: WebGLUniformLocation | null;
  let coverLocation: WebGLUniformLocation | null;
  let nightLocation: WebGLUniformLocation | null;
  const draw = () => {
    if (disposed) return;
    gl.uniform1f(phaseLocation, (elapsed % FLOW_PERIOD_MS) / FLOW_PERIOD_MS * Math.PI * 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    canvas.dataset.flowFrame = String(++frame);
    canvas.dataset.flowTimeMs = elapsed.toFixed(3);
    lastDrawTime = elapsed;
  };
  function resize() {
    if (disposed) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    // Preserve native source detail while bounding high-DPI desktop GPU work.
    const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (width * height)));
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width === pixelWidth && canvas.height === pixelHeight && frame) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    gl!.viewport(0, 0, pixelWidth, pixelHeight);
    const viewAspect = width / height;
    const imageAspect = image.naturalWidth / image.naturalHeight;
    gl!.uniform2f(coverLocation, Math.min(1, viewAspect / imageAspect), Math.min(1, imageAspect / viewAspect));
    draw();
  }
  const tick = (timestamp: number) => {
    if (disposed || stopped) return;
    if (previousTimestamp !== undefined) elapsed += timestamp - previousTimestamp;
    previousTimestamp = timestamp;
    // RAF synchronizes with paint; limit this decorative surface to 30 actual draws/s.
    if (elapsed - lastDrawTime >= 1000 / 30 - 0.5) draw();
    request = requestAnimationFrame(tick);
  };
  const setPaused = (paused: boolean) => {
    if (disposed) return;
    cancelAnimationFrame(request);
    stopped = paused;
    previousTimestamp = undefined;
    onState(paused ? 'paused' : 'running');
    if (!paused) request = requestAnimationFrame(tick);
  };

  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Decorative shader unavailable');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
    }
    program = gl.createProgram();
    if (!program) throw new Error('Decorative program unavailable');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Decorative program unsupported');
    gl.useProgram(program);
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!buffer || !texture) throw new Error('Decorative resources unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Decorative texture unavailable');
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
    phaseLocation = gl.getUniformLocation(program, 'u_phase');
    coverLocation = gl.getUniformLocation(program, 'u_cover');
    nightLocation = gl.getUniformLocation(program, 'u_night');
    gl.uniform1f(nightLocation, initiallyNight ? 1 : 0);
    canvas.dataset.flowPeriodMs = String(FLOW_PERIOD_MS);
    canvas.addEventListener('webglcontextlost', lost);
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('resize', resize);
    resize();
    setPaused(initiallyPaused);
    const setNight = (night: boolean) => {
      if (disposed) return;
      gl.uniform1f(nightLocation, night ? 1 : 0);
      draw(); // Recolour this exact frame without resetting elapsed animation time.
    };
    return { setPaused, setNight, destroy };
  } catch {
    destroy();
    return null;
  }
}

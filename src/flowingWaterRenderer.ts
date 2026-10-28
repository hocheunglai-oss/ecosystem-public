/** A fixed, softly lit water surface. No image translation, scaling or UV distortion. */
export const FLOW_PERIOD_MS = 48_000;
export const FLOW_SCENE_ASPECT = 2400 / 1132;

type FlowState = 'running' | 'paused' | 'fallback';
export type FlowingWaterRenderer = { setPaused: (paused: boolean) => void; destroy: () => void };

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
uniform vec2 u_cover;
uniform float u_phase;
varying vec2 v_uv;
// Analytic slopes of ten shallow waves. Integer time harmonics make the surface
// and its velocity identical at either end of the 48-second cycle.
vec2 waveSlope(vec2 p, vec2 direction, float amplitude, float harmonic, float offset) {
  return amplitude * direction * cos(dot(direction, p) + harmonic * u_phase + offset);
}
vec3 waterColour(vec2 p) {
  // Continuous colour fields retain the reference's quiet, anchored bands.
  float y = 1.0 - p.y;
  float boundary = y + 0.009 * sin(p.x * 5.0 + 0.4) + 0.004 * cos(p.x * 10.0);
  vec3 colour = vec3(90.0,185.0,159.0) / 255.0;
  colour = mix(colour, vec3(77.0,145.0,132.0) / 255.0, smoothstep(0.045,0.175,boundary));
  colour = mix(colour, vec3(97.0,192.0,163.0) / 255.0, smoothstep(0.285,0.405,boundary));
  colour = mix(colour, vec3(91.0,173.0,174.0) / 255.0, smoothstep(0.555,0.620,boundary));
  colour = mix(colour, vec3(135.0,189.0,228.0) / 255.0, smoothstep(0.690,0.765,boundary));
  colour = mix(colour, vec3(160.0,204.0,241.0) / 255.0, smoothstep(0.810,1.0,boundary));
  return colour;
}
void main() {
  vec2 p = 0.5 + (v_uv - 0.5) * u_cover;
  vec2 surface = vec2(p.x * 2.12, p.y);
  vec2 slope = waveSlope(surface,vec2(1.3,10.0),0.008,1.0,0.2)
    + waveSlope(surface,vec2(-0.8,19.0),0.004,1.0,1.6)
    + waveSlope(surface,vec2(1.7,32.0),0.0018,2.0,3.0)
    + waveSlope(surface,vec2(-1.9,6.0),0.010,1.0,4.1)
    + waveSlope(surface,vec2(0.7,47.0),0.0007,2.0,2.4)
    + waveSlope(surface,vec2(-1.1,65.0),0.00035,3.0,5.4)
    + waveSlope(surface,vec2(6.0,56.0),0.0014,1.0,0.9)
    + waveSlope(surface,vec2(-4.0,78.0),0.0010,2.0,3.3)
    + waveSlope(surface,vec2(3.0,110.0),0.00055,2.0,1.1)
    + waveSlope(surface,vec2(-7.0,145.0),0.00035,3.0,4.7);
  vec3 normal = normalize(vec3(-slope.x,1.0,-slope.y));
  vec3 viewDirection = normalize(vec3(0.0,0.65,0.76));
  vec3 reflection = reflect(-viewDirection,normal);
  // Broad reflected light gives depth without sharp glints, caustics or foam.
  float sky = pow(max(dot(reflection,normalize(vec3(0.12,0.86,-0.50))),0.0),10.0);
  float distantLight = pow(max(dot(reflection,normalize(vec3(-0.42,0.45,-0.78))),0.0),18.0);
  float light = (sky - 0.54) * 0.100 + (distantLight - 0.16) * 0.045;
  float nearWater = 1.0 - smoothstep(0.22,0.52,p.y);
  light *= mix(0.46,1.0,nearWater);
  vec3 colour = waterColour(p) + light * vec3(0.78,0.94,1.0);
  gl_FragColor = vec4(clamp(colour,0.0,1.0),1.0);
}
`;

/** Returns null on unsupported graphics; the phase-zero still stays visible. */
export function createFlowingWaterRenderer(
  canvas: HTMLCanvasElement,
  initiallyPaused: boolean,
  onState: (state: FlowState) => void,
): FlowingWaterRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'low-power',
  });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
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
    // Keep the procedural surface sharp while bounding high-DPI desktop GPU work.
    const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (width * height)));
    const pixelWidth = Math.max(1, Math.round(width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width === pixelWidth && canvas.height === pixelHeight && frame) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    gl!.viewport(0, 0, pixelWidth, pixelHeight);
    const viewAspect = width / height;
    const imageAspect = FLOW_SCENE_ASPECT;
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
    if (!buffer) throw new Error('Decorative resources unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Decorative surface unavailable');
    phaseLocation = gl.getUniformLocation(program, 'u_phase');
    coverLocation = gl.getUniformLocation(program, 'u_cover');
    canvas.dataset.flowPeriodMs = String(FLOW_PERIOD_MS);
    canvas.addEventListener('webglcontextlost', lost);
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('resize', resize);
    resize();
    setPaused(initiallyPaused);
    return { setPaused, destroy };
  } catch {
    destroy();
    return null;
  }
}

/** A depth-tested ocean mesh with two opposing wave trains and a fixed camera. */
export const FLOW_PERIOD_MS = 48_000;
export const FLOW_SCENE_ASPECT = 2400 / 1132;

type FlowState = 'running' | 'paused' | 'fallback';
export type FlowingWaterRenderer = { setPaused: (paused: boolean) => void; destroy: () => void };

const SURFACE = `
uniform float u_phase;
// Counter-propagating curved wave trains. The integer time harmonics close
// both height and velocity at 48 seconds. These are actual mesh elevations.
float waterHeight(vec2 p) {
  float meeting = p.y + 0.20 * sin(p.x * 0.75 + 0.16 * sin(u_phase));
  float north = smoothstep(-0.55, 0.55, meeting);
  float a = p.y * 11.0 + p.x * 1.45 + 0.95 * sin(p.x * 1.6 + u_phase) + 0.28 * sin(p.x * 5.3 - 2.0 * u_phase) + 2.0 * u_phase;
  float b = p.y * 13.0 - p.x * 1.70 + 0.80 * sin(p.x * 1.8 - u_phase) + 0.24 * sin(p.x * 4.5 + 2.0 * u_phase) - 2.0 * u_phase;
  float crestA = pow(0.5 + 0.5 * sin(a), 3.0);
  float crestB = pow(0.5 + 0.5 * sin(b), 3.0);
  float height = 0.145 * mix(0.24, 1.0, north) * (crestA - 0.3125)
    + 0.135 * mix(1.0, 0.24, north) * (crestB - 0.3125);
  height += 0.028 * sin(p.y * 5.5 + p.x * 0.9 + u_phase);
  height += 0.018 * sin(p.y * 23.0 + p.x * 3.8 + 0.6 * sin(p.x * 5.0 + u_phase) - 3.0 * u_phase);
  height += 0.009 * sin(p.y * 39.0 - p.x * 5.2 + 0.7 * sin(p.x * 7.0 - u_phase) + 4.0 * u_phase);
  return height;
}
`;

const VERTEX_SHADER = `
precision highp float;
attribute vec2 a_position;
uniform vec2 u_cover;
varying vec2 v_surface;
varying vec3 v_normal;
varying float v_height;
${SURFACE}
void main() {
  vec2 p = vec2(a_position.x * 2.12, a_position.y);
  float h = waterHeight(p);
  const float e = 0.002;
  float dx = (waterHeight(p + vec2(e,0.0)) - waterHeight(p - vec2(e,0.0))) / (2.0 * e);
  float dy = (waterHeight(p + vec2(0.0,e)) - waterHeight(p - vec2(0.0,e))) / (2.0 * e);
  v_surface = p;
  v_height = h;
  v_normal = normalize(vec3(-dx,-dy,1.0));
  // Fixed oblique camera. Elevation changes projected crests and depth ordering;
  // no image is sampled and neither the canvas nor camera moves.
  gl_Position = vec4(a_position.x / u_cover.x,
    (a_position.y + 0.52 * h) / u_cover.y,
    0.28 * a_position.y - 0.60 * h, 1.0);
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_phase;
varying vec2 v_surface;
varying vec3 v_normal;
varying float v_height;
void main() {
  vec2 p = v_surface;
  // Fine wavelets belong to the water surface, not a scrolling bitmap.
  vec2 detail = vec2(0.060 * cos(p.x * 20.0 + p.y * 62.0 + 1.4 * sin(p.x * 8.0 - u_phase) + 3.0 * u_phase),
                     0.075 * cos(p.x * 13.0 - p.y * 81.0 + 1.1 * sin(p.x * 11.0 + u_phase) - 4.0 * u_phase));
  vec3 normal = normalize(v_normal + vec3(detail,0.0));
  vec3 view = normalize(vec3(0.0,-0.52,1.0));
  vec3 light = normalize(vec3(-0.42,0.68,0.78));
  float boundary = p.y + 0.20 * sin(p.x * 0.75 + 0.16 * sin(u_phase));
  // Two water bodies retain their material colours while their meeting front
  // rises and recedes with the opposing swells.
  float jade = smoothstep(-0.38,0.45,boundary + 0.85 * v_height);
  vec3 colour = mix(vec3(0.53,0.77,0.91),vec3(0.075,0.58,0.57),jade);
  float diffuse = max(dot(normal,light),0.0);
  colour *= 0.78 + 0.30 * diffuse;
  float fresnel = pow(1.0 - max(dot(normal,view),0.0),3.0);
  float specular = pow(max(dot(normal,normalize(light + view)),0.0),65.0);
  colour = mix(colour,vec3(0.82,0.94,0.98),0.20 * fresnel);
  colour += specular * vec3(0.13,0.18,0.20);
  colour += smoothstep(0.045,0.13,v_height) * vec3(0.025,0.045,0.045);
  gl_FragColor = vec4(clamp(colour,0.0,1.0),1.0);
}
`;

// A continuous 384 × 256 grid, joined with degenerate strip vertices. A single
// native draw renders the complete depth-tested surface (197,630 vertices).
export const FLOW_MESH_COLUMNS = 384;
export const FLOW_MESH_ROWS = 256;
export const FLOW_MESH_VERTEX_COUNT = FLOW_MESH_ROWS * (FLOW_MESH_COLUMNS + 1) * 2 + (FLOW_MESH_ROWS - 1) * 2;
function createSurfaceMesh() {
  const points = new Float32Array(FLOW_MESH_VERTEX_COUNT * 2);
  let offset = 0;
  const point = (column: number, row: number) => {
    points[offset++] = (column / FLOW_MESH_COLUMNS * 2 - 1) * 1.12;
    points[offset++] = (row / FLOW_MESH_ROWS * 2 - 1) * 1.24;
  };
  for (let row = 0; row < FLOW_MESH_ROWS; row++) {
    if (row) point(0,row);
    for (let column = 0; column <= FLOW_MESH_COLUMNS; column++) { point(column,row); point(column,row + 1); }
    if (row < FLOW_MESH_ROWS - 1) point(FLOW_MESH_COLUMNS,row + 1);
  }
  return points;
}

/** Returns null on unsupported graphics; the phase-zero still stays visible. */
export function createFlowingWaterRenderer(
  canvas: HTMLCanvasElement,
  initiallyPaused: boolean,
  onState: (state: FlowState) => void,
): FlowingWaterRenderer | null {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: true, stencil: false,
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
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, FLOW_MESH_VERTEX_COUNT);
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
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.075, 0.58, 0.57, 1);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('Decorative resources unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, createSurfaceMesh(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Decorative surface unavailable');
    phaseLocation = gl.getUniformLocation(program, 'u_phase');
    coverLocation = gl.getUniformLocation(program, 'u_cover');
    canvas.dataset.flowPeriodMs = String(FLOW_PERIOD_MS);
    canvas.dataset.flowGeometry = 'layered-ocean-mesh';
    canvas.dataset.flowVertices = String(FLOW_MESH_VERTEX_COUNT);
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

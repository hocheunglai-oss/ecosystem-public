/** Two independently moving painted oceans; this is not a fluid simulation. */
export const FLOW_PERIOD_MS = 48_000;
export const FLOW_SCENE_ASPECT = 1672 / 941;
export const FLOW_MESH_COLUMNS = 384;
export const FLOW_MESH_ROWS = 96;
export const FLOW_LAYER_COUNT = 2;
export const FLOW_LAYER_VERTEX_COUNT = FLOW_MESH_ROWS * (FLOW_MESH_COLUMNS + 1) * 2 + (FLOW_MESH_ROWS - 1) * 2;
export const FLOW_MESH_VERTEX_COUNT = FLOW_LAYER_VERTEX_COUNT * FLOW_LAYER_COUNT;
const PAINTING_SOURCE = '/flowing-water-day.png';
const OVERLAP_MARGIN = .055;

type FlowState = 'running' | 'paused' | 'fallback';
export type FlowingWaterRenderer = { setPaused: (paused: boolean) => void; destroy: () => void };
type Layer = { buffer: WebGLBuffer };

// The single authored front follows the existing pale-blue crest. Geometry,
// UV and motion match the reviewed two-ocean prototype; only the distant sheet
// extends beneath the nearer sheet, so no duplicate crest is exposed.
const CREST = [475, 489, 516, 541, 565, 578, 591, 572, 556, 540, 554, 566, 511, 465, 443, 443, 435, 415].map(y => y / 941);
const LAYERS = [
  { direction: 1, front: 1, depth: .25, amplitude: 18, harmonic: 1 },
  { direction: -1, front: 0, depth: -.25, amplitude: 17, harmonic: 1 },
];
function curve(x: number, anchors: number[]) {
  const q = Math.min(1, Math.max(0, x)) * (anchors.length - 1), i = Math.min(anchors.length - 2, Math.floor(q)), t = q - i;
  const a = anchors[Math.max(0, i - 1)], b = anchors[i], c = anchors[i + 1], d = anchors[Math.min(anchors.length - 1, i + 2)];
  return .5 * (2*b + (-a+c)*t + (2*a-5*b+4*c-d)*t*t + (-a+3*b-3*c+d)*t*t*t);
}
function createStrip(index: number) {
  const points = new Float32Array(FLOW_LAYER_VERTEX_COUNT * 6);
  let offset = 0;
  const point = (column: number, row: number) => {
    const x = column / FLOW_MESH_COLUMNS, boundary = curve(x, CREST);
    const top = index ? boundary : 0, bottom = index ? 1 : boundary;
    // Original material only: the far sheet's margin remains under the near
    // sheet throughout their approach-and-return cycle.
    const start = top, end = index ? 1 : Math.min(1, boundary + OVERLAP_MARGIN);
    const y = start + (end - start) * row / FLOW_MESH_ROWS;
    const materialY = y;
    points[offset++] = x; points[offset++] = y;
    points[offset++] = (y - top) / (bottom - top);
    points[offset++] = index ? y - start : 1;
    points[offset++] = index ? 1 : end - y;
    points[offset++] = materialY;
  };
  for (let row = 0; row < FLOW_MESH_ROWS; row++) {
    if (row) point(0, row);
    for (let column = 0; column <= FLOW_MESH_COLUMNS; column++) { point(column, row); point(column, row + 1); }
    if (row < FLOW_MESH_ROWS - 1) point(FLOW_MESH_COLUMNS, row + 1);
  }
  return points;
}

const VERTEX_SHADER = `
precision highp float;
attribute vec3 a_material;
attribute vec3 a_margins;
uniform vec2 u_cover;
uniform vec2 u_viewport;
uniform float u_travel;
uniform float u_front;
uniform float u_depth;
uniform float u_curl;
uniform float u_phase;
varying vec2 v_uv;
varying vec2 v_margins;
varying float v_lip;
void main() {
  v_uv = vec2(a_material.x,a_margins.z);
  v_margins = a_margins.xy;
  float local = a_material.z;
  float distance = local - u_front;
  // Broad interiors stay almost still. Each physical strip has a separate
  // narrow front that rises/curls; shared source UVs do not slide underneath it.
  float front = exp(-0.5 * pow(distance / .15, 2.0));
  float lip = exp(-0.5 * pow(distance / .055, 2.0));
  float perimeter = smoothstep(0.0,.025,a_material.y)
    * (1.0-smoothstep(.975,1.0,a_material.y));
  float curvature = .92 + .08*cos(a_material.x*6.2831853 + u_phase);
  float movement = u_travel * front * perimeter * curvature;
  vec2 position = vec2(2.0*a_material.x-1.0,1.0-2.0*a_material.y) / u_cover;
  position.y -= 2.0*movement/u_viewport.y;
  float depth = u_depth - .075*u_curl*lip;
  gl_Position = vec4(position,depth,1.0);
  v_lip = lip*u_curl;
}`;
const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D u_painting;
varying vec2 v_uv;
varying vec2 v_margins;
varying float v_lip;
void main() {
  float alpha = smoothstep(0.0,.0045,v_margins.x)
    * smoothstep(0.0,.0045,v_margins.y);
  if (alpha < .001) discard;
  vec3 pigment = texture2D(u_painting,v_uv).rgb;
  // A bounded 2.5% crease shadow follows only the raised painted lip. At the
  // reference frame it is zero; there is no new gloss, colour or reflection.
  pigment *= 1.0-.025*v_lip;
  gl_FragColor = vec4(pigment,alpha);
}`;

/** Returns null on unsupported graphics; loading/failure keeps the original painting visible. */
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
  const layers: Layer[] = [];
  const image = new Image();
  image.decoding = 'async';
  let program: WebGLProgram | null = null;
  let texture: WebGLTexture | null = null;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  let ready = false;
  let stopped = initiallyPaused;
  let request = 0;
  let previousTimestamp: number | undefined;
  let elapsed = 0;
  let lastDrawTime = -Infinity;
  let frame = 0;
  let width = 0;
  let height = 0;
  const uniforms: Partial<Record<'cover' | 'viewport' | 'phase' | 'travel' | 'front' | 'depth' | 'curl', WebGLUniformLocation>> = {};

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(request);
    request = 0;
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('webglcontextlost', lost);
    for (const layer of layers) gl.deleteBuffer(layer.buffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  const lost = (event: Event) => {
    event.preventDefault();
    destroy();
    onState('fallback');
  };
  const publishState = () => {
    if (!disposed) onState(!ready || !frame ? 'fallback' : stopped ? 'paused' : 'running');
  };
  const bind = (layer: Layer) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  };
  const draw = () => {
    if (disposed || !ready) return;
    const phase = (elapsed % FLOW_PERIOD_MS) / FLOW_PERIOD_MS * Math.PI * 2;
    gl.uniform1f(uniforms.phase!, phase);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Two native draws, back to front. Each source-attached UV field belongs
    // to its own layer; no unmoving duplicate image is drawn under these fronts.
    for (let index = 0; index < layers.length; index++) {
      const spec = LAYERS[index];
      const amplitude = Math.max(4.5, Math.min(18, spec.amplitude * width / 1440));
      const wave = index === 0 ? (1-Math.cos(phase))*.5
        : .85*(1-Math.cos(phase))*.5+.15*(1-Math.cos(2*phase))*.5;
      const travel = spec.direction * amplitude * wave;
      const curl = (1-Math.cos(spec.harmonic*phase))*.5;
      bind(layers[index]);
      gl.uniform1f(uniforms.travel!, travel); gl.uniform1f(uniforms.front!, spec.front);
      gl.uniform1f(uniforms.depth!, spec.depth); gl.uniform1f(uniforms.curl!, curl);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, FLOW_LAYER_VERTEX_COUNT);
    }
    canvas.dataset.flowFrame = String(++frame);
    canvas.dataset.flowTimeMs = elapsed.toFixed(3);
    canvas.dataset.flowDrawsPerFrame = String(layers.length);
    lastDrawTime = elapsed;
  };
  const tick = (timestamp: number) => {
    request = 0;
    if (disposed || stopped || !ready || !frame) return;
    if (previousTimestamp !== undefined) elapsed += timestamp - previousTimestamp;
    previousTimestamp = timestamp;
    if (elapsed - lastDrawTime >= 1000 / 30 - 0.5) draw();
    request = requestAnimationFrame(tick);
  };
  function resize() {
    if (disposed || !ready) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (bounds.width * bounds.height)));
    const pixelWidth = Math.max(1, Math.round(bounds.width * scale));
    const pixelHeight = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width === pixelWidth && canvas.height === pixelHeight && width === bounds.width && height === bounds.height && frame) return;
    width = bounds.width; height = bounds.height;
    canvas.width = pixelWidth; canvas.height = pixelHeight;
    gl!.viewport(0, 0, pixelWidth, pixelHeight);
    const viewAspect = width / height;
    gl!.uniform2f(uniforms.cover!, Math.min(1, viewAspect / FLOW_SCENE_ASPECT), Math.min(1, FLOW_SCENE_ASPECT / viewAspect));
    gl!.uniform2f(uniforms.viewport!, width, height);
    draw();
    publishState();
    if (!stopped && !request) request = requestAnimationFrame(tick);
  }
  const setPaused = (paused: boolean) => {
    if (disposed) return;
    cancelAnimationFrame(request);
    request = 0;
    stopped = paused;
    previousTimestamp = undefined;
    publishState();
    if (ready && frame && !paused) request = requestAnimationFrame(tick);
  };
  const loadPainting = async () => {
    try {
      image.src = PAINTING_SOURCE;
      await image.decode();
      // Unmount/reduced motion/context loss may happen while decode is pending.
      // Never upload, publish state or schedule a frame after cleanup.
      if (disposed) return;
      if (image.naturalWidth !== 1672 || image.naturalHeight !== 941) throw new Error('Unexpected painting dimensions');
      texture = gl.createTexture();
      if (!texture) throw new Error('Decorative texture unavailable');
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.uniform1i(gl.getUniformLocation(program!, 'u_painting'), 0);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Decorative texture unavailable');
      ready = true;
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      window.addEventListener('resize', resize);
      resize();
      setPaused(stopped);
    } catch {
      if (disposed) return;
      destroy();
      onState('fallback');
    }
  };

  try {
    onState('fallback');
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Decorative shader unavailable');
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Decorative shader unsupported');
    }
    program = gl.createProgram();
    if (!program) throw new Error('Decorative program unavailable');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.bindAttribLocation(program, 0, 'a_material');
    gl.bindAttribLocation(program, 1, 'a_margins');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Decorative program unsupported');
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DITHER); gl.clearColor(0, 0, 0, 1);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
    for (let index = 0; index < FLOW_LAYER_COUNT; index++) {
      const buffer = gl.createBuffer();
      if (!buffer) throw new Error('Decorative mesh unavailable');
      layers.push({ buffer });
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, createStrip(index), gl.STATIC_DRAW);
    }
    for (const key of ['cover', 'viewport', 'phase', 'travel', 'front', 'depth', 'curl'] as const) {
      const location = gl.getUniformLocation(program, `u_${key}`);
      if (!location) throw new Error('Decorative uniform unavailable');
      uniforms[key] = location;
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Decorative surface unavailable');
    canvas.dataset.flowPeriodMs = String(FLOW_PERIOD_MS);
    canvas.dataset.flowGeometry = 'painted-layer-mesh';
    canvas.dataset.flowLayers = String(FLOW_LAYER_COUNT);
    canvas.dataset.flowVertices = String(FLOW_MESH_VERTEX_COUNT);
    canvas.dataset.flowVerticesPerLayer = String(FLOW_LAYER_VERTEX_COUNT);
    canvas.addEventListener('webglcontextlost', lost);
    void loadPainting();
    return { setPaused, destroy };
  } catch {
    destroy();
    return null;
  }
}

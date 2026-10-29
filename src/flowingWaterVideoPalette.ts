import { WATER_NIGHT_GLSL } from './waterNightPalette';

type VideoPalette = { setActive: (active: boolean, showFrame?: boolean) => void; destroy: () => void };

/** Colour-only pass over the current frame of the existing video. No second media
 * source, timeline, flow transform or CSS/SVG filter participates in night mode.
 */
export function createVideoNightPalette(
  canvas: HTMLCanvasElement, video: HTMLVideoElement, onReady: (ready: boolean) => void,
): VideoPalette | null {
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: 'low-power',
  });
  if (!gl) { canvas.dataset.paletteError = 'WebGL unavailable'; return null; }
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
  let resizeObserver: ResizeObserver | undefined;
  let active = false, visible = false, disposed = false, frameRequest = 0, animationRequest = 0, ready = false;
  let lastTime = -1, cover: WebGLUniformLocation | null = null;
  function cancel() {
    if (frameRequest) video.cancelVideoFrameCallback?.(frameRequest);
    if (animationRequest) cancelAnimationFrame(animationRequest);
    frameRequest = animationRequest = 0;
  }
  function destroy() {
    if (disposed) return;
    disposed = true; cancel(); resizeObserver?.disconnect();
    canvas.removeEventListener('webglcontextlost', lost);
    video.removeEventListener('loadeddata', wake);
    video.removeEventListener('seeked', wake);
    gl!.deleteTexture(texture); gl!.deleteBuffer(buffer); gl!.deleteProgram(program);
    for (const shader of shaders) gl!.deleteShader(shader);
    // Delete owned GPU resources; do not force context loss here. React's mount
    // rehearsal can reuse this same canvas immediately after cleanup.
  }
  function lost(event: Event) { event.preventDefault(); destroy(); onReady(false); }
  function draw(force = false, allowPaused = false) {
    if (disposed || (!active && !allowPaused) || video.readyState < 2 || !video.videoWidth) return;
    if (!force && lastTime === video.currentTime) return;
    try {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, video);
      if (gl!.getError() !== gl!.NO_ERROR) throw new Error('Video texture unavailable');
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      lastTime = video.currentTime;
      canvas.dataset.sourceTime = String(lastTime);
      if (!ready) { ready = true; onReady(true); }
    } catch (error) { canvas.dataset.paletteError = error instanceof Error ? error.message : 'Video frame unavailable'; destroy(); onReady(false); }
  }
  function resize() {
    if (disposed) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    // Decorative colour compositing is bounded on high-density phones/desktops.
    const scale = Math.min(devicePixelRatio || 1, 2, Math.sqrt(2_000_000 / (width * height)));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl!.viewport(0, 0, w, h);
    const view = width / height, source = (video.videoWidth || 1492) / (video.videoHeight || 704);
    gl!.uniform2f(cover, Math.min(1, view / source), Math.min(1, source / view));
    draw(true, visible);
  }
  function schedule() {
    if (disposed || !active) return;
    if (video.requestVideoFrameCallback) {
      frameRequest = video.requestVideoFrameCallback(() => { frameRequest = 0; draw(); schedule(); });
    } else {
      animationRequest = requestAnimationFrame(() => { animationRequest = 0; draw(); schedule(); });
    }
  }
  function wake() { if (visible && !disposed) { resize(); } }
  function setActive(next: boolean, showFrame = next) {
    if (disposed) return;
    cancel(); active = next; visible = showFrame;
    if (visible) resize();
    if (active) schedule();
  }
  try {
    const sources: readonly [number, string][] = [
      [gl.VERTEX_SHADER, 'attribute vec2 a_position; varying vec2 v_uv; void main(){v_uv=a_position*.5+.5;gl_Position=vec4(a_position,0.,1.);}'],
      [gl.FRAGMENT_SHADER, `precision highp float; uniform sampler2D u_image; uniform vec2 u_cover; varying vec2 v_uv;
        ${WATER_NIGHT_GLSL}
        void main(){gl_FragColor=waterNight(texture2D(u_image,.5+(v_uv-.5)*u_cover));}`],
    ];
    for (const [type, source] of sources) {
      const shader = gl.createShader(type); if (!shader) throw new Error('Shader unavailable');
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Palette shader unsupported');
    }
    program = gl.createProgram(); if (!program) throw new Error('Palette unavailable');
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.bindAttribLocation(program, 0, 'a_position'); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Palette unsupported');
    gl.useProgram(program); buffer = gl.createBuffer(); texture = gl.createTexture();
    if (!buffer || !texture) throw new Error('Palette resources unavailable');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.uniform1i(gl.getUniformLocation(program,'u_image'),0);
    cover = gl.getUniformLocation(program,'u_cover');
    canvas.addEventListener('webglcontextlost',lost);
    video.addEventListener('loadeddata',wake); video.addEventListener('seeked',wake);
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
    return { setActive, destroy };
  } catch (error) { canvas.dataset.paletteError = error instanceof Error ? error.message : 'Palette unavailable'; destroy(); return null; }
}

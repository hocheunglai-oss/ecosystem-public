import { useLayoutEffect, useRef } from "react";
import { waterMask } from "./renderer";
import { HARBOUR_ASSETS, decodedHarbourImage, loadHarbourImage } from "./harbourAssets";

const vertexSource = `attribute vec2 position;
varying vec2 screenUv;
void main() {
  screenUv = vec2((position.x + 1.) * .5, (1. - position.y) * .5);
  gl_Position = vec4(position, 0., 1.);
}`;

const fragmentSource = `precision highp float;
varying vec2 screenUv;
uniform sampler2D plate;
uniform sampler2D mask;
uniform vec4 crop;
uniform float time;
uniform float night;

float waterNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 part = fract(point);
  part = part * part * (3. - 2. * part);
  vec4 corners = vec4(dot(cell, vec2(127.1, 311.7)),
    dot(cell + vec2(1., 0.), vec2(127.1, 311.7)),
    dot(cell + vec2(0., 1.), vec2(127.1, 311.7)),
    dot(cell + vec2(1.), vec2(127.1, 311.7)));
  corners = fract(sin(corners) * 43758.5453);
  return mix(mix(corners.x, corners.y, part.x),
    mix(corners.z, corners.w, part.x), part.y);
}

// A soft patch on the water-facing side of a moored hull, not a moving wake.
// x is the patch envelope; y is distance out from the waterline.
vec2 hullWater(vec2 point, vec2 stern, vec2 bow) {
  vec2 edge = bow - stern;
  float span = length(edge);
  vec2 along = edge / span;
  vec2 offset = point - stern;
  float position = dot(offset, along);
  float outward = dot(offset, vec2(-along.y, along.x));
  float ends = smoothstep(-18., 12., position)
    * (1. - smoothstep(span - 12., span + 18., position));
  float side = smoothstep(-3., 5., outward)
    * (1. - smoothstep(12., 44., outward));
  return vec2(ends * side, outward);
}

void main() {
  vec2 uv = crop.xy + screenUv * crop.zw;
  float wet = texture2D(mask, uv).r;
  if (wet < .003) { gl_FragColor = vec4(0.); return; }
  vec2 resolution = vec2(1671., 941.);
  vec2 p = uv * resolution;
  float depth = smoothstep(.10, 1., uv.y);
  float swell = sin(p.x * .029 + p.y * .073 - time * .84);
  float cross = sin(p.x * .049 - p.y * .121 + time * 1.20);
  float ripple = sin(p.x * .087 + p.y * .58 - time * 2.25 + swell * .9);
  float fine = sin(p.x * .17 - p.y * .97 + time * 3.72 + cross * .7);
  // Alternating flow phases hide the texture reset and keep movement continuous.
  float current = fract(time / 12.);
  float currentB = fract(current + .5);
  float blend = 1. - abs(current * 2. - 1.);
  vec2 refraction = vec2(swell * 3.8 + cross * 1.7, ripple * 1.05 + swell * 1.8) * depth * wet;
  // Keep these waterlines aligned with the two stationary barge illustrations.
  vec2 bunkerHull = hullWater(p, vec2(940., 472.), vec2(1150., 522.));
  vec2 lngHull = hullWater(p, vec2(578., 378.), vec2(763., 426.));
  vec2 hull = bunkerHull.x > lngHull.x ? bunkerHull : lngHull;
  float brokenReflection = 0.;
  float hullGlint = 0.;
  if (hull.x > .001) {
    // Advected, overlapping noise breaks up reflections without visible rings,
    // parallel strokes or a periodic outline tracing the vessel.
    vec2 localFlow = vec2(p.x * .038 - time * .095, p.y * .13 + time * .07);
    float chop = waterNoise(localFlow);
    float detail = waterNoise(localFlow * 2.31 + vec2(time * .06, -time * .13));
    float patches = waterNoise(vec2(p.x * .061 + time * .04, p.y * .047 - time * .055));
    float irregular = chop * .65 + detail * .35;
    refraction += vec2((chop - .5) * 1.9, (detail - .5) * 1.1) * hull.x * wet;
    brokenReflection = hull.x * (1. - smoothstep(5., 28., hull.y))
      * (.025 + irregular * .09) * mix(.55, 1., patches);
    float crest = ripple * .32 + fine * .16 + irregular * .9;
    hullGlint = smoothstep(.68, 1.15, crest) * smoothstep(.3, .78, patches)
      * hull.x * .065;
  }
  vec2 drift = vec2(25., 8.) * depth * wet;
  vec2 sampleA = uv + (refraction - drift * (current - .5)) / resolution;
  vec2 sampleB = uv + (refraction - drift * (currentB - .5)) / resolution;
  float clearance = min(texture2D(mask, sampleA).r, texture2D(mask, sampleB).r);
  vec3 original = texture2D(plate, uv).rgb;
  vec3 flowing = mix(texture2D(plate, sampleB).rgb, texture2D(plate, sampleA).rgb, blend);
  vec3 water = mix(original, flowing, clearance);
  float light = (ripple * .028 + fine * .009 + swell * .011 + cross * .006) * depth;
  water += vec3(.56, .82, 1.) * light * mix(1., .34, night);
  float sun = smoothstep(.69, 1., uv.x) * smoothstep(.28, .85, uv.y);
  float glint = pow(max(0., ripple * .64 + fine * .36), 9.) * .19 * sun;
  water += mix(vec3(1., .84, .59), vec3(.5, .67, .9), night) * glint * mix(1., .24, night);
  // Reflected green hull colour stays fragmented and much dimmer after dark.
  water = mix(water, mix(vec3(.035, .23, .17), vec3(.017, .065, .065), night),
    brokenReflection * wet);
  water += mix(vec3(.62, .83, .88), vec3(.32, .49, .62), night)
    * hullGlint * mix(1., .36, night) * wet;
  // Transparent land lets the original full-resolution harbor remain untouched.
  gl_FragColor = vec4(water, wet);
}`;

function createSurface(canvas: HTMLCanvasElement, plate: HTMLImageElement, night: boolean) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) throw new Error("Water rendering unavailable");
  const shaders: WebGLShader[] = [];
  const textures: WebGLTexture[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!program || !buffer) throw new Error("Water rendering unavailable");
  const dispose = () => {
    textures.forEach((texture) => gl.deleteTexture(texture));
    shaders.forEach((shader) => gl.deleteShader(shader));
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Water rendering unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Water rendering unavailable");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Water rendering unavailable");
    gl.useProgram(program);
    gl.uniform1f(gl.getUniformLocation(program, "night"), night ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    [plate, waterMask(plate)].forEach((image, index) => {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Water rendering unavailable");
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      gl.uniform1i(
        gl.getUniformLocation(program, index ? "mask" : "plate"),
        index,
      );
    });
    const crop = gl.getUniformLocation(program, "crop");
    const time = gl.getUniformLocation(program, "time");
    return {
      resize(width: number, height: number) {
        // No device-pixel-ratio multiplier: only the water layer is downsampled.
        const quality = Math.min(
          1,
          1440 / width,
          1000 / height,
          Math.sqrt(900_000 / (width * height)),
        );
        canvas.width = Math.max(1, Math.round(width * quality));
        canvas.height = Math.max(1, Math.round(height * quality));
        gl.viewport(0, 0, canvas.width, canvas.height);
        const cover = Math.max(width / 1671, height / 941);
        const u = width / (1671 * cover),
          v = height / (941 * cover);
        gl.uniform4f(crop, (1 - u) / 2, (1 - v) / 2, u, v);
      },
      draw(seconds: number) {
        gl.uniform1f(time, seconds);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** One bounded GPU layer, with no traffic, per-frame React renders or image uploads. */
export function OceanSurface({ enabled, src = HARBOUR_ASSETS.light, night = false }: { enabled: boolean; src?: string; night?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !enabled) return;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let surface: ReturnType<typeof createSurface> | undefined;
    let frame = 0,
      activeSince = 0,
      elapsed = 0,
      lastDraw = -Infinity;
    let inView = true;
    const pause = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        elapsed += performance.now() - activeSince;
      }
    };
    const draw = (now: number) => {
      if (disposed || !surface) return;
      if (now - lastDraw >= 1000 / 24) {
        surface.draw((elapsed + now - activeSince) / 1000);
        lastDraw = now - ((now - lastDraw) % (1000 / 24) || 0);
      }
      frame = requestAnimationFrame(draw);
    };
    const update = () => {
      if (disposed || !surface) return;
      const permitted = !document.hidden && inView && !preference.matches;
      canvas.dataset.waterState = permitted ? "running" : "paused";
      canvas.style.opacity = preference.matches ? "0" : "1";
      if (permitted && !frame) {
        activeSince = performance.now();
        lastDraw = activeSince - 1000 / 24;
        frame = requestAnimationFrame(draw);
      } else if (!permitted) pause();
    };
    const resize = new ResizeObserver(([entry]) => {
      if (!surface || disposed) return;
      surface.resize(entry.contentRect.width, entry.contentRect.height);
      surface.draw(elapsed / 1000);
    });
    const visibility = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    const lost = (event: Event) => {
      event.preventDefault();
      pause();
      surface = undefined;
      canvas.dataset.waterState = "fallback";
      canvas.style.opacity = "0";
    };
    canvas.addEventListener("webglcontextlost", lost);
    document.addEventListener("visibilitychange", update);
    preference.addEventListener("change", update);
    visibility.observe(canvas);
    const initialize = (image: HTMLImageElement) => {
        if (disposed) return;
        surface = createSurface(canvas, image, night);
        canvas.dataset.waterPlate = src;
        const bounds = canvas.getBoundingClientRect();
        surface.resize(bounds.width, bounds.height);
        surface.draw(0);
        resize.observe(canvas);
        update();
    };
    const fallback = () => {
        if (!disposed) {
          canvas.dataset.waterState = "fallback";
          canvas.style.opacity = "0";
        }
    };
    const image = decodedHarbourImage(src);
    if (image) {
      try { initialize(image); } catch { fallback(); }
    } else {
      void loadHarbourImage(src).then(initialize).catch(fallback);
    }
    return () => {
      disposed = true;
      pause();
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", update);
      preference.removeEventListener("change", update);
      canvas.removeEventListener("webglcontextlost", lost);
      surface?.dispose();
      canvas.style.opacity = "0";
      canvas.dataset.waterState = "paused";
    };
  }, [enabled, src, night]);
  return (
    <canvas
      ref={ref}
      className="marine-world__water"
      data-water-state="static"
      aria-hidden="true"
    />
  );
}

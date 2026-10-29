/** The approved sunset colours, applied to source pixels rather than an SVG URL filter.
 * WebKit drops referenced SVG filters on accelerated video/WebGL layers (bug 322588).
 * Keep this contract shared by moving media and the reduced-motion/error still.
 */
export const WATER_NIGHT_MATRIX = [
  -0.315127, 4.299968, -1.352730, 0, -1.626157,
  0.626944, 1.519584, 0.002427, 0, -0.794092,
  0.386135, -3.250374, 1.438371, 0, 1.762207,
  0, 0, 0, 1, 0,
] as const;
export const WATER_NIGHT_CHANNELS = [[0.035, 0.540], [0.025, 0.300], [0.065, 0.440]] as const;

export const WATER_NIGHT_GLSL = `
vec4 waterNight(vec4 source) {
  vec3 mapped = clamp(vec3(
    dot(source.rgb, vec3(${WATER_NIGHT_MATRIX.slice(0, 3).join(',')})) + ${WATER_NIGHT_MATRIX[4]},
    dot(source.rgb, vec3(${WATER_NIGHT_MATRIX.slice(5, 8).join(',')})) + ${WATER_NIGHT_MATRIX[9]},
    dot(source.rgb, vec3(${WATER_NIGHT_MATRIX.slice(10, 13).join(',')})) + ${WATER_NIGHT_MATRIX[14]}
  ), 0.0, 1.0);
  return vec4(mix(vec3(${WATER_NIGHT_CHANNELS.map(c => c[0]).join(',')}),
    vec3(${WATER_NIGHT_CHANNELS.map(c => c[1]).join(',')}), mapped), source.a);
}`;

/** One bounded conversion per loaded still; works when WebGL is unavailable. */
export function drawWaterNightStill(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data, matrix = WATER_NIGHT_MATRIX;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    for (let channel = 0; channel < 3; channel++) {
      const row = channel * 5, [low, high] = WATER_NIGHT_CHANNELS[channel];
      const value = Math.max(0, Math.min(1, r * matrix[row] + g * matrix[row + 1] + b * matrix[row + 2] + matrix[row + 4]));
      data[i + channel] = (low + value * (high - low)) * 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return true;
}

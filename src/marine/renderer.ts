import {
  SCENE_WIDTH as W,
  SCENE_HEIGHT as H,
  LOOP_SECONDS,
  passingShip,
  launch,
  receivingShip,
  bunkerBarge,
  waterPhase,
  type VesselPose,
} from "./scene";

const vertex = `attribute vec2 position; varying vec2 uv;
void main(){uv=vec2((position.x+1.)*.5,(1.-position.y)*.5);gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision highp float;
varying vec2 uv; uniform sampler2D plate; uniform sampler2D mask; uniform float phase;
void main(){
  vec3 original=texture2D(plate,uv).rgb;
  float wet=texture2D(mask,uv).r;
  float depth=smoothstep(.10,1.,uv.y);
  vec2 p=uv*vec2(1672.,940.);
  // Every temporal frequency is an integer multiple of the 120-second cycle.
  float swell=sin(p.x*.029+p.y*.073-phase*16.);
  float cross=sin(p.x*.049-p.y*.121+phase*23.);
  float ripple=sin(p.x*.087+p.y*.58-phase*43.+swell*.9);
  float fine=sin(p.x*.17-p.y*.97+phase*71.+cross*.7);
  // Two overlapping flow phases keep the surface travelling continuously.
  // Their weights vanish at reset, so the texture never snaps backwards.
  float current=fract(phase/6.28318530718*10.);
  float currentB=fract(current+.5);
  float blend=1.-abs(current*2.-1.);
  vec2 resolution=vec2(1672.,940.);
  vec2 refraction=vec2(swell*3.8+cross*1.7,ripple*1.05+swell*1.8)*depth*wet;
  vec2 drift=vec2(25.,8.)*depth*wet;
  vec2 sampleA=uv+(refraction-drift*(current-.5))/resolution;
  vec2 sampleB=uv+(refraction-drift*(currentB-.5))/resolution;
  // Shorelines stay protected even when the displaced sample approaches land.
  float clearance=min(texture2D(mask,sampleA).r,texture2D(mask,sampleB).r);
  vec3 moving=mix(texture2D(plate,sampleB).rgb,texture2D(plate,sampleA).rgb,blend);
  vec3 water=mix(original,moving,clearance);
  float light=(ripple*.028+fine*.009+swell*.011+cross*.006)*depth*wet;
  water+=vec3(.56,.82,1.)*light;
  // Small sunlight glints are concentrated in the existing reflection on the right.
  float sun=smoothstep(.69,1.,uv.x)*smoothstep(.28,.85,uv.y);
  float glint=pow(max(0.,ripple*.64+fine*.36),9.)*.19*sun*wet;
  water+=vec3(1.,.84,.59)*glint;
  gl_FragColor=vec4(mix(original,water,wet),1.);
}`;

function canvas(w = W, h = H) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function context(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  return ctx;
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`Could not load marine asset: ${src}`));
    img.src = src;
  });
}

/** Shoreline protection. The plate remains perfectly still outside open water. */
export function waterMask(plate: HTMLImageElement) {
  const c = canvas(),
    ctx = context(c);
  ctx.drawImage(plate, 0, 0, W, H);
  const pixels = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = pixels.data[i] / 255,
      g = pixels.data[i + 1] / 255,
      b = pixels.data[i + 2] / 255;
    const blue =
      Math.max(0, Math.min(1, (b - r - 0.03) * 9)) *
      Math.max(0, Math.min(1, (b - g + 0.025) * 14));
    pixels.data[i] =
      pixels.data[i + 1] =
      pixels.data[i + 2] =
        Math.round(blue * 255);
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  ctx.fillStyle = "#000";
  const land = [
    // Sky and distant land; mountain island in the upper centre.
    [
      [0, 0],
      [1672, 0],
      [1672, 96],
      [1435, 92],
      [1385, 116],
      [1350, 133],
      [1240, 119],
      [1100, 100],
      [1055, 132],
      [979, 150],
      [872, 159],
      [780, 160],
      [701, 177],
      [651, 189],
      [577, 179],
      [520, 187],
      [421, 184],
      [397, 176],
      [417, 150],
      [470, 134],
      [491, 114],
      [521, 111],
      [555, 126],
      [623, 99],
      [620, 94],
      [0, 103],
    ],
    // Main harbour island, all cranes, ships at berth and the breakwater.
    [
      [507, 305],
      [519, 280],
      [539, 280],
      [550, 302],
      [629, 296],
      [632, 309],
      [619, 326],
      [659, 335],
      [679, 309],
      [703, 286],
      [759, 268],
      [786, 263],
      [784, 237],
      [820, 234],
      [841, 251],
      [870, 239],
      [894, 243],
      [925, 270],
      [975, 265],
      [986, 221],
      [1014, 200],
      [1041, 219],
      [1077, 198],
      [1107, 178],
      [1107, 133],
      [1121, 133],
      [1128, 174],
      [1170, 171],
      [1200, 194],
      [1235, 200],
      [1263, 226],
      [1276, 259],
      [1308, 279],
      [1344, 260],
      [1364, 267],
      [1368, 249],
      [1380, 249],
      [1388, 276],
      [1441, 268],
      [1461, 290],
      [1501, 302],
      [1550, 311],
      [1570, 340],
      [1626, 347],
      [1672, 339],
      [1672, 424],
      [1641, 430],
      [1660, 458],
      [1645, 478],
      [1603, 470],
      [1560, 475],
      [1514, 445],
      [1469, 446],
      [1390, 461],
      [1371, 507],
      [1422, 521],
      [1449, 514],
      [1475, 529],
      [1487, 558],
      [1491, 510],
      [1507, 510],
      [1510, 558],
      [1562, 577],
      [1524, 603],
      [1480, 590],
      [1436, 556],
      [1350, 537],
      [1280, 537],
      [1216, 511],
      [1180, 481],
      [1093, 455],
      [1017, 434],
      [960, 430],
      [903, 414],
      [850, 399],
      [849, 383],
      [875, 375],
      [875, 350],
      [891, 326],
      [896, 325],
      [903, 364],
      [921, 369],
      [934, 348],
      [950, 348],
      [956, 380],
      [995, 385],
      [995, 409],
      [1052, 433],
      [1045, 447],
      [974, 420],
      [919, 405],
      [850, 399],
      [778, 365],
      [744, 372],
      [700, 372],
      [737, 389],
      [731, 403],
      [698, 404],
      [594, 362],
      [596, 346],
      [614, 337],
      [612, 314],
      [552, 319],
    ],
    // Foreground island and marina, including submerged rocks.
    [
      [0, 654],
      [35, 620],
      [88, 610],
      [118, 582],
      [163, 586],
      [182, 560],
      [226, 539],
      [263, 549],
      [286, 574],
      [316, 587],
      [350, 604],
      [382, 628],
      [425, 646],
      [453, 674],
      [474, 696],
      [451, 716],
      [416, 722],
      [420, 754],
      [378, 778],
      [338, 799],
      [288, 807],
      [248, 837],
      [189, 826],
      [152, 806],
      [108, 792],
      [66, 777],
      [0, 755],
    ],
    // Far right port / headland.
    [
      [1322, 157],
      [1361, 134],
      [1400, 134],
      [1432, 91],
      [1478, 87],
      [1527, 98],
      [1557, 118],
      [1608, 116],
      [1640, 89],
      [1672, 88],
      [1672, 231],
      [1612, 229],
      [1556, 217],
      [1490, 212],
      [1436, 197],
      [1390, 184],
      [1379, 176],
      [1322, 178],
    ],
    [
      [0, 390],
      [31, 386],
      [52, 398],
      [62, 409],
      [92, 415],
      [114, 438],
      [63, 443],
      [0, 433],
    ],
    [
      [164, 410],
      [192, 407],
      [209, 421],
      [201, 435],
      [168, 433],
    ],
    [
      [673, 212],
      [700, 204],
      [721, 208],
      [749, 219],
      [732, 229],
      [689, 225],
    ],
    [
      [387, 168],
      [395, 160],
      [408, 170],
      [404, 178],
      [386, 177],
    ],
  ];
  for (const points of land) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
  const softened = canvas();
  const soft = context(softened);
  soft.filter = "blur(1.8px)";
  soft.drawImage(c, 0, 0);
  return softened;
}

function shader(gl: WebGLRenderingContext, type: number, code: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, code);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "Marine shader failed");
  return s;
}
function ocean(plate: HTMLImageElement, mask: HTMLCanvasElement) {
  const c = canvas(),
    gl = c.getContext("webgl", {
      alpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
  if (!gl) throw new Error("WebGL is required to render the marine film");
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error("Could not link marine shader");
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const pos = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  [plate, mask].forEach((image, i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(gl.getUniformLocation(program, i ? "mask" : "plate"), i);
  });
  const time = gl.getUniformLocation(program, "phase");
  return {
    canvas: c,
    draw(t: number) {
      gl.uniform1f(time, waterPhase(t));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
  };
}

function wake(ctx: CanvasRenderingContext2D, pose: VesselPose, t: number) {
  if (pose.speed < 0.02) return;
  const w = pose.width,
    length = w * (pose.speed + 0.55),
    angle = pose.heading;
  ctx.save();
  ctx.translate(pose.x, pose.y + w * 0.105);
  ctx.rotate(angle);
  const start = -w * 0.4;
  // Narrow propeller turbulence trails away from the stern, never the bow.
  const wash = ctx.createLinearGradient(start, 0, start - length, 0);
  wash.addColorStop(0, "rgba(210,238,235,.52)");
  wash.addColorStop(0.17, "rgba(172,223,231,.26)");
  wash.addColorStop(0.65, "rgba(139,206,222,.08)");
  wash.addColorStop(1, "rgba(140,207,222,0)");
  ctx.save();
  ctx.filter = "blur(1.25px)";
  ctx.strokeStyle = wash;
  ctx.lineWidth = w * 0.055;
  ctx.beginPath();
  ctx.moveTo(start, 0);
  ctx.lineTo(start - length, 0);
  ctx.stroke();
  ctx.restore();
  for (let side = -1; side <= 1; side += 2) {
    for (let lane = 0; lane < 3; lane++) {
      ctx.beginPath();
      for (let j = 0; j <= 70; j++) {
        const q = j / 70,
          x = start - length * q;
        const y =
          side * (w * 0.026 + q * w * (0.15 + lane * 0.018)) +
          Math.sin(q * 38 - waterPhase(t) * 40 + lane) * q * w * 0.003;
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = wash;
      ctx.lineWidth = ((0.8 - lane * 0.19) * w) / 100;
      ctx.stroke();
    }
  }
  // Broken flecks, rather than a solid graphic line.
  for (let k = 0; k < 48; k++) {
    const q = (k / 48 + (t / LOOP_SECONDS) * 4) % 1,
      spread = q * w * 0.1;
    ctx.globalAlpha = (1 - q) ** 2 * 0.24;
    ctx.fillStyle = "#e2f1ed";
    ctx.beginPath();
    ctx.ellipse(
      start - q * length,
      Math.sin(k * 7.71) * spread,
      0.4 + q * w * 0.013,
      0.25 + q * 0.6,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

function vessel(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  pose: VesselPose,
  phase: number,
  sourceAngle = 0.436,
) {
  const h = (pose.width * img.height) / img.width;
  const bob = Math.sin(phase * 18 + pose.x * 0.01) * 0.28;
  ctx.save();
  ctx.translate(pose.x, pose.y + bob);
  ctx.rotate(pose.heading - sourceAngle);
  // A soft waterline reflection and contact shadow anchor the cutout to the sea.
  ctx.save();
  ctx.translate(0, h * 0.39);
  ctx.scale(1, -0.22);
  ctx.globalAlpha = 0.17;
  ctx.filter = "blur(2px)";
  ctx.drawImage(img, -pose.width / 2, -h / 2, pose.width, h);
  ctx.restore();
  ctx.shadowColor = "rgba(2,26,45,.48)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 2;
  ctx.drawImage(img, -pose.width / 2, -h / 2, pose.width, h);
  ctx.restore();
}

export async function createMarineRenderer(target: HTMLCanvasElement) {
  const [plate, container, passingContainer, barge, pilot] = await Promise.all([
    loadImage("/marine/ocean-plate.png"),
    loadImage("/marine/container-ship.png"),
    loadImage("/marine/passing-container-red.png"),
    loadImage("/marine/bunker-barge.png"),
    loadImage("/marine/pilot-launch.png"),
  ]);
  const mask = waterMask(plate),
    sea = ocean(plate, mask);
  const ctx = context(target);
  return {
    mask,
    render(time: number) {
      const t = ((time % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS,
        phase = waterPhase(t);
      sea.draw(t);
      ctx.save();
      ctx.scale(target.width / W, target.height / H);
      ctx.drawImage(sea.canvas, 0, 0, W, H);
      const passing = passingShip(t),
        tender = launch(t),
        bunker = bunkerBarge(t);
      wake(ctx, passing, t);
      vessel(ctx, passingContainer, passing, phase);
      wake(ctx, tender, t);
      vessel(ctx, pilot, tender, phase, -0.33);
      vessel(ctx, container, receivingShip, phase);
      vessel(ctx, barge, bunker, phase);
      // Dark pneumatic fenders and restrained mooring lines between the vessels.
      ctx.save();
      ctx.strokeStyle = "rgba(208,191,150,.65)";
      ctx.lineWidth = 0.65;
      [
        [-30, 8, -25, -8],
        [27, 23, 24, 9],
      ].forEach(([a, b, c, d]) => {
        ctx.beginPath();
        ctx.moveTo(receivingShip.x + a, receivingShip.y + b);
        ctx.lineTo(bunker.x + c, bunker.y + d);
        ctx.stroke();
      });
      ctx.fillStyle = "#101e24";
      [
        [-30, 20],
        [-1, 29],
        [19, 35],
      ].forEach(([x, y]) => {
        ctx.beginPath();
        ctx.ellipse(
          receivingShip.x + x,
          receivingShip.y + y,
          3,
          2,
          0.33,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      });
      // The bunker hose is a continuous physical connection, without an overlay animation.
      ctx.beginPath();
      ctx.moveTo(receivingShip.x - 6, receivingShip.y + 12);
      ctx.bezierCurveTo(
        receivingShip.x - 14,
        receivingShip.y + 29,
        bunker.x + 15,
        bunker.y + 3,
        bunker.x + 6,
        bunker.y - 7,
      );
      ctx.strokeStyle = "#0e2027";
      ctx.lineWidth = 2.8;
      ctx.stroke();
      ctx.strokeStyle = "rgba(182,174,138,.55)";
      ctx.lineWidth = 0.65;
      ctx.stroke();
      ctx.restore();
      ctx.restore();
    },
  };
}

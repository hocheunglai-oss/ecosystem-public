import { createMarineRenderer } from "../src/marine/renderer";
import { LOOP_SECONDS } from "../src/marine/scene";
import {
  Output,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
} from "mediabunny";

const target = document.querySelector<HTMLCanvasElement>("#scene")!;
const slider = document.querySelector<HTMLInputElement>("#time")!;
const status = document.querySelector<HTMLElement>("#status")!;
const play = document.querySelector<HTMLButtonElement>("#play")!;
const renderer = await createMarineRenderer(target);
let active = false,
  start = 0,
  t = 0;
function frame(timestamp: number) {
  if (!active) return;
  t = ((timestamp - start) / 1000) % LOOP_SECONDS;
  renderer.render(t);
  slider.value = String(t);
  status.textContent = `${t.toFixed(1)} / 120s`;
  requestAnimationFrame(frame);
}
play.onclick = () => {
  active = !active;
  play.textContent = active ? "Pause" : "Play";
  start = performance.now() - t * 1000;
  if (active) requestAnimationFrame(frame);
};
slider.oninput = () => {
  t = Number(slider.value);
  start = performance.now() - t * 1000;
  renderer.render(t);
  status.textContent = `${t.toFixed(1)} / 120s`;
};
renderer.render(0);
status.textContent = "Ready";
Object.assign(window, {
  marineReady: true,
  renderMarineAt(time: number) {
    active = false;
    t = time;
    renderer.render(time);
    status.textContent = `${time.toFixed(2)}s`;
  },
  async renderMarineFilm(
    width = 1672,
    height = 940,
    bitrate = 3_600_000,
    name = "harbour-loop.mp4",
  ) {
    active = false;
    target.width = width;
    target.height = height;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(target, {
      codec: "avc",
      bitrate,
      keyFrameInterval: 4,
    });
    output.addVideoTrack(source, { frameRate: 24 });
    await output.start();
    const count = LOOP_SECONDS * 24;
    for (let i = 0; i < count; i++) {
      renderer.render(i / 24);
      await source.add(i / 24, 1 / 24);
      if (i % 24 === 0) {
        status.textContent = `Rendering ${i / 24}s / 120s`;
        console.info("render-progress", name, i / 24);
      }
    }
    await output.finalize();
    const url = URL.createObjectURL(
      new Blob([output.target.buffer!], { type: "video/mp4" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    status.textContent = "Film ready";
    return {
      bytes: output.target.buffer!.byteLength,
      width,
      height,
      seconds: LOOP_SECONDS,
      frameRate: 24,
    };
  },
});

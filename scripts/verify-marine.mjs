import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const base = process.env.ECO_DEMO_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const report = { base, at: new Date().toISOString(), checks: [], errors: [] };
for (const [label, width, height] of [
  ["desktop", 1440, 1000],
  ["wide", 1920, 1080],
  ["mobile", 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const video = page.locator("video");
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
    {},
    { timeout: 30000 },
  );
  const facts = await video.evaluate((v) => ({
    width: v.videoWidth,
    height: v.videoHeight,
    duration: v.duration,
    muted: v.muted,
    loop: v.loop,
    paused: v.paused,
    src: v.currentSrc,
  }));
  assert.equal(facts.duration, 120);
  assert.equal(facts.loop, true);
  assert.equal(facts.muted, true);
  assert.equal(facts.paused, false);
  assert.equal(facts.width, label === "mobile" ? 960 : 1672);
  await video.evaluate((v) => {
    v.currentTime = 8;
  });
  await page.waitForTimeout(200);
  await page.screenshot({
    path: `artifacts/marine/final-${label}.png`,
    fullPage: label === "mobile",
  });
  // Check actual decoded pixels move: boats travel and the ocean itself changes.
  const frames = await video.evaluate(async (v) => {
    v.pause();
    const c = document.createElement("canvas");
    c.width = 1672;
    c.height = 940;
    const ctx = c.getContext("2d");
    async function pixels(time) {
      await new Promise((resolve) => {
        v.addEventListener("seeked", resolve, { once: true });
        v.currentTime = time;
      });
      ctx.drawImage(v, 0, 0, 1672, 940);
      return ctx.getImageData(0, 0, 1672, 940).data;
    }
    const a = await pixels(0),
      b = await pixels(1);
    const region = (x, y, w, h) => {
      let sum = 0;
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
          for (let ch = 0; ch < 3; ch++)
            sum += Math.abs(
              a[(yy * 1672 + xx) * 4 + ch] - b[(yy * 1672 + xx) * 4 + ch],
            );
      return sum / (w * h * 3);
    };
    return {
      waterDifference: region(810, 700, 160, 110),
      landDifference: region(1150, 230, 80, 45),
      vesselDifference: region(780, 550, 170, 130),
    };
  });
  assert.ok(frames.waterDifference > 3, "Surface movement must survive video compression");
  assert.ok(frames.vesselDifference > 0.5, "Vessels must travel");
  await video.evaluate((v) => {
    v.currentTime = 119.7;
    return v.play();
  });
  await page.waitForFunction(
    () => document.querySelector("video").currentTime < 2,
    {},
    { timeout: 5000 },
  );
  report.checks.push({ label, ...facts, ...frames, loopWrapped: true });
  await page.close();
}
const fallback = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
});
await fallback.route("**/*.mp4", (route) => route.abort());
await fallback.goto(base, { waitUntil: "domcontentloaded" });
await fallback.waitForFunction(
  () =>
    document.querySelector(".marine-world")?.dataset.playback === "fallback",
);
await fallback.waitForFunction(() => {
  const poster = document.querySelector(".marine-world__poster");
  return poster?.complete && poster.naturalWidth > 0;
});
assert.ok(
  await fallback
    .getByRole("button", { name: "New enquiry", exact: true })
    .isVisible(),
);
report.checks.push({ failedVideoRetainsPosterAndUsablePage: true });
await browser.close();
assert.deepEqual(report.errors, []);
await writeFile(
  "artifacts/marine/media-verification.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));

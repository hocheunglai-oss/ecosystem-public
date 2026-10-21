import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({
  viewport: { width: 1672, height: 1010 },
  acceptDownloads: true,
});
page.on("pageerror", (e) => console.error(e));
page.on("console", (m) => {
  if (m.text().includes("render-progress")) console.log(m.text());
});
await page.goto("http://127.0.0.1:4173/scripts/marine-preview.html");
await page.waitForFunction(
  () => window.marineReady === true,
  {},
  { timeout: 30000 },
);
await mkdir("artifacts/marine", { recursive: true });
for (const time of [0, 20, 40, 60, 80, 100, 119.958333333, 120]) {
  await page.evaluate((t) => window.renderMarineAt(t), time);
  await page.locator("canvas").screenshot({
    path: `artifacts/marine/frame-${String(time).replace(".", "_")}.png`,
  });
}
const poster = await page.evaluate(() => {
  window.renderMarineAt(0);
  return document
    .querySelector("canvas")
    .toDataURL("image/jpeg", 0.93)
    .split(",")[1];
});
await writeFile(
  "public/marine/harbour-poster.jpg",
  Buffer.from(poster, "base64"),
);
const report = [];
if (!process.argv.includes("--frames-only")) {
  for (const config of [
    [1672, 940, 4_800_000, "harbour-loop.mp4"],
    [960, 540, 2_000_000, "harbour-loop-mobile.mp4"],
  ]) {
    const downloadPromise = page.waitForEvent("download", { timeout: 1800000 });
    const metadata = await page.evaluate(
      (args) => window.renderMarineFilm(...args),
      config,
    );
    const download = await downloadPromise;
    await download.saveAs(resolve("public/marine", config[3]));
    report.push({ file: config[3], ...metadata });
    console.log(JSON.stringify(report.at(-1)));
  }
  await writeFile(
    "artifacts/marine/render-report.json",
    JSON.stringify(report, null, 2),
  );
}
await browser.close();

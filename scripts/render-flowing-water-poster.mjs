import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Run with the repository's Node 24 and installed Playwright Chromium. The PNG
// is a native renderer capture, not an edited image or a screenshot of the UI.
// Driver/browser changes can affect pixels; provenance records the toolchain.
assert.equal(process.versions.node.split('.')[0], '24', 'Use the repository-supported Node 24 runtime');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererPath = join(root, 'src/flowingWaterRenderer.ts');
const posterPath = join(root, 'public/flowing-water-smooth.png');
const provenanceDirectory = join(root, 'output/flowing-water-poster');
const provenancePath = join(provenanceDirectory, 'provenance.json');
const width = 2400;
const height = 1132;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = await readFile(rendererPath, 'utf8');
const compiled = stripTypeScriptTypes(source, { mode: 'strip' });
const browser = await chromium.launch({ headless: true });
let context;
let page;

try {
  context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1,
    colorScheme: 'light', reducedMotion: 'no-preference',
  });
  // This standalone capture needs no network, application session or fixtures.
  await context.route('**/*', route => route.abort());
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent('<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style><canvas></canvas>');
  await page.addScriptTag({
    type: 'module',
    content: `${compiled}\nglobalThis.ecoPosterRenderer = createFlowingWaterRenderer(document.querySelector('canvas'), true, state => { document.body.dataset.state = state; });`,
  });
  await page.waitForFunction(() => document.body.dataset.state === 'paused'
    && document.querySelector('canvas').dataset.flowFrame === '1');
  const canvas = page.locator('canvas');
  const frameState = () => canvas.evaluate(node => ({
    state: document.body.dataset.state,
    width: node.width, height: node.height,
    cssWidth: node.getBoundingClientRect().width,
    cssHeight: node.getBoundingClientRect().height,
    frame: Number(node.dataset.flowFrame),
    timeMs: Number(node.dataset.flowTimeMs),
    periodMs: Number(node.dataset.flowPeriodMs),
  }));
  const expected = {
    state: 'paused', width, height, cssWidth: width, cssHeight: height,
    frame: 1, timeMs: 0, periodMs: 48_000,
  };
  assert.deepEqual(await frameState(), expected, 'Capture the first native frame at phase zero');
  const graphics = await canvas.evaluate(node => {
    const gl = node.getContext('webgl');
    gl.finish();
    return { renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
  });
  const png = await canvas.screenshot({ type: 'png', scale: 'css' });
  assert.deepEqual(await frameState(), expected, 'Rendering must stay paused throughout capture');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), width, 'The PNG keeps the native canvas width');
  assert.equal(png.readUInt32BE(20), height, 'The PNG keeps the native canvas height');

  const provenance = {
    kind: 'Native procedural renderer still at phase zero; no image editing',
    renderer: 'src/flowingWaterRenderer.ts', rendererSha256: sha256(source),
    generator: 'scripts/render-flowing-water-poster.mjs',
    generatorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    poster: 'public/flowing-water-smooth.png',
    ...expected, bytes: png.length, sha256: sha256(png),
    nodeVersion: process.version, chromiumVersion: browser.version(), graphics,
    generatedAt: new Date().toISOString(),
  };
  await mkdir(provenanceDirectory, { recursive: true });
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(posterPath, png);
  console.log(JSON.stringify({ poster: posterPath, provenance: provenancePath, width, height, bytes: png.length, sha256: provenance.sha256 }));
} finally {
  // Release the renderer even when capture/assertions fail, then always close
  // this script's isolated context and browser without touching personal tabs.
  try {
    if (page && !page.isClosed()) await page.evaluate(() => globalThis.ecoPosterRenderer?.destroy()).catch(() => {});
  } finally {
    try { await context?.close(); } finally { await browser.close(); }
  }
}

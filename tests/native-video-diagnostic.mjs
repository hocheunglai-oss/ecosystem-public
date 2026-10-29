// Timing observations only: completion is NOT a playback/loop pass. The strict
// application video and pixel gates remain in flowing-water.e2e.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const repo = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(process.env.ECO_DIAGNOSTIC_OUTPUT || join(repo, 'output/native-video-diagnostic'));
const engine = process.env.ECO_DIAGNOSTIC_ENGINE || 'webkit';
assert.ok(['chromium', 'webkit'].includes(engine));
const require = createRequire(import.meta.url);
const playwright = require('@playwright/test');
const playwrightRequire = createRequire(createRequire(require.resolve('@playwright/test')).resolve('playwright'));
const browserManifest = JSON.parse(await readFile(new URL('browsers.json', `file://${playwrightRequire.resolve('playwright-core/package.json')}`), 'utf8'));
const optionalVersion = (command, args) => {
  try { return { available: true, text: execFileSync(command, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').slice(0, 3).join('\n') }; }
  catch (error) { return { available: false, code: error.code ?? error.status }; }
};
const runtime = {
  node: process.version,
  webkitGstUsePlaybin3: process.env.WEBKIT_GST_USE_PLAYBIN3 ?? null,
  browser: browserManifest.browsers.find(browser => browser.name === engine),
  gstreamer: optionalVersion('gst-inspect-1.0', ['--version']),
  ffmpeg: optionalVersion('ffmpeg', ['-version']),
};
const files = {
  '/desktop.mp4': { path: 'public/flowing-water-watercolour.mp4', type: 'video/mp4', sha256: '4f3f318280ad48e6bab0bdb9f84c09346a80c413fa1424fcbbaa9e14155143ef' },
  '/mobile.mp4': { path: 'public/flowing-water-watercolour-mobile.mp4', type: 'video/mp4', sha256: '428fd8fd05c42ac5d331e215dc2d2a056ff4b8b964a697d9d8256fb082e3e079' },
  '/original.webm': { path: 'tests/fixtures/watercolour-directional.webm', type: 'video/webm', sha256: 'c2394b91bf3c850afceb05473edec7134b7407a71604553e1d99967a5385c2af' },
};
const cases = [
  { name: 'desktop-http-unrouted', path: '/desktop.mp4', loop: true, routing: 'none' },
  { name: 'desktop-http-api-route', path: '/desktop.mp4', loop: true, routing: 'api-only' },
  { name: 'desktop-http-full-route', path: '/desktop.mp4', loop: true, routing: 'all' },
  { name: 'desktop-blob-loop', path: '/desktop.mp4', loop: true, routing: 'none', blob: true },
  { name: 'desktop-http-ended', path: '/desktop.mp4', loop: false, routing: 'none' },
  { name: 'mobile-http-loop', path: '/mobile.mp4', loop: true, routing: 'none' },
  { name: 'webm-http-loop', path: '/original.webm', loop: true, routing: 'none' },
];
const selected = process.env.ECO_DIAGNOSTIC_CASES?.split(',');
if (selected) assert.ok(selected.length && selected.every(name => cases.some(item => item.name === name)), 'Unknown diagnostic case');
const requests = [], results = [];
await mkdir(out, { recursive: true });
const save = (name, data) => writeFile(join(out, name), JSON.stringify(data));
const errorData = error => ({ name: error.name, message: error.message, stack: error.stack });
const summary = () => ({ purpose: 'diagnostic-observations-not-a-pass', engine, platform: process.platform, playwrightVersion: require('@playwright/test/package.json').version, runtime, results });

// This bare document has no scripts or remote resources. CSP independently
// confines media/fetch to this owned server, including the un-intercepted case.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  if (path === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; media-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'",
    }).end(req.method === 'HEAD' ? undefined : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#111"></body></html>');
    return;
  }
  const file = files[path];
  if (!file?.bytes) { res.writeHead(404).end(); return; }
  let start = 0, end = file.bytes.length - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${file.bytes.length}` }).end(); return; }
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    else start = Math.max(0, file.bytes.length - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.bytes.length) { res.writeHead(416, { 'Content-Range': `bytes */${file.bytes.length}` }).end(); return; }
    status = 206;
  }
  const headers = { 'Content-Type': file.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${file.bytes.length}` } : {}) };
  requests.push({ path, method: req.method, range: range || null, status, headers, at: Date.now() });
  res.writeHead(status, headers).end(req.method === 'HEAD' ? undefined : file.bytes.subarray(start, end + 1));
});

let browser;
try {
  for (const file of Object.values(files)) {
    file.bytes = await readFile(join(repo, file.path));
    assert.equal(createHash('sha256').update(file.bytes).digest('hex'), file.sha256, file.path);
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { headless: true };
  if (engine === 'chromium' && process.env.ECO_CHROMIUM_EXECUTABLE) options.executablePath = process.env.ECO_CHROMIUM_EXECUTABLE;
  browser = await playwright[engine].launch(options);
  console.log(JSON.stringify({ purpose: 'diagnostic-runtime-provenance', engine, runtime, browserVersion: browser.version() }));
  for (const item of cases.filter(item => !selected || selected.includes(item.name))) {
    const row = { purpose: 'diagnostic-observation', case: item, engine, browserVersion: browser.version(), assetSha256: files[item.path].sha256, routeHits: 0, violations: [], errors: [], responses: [] };
    const requestStart = requests.length;
    let context, timer;
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
      context.on('request', request => { if (new URL(request.url()).origin !== origin) row.violations.push(request.url()); });
      if (item.routing !== 'none') await context.route(item.routing === 'api-only' ? '**/api/**' : '**/*', route => {
        row.routeHits++;
        if (new URL(route.request().url()).origin !== origin) return route.abort('blockedbyclient');
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => row.errors.push(errorData(error)));
      page.on('response', response => row.responses.push({ url: response.url(), status: response.status(), headers: response.headers() }));
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const data = await Promise.race([page.evaluate(async item => {
        let blobURL;
        const requestedURL = new URL(item.path, location.href).href;
        if (item.blob) {
          const response = await fetch(requestedURL);
          if (!response.ok) throw new Error('Blob source fetch failed');
          blobURL = URL.createObjectURL(await response.blob());
        }
        const video = document.createElement('video');
        video.muted = true; video.loop = item.loop; video.playsInline = true; video.preload = 'auto';
        video.style.cssText = 'display:block;width:100vw;height:100vh;object-fit:contain';
        document.body.append(video);
        const started = performance.now(), events = [], frames = [], polls = [];
        let request = 0, finished = false;
        const ranges = range => Array.from({ length: range.length }, (_, index) => [range.start(index), range.end(index)]);
        const state = () => ({ at: performance.now() - started, time: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking, readyState: video.readyState, networkState: video.networkState, buffered: ranges(video.buffered), seekable: ranges(video.seekable), ended: video.ended, error: video.error ? { code: video.error.code, message: video.error.message } : null, visible: document.visibilityState });
        return await new Promise(resolve => {
          let deadline, poll;
          const finish = reason => {
            if (finished) return;
            finished = true; clearTimeout(deadline); clearInterval(poll);
            if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(request);
            const final = state();
            video.pause();
            resolve({ reason, events, frames, polls, final, currentSrc: video.currentSrc, canPlay: { mp4: video.canPlayType('video/mp4; codecs="avc1.640028"'), webm: video.canPlayType('video/webm; codecs="vp9"') }, elapsedMs: performance.now() - started });
            if (blobURL) URL.revokeObjectURL(blobURL);
          };
          for (const event of ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'emptied', 'error']) video.addEventListener(event, () => {
            events.push({ event, ...state() });
            if (event === 'ended' && !item.loop) finish('ended');
            if (event === 'error') finish('media-error');
          });
          const onFrame = (now, m) => {
            if (finished) return;
            frames.push([now, performance.now() - started, m.mediaTime, video.currentTime, m.presentedFrames, m.expectedDisplayTime, m.presentationTime]);
            if (frames.length >= 1000) { finish('callback-limit'); return; }
            request = video.requestVideoFrameCallback(onFrame);
          };
          if (video.requestVideoFrameCallback) request = video.requestVideoFrameCallback(onFrame);
          poll = setInterval(() => polls.push(state()), 200);
          deadline = setTimeout(() => finish('14-second-observation'), 14000);
          video.src = blobURL || requestedURL;
          void video.play().catch(error => { events.push({ event: 'play-rejection', message: error.message, ...state() }); finish('play-rejected'); });
        });
      }, item), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic page exceeded 30 seconds')), 30000); })]);
      const wraps = data.frames.flatMap((frame, index) => {
        const prior = data.frames[index - 1];
        return prior && frame[2] < prior[2] - 1 ? [{ from: prior[2], to: frame[2], nativeFrom: prior[3], nativeTo: frame[3], wallMs: frame[0] - prior[0], expectedDisplayDelta: frame[5] - prior[5], presentedFramesDelta: frame[4] - prior[4] }] : [];
      });
      Object.assign(row, { outcome: 'observed-not-validated', wraps, earlyWraps: wraps.filter(wrap => wrap.from < 5.7), maximumObservedMediaTime: Math.max(0, ...data.frames.map(frame => frame[2])), frameFields: ['callbackNow', 'wallMs', 'mediaTime', 'nativeTime', 'presentedFrames', 'expectedDisplayTime', 'presentationTime'], data });
    } catch (error) {
      row.outcome = 'diagnostic-error'; row.errors.push(errorData(error));
    } finally {
      clearTimeout(timer);
      if (context) await context.close().catch(error => row.errors.push(errorData(error)));
      row.requests = requests.slice(requestStart);
      await save(`${engine}-${item.name}.json`, row);
      results.push({ case: item.name, outcome: row.outcome, reason: row.data?.reason, routeHits: row.routeHits, wraps: row.wraps, earlyWraps: row.earlyWraps?.length, maximumObservedMediaTime: row.maximumObservedMediaTime, errors: row.errors, violations: row.violations });
      await save(`${engine}-summary.json`, summary());
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} catch (error) {
  await save(`${engine}-fatal.json`, { ...summary(), error: errorData(error) });
  throw error;
} finally {
  try { if (browser) await browser.close(); }
  finally { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}

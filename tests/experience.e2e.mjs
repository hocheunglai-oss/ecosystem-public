import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUTPUT = new URL('../artifacts/', import.meta.url);
await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const browserErrors = [];
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const drops = state => state.drops.filter(entry => entry.owner === 'otto').reduce((sum, entry) => sum + entry.amount, 0);
async function nav(page, name) {
  const link = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
}
async function role(page, id) { await page.getByLabel('Demo role', { exact: true }).selectOption(id); }
async function approvePortUpdate(page, title = 'Singapore: clearer desk handovers') {
  await role(page, 'marco');
  await nav(page, 'Management');
  await page.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'Review contribution', exact: true }).click();
  await page.getByLabel('Review note').fill('Accepted after reviewing its source and usefulness to the group.');
  await page.getByRole('button', { name: 'Publish & award Drops', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function assertNoFeedback(page) {
  await expect(page.locator('.experience-feedback')).toHaveCount(0);
  await expect(page.locator('.experience-announcement')).toHaveText('');
}
async function scenario(name, callback, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  const mediaRequests = [];
  page.on('request', request => { if (/\.mp4(?:$|\?)/.test(request.url())) mediaRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(`Page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  try {
    // Streaming background video is independent of app readiness; networkidle may never arrive.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('MAKE WAVES');
    await callback(page, mediaRequests);
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`experience-failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, OUTPUT).pathname, fullPage: true, animations: 'disabled' }).catch(() => {});
  } finally {
    browserErrors.push(...errors.map(error => ({ scenario: name, error })));
    await context.close();
  }
}

await scenario('The harbour stays clear while the group mission opens port intelligence', async page => {
  await expect(page.locator('.marine-world')).toBeVisible();
  await expect(page.locator('.ocean-routes, .voyage-vessel, .port-beacon, .port-signal')).toHaveCount(0);
  for (const [name, id] of [['Hong Kong', 'port-hong-kong'], ['Tokyo', 'port-tokyo'], ['Rotterdam', 'port-rotterdam'], ['Singapore', 'port-singapore']]) {
    await page.locator('.mission-stops').getByRole('button', { name: `${name}: needs an update`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/ports\\?port=${id}$`));
    await expect(page.locator('#port-detail h2')).toHaveText(name);
    await nav(page, 'Overview');
  }
});

await scenario('Mission membership persists per user without awarding fake Drops', async page => {
  const before = drops(await snapshot(page));
  await page.getByRole('button', { name: 'Join the mission', exact: true }).click();
  await expect(page.locator('.mission-joined')).toContainText('You’re on board');
  assert.equal(drops(await snapshot(page)), before);
  await role(page, 'elena');
  await expect(page.getByRole('button', { name: 'Join the mission', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Join the mission', exact: true }).click();
  await role(page, 'otto');
  await expect(page.locator('.mission-joined')).toBeVisible();
  await nav(page, 'Port Info');
  await nav(page, 'Overview');
  await expect(page.locator('.mission-joined')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('.mission-joined')).toBeVisible();
  const members = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.mission')));
  assert.equal(members.length, 2);
  assert.ok(members.some(id => id.endsWith(':otto')));
  assert.ok(members.some(id => id.endsWith(':elena')));
  assert.equal(drops(await snapshot(page)), before);
  await assertNoFeedback(page);
});

await scenario('Animation pause stops the film and persists without loading video on reload', async page => {
  const film = page.locator('.marine-world__film');
  await expect(page.locator('.workspace')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'playing', { timeout: 15000 });
  await expect.poll(() => film.evaluate(element => element.currentTime)).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'paused');
  const samples = await film.evaluate(async element => {
    const before = element.currentTime;
    await new Promise(resolve => setTimeout(resolve, 250));
    return { before, after: element.currentTime, paused: element.paused };
  });
  assert.equal(samples.paused, true);
  assert.ok(Math.abs(samples.after - samples.before) < 0.02, 'Paused video must keep its frame');
  assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.motion')), 'off');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeVisible();
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'static');
  assert.equal(await film.getAttribute('src'), null, 'A paused initial visit should load only the poster');
  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'playing', { timeout: 15000 });
  await page.locator('.voyage-log').scrollIntoViewIfNeeded();
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'paused');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'playing');
});

await scenario('Accepted knowledge earns animated Drops for its author and advances group mission', async page => {
  await assertNoFeedback(page);
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '0 of 8 ports refreshed');
  const before = drops(await snapshot(page));
  await approvePortUpdate(page);
  await expect(page.locator('.experience-feedback')).toContainText('+20');
  await expect(page.locator('.experience-feedback__recipient')).toHaveText('Earned by Sample Trader');
  await expect(page.locator('.experience-feedback')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('.experience-flying-drop')).toHaveCount(6);
  await expect(page.locator('.experience-announcement')).toHaveText('20 black Drops awarded to Sample Trader. Singapore: clearer desk handovers.');
  assert.equal(drops(await snapshot(page)), before + 20);
  await expect(page.locator('.toast[role="status"]')).toHaveCount(0);
  await page.screenshot({ path: new URL('experience-earned-drops.png', OUTPUT).pathname });
  await expect(page.locator('.experience-feedback')).toHaveCount(0, { timeout: 3500 });
  await expect(page.locator('.experience-flying-drop')).toHaveCount(0);
  await role(page, 'otto');
  await assertNoFeedback(page);
  await nav(page, 'Overview');
  await expect(page.locator('[data-drops-counter]')).toContainText('90');
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '1 of 8 ports refreshed');
  await expect(page.locator('.mission-stops').getByRole('button', { name: 'Singapore: refreshed', exact: true })).toHaveClass('complete');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main h1')).toBeVisible();
  await assertNoFeedback(page);
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '1 of 8 ports refreshed');
  await role(page, 'marco');
  await assertNoFeedback(page);
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertNoFeedback(page);
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '0 of 8 ports refreshed');
  assert.equal(drops(await snapshot(page)), before);
});

await scenario('Repeated updates to one port count as one refreshed port', async page => {
  await approvePortUpdate(page);
  await role(page, 'otto');
  await nav(page, 'Overview');
  await page.getByRole('button', { name: 'Share local knowledge', exact: true }).click();
  await page.getByLabel('What changed or what did you learn?').fill('Singapore: documented berth handover');
  await page.getByLabel('Details', { exact: true }).fill('Include the berth identifier and confirmed delivery window in the next desk handover.');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '1 of 8 ports refreshed');
  await approvePortUpdate(page, 'Singapore: documented berth handover');
  await nav(page, 'Overview');
  await expect(page.locator('.mission-stops')).toHaveAttribute('aria-label', '1 of 8 ports refreshed');
  assert.equal(drops(await snapshot(page)), 110);
});

await scenario('Reduced motion leaves the film unloaded and uses a brief static award', async (page, mediaRequests) => {
  await expect(page.locator('.workspace')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'static');
  assert.equal(await page.locator('.marine-world__film').getAttribute('src'), null);
  // The operating-system preference continues to win even after the UI toggle.
  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'static');
  assert.equal(await page.locator('.marine-world__film').getAttribute('src'), null);
  assert.deepEqual(mediaRequests, [], 'Reduced motion must not download a background film');
  await approvePortUpdate(page);
  await expect(page.locator('.experience-feedback')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.experience-feedback')).toContainText('+20');
  await expect(page.locator('.experience-flying-drop')).toHaveCount(0);
  await expect(page.locator('.experience-feedback')).toHaveCount(0, { timeout: 2900 });
  await assertNoFeedback(page);
}, { reducedMotion: 'reduce' });

await browser.close();
await writeFile(new URL('experience-report.json', OUTPUT), JSON.stringify({ base: BASE, at: new Date().toISOString(), results, browserErrors }, null, 2));
console.log(JSON.stringify({ scenarios: results, browserErrors }, null, 2));
process.exitCode = results.some(item => item.status === 'failed') || browserErrors.length ? 1 : 0;

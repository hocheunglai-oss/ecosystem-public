import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_HOLIDAY_ORIGIN || 'http://127.0.0.1:4340';
const out = resolve(process.env.ECO_HOLIDAY_OUTPUT || 'output/holiday-status');
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'holiday@example.test', displayName: 'HOLIDAY FIXTURE', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: false, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(out, { recursive: true });

async function fixture(context) {
  const state = { user: null, writes: [] };
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  await context.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) state.writes.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, json: { message: 'Unconfigured isolated fixture.' } });
  });
  await installEmptyLiveInbox(context);
  await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
  await context.route('**/api/access/**', route => {
    assert.equal(route.request().method(), 'GET');
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    return route.fulfill({ status: path === 'session' ? 200 : 403, json: path === 'session' ? { user: state.user, preview: null } : { message: 'Read only.' } });
  });
  await context.route('**/api/profile-tabs/**', route => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } });
  });
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
  return state;
}

async function openProfile(workspace, kind, name) {
  await btn(workspace, kind === 'port' ? 'Port Index' : 'Country Index').click();
  await workspace.getByLabel('Country or port', { exact: true }).fill(name);
  await workspace.locator('.location-table').getByRole('button', { name, exact: true }).click();
  return workspace.locator('.knowledge').first();
}

async function statusColor(trigger) {
  return trigger.locator('span').evaluate(node => ({ color: getComputedStyle(node).color, danger: getComputedStyle(node).getPropertyValue('--ui-danger').trim() }));
}

for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
      const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, isMobile: width < 760, hasTouch: width < 760, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
      await installStagingCookies(context, base);
      const state = await fixture(context);
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-10-20T04:00:00Z'));
      const shot = async name => {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no document overflow`);
        for (const element of await page.locator('.public-holidays-control, .public-holidays-hint:visible, .public-holidays-trigger').all()) {
          const box = await element.boundingBox();
          assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `${name}: holiday content stays inside the viewport`);
        }
      };
      try {
        sharedLocations(context).seed(value => {
          value.locationCountries = ['Singapore', 'Netherlands', 'United Arab Emirates', 'Canada'].map(name => ({ id: name, name }));
          value.ports = value.ports.filter(port => ['port-singapore', 'port-rotterdam', 'port-fujairah'].includes(port.id));
          const seed = value.ports.find(port => port.id === 'port-singapore');
          value.ports.push({ ...seed, id: 'port-fixture-offset', name: 'OFFSET FIXTURE', timezone: 'UTC-3:30' }, { ...seed, id: 'port-fixture-unknown', name: 'UNKNOWN ZONE FIXTURE', timezone: 'Not/A_Zone' });
        });
        await page.goto(base);
        await expect(btn(page, 'Sign in')).toBeEnabled();
        await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
        await expect(btn(page, 'Public holidays')).toHaveCount(0);
        await shot('signed-out');
        state.user = structuredClone(user);
        await page.reload();
        await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
        await btn(nav, 'Ports & Suppliers').click();
        await btn(nav, 'Countries & Ports').click();
        const workspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });

        let profile = await openProfile(workspace, 'country', 'Netherlands');
        let trigger = btn(profile, 'Public holidays');
        await expect(trigger).toHaveText('TODAY IS NOT A PUBLIC HOLIDAY');
        assert.equal(await trigger.locator('.public-holidays-today').count(), 0);
        const normal = await statusColor(trigger);
        const hint = profile.getByRole('tooltip');
        await trigger.focus();
        await expect(hint).toBeVisible();
        await expect(hint).toHaveText('NEXT: 25 DEC 2026 · CHRISTMAS DAY');
        await expect(trigger).toHaveAccessibleDescription(/TODAY IS NOT A PUBLIC HOLIDAY.*NEXT: 25 DEC 2026/);
        await shot('normal-focus-hint');
        await trigger.press('Escape');
        await expect(hint).toBeHidden();
        await expect(workspace).toBeVisible();
        if (width >= 760) {
          await page.mouse.move(1, 1);
          await trigger.hover();
          await expect(hint).toBeVisible();
          await hint.hover();
          await expect(hint).toBeVisible();
        }
        await (width < 760 ? trigger.tap() : trigger.click());
        const modal = page.getByRole('dialog', { name: 'PUBLIC HOLIDAYS', exact: true });
        await expect(modal.locator('.public-holidays-next')).toHaveText('NEXT: 25 DEC 2026 · CHRISTMAS DAY');
        await expect(modal.getByRole('table', { name: 'Netherlands public holidays 2026', exact: true })).toBeVisible();
        await shot('calendar-touch');
        await btn(modal, 'Close dialog').click();

        await page.clock.setFixedTime(new Date('2026-11-07T15:59:58Z'));
        profile = await openProfile(workspace, 'port', 'Singapore');
        trigger = btn(profile, 'Public holidays');
        await expect(trigger).toHaveText('TODAY IS NOT A PUBLIC HOLIDAY');
        const time = profile.locator('.knowledge-local-time time');
        await expect(time).toHaveText('23:59:58');
        const clockBefore = await time.boundingBox(), statusBefore = await trigger.boundingBox();
        await page.clock.setFixedTime(new Date('2026-11-07T15:59:59Z'));
        await expect(time).toHaveText('23:59:59');
        assert.deepEqual(await time.boundingBox(), clockBefore, 'Seconds never alter the clock box');
        assert.deepEqual(await trigger.boundingBox(), statusBefore, 'Seconds never shift the adjacent status');
        await page.clock.setFixedTime(new Date('2026-11-07T16:00:00Z'));
        await expect(time).toHaveText('00:00:00');
        await expect(trigger).toHaveText('PUBLIC HOLIDAY (DEEPAVALI)');
        assert.notEqual((await statusColor(trigger)).color, normal.color);
        await expect(trigger.locator('.public-holidays-today')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 180, 192)' : 'rgb(164, 47, 59)');
        await trigger.focus();
        await expect(profile.getByRole('tooltip')).toContainText('9 NOV 2026');
        await shot('holiday-red-midnight');

        await page.clock.setFixedTime(new Date('2026-01-01T03:29:59Z'));
        profile = await openProfile(workspace, 'port', 'OFFSET FIXTURE');
        await expect(profile.locator('.knowledge-local-time time')).toHaveText('23:59:59');
        await expect(btn(profile, 'Public holidays')).toHaveText('PUBLIC HOLIDAY DATES UNAVAILABLE', { timeout: 5000 });
        await page.clock.setFixedTime(new Date('2026-01-01T03:30:00Z'));
        await expect(profile.locator('.knowledge-local-time time')).toHaveText('00:00:00');
        await expect(btn(profile, 'Public holidays')).toHaveText("PUBLIC HOLIDAY (NEW YEAR'S DAY)");
        profile = await openProfile(workspace, 'port', 'UNKNOWN ZONE FIXTURE');
        await expect(profile.locator('.knowledge-local-time')).toContainText('—');
        await expect(btn(profile, 'Public holidays')).toHaveText('PUBLIC HOLIDAY DATES UNAVAILABLE');

        await page.clock.setFixedTime(new Date('2027-03-01T00:00:00Z'));
        profile = await openProfile(workspace, 'country', 'United Arab Emirates');
        trigger = btn(profile, 'Public holidays');
        await expect(trigger).toHaveText('PUBLIC HOLIDAY STATUS UNCONFIRMED');
        await trigger.focus();
        await expect(profile.getByRole('tooltip')).toHaveText('NEXT PUBLISHED: 2 DEC 2027 · NATIONAL DAY (SCHEDULED)');
        await shot('pending-calendar');
        profile = await openProfile(workspace, 'country', 'Canada');
        await expect(btn(profile, 'Public holidays')).toHaveText('PUBLIC HOLIDAY DATES UNAVAILABLE');
        await shot('unavailable-calendar');
        assert.deepEqual(state.writes, []);
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, status: 'passed' });
        console.log(`PASS ${engine} ${width} ${theme}: holiday status, hint, touch calendar and stable clock`);
      } catch (error) {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-FAILURE.png`, fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify({ base, results, limits: 'Isolated API fixtures and fixed dates; physical devices and native Safari are not covered.' }, null, 2));
console.log(JSON.stringify({ passed: results.length, output: out }));

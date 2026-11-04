import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_BACKUP_ALERT_ORIGIN ?? process.env.ECO_UI_ORIGIN ?? 'http://127.0.0.1:4173';
const out = resolve(process.env.ECO_BACKUP_ALERT_OUTPUT ?? 'output/backup-alert-ui');
await mkdir(out, { recursive: true });
const admin = { id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.test', displayName: 'SAMPLE ADMIN', officeId: 'HONG KONG', officeName: 'HONG KONG',
  isAdmin: true, isActive: true, isManager: false, isSpcTrader: false, activated: true, passwordChangeSuggested: false, revision: 1,
  capabilities: { appearancePreview: false, testWorkspace: false } };
const reports = [];
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true,
    ...(engine === 'chromium' && process.env.ECO_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ECO_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      await installStagingCookies(context, base);
      const page = await context.newPage();
      const state = { user: { ...admin }, preview: null, status: 'unavailable', detail: 'THE LATEST BACKUP RUN DID NOT COMPLETE SUCCESSFULLY.', expired: false,
        http: 200, requests: 0, writes: [], clock: Date.now(), hold: false, held: null };
      const health = () => ({ schemaVersion: 1, status: state.status, observedAt: new Date(state.clock).toISOString(), expiresAt: new Date(state.clock + (state.expired ? 0 : 30_000)).toISOString(), cacheTtlSeconds: 30,
        checks: ['database-backup', 'document-backup'].map(id => ({ id, label: id, status: state.status, checkedAt: new Date(state.clock).toISOString(),
          detail: state.detail })) });
      await context.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') state.writes.push(path);
        if (path === '/api/access/session') return route.fulfill(state.user ? { json: { user: state.user, preview: state.preview } } : { status: 401, json: { message: 'Sign in required.' } });
        if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
        if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
        if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
        if (path === '/api/enquiries/records') return route.fulfill({ json: { items: [], nextCursor: null } });
        if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
        if (path === '/api/admin/system-health') {
          state.requests++;
          if (state.hold) { state.hold = false; state.held = route; return; }
          return route.fulfill({ status: state.http, json: state.http === 200 ? health() : { message: 'Unavailable.' } });
        }
        if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-03T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
        return route.fulfill({ status: 503, json: { message: 'Unconfigured synthetic request.' } });
      });
      await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
      await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const bell = () => page.getByRole('button', { name: 'Notifications', exact: true });
      const notice = () => page.getByRole('status', { name: 'Backup alert', exact: true });
      const close = () => page.getByRole('button', { name: 'Close notifications', exact: true }).click();
      const reopen = async () => { await close(); await bell().click(); };
      try {
        await page.clock.install({ time: new Date(state.clock) });
        await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        assert.equal(state.requests, 0, 'Closed notification panel does not start health polling');
        await bell().click();
        await expect(notice()).toContainText('BACKUP REQUIRES ATTENTION');
        assert.equal((await notice().innerText()).match(/THE LATEST BACKUP RUN/g)?.length, 1, 'Database and document alerts are one incident');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
        const box = await notice().boundingBox(); assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, 'Alert fits phone width');
        const button = await notice().getByRole('button', { name: 'REFRESH', exact: true }).boundingBox();
        assert.ok(button && button.height >= (width <= 760 ? 44 : 36), 'Refresh touch target');
        state.status = 'healthy'; await notice().getByRole('button', { name: 'REFRESH', exact: true }).click();
        await expect(notice()).toHaveCount(0);
        for (const [status, detail] of [
          ['degraded', 'ENCRYPTED BACKUP COPIES VERIFIED. CAPACITY OR RETENTION NEEDS ATTENTION.'],
          ['degraded', 'THE LATEST BACKUP RUN HAS NOT COMPLETED.'],
          ['unknown', 'BACKUP STATUS COULD NOT BE VERIFIED.'],
        ]) {
          state.status = status; state.detail = detail;
          const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/system-health');
          await reopen(); await (await response).finished(); await expect(notice()).toHaveCount(0);
        }
        state.status = 'unavailable'; state.expired = true;
        const expiredResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/system-health');
        await reopen(); await (await expiredResponse).finished(); await expect(notice()).toHaveCount(0); state.expired = false;
        state.status = 'degraded'; state.detail = 'ENCRYPTED BACKUP COPIES VERIFIED. CAPACITY OR RETENTION NEEDS ATTENTION.';
        const capacityResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/system-health');
        await reopen(); await (await capacityResponse).finished(); await expect(notice()).toHaveCount(0);
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-quiet.png`, fullPage: true });
        await close();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Administration', exact: true }).click();
        state.status = 'degraded'; state.detail = 'ENCRYPTED BACKUP COPIES VERIFIED. CAPACITY OR RETENTION NEEDS ATTENTION.';
        await page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'System Health', exact: true }).click();
        const database = page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'database-backup', exact: true }) });
        await expect(database.locator('.admin-status')).toHaveText('degraded');
        await expect(database).toContainText(state.detail);
        await database.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-passive-health.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Passive health has no horizontal overflow');
        for (const status of ['unknown', 'unavailable']) {
          state.status = status; state.detail = status === 'unknown' ? 'BACKUP STATUS COULD NOT BE VERIFIED.' : 'THE LATEST BACKUP RUN DID NOT COMPLETE SUCCESSFULLY.';
          await page.getByRole('button', { name: 'Refresh', exact: true }).click();
          await expect(database.locator('.admin-status')).toHaveText(status);
          await expect(database).toContainText(state.detail);
        }
        if (width === 390) {
          await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
          await bell().click(); await expect(notice()).toBeVisible();
          state.http = 503; await notice().getByRole('button', { name: 'REFRESH', exact: true }).click();
          await expect(notice()).toHaveCount(0);
          state.http = 403; await reopen();
          await expect(notice()).toHaveCount(0);
          const deniedRequests = state.requests;
          state.clock += 60_000; await page.clock.fastForward(60_000);
          assert.equal(state.requests, deniedRequests, '403 stops unauthorized polling and removes stale notice');
          state.http = 200; state.status = 'unavailable'; await reopen(); await expect(notice()).toBeVisible();
          state.hold = true; await notice().getByRole('button', { name: 'REFRESH', exact: true }).click();
          await expect.poll(() => Boolean(state.held)).toBe(true);
          state.user = { ...admin, id: '10000000-0000-4000-8000-000000000002', displayName: 'SECOND ADMIN' }; state.status = 'healthy';
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await expect(page.locator('.trader-hud')).toContainText('SECOND ADMIN');
          await state.held.fulfill({ json: { ...health(), checks: health().checks.map(check => ({ ...check, status: 'unavailable' })) } }).catch(() => {});
          state.held = null;
          await bell().click(); await expect(notice()).toHaveCount(0);
          state.preview = { role: 'admin', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await expect(page.getByRole('status', { name: 'Role preview', exact: true })).toBeVisible();
          const previewRequests = state.requests; await bell().click();
          state.clock += 31_000; await page.clock.fastForward(31_000);
          assert.equal(state.requests, previewRequests, 'VIEW AS does not fetch administrator backup alerts');
          await expect(notice()).toHaveCount(0);
          state.preview = null; state.user = { ...admin, isAdmin: false };
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await expect(page.locator('.trader-hud')).toHaveAttribute('data-role', 'trader');
          const memberRequests = state.requests; await bell().click();
          state.clock += 31_000; await page.clock.fastForward(31_000);
          assert.equal(state.requests, memberRequests, 'Ordinary members never request the admin endpoint');
          await expect(notice()).toHaveCount(0);
          state.user = null; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
          assert.equal(state.requests, memberRequests, 'Signed-out view does not request backup status');
        }
        assert.deepEqual(state.writes, []); assert.deepEqual(errors, []);
        reports.push({ engine, width, theme, passed: true, writes: state.writes.length,
          notificationFailure: 'unavailable', quietScreenshot: 'capacity-advisory',
          quietStates: ['healthy', 'capacity-advisory', 'pending', 'unknown', 'expired'],
          passiveHealthStates: ['degraded', 'unknown', 'unavailable'], accessChecks: width === 390 });
        console.log(`PASS ${engine} ${width} ${theme}`);
      } catch (error) { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-failure.png`, fullPage: true }); throw error; }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2));

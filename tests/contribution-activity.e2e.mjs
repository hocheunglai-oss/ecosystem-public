import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Fixed-time, disposable browser data. Works against local builds or the public demo.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const NOW = new Date('2026-10-13T07:00:00.000Z');
const output = new URL('../artifacts/contribution-activity/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const openActivity = async (page, mobile) => {
  if (mobile) {
    await page.locator('.hud-profile-toggle').click();
    await page.getByRole('button', { name: 'Contribution Activity', exact: true }).click();
  } else await page.locator('[data-resource="activity"]').click();
  return page.locator('#hud-contribution-activity');
};
try {
  for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 320]]) {
    const mobile = width < 850;
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
    await context.addInitScript(theme => {
      sessionStorage.setItem('ecosystem.session.v1', 'otto');
      localStorage.setItem('ecosystem.theme.v1', theme);
    }, theme);
    await page.clock.setFixedTime(NOW);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
      const entry = (id, at, title, body, extra = {}) => ({ id, createdAt: at, publishedAt: at, title, body,
        author: 'otto', status: 'approved', publication: 'direct', targetType: 'port', targetId: 'port-chiba', ...extra });
      state.contributions = [
        entry('today-a', '2026-10-13T01:00:00Z', 'DELIVERY PLANNING', 'AGENT CONFIRMED MORNING DELIVERY.'),
        entry('today-b', '2026-10-13T02:00:00Z', 'DELIVERY PLANNING', 'AGENT CONFIRMED 09:00 DELIVERY.'),
        entry('week', '2026-10-10T02:00:00Z', 'SUPPLIER CONTACT', 'OPERATIONS CONTACT UPDATED.'),
        entry('month-before', '2026-09-24T02:00:00Z', 'SAMPLE LOCATION', 'MANIFOLD SAMPLING CONFIRMED.'),
        entry('previous', '2026-09-01T02:00:00Z', 'BARGE DETAILS', 'DELIVERY BARGE DETAILS CHECKED.'),
        entry('older', '2026-08-01T02:00:00Z', 'QUALITY DOCUMENTS', 'SUPPLIER QUALITY DOCUMENTS ADDED.'),
        entry('manager', '2026-10-11T02:00:00Z', 'TERMINAL CONTACT', 'TERMINAL CONTACT UPDATED.', { author: 'gianmichele' }),
        entry('pending', '2026-10-13T02:00:00Z', 'NOT PUBLISHED', 'PENDING DRAFT.', { status: 'pending' }),
        entry('declined', '2026-10-13T02:00:00Z', 'DECLINED', 'DECLINED DRAFT.', { status: 'declined' }),
      ];
      state.drops = [];
      state.economy = { version: 2, grants: [{ id: 'legacy-grant', key: 'legacy-grant', at: '2026-10-13T01:00:00Z', owner: 'otto',
        resource: 'gold', amount: 9999, reason: 'LEGACY DEMO GRANT', teamId: 'team-gianmichele', source: 'demo' }] };
      state.hats = ['2026-10-11T02:00:00Z', '2026-08-02T02:00:00Z'].map((at, i) => ({ id: `hat-${i}`,
        target: { kind: 'key-info', portId: 'port-chiba', field: i ? 'isoSpecs' : 'sampleLocation' }, targetKey: `test-entry-${i}`,
        readerId: 'gianmichele', recipientId: 'otto', awardedAt: at,
        update: { updatedBy: 'otto', updatedAt: '2026-08-01T01:00:00Z' } }));
      localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'networkidle' });
    const before = await readState(page);
    await expect(page.locator('[data-resource="gold"], .resource-icon-gold, .gold-update-button')).toHaveCount(0);
    await expect(page.locator('[data-resource="hat"] strong')).toHaveText('2');
    if (!mobile) await expect(page.locator('[data-resource="activity"] strong')).toHaveText('3');
    const panel = await openActivity(page, mobile);
    const total = panel.locator('[data-activity-total]'), hats = panel.locator('[data-activity-hats]');
    const filter = panel.getByRole('combobox', { name: 'Contribution period' });
    await expect(total).toHaveText('3');
    await expect(hats).toHaveText('1');
    await expect(panel.locator('.activity-comparison b')).toHaveText('+2');
    assert.deepEqual(await panel.locator('.activity-weeks li > strong').allTextContents(), ['0', '1', '0', '2']);
    await expect(panel.locator('.activity-history > li')).toHaveCount(3);
    const latest = panel.locator('.activity-history > li').filter({ hasText: 'DELIVERY PLANNING' });
    await latest.locator('summary').click();
    await expect(latest.locator('.activity-publication')).toHaveCount(2);
    await expect(latest).toContainText('AGENT CONFIRMED MORNING DELIVERY.');
    await expect(latest).toContainText('AGENT CONFIRMED 09:00 DELIVERY.');
    await filter.selectOption('7d');
    await expect(total).toHaveText('2');
    await expect(panel.locator('.activity-weeks li')).toHaveCount(7);
    await filter.selectOption('month');
    await expect(total).toHaveText('2');
    await filter.selectOption('all');
    await expect(total).toHaveText('5');
    await expect(hats).toHaveText('2');
    await expect(panel.locator('.activity-comparison')).toHaveCount(0);
    await expect(panel.locator('.activity-history > li')).toHaveCount(5);
    await expect(panel).toContainText('QUALITY DOCUMENTS');
    await filter.selectOption('28d');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal viewport overflow');
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Activity panel fits viewport');
    await page.screenshot({ path: new URL(`${theme}-${width}.png`, output).pathname });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator(mobile ? '.hud-profile-toggle' : '[data-resource="activity"]')).toBeFocused();
    if (!mobile) {
      await page.locator('.hud-achievements-toggle').click();
      const office = page.locator('[data-office-summary="team-gianmichele"]');
      await expect(office.locator('[data-activity-total]')).toHaveText('4');
      await expect(page.locator('[data-team-member="otto"] td').first()).toHaveText('3');
      await expect(page.locator('[data-team-member="gianmichele"] td').first()).toHaveText('1');
      await page.getByRole('button', { name: 'Close achievements' }).click();
    }
    assert.deepEqual(await readState(page), before, 'Reading activity preserves saved data, Hats and legacy balances');
    await page.reload({ waitUntil: 'networkidle' });
    const reopened = await openActivity(page, mobile);
    await expect(reopened.locator('[data-activity-total]')).toHaveText('3');
    assert.deepEqual(await readState(page), before, 'Reload preserves business records and contribution attribution');
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'All verification stays within isolated local demo state');
    console.log(`${theme}/${width}: date windows, grouping, history, Hats, office totals, persistence, responsive layout and focus passed`);
    await context.close();
  }
} finally { await browser.close(); }

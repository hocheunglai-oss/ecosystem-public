import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

const base = process.env.ECO_PHONE_UI_ORIGIN ?? 'http://127.0.0.1:4267';
const out = new URL('../output/phone-requests-ui/', import.meta.url);
await mkdir(out, { recursive: true });
const reports = [];
const original = { id: '11111111-1111-4111-8111-111111111111', email: 'phone-preview@example.test', displayName: 'PHONE REQUEST VERIFY', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      let user = { ...original }, requests = [], sent = [], rejected = [];
      await context.route('**/api/access/**', async route => {
        const path = new URL(route.request().url()).pathname.replace('/api/access/', '');
        const reply = (json, status = 200) => route.fulfill({ json, status });
        if (path === 'session') return reply({ user, effectiveUser: user, preview: null });
        if (path === 'users' && route.request().method() === 'GET') return reply({ users: [user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] });
        if (path === 'phone-requests' && route.request().method() === 'GET') return reply({ requests });
        if (path === 'phone-requests') {
          const payload = route.request().postDataJSON(); sent.push(payload);
          const request = { id: payload.requestId, userId: user.id, displayName: user.displayName, email: user.email, officeName: user.officeName, currentPhone: user.phone, requestedPhone: payload.phone, status: 'pending', requestedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null };
          requests = [request, ...requests]; return reply({ request });
        }
        if (path === 'phone-requests/review') {
          const payload = route.request().postDataJSON(), request = requests.find(item => item.id === payload.id);
          assert.ok(request); request.status = payload.decision === 'approve' ? 'approved' : 'declined';
          request.reviewedAt = new Date().toISOString(); request.reviewedBy = user.id;
          if (request.status === 'approved') user = { ...user, phone: request.requestedPhone, revision: user.revision + 1 };
          else rejected.push(request.id);
          return reply({ request });
        }
        return reply({ message: 'Unexpected request.' }, 403);
      });
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const shot = async name => {
        await page.screenshot({ path: new URL(`${engine}-${width}-${theme}-${name}.png`, out).pathname, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}/${width}/${theme}/${name} horizontal overflow`);
        for (const box of await page.locator('.personal-phone, .phone-request').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right }; }))) {
          assert.ok(box.left >= -1 && box.right <= width + 1, `${engine}/${width}/${theme}/${name} clipped panel`);
        }
        if (width <= 760 && name === 'notification') {
          await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
          await page.screenshot({ path: new URL(`${engine}-${width}-${theme}-notification-bottom.png`, out).pathname });
          await page.evaluate(() => scrollTo(0, 0));
        }
      };
      try {
        await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Personal details', exact: true }).click();
        await page.getByRole('button', { name: 'Request change', exact: true }).click();
        await page.getByLabel('New WhatsApp phone', { exact: true }).fill('+65 (8123)-4567');
        await page.getByLabel('New WhatsApp phone', { exact: true }).blur();
        await expect(page.getByLabel('New WhatsApp phone', { exact: true })).toHaveValue('+6581234567');
        await shot('form');
        await page.getByRole('button', { name: 'Submit request', exact: true }).click();
        await expect(page.locator('.personal-phone')).toContainText(/awaiting admin approval/i);
        await expect(page.locator('.personal-phone-value')).toContainText(original.phone);
        await expect(page.getByRole('button', { name: 'Request change', exact: true })).toHaveCount(0);
        assert.equal(sent[0].phone, '+6581234567'); assert.match(sent[0].requestId, /^[a-f0-9-]{36}$/);
        await shot('pending');
        await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
        const bell = page.getByRole('button', { name: /Notifications, 1 phone change request awaiting approval/i });
        await expect(bell).toBeVisible(); await bell.click();
        const queue = page.getByRole('region', { name: 'Phone change requests', exact: true });
        await expect(queue).toContainText('+6581234567'); await shot('notification');
        await queue.getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(queue).toContainText(/phone number updated/i);
        await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Personal details', exact: true }).click();
        await expect(page.locator('.personal-phone-value')).toContainText('+6581234567'); await shot('approved');
        await page.getByRole('button', { name: 'Request change', exact: true }).click();
        await page.getByLabel('New WhatsApp phone', { exact: true }).fill('+6587654321');
        await page.getByRole('button', { name: 'Submit request', exact: true }).click();
        await expect(page.locator('.personal-phone')).toContainText(/awaiting admin approval/i);
        await page.getByRole('button', { name: 'Users & Access', exact: true }).click();
        await expect(page.locator('.users-access-list > button')).toHaveCount(1);
        const directoryQueue = page.getByRole('region', { name: 'Phone change requests', exact: true });
        await expect(directoryQueue).toContainText('+6587654321'); await shot('directory-queue');
        await directoryQueue.getByRole('button', { name: 'Decline', exact: true }).click();
        await expect(directoryQueue).toContainText(/phone change declined/i);
        await page.getByRole('button', { name: 'Personal details', exact: true }).click();
        await expect(page.locator('.personal-phone')).toContainText(/declined/i);
        await expect(page.locator('.personal-phone-value')).toContainText('+6581234567');
        await page.getByRole('button', { name: 'Request change', exact: true }).click();
        await page.getByLabel('New WhatsApp phone', { exact: true }).fill('+6587654322');
        await page.getByRole('button', { name: 'Submit request', exact: true }).click();
        await expect(page.locator('.personal-phone')).toContainText(/awaiting admin approval/i);
        await page.getByRole('button', { name: 'Users & Access', exact: true }).click();
        await page.locator('.users-access-list > button').click();
        await page.getByLabel('Name', { exact: true }).fill('UNSAVED EDIT');
        await page.getByRole('region', { name: 'Phone change requests', exact: true }).getByRole('button', { name: 'Approve', exact: true }).click();
        await expect(page.getByLabel('Name', { exact: true })).toHaveValue('UNSAVED EDIT');
        await expect(page.getByRole('button', { name: 'Reload user', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: 'Reload user', exact: true }).click();
        await expect(page.getByLabel('WhatsApp phone', { exact: true })).toHaveValue('+6587654322');
        assert.equal(rejected.length, 1); assert.deepEqual(errors, []);
        reports.push({ engine, width, theme, passed: true }); console.log(`PASS ${engine} ${width} ${theme}`);
      } catch (error) { await shot('failure').catch(() => {}); throw error; }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(new URL('results.json', out), JSON.stringify(reports, null, 2));

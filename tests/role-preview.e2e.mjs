import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4261';
const output = new URL('../output/role-preview-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const realUser = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test', displayName: 'PREVIEW ADMIN',
  phone: '+85200000001', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isManager: false,
  isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 5 };
const offices = ['HONG KONG', 'SINGAPORE', 'KOREA', 'CREDIT'].map(id => ({ id, name: id }));
const results = [];
const snapshot = page => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
  .filter(key => key.startsWith('ecosystem.prototype.') || key.startsWith('ecosystem.inbox.')).map(key => [key, localStorage.getItem(key)])));
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_ONE && (width !== 1440 || theme !== 'light')) continue;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      let preview = null, actual = { ...realUser }, mutations = 0;
      const envelope = () => ({ user: actual, preview, effectiveUser: preview ? { ...actual, officeId: preview.officeId,
        officeName: preview.officeName, isAdmin: preview.role === 'admin', isManager: preview.role === 'manager', isSpcTrader: preview.role === 'spc-trader' } : actual });
      await context.route('**/api/access/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname.replace('/api/access/', '');
        const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
        const reply = (json, status = 200) => route.fulfill({ status, json });
        if (path === 'session') return reply(actual ? envelope() : { user: null }, actual ? 200 : 401);
        if (path === 'preview/options') return reply({ offices });
        if (path === 'preview') { preview = { ...body, officeName: body.officeId, readOnly: true }; return reply(envelope()); }
        if (path === 'preview/end') { preview = null; return reply(envelope()); }
        if (path === 'logout') { preview = null; actual = null; return reply({ user: null }); }
        if (path === 'users' && request.method() === 'GET') return reply({ users: [actual], offices });
        mutations++; return reply({ message: 'Unexpected mutation.' }, 403);
      });
      await context.addInitScript(value => { localStorage.setItem('ecosystem.theme.v1', value); }, theme);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(base);
        await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('button', { name: 'Users & Access', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
        await expect(page.getByRole('button', {name: 'Reset demo',exact:true})).toHaveCount(0);
        await expect(page.locator('.home-hat-ranking')).toHaveCount(0);
        const before = await snapshot(page);
        const otherTab = width === 1440 && theme === 'light' ? await context.newPage() : null;
        if (otherTab) { await otherTab.goto(base); await otherTab.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor(); }
        for (const role of ['trader', 'spc-trader', 'manager', 'credit']) {
          await page.getByRole('button', { name: 'View as', exact: true }).click();
          await page.getByRole('button', { name: ({trader:'Normal trader','spc-trader':'SPC Trader',manager:'Manager',credit:'Credit'})[role], exact: true }).click();
          await expect(page.getByRole('status', { name: 'Role preview' })).toContainText('Read only');
          assert.equal(preview.role, role);
          assert.equal(preview.officeId, role === 'credit' ? 'CREDIT' : realUser.officeId);
          if (otherTab) await expect(otherTab.getByRole('status', { name: 'Role preview' })).toContainText('Read only');
          await expect(page.locator('.hud-identity')).toContainText(realUser.displayName);
          await expect(page.locator('.hud-achievements-toggle, .hud-office-performance')).toHaveCount(0);
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Users & Access', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
          if (role === 'admin') await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled();
          else await expect(page.locator('.users-access')).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Team performance', exact: true })).toHaveCount(0);
          if (role === 'manager') await page.screenshot({ path: new URL(`${engine}-${width}-${theme}-manager.png`, output).pathname });
          await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
          if (role === 'credit') {
            assert.match(await page.locator('.hud-identity').innerText(), /Trader.*CREDIT/is);
            await page.screenshot({ path: new URL(`${engine}-${width}-${theme}-credit.png`, output).pathname });
          }
        }
        await page.getByRole('button', { name: 'Back to PREVIEW ADMIN', exact: true }).click();
        await expect(page.getByRole('status', { name: 'Role preview' })).toHaveCount(0);
        if (otherTab) { await expect(otherTab.getByRole('status', { name: 'Role preview' })).toHaveCount(0); await otherTab.close(); }
        assert.equal(preview, null);
        assert.deepEqual(await snapshot(page), before, 'Preview must not persist business or inbox mutations');
        assert.equal(mutations, 0);
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
        results.push({ engine, width, theme, passed: true, presets: 4 });
        console.log(`PASS ${engine} ${width} ${theme}`);
      } catch (error) {
        await page.screenshot({ path: new URL(`${engine}-${width}-${theme}-failure.png`, output).pathname }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));

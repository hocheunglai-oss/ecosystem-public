import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installTestWorkspacePolicy, activateTestWorkspace } from './fixtures/test-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_RELEASE_UI_ORIGIN || 'http://127.0.0.1:4327';
const out = resolve(process.env.ECO_RELEASE_UI_OUTPUT || 'output/eco-release-gates-ui');
const notice = 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0';
const admin = { capabilities: { appearancePreview: true, testWorkspace: true }, id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const roles = [['trader', 'Normal trader'], ['spc-trader', 'SPC Trader'], ['manager', 'Manager'], ['credit', 'Credit']];
const results = [];
await mkdir(out, { recursive: true });
async function mocks(context) {
  await installTestWorkspacePolicy(context);
  const state = { user: { ...admin }, preview: null, buyerFetches: 0, writes: [], logout: false };
  await installEmptyLiveInbox(context);
  await context.route('**/api/access/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname.split('/api/access/')[1];
    if (path === 'preview') { const input = request.postDataJSON(); state.preview = { ...input, officeName: input.officeId, readOnly: true }; }
    if (path === 'preview/end') state.preview = null;
    if (path === 'logout') { state.logout = true; return route.fulfill({ json: { ok: true } }); }
    if (path === 'session' && state.logout) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (['session', 'preview', 'preview/end'].includes(path)) return route.fulfill({ json: { user: state.user, preview: state.preview } });
    return route.fulfill({ json: { requests: [], users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
  });
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-09T00:00:00Z', periodEnd: '2026-10-16T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } }));
  await context.route('**/api/profile-tabs/**', route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === 'POST' ? req.postDataJSON() : null;
    const target = body?.target ?? { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') };
    if (target.kind === 'buyer') state.buyerFetches++;
    if (body) state.writes.push(body);
    return route.fulfill({ json: { target, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } });
  });
  return state;
}
async function open(page, name) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = navigation.getByRole('button', { name: name === 'Enquiries' ? 'Trading' : 'Buyers and Credit', exact: true });
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await navigation.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
// The disabled home heading intentionally has no route. Exercise legacy links
// independently so hiding navigation cannot conceal a missing central gate.
async function openDeferred(page, name) {
  await page.locator('.world-launcher').evaluate((node, route) => { const link = document.createElement('a'); link.href = route; link.textContent = 'TEST DEFERRED WORKSPACE LINK'; link.dataset.releaseTestLink = 'true'; node.append(link); }, name === 'Buyer Profiles' ? '#/companies' : '#/credit');
  const link = page.locator('[data-release-test-link]'); await link.click(); await link.evaluate(node => node.remove());
  const dialog = page.getByRole('dialog', { name, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function expectDeferredHeading(page) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = navigation.locator('[data-group="Buyers and Credit"]');
  const heading = group.getByRole('heading', { name: 'Buyers and Credit', exact: true });
  await expect(heading).toBeVisible(); await expect(heading).toHaveAccessibleDescription(notice);
  await expect(group.getByText(notice, { exact: true })).toBeVisible();
  await expect(group.locator('button, a, svg, [aria-expanded], [aria-controls], .launcher-expansion')).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Buyer Profiles', exact: true, includeHidden: true })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Credit Requests', exact: true, includeHidden: true })).toHaveCount(0);
  await heading.click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
  assert.ok(await heading.evaluate(node => node.tabIndex < 0), 'Deferred heading is not an interactive keyboard target');
  const layout = await group.evaluate(node => { const heading = node.querySelector('[role="heading"]').getBoundingClientRect(), remark = node.querySelector('.launcher-release-remark'); return { gap: remark.getBoundingClientRect().top - heading.bottom, fontSize: parseFloat(getComputedStyle(remark).fontSize) }; });
  assert.ok(layout.gap >= -1 && layout.gap <= 8 && layout.fontSize === 11, 'Small release remark directly follows the lime heading');
}
async function close(page) { await page.getByRole('button', { name: 'Close workspace', exact: true }).click(); }
async function changePreview(page, label) {
  await page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true }).click();
  await page.locator('.home-display-controls').getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('status', { name: 'Role preview' }).first()).toContainText(label);
}
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    await installStagingCookies(context, base); const state = await mocks(context);
    await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
    const shot = async name => { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: viewport overflow`); };
    try {
      await page.goto(base); await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible(); await activateTestWorkspace(page);
      let dialog = await open(page, 'Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible(); await close(page);
      dialog = await open(page, 'Credit Requests'); await expect(dialog.locator('.credit-workspace')).toBeVisible();
      // Admin contextual links and modal remain usable.
      await dialog.getByRole('button', { name: 'Credit request', exact: true }).click(); await expect(page.getByRole('dialog').last().locator('form')).toBeVisible(); await page.keyboard.press('Escape'); await close(page);
      const search = page.getByRole('combobox', { name: 'Search ECO' }); await search.fill('ECO20001'); await expect(page.getByRole('option').first()).toContainText('Buyer'); await search.press('Escape'); await search.fill('');
      for (const [role, label] of roles) {
        await changePreview(page, label);
        const before = state.buyerFetches;
        await expectDeferredHeading(page);
        if (role === 'trader') await shot('preview-menu');
        for (const name of ['Buyer Profiles', 'Credit Requests']) {
          dialog = await openDeferred(page, name); await expect(dialog.locator('.release-notice:visible')).toHaveText(notice);
          await expect(dialog.locator('.buyer-profile, .buyer-profile-directory, .credit-workspace')).toHaveCount(0);
          if (role === 'trader') await shot(name === 'Buyer Profiles' ? 'buyer-gate' : 'credit-gate'); await close(page);
        }
        await search.fill('ECO20001'); await expect(page.getByRole('option')).toHaveCount(0); await expect(page.getByText('No results', { exact: true })).toBeVisible(); await search.fill('');
        dialog = await open(page, 'Enquiries'); await expect(dialog.getByRole('region', { name: 'Client credit' }).locator('.release-notice:visible')).toHaveText(notice);
        await dialog.getByRole('tab', { name: 'Buyers and Credit', exact: true }).click(); await expect(dialog.locator('#center-panel-Credit .release-notice')).toHaveText(notice); await expect(dialog.locator('.buyer-profile, .credit-usage')).toHaveCount(0);
        if (role === 'trader') await shot('enquiry-credit-gate'); await close(page);
        assert.equal(state.buyerFetches, before, `${role}: blocked screens must not fetch buyer profile data`);
        await page.getByRole('button', { name: 'Back to SAMPLE TRADER', exact: true }).first().click(); await expect(page.getByRole('status', { name: 'Role preview' })).toHaveCount(0);
      }
      // Revoke administrator access while a buyer workspace is mounted. Cached
      // administrator panels must disappear before another person can use them.
      dialog = await open(page, 'Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible();
      state.user = { ...admin, displayName: 'REAL TRADER', isAdmin: false, isSpcTrader: false }; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(page.locator('.hud-identity')).toContainText('REAL TRADER'); await expect(page.locator('.buyer-profile-directory')).toHaveCount(0);
      for (const [role] of roles) {
        state.user = { ...admin, displayName: `REAL ${role.toUpperCase()}`, isAdmin: false, isSpcTrader: role === 'spc-trader', isManager: role === 'manager', officeId: role === 'credit' ? 'CREDIT' : 'HONG KONG', officeName: role === 'credit' ? 'CREDIT' : 'HONG KONG' };
        await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
        await expect(page.locator('.hud-identity')).toContainText(`REAL ${role.toUpperCase()}`);
        await expect(page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true })).toHaveCount(0);
        await expectDeferredHeading(page);
        for (const name of ['Buyer Profiles', 'Credit Requests']) { dialog = await openDeferred(page, name); await expect(dialog.locator('.release-notice:visible')).toHaveText(notice); await close(page); }
      }
      state.user = { ...admin }; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true })).toBeVisible();
      dialog = await open(page, 'Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible(); await close(page);
      assert.deepEqual(state.writes, [], 'release preview must not save profile data'); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true, previewRoles: roles.map(([role]) => role), actualRoles: roles.map(([role]) => role) }); console.log(`PASS ${engine} ${width} ${theme}: admin, four previews, four actual roles, search, legacy links, enquiry, access revocation`);
    } catch (error) { await shot('failure'); throw error; } finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ base, results, limits: 'Isolated browser fixtures; native Safari and physical devices not tested.' }, null, 2));

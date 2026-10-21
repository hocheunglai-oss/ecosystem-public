import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4186';
const OUT = new URL('../artifacts/hats-knowledge/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const update = { updatedBy: 'gianmichele', updatedAt: '2026-10-05T09:00:00.000Z' };
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
async function profile(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await button(nav, 'Intelligence').click();
  await button(nav, 'Countries & Ports').click();
  const dialog = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  await button(dialog, 'Port Index').click();
  await dialog.getByLabel('Country or port', { exact: true }).fill('Chiba');
  await button(dialog.locator('.location-table'), 'Chiba').click();
  return dialog;
}
try {
  for (const { width, height, theme } of [
    { width: 1440, height: 900, theme: 'light' },
    { width: 1280, height: 800, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    { width: 850, height: 900, theme: 'dark' },
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', hasTouch: width < 900 });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(BASE);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      await page.evaluate(update => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        state.knowledgeRecords ??= {};
        state.knowledgeRecords['port:port-chiba'] = { version: 1, layoutVersion: 2, sections: [
          { id: 'general', role: 'port-information', title: 'Port Information', blocks: [
            { id: 'note', type: 'text', title: 'DELIVERY NOTE', text: 'CONFIRM BARGE ACCESS BEFORE ARRIVAL.', update },
          ] },
          { id: 'remarks', role: 'trader-remarks', title: "Trader's Remarks", blocks: [
            { id: 'cross-tab-note', type: 'text', title: 'AFTER HOURS', text: 'NIGHTSHIFT NEEDS ADVANCE NOTICE.', update },
          ] },
        ] };
        const port = state.ports.find(port => port.id === 'port-chiba');
        port.intelligenceKeyInfo = { qualityClaim: 'Possible', isoSpecs: 'All', sampleLocation: "Vessel's manifold", debunkering: 'Common' };
        port.intelligenceEntryUpdates = { qualityClaim: update };
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
      }, update);
      await page.reload();
      let dialog = await profile(page);
      const search = dialog.getByRole('textbox', { name: 'Search all tabs', exact: true });
      await expect(search).toBeVisible();
      assert.equal(await search.evaluate(input => !!input.closest('.knowledge-header')), true);
      await search.fill('nightshift');
      const results = dialog.getByRole('region', { name: 'Search all tabs', exact: true });
      await expect(results).toContainText('NIGHTSHIFT NEEDS ADVANCE NOTICE.');
      await expect(results.locator('.knowledge-search-section-head')).toContainText("Trader's Remarks");
      await expect(results).not.toContainText('CONFIRM BARGE ACCESS');
      await button(dialog, 'Clear information search').click();
      await expect(dialog.getByRole('tab', { name: 'Port Information', exact: true })).toHaveAttribute('aria-selected', 'true');
      const article = dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: 'DELIVERY NOTE', exact: true }) });
      const trigger = article.getByRole('button', { name: 'Hats Off to SAMPLE MANAGER A for DELIVERY NOTE', exact: true });
      await expect(trigger).toBeVisible();
      await expect(trigger.locator('time')).toHaveAttribute('datetime', update.updatedAt);
      await expect(trigger.locator('svg.lucide-history')).toHaveCount(0);
      if (width >= 900) {
        await trigger.hover();
        await expect(trigger.locator('.knowledge-hat-action')).toHaveCSS('visibility', 'visible');
      }
      const before = await snapshot(page);
      await trigger.click();
      const undo = article.getByRole('button', { name: 'Hats Off to SAMPLE MANAGER A for DELIVERY NOTE', exact: true });
      await expect(undo).toHaveAttribute('aria-pressed', 'true');
      let state = await snapshot(page);
      assert.equal(state.hats.filter(hat => !hat.undoneAt).length, 1);
      assert.equal(state.hats[0].recipientId, 'gianmichele');
      assert.deepEqual(state.contributions, before.contributions, 'Giving Hats earns no Gold');
      await undo.click();
      await expect(trigger).toHaveAttribute('aria-pressed', 'false');
      await trigger.click();
      await expect(undo).toHaveAttribute('aria-pressed', 'true');
      assert.equal((await snapshot(page)).hats.length, 1, 'Undo/reaward keeps one entry');
      const sizes = await dialog.locator('.knowledge-update, .knowledge-entry-edit').evaluateAll(buttons => [...new Set(buttons.filter(button => button.offsetParent).map(button => getComputedStyle(button).fontSize))]);
      assert.equal(sizes.length, 1, `UPDATE font sizes match: ${sizes}`);
      assert.equal(await dialog.locator('.knowledge-facts').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
      await page.mouse.move(1, 1);
      await page.screenshot({ path: new URL(`profile-${width}-${theme}.png`, OUT).pathname });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.reload();
      dialog = await profile(page);
      await expect(dialog.getByRole('button', { name: 'Hats Off to SAMPLE MANAGER A for DELIVERY NOTE', exact: true })).toHaveAttribute('aria-pressed', 'true');
      // A later contributor receives only NEW endorsements; the prior Hat remains Vincent's.
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        const document = state.knowledgeRecords['port:port-chiba'];
        document.version++;
        document.sections[0].blocks[0].update = { updatedBy: 'silvia', updatedAt: '2026-10-06T09:00:00.000Z' };
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
        sessionStorage.setItem('ecosystem.session.v1', 'filippo');
      });
      await page.reload();
      dialog = await profile(page);
      await button(dialog, 'Hats Off to SAMPLE MANAGER B for DELIVERY NOTE').click();
      state = await snapshot(page);
      assert.deepEqual(state.hats.map(hat => hat.recipientId), ['gianmichele', 'silvia']);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width} ${theme}: all-tab search, Hat award/undo/persistence/latest attribution, consistent actions and no overflow`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

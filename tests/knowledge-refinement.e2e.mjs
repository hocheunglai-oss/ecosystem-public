import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4187';
const OUT = new URL('../artifacts/knowledge-refinement/', import.meta.url);
const update = { updatedBy: 'otto', updatedAt: '2026-10-05T09:00:00.000Z' };
const text = 'EXACT LEGACY CONTENT. SOURCE TEXT MUST REMAIN INTACT.';
const evidence = { source: 'Agent email', evidence: 'Original mixed Case source evidence.' };
const existingHat = {
  id: 'legacy-award', target: { kind: 'knowledge', target: { kind: 'port', id: 'port-chiba' }, blockId: 'legacy-note' },
  targetKey: JSON.stringify(['knowledge', 'port', 'port-chiba', 'legacy-note', null]),
  readerId: 'filippo', recipientId: 'otto', awardedAt: '2026-10-05T10:00:00.000Z', update, documentVersion: 4,
};
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
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
async function switchProfile(page, actor) {
  await page.evaluate(actor => sessionStorage.setItem('ecosystem.session.v1', actor), actor);
  await page.reload();
  return profile(page);
}
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const { width, height, theme } of [
    { width: 1440, height: 900, theme: 'light' },
    { width: 1280, height: 800, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    { width: 850, height: 900, theme: 'dark' },
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    try {
      await page.goto(BASE);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      await page.evaluate(({ update, text, evidence, existingHat }) => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        state.knowledgeRecords ??= {};
        state.knowledgeRecords['port:port-chiba'] = { version: 4, layoutVersion: 2, sections: [
          { id: 'general', role: 'port-information', title: 'Port Information', blocks: [
            { id: 'legacy-note', type: 'text', title: '  ', text, provenance: evidence, update },
            { id: 'legacy-unknown', type: 'text', title: '', text: 'SOURCE WITHOUT RECORDED CONTRIBUTOR.' },
          ] },
        ] };
        const port = state.ports.find(port => port.id === 'port-chiba');
        port.intelligenceKeyInfo = { qualityClaim: 'Possible', isoSpecs: 'All', sampleLocation: "Vessel's manifold", debunkering: 'Common' };
        port.intelligenceEntryUpdates = { isoSpecs: update, debunkering: update };
        state.hats = [existingHat];
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
      }, { update, text, evidence, existingHat });
      const before = await snapshot(page);
      await page.reload();
      let dialog = await profile(page);
      let state = await snapshot(page);
      const document = state.knowledgeRecords['port:port-chiba'];
      assert.equal(document.version, 4);
      assert.deepEqual(document.sections[0].blocks.map(block => block.title), ['Port Information 1', 'Port Information 2']);
      assert.equal(document.sections[0].blocks[0].text, text);
      assert.deepEqual(document.sections[0].blocks[0].provenance, evidence);
      assert.deepEqual(document.sections[0].blocks[0].update, update);
      assert.equal(document.sections[0].blocks[1].update, undefined);
      assert.deepEqual(state.hats, [existingHat]);
      assert.deepEqual(state.contributions, before.contributions);
      assert.deepEqual(state.knowledgeHistory, before.knowledgeHistory);
      const first = dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Port Information 1', exact: true }) });
      const unknown = dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Port Information 2', exact: true }) });
      await expect(first).toContainText(text);
      await expect(first.locator('.knowledge-attribution-static')).toContainText('SAMPLE TRADER');
      await expect(unknown.locator('.knowledge-entry-audit')).toHaveCount(0);
      await expect(dialog.locator('.knowledge-facts .knowledge-audit-trigger')).toHaveCount(0);
      await expect(dialog.locator('.knowledge-facts .knowledge-attribution-static')).toHaveCount(2);
      await expect(dialog.locator('.knowledge-entry-audit svg.lucide-history')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '1 Hats. Hat ranking', exact: true })).toBeVisible();
      const buttons = await dialog.locator('.knowledge-entry-edit').evaluateAll(elements => elements.map(element => ({ size: getComputedStyle(element).fontSize, color: getComputedStyle(element).color })));
      assert.ok(buttons.length >= 3);
      assert.ok(buttons.every(button => button.size === '10px'));
      assert.ok(buttons.every(button => button.color === (theme === 'light' ? 'rgb(24, 140, 121)' : 'rgb(128, 219, 193)')), `UPDATE styles: ${JSON.stringify(buttons)}`);
      assert.equal(await dialog.locator('.knowledge-facts').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
      const headerHeights = await dialog.locator('.knowledge-facts > header, .knowledge-block-head').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().height)));
      if (width >= 900) assert.ok(headerHeights.every(height => height >= 28 && height <= 32), `Compact desktop headers: ${headerHeights}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: new URL(`profile-${width}-${theme}.png`, OUT).pathname });

      // Required titles reject both empty and whitespace-only new entries without any save or award.
      await button(dialog, 'Update Port Information 1').click();
      const editor = page.getByRole('dialog', { name: 'Update information', exact: true });
      await button(editor, 'Add Text').click();
      const title = editor.getByLabel('Block 3 title', { exact: true });
      await editor.getByLabel('Block 3 text', { exact: true }).fill('NEW ENTRY NEEDS A TITLE.');
      for (const invalid of ['', '   ']) {
        await title.fill(invalid);
        await button(editor, 'Update').click();
        await expect(editor).toBeVisible();
        assert.equal(await title.evaluate(input => input.checkValidity()), false);
        assert.equal((await snapshot(page)).knowledgeRecords['port:port-chiba'].version, 4);
      }
      await page.screenshot({ path: new URL(`required-title-${width}-${theme}.png`, OUT).pathname });
      await button(editor, 'Cancel').click();

      // A different signed-in trader can award the two individually attributed Key Info fields.
      dialog = await switchProfile(page, 'silvia');
      await expect(dialog.locator('.knowledge-facts .knowledge-audit-trigger')).toHaveCount(2);
      const iso = button(dialog.locator('.knowledge-facts'), 'Hats Off to SAMPLE TRADER for ISO Specs');
      const debunkering = button(dialog.locator('.knowledge-facts'), 'Hats Off to SAMPLE TRADER for Debunkering');
      if (width >= 900) {
        await iso.hover();
        await expect(iso.locator('.knowledge-hat-action')).toHaveCSS('visibility', 'visible');
      } else {
        await expect(iso.locator('.knowledge-hat-action')).toHaveCSS('visibility', 'visible');
      }
      await iso.click();
      await expect(iso).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(1, 1);
      await expect(iso.locator('.knowledge-hat-check')).toBeVisible();
      assert.ok(!(await iso.innerText()).includes('UNDO'));
      assert.ok(!(await iso.innerText()).includes('−1'));
      await debunkering.click();
      await expect(debunkering).toHaveAttribute('aria-pressed', 'true');
      state = await snapshot(page);
      assert.deepEqual(state.hats.map(hat => hat.recipientId), ['otto', 'otto', 'otto']);
      assert.deepEqual(state.hats.slice(1).map(hat => hat.target), [
        { kind: 'key-info', portId: 'port-chiba', field: 'isoSpecs' },
        { kind: 'key-info', portId: 'port-chiba', field: 'debunkering' },
      ]);
      assert.deepEqual(state.hats[0], existingHat);
      assert.deepEqual(state.contributions, before.contributions, 'Hats do not earn extra Gold');
      await page.mouse.move(1, 1);
      await page.screenshot({ path: new URL(`key-info-awarded-${width}-${theme}.png`, OUT).pathname });
      await page.reload();
      dialog = await profile(page);
      await expect(button(dialog, 'Hats Off to SAMPLE TRADER for ISO Specs')).toHaveAttribute('aria-pressed', 'true');
      await expect(button(dialog, 'Hats Off to SAMPLE TRADER for Debunkering')).toHaveAttribute('aria-pressed', 'true');
      await switchProfile(page, 'otto');
      await expect(page.getByRole('button', { name: '3 Hats. Hat ranking', exact: true })).toBeVisible();
      assert.deepEqual(errors, []);
      console.log(`PASS ${width} ${theme}: legacy title preservation, required title validation, compact green actions, self-Hat exclusion, Key Info awards and persistent personal total; headers ${headerHeights.join('/')}`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

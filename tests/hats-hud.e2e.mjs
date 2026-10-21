import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Disposable, isolated browser contexts only. No production or personal browser state.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const OUT = new URL('../artifacts/hats-hud/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const scenarios = [[1440, 900, false], [1280, 720, false], [390, 844, true], [850, 900, true], [320, 844, true]];
const hatButton = page => page.locator('.hud-resource[data-resource="hat"]');
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const intersects = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;

async function seedRecognition(page) {
  await page.evaluate(async () => {
    const { createSeedState } = await import('/src/lib/seed.ts');
    const { actors, applyAction } = await import('/src/lib/model.ts');
    const { knowledgeDocument } = await import('/src/lib/knowledge.ts');
    const { hatRecipient } = await import('/src/lib/hats.ts');
    let state = createSeedState();
    const target = { kind: 'port', id: 'port-chiba' };
    for (let index = 0; index < actors.length; index++) {
      const author = actors[index], base = knowledgeDocument(state, target), document = structuredClone(base);
      const blockId = `browser-hat-test-${author.id}`;
      document.sections[0].blocks.push({ id: blockId, type: 'text', title: 'TEST ONLY', text: `Isolated browser verification for ${author.name}.` });
      state = applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: base.version, baseDocument: base, document }, reason: 'Test only' }, author);
      const entry = { kind: 'knowledge', target, blockId };
      for (const reader of actors.filter(person => person.id !== author.id).slice(0, index + 1)) {
        state = applyAction(state, { type: 'set-hat', target: entry, expectedUpdate: hatRecipient(state, entry), active: true }, reader);
      }
    }
    localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
  });
  await page.reload({ waitUntil: 'networkidle' });
}

try {
  for (const [width, height, mobile] of scenarios) for (const theme of ['light', 'dark']) {
    const name = `${width}x${height}-${theme}`;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [], externalWrites = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) externalWrites.push(request.url()); });
    await context.addInitScript(mode => {
      localStorage.setItem('ecosystem.theme.v1', mode);
      sessionStorage.setItem('ecosystem.session.v1', 'gianmichele');
    }, theme);
    try {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('data-interface', mobile ? 'mobile' : 'desktop');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(hatButton(page).locator('strong')).toHaveText('0');
      if (!mobile) {
        await expect(page.locator('.home-hat-ranking .hat-ranking-list')).toHaveCount(0);
        await expect(page.locator('.home-hat-ranking .hat-ranking-empty')).toBeVisible();
      }
      await seedRecognition(page);
      await expect(hatButton(page).locator('strong')).toHaveText('5');
      const before = await saved(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal viewport overflow');
      const hudGeometry = await page.locator('.trader-hud').evaluate(hud => {
        const bounds = hud.getBoundingClientRect().toJSON();
        return { bounds, controls: [...hud.querySelectorAll('.hud-profile-toggle, .hud-resource, .inbox-toggle, .hud-settings')].map(control => control.getBoundingClientRect().toJSON()) };
      });
      for (const control of hudGeometry.controls) assert.ok(control.x >= hudGeometry.bounds.x - 1 && control.right <= hudGeometry.bounds.right + 1, 'HUD controls fit the panel');
      for (let i = 0; i < hudGeometry.controls.length; i++) for (let j = i + 1; j < hudGeometry.controls.length; j++) {
        assert.equal(intersects(hudGeometry.controls[i], hudGeometry.controls[j]), false, 'HUD controls do not overlap');
      }
      await expect(page.locator('.resource-icon-oil, .resource-icon-gold, .fleet-berths, .fleet-berth, .team-destination')).toHaveCount(0);
      if (mobile) {
        await expect(page.locator('.hud-resource[data-resource="oil"], .hud-resource[data-resource="activity"], .home-hat-ranking, .fleet-berths, .hud-achievements-toggle')).toHaveCount(0);
      } else {
        await expect(page.locator('.home-hat-ranking .hat-ranking-list li')).toHaveCount(7);
        await expect(page.locator('.home-hat-ranking .hat-ranking-position').first()).toHaveText('1');
        await expect(page.locator('.home-hat-ranking .hat-ranking-position').nth(1)).toHaveText('1');
        await expect(page.locator('.home-hat-ranking .hat-ranking-position').nth(2)).toHaveText('3');
        const geometry = await page.evaluate(() => ({
          ranking: document.querySelector('.home-hat-ranking').getBoundingClientRect().toJSON(),
          others: [...document.querySelectorAll('.home-hud-stack, .world-controls, .home-display-controls')].map(element => ({ name: element.className, box: element.getBoundingClientRect().toJSON() })),
        }));
        for (const other of geometry.others) assert.equal(intersects(geometry.ranking, other.box), false, `Ranking avoids ${other.name}`);
        const activity = page.locator('.hud-resource[data-resource="activity"]');
        await expect(activity).toHaveAttribute('aria-label', '1 contributions in the last 28 days');
        await expect(activity.locator('.resource-icon-activity')).toHaveCount(1);
        await expect(activity).toContainText('28D');
        const controlGaps = await page.locator('.hud-points-row').evaluate(row => {
          const controls = [...row.children].map(child => child.getBoundingClientRect());
          return controls.slice(1).map((box, index) => box.left - controls[index].right);
        });
        assert.ok(controlGaps.every(gap => gap >= 11), 'Desktop resources and utility controls have clear spacing');
      }
      await page.screenshot({ path: new URL(`home-${name}.png`, OUT).pathname });
      await hatButton(page)[mobile ? 'tap' : 'click']();
      await expect(page.locator('html')).toHaveAttribute('data-interface', mobile ? 'mobile' : 'desktop');
      await expect(hatButton(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#hud-hat-ranking .hat-ranking-list li')).toHaveCount(7);
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      const inlineGeometry = await page.locator('#hud-hat-ranking').evaluate(panel => ({ panel: panel.getBoundingClientRect().toJSON(), hud: panel.closest('.trader-hud').getBoundingClientRect().toJSON() }));
      assert.ok(inlineGeometry.panel.x >= inlineGeometry.hud.x && inlineGeometry.panel.right <= inlineGeometry.hud.right + 1 && inlineGeometry.panel.bottom <= inlineGeometry.hud.bottom + 1, 'Expanded ranking stays inside the HUD');
      if (mobile) await page.locator('#hud-hat-ranking').scrollIntoViewIfNeeded();
      else await expect(page.locator('.home-hat-ranking')).not.toBeVisible();
      await page.screenshot({ path: new URL(`inline-${name}.png`, OUT).pathname });
      await expect(page.locator('html')).toHaveAttribute('data-interface', mobile ? 'mobile' : 'desktop');
      if (mobile) await hatButton(page).tap();
      else await hatButton(page).press('Escape');
      await expect(page.locator('#hud-hat-ranking')).toHaveCount(0);
      await hatButton(page)[mobile ? 'tap' : 'click']();
      await page.getByRole('button', { name: /^Personal details$/i })[mobile ? 'tap' : 'click']();
      await expect(page.locator('#hud-hat-ranking')).toHaveCount(0);
      await expect(hatButton(page)).toHaveAttribute('aria-expanded', 'false');
      const profile = page.getByRole('region', { name: /^Personal details$/i });
      await expect(profile).toBeVisible();
      await profile.getByRole('button', { name: /^Close personal details$/i })[mobile ? 'tap' : 'click']();
      assert.deepEqual(await saved(page), before, 'Reading rankings does not change awards or business data');
      assert.deepEqual(errors, [], 'No browser errors');
      assert.deepEqual(externalWrites, [], 'No remote writes');
      results.push({ name, status: 'passed' });
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${name}.png`, OUT).pathname, fullPage: true });
      results.push({ name, status: 'failed', error: error.message });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
  await browser.close();
}

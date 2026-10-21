import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4189';
const OUT = new URL('../artifacts/incoming-scenarios/', import.meta.url);
await mkdir(OUT, { recursive: true });
const scenarios = [
  ['normal', 'Normal enquiry'], ['insufficient-credit', 'Insufficient credit'],
  ['same-enquiry', 'Same enquiry · another trader'], ['same-account', 'Same account · another trader'],
  ['unknown-port', 'Unknown port'], ['unknown-buyer', 'Unknown buyer'],
  ['suspended-buyer', 'Suspended buyer'], ['overdue-payment', 'Overdue payment'],
  ['multi-grade', 'Three grades · split suppliers'], ['pending-credit', 'Buyer awaiting credit approval'],
];
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
try {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: 'reduce' });
    await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    try {
      await page.goto(BASE);
      await page.getByRole('combobox', { name: 'Demo profile', exact: true }).selectOption('otto');
      await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
      for (const [index, [id, label]] of scenarios.entries()) {
        await page.getByRole('button', { name: 'Notifications', exact: true }).click();
        const inbox = page.getByRole('region', { name: 'Enquiries', exact: true });
        await inbox.getByRole('button', { name: index % 2 ? 'Email (demo)' : 'WhatsApp (demo)', exact: true }).click();
        const picker = inbox.getByRole('region', { name: 'Enquiry scenarios', exact: true });
        await expect(picker.getByRole('button')).toHaveCount(11);
        if (index === 0) await page.screenshot({ path: new URL(`picker-${width}-${theme}.png`, OUT).pathname });
        await picker.getByRole('button', { name: label, exact: true }).click();
        const center = page.getByRole('dialog', { name: 'Enquiries', exact: true });
        await expect(center).toBeVisible();
        await expect(center.getByRole('tab', { name: 'Enquiries', exact: true })).toHaveAttribute('aria-selected', 'true');
        const buyer = center.getByRole('combobox', { name: 'Buyer', exact: true });
        const port = center.getByRole('combobox', { name: 'Port', exact: true });
        if (id === 'normal') { await expect(buyer).toHaveValue(/ASTER/); await expect(center.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled(); }
        if (id === 'insufficient-credit') await expect(center.getByRole('region', { name: 'Credit alerts' })).toContainText('Shortfall');
        if (id === 'same-enquiry' || id === 'same-account') {
          await expect(center.getByRole('region', { name: 'Account activity' })).toContainText(id === 'same-enquiry' ? 'SAME VESSEL' : 'DIFFERENT VESSEL');
        }
        if (id === 'unknown-port') {
          await expect(port).toHaveValue(/PUERTO BRISA/i);
          await expect(center.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
          await center.getByRole('button', { name: 'Countries & Ports', exact: true }).click();
          const locations = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
          await expect(locations).toBeVisible();
          await locations.getByRole('button', { name: 'Enquiries', exact: true }).click();
          await expect(center.getByLabel('Raw enquiry', { exact: true })).toHaveValue(/Puerto Brisa/i);
        }
        if (id === 'unknown-buyer') {
          await expect(buyer).toHaveValue(/PELORUS/);
          await expect(center.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
          await center.getByRole('button', { name: 'Add lead', exact: true }).click();
          const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /New lead/i }) });
          await expect(modal).toBeVisible();
          await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        }
        if (id === 'suspended-buyer') await expect(center.getByRole('region', { name: 'Credit alerts' })).toContainText('Suspended');
        if (id === 'overdue-payment') await expect(center.getByRole('region', { name: 'Credit alerts' })).toContainText('Overdue payment');
        if (id === 'pending-credit') await expect(center.getByRole('region', { name: 'Credit alerts' })).toContainText('awaiting credit approval');
        if (id === 'multi-grade') { for (const grade of ['HSFO', 'VLSFO', 'LSMGO']) await expect(center.getByLabel(grade, { exact: true })).not.toHaveValue(''); }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${id} page fits`);
        if (['normal', 'insufficient-credit', 'unknown-buyer'].includes(id)) await page.screenshot({ path: new URL(`${id}-${width}-${theme}.png`, OUT).pathname });
        await center.getByRole('button', { name: 'Close workspace', exact: true }).click();
        results.push({ width, theme, scenario: id, status: 'pass' });
      }
      assert.deepEqual(errors, []);
      const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')));
      assert.equal(snapshot.items.length, scenarios.length);
      assert(snapshot.items.every(item => item.owner === 'otto'));
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
}
console.log(`${results.length} incoming scenario browser cases passed`);

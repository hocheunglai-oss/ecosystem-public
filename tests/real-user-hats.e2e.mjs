import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

// Authenticated UI fixtures in an isolated local browser only. Every access
// request is intercepted; no account or publication is written to a service.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const output = new URL('../artifacts/real-user-hats/', import.meta.url);
await mkdir(output, { recursive: true });
const reader = '20000000-0000-4000-8000-000000000001';
const author = '20000000-0000-4000-8000-000000000002';
const unknown = '20000000-0000-4000-8000-000000000003';
const email = 'Author.Name@example.com';
const storageKey = `ecosystem.prototype.v2:${reader}`;
const user = { id: reader, email: 'Reader.Name@example.com', displayName: 'HAT READER', officeId: 'HKG', officeName: 'HONG KONG',
  isAdmin: false, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };

async function openProfile(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await nav.getByRole('button', { name: 'Ports & Suppliers', exact: true }).click();
  await nav.getByRole('button', { name: 'Countries & Ports', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  await dialog.getByRole('button', { name: 'Port Index', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Country or port', exact: true }).fill('Chiba');
  await dialog.locator('.location-table').getByRole('button', { name: 'Chiba', exact: true }).click();
  return dialog;
}
const readState = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const article = (page, dialog, title) => dialog.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

for (const engine of ['chromium', 'webkit']) {
  const browser = await (engine === 'chromium' ? chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }) : webkit.launch({ headless: true }));
  try {
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 850, hasTouch: width < 850, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage(), errors = [], unexpectedRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/api/**', async route => {
          const request = route.request(), path = new URL(request.url()).pathname;
          if (path === '/api/access/session' && request.method() === 'GET') return route.fulfill({ json: { user } });
          unexpectedRequests.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 500, json: { message: 'Unexpected test service request.' } });
        });
        await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
        await page.clock.setFixedTime(new Date('2026-10-14T03:00:00Z'));
        await page.goto(base, { waitUntil: 'networkidle' });
        await expect(page.locator('[data-trader-hud]')).toBeVisible();
        await page.evaluate(({ storageKey, reader, author, unknown, email }) => {
          const state = JSON.parse(localStorage.getItem(storageKey));
          state.hats = [];
          state.profiles[author] = { email, phone: '' };
          state.knowledgeRecords ??= {};
          state.knowledgeRecords['port:port-chiba'] = { version: 1, layoutVersion: 2, sections: [{ id: 'general', role: 'port-information', title: 'Port Information', blocks: [
            { id: 'real-author', type: 'text', title: 'UUID AUTHOR NOTE', text: 'CONFIRMED LOCAL DELIVERY INFORMATION.', update: { updatedBy: author, updatedAt: '2026-10-13T01:00:00Z' } },
            { id: 'own-note', type: 'text', title: 'SELF AUTHORED NOTE', text: 'THIS NOTE BELONGS TO THE SIGNED-IN READER.', update: { updatedBy: reader, updatedAt: '2026-10-13T01:00:00Z' } },
            { id: 'unknown-note', type: 'text', title: 'UNKNOWN AUTHOR NOTE', text: 'THIS UUID HAS NO KNOWN PROFILE.', update: { updatedBy: unknown, updatedAt: '2026-10-13T01:00:00Z' } },
          ] }] };
          localStorage.setItem(storageKey, JSON.stringify(state));
        }, { storageKey, reader, author, unknown, email });
        await page.reload({ waitUntil: 'networkidle' });
        let dialog = await openProfile(page);
        const authorNote = article(page, dialog, 'UUID AUTHOR NOTE');
        const trigger = authorNote.getByRole('button', { name: `Hats Off to ${email} for UUID AUTHOR NOTE`, exact: true });
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveAttribute('aria-pressed', 'false');
        await expect(authorNote.locator('.knowledge-attribution-name')).toHaveText(email);
        await expect(authorNote.locator('.knowledge-attribution-name')).toHaveCSS('text-transform', 'none');
        await expect(trigger.locator('.knowledge-hat-action [data-email-value]')).toHaveText(email);
        await expect(trigger.locator('.knowledge-hat-action [data-email-value]')).toHaveCSS('text-transform', 'none');
        const selfNote = article(page, dialog, 'SELF AUTHORED NOTE');
        await expect(selfNote.locator('.knowledge-attribution-name')).toHaveText('HAT READER');
        await expect(selfNote.getByRole('button', { name: /Hats Off/ })).toHaveCount(0);
        const unknownNote = article(page, dialog, 'UNKNOWN AUTHOR NOTE');
        await expect(unknownNote.locator('.knowledge-attribution-name')).toHaveText('CONTRIBUTOR');
        await expect(unknownNote.getByRole('button', { name: /Hats Off/ })).toHaveCount(0);
        const before = await readState(page);
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-pressed', 'true');
        let recorded = await readState(page);
        assert.equal(recorded.hats.length, 1);
        assert.equal(recorded.hats[0].readerId, reader);
        assert.equal(recorded.hats[0].recipientId, author);
        const receivedAt = recorded.hats[0].awardedAt;
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-pressed', 'false');
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-pressed', 'true');
        recorded = await readState(page);
        assert.equal(recorded.hats.length, 1, 'Undo and restore reuse the existing reader slot');
        assert.equal(recorded.hats[0].awardedAt, receivedAt);
        assert.equal(recorded.hats[0].undoneAt, undefined);
        assert.deepEqual(recorded.contributions, before.contributions, 'Hats do not fabricate contributions');
        await page.screenshot({ path: new URL(`${engine}-${width}-${theme}.png`, output).pathname });
        await page.reload({ waitUntil: 'networkidle' });
        dialog = await openProfile(page);
        await expect(article(page, dialog, 'UUID AUTHOR NOTE').getByRole('button', { name: `Hats Off to ${email} for UUID AUTHOR NOTE`, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
        await page.locator('[data-resource="hat"]').click();
        const ranking = page.locator('#hud-hat-ranking');
        await expect(ranking.locator('.hat-ranking-name')).toHaveText(email);
        await expect(ranking.locator('.hat-ranking-name')).toHaveCSS('text-transform', 'none');
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpectedRequests, []);
        console.log(`PASS ${engine} ${width} ${theme}: UUID Hat click, slot reuse, self/unknown exclusion, email case, persistence`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}

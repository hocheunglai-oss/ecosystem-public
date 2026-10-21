import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { syntheticPdf } from './fixtures/pdf-document.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_PDF_PREVIEW_ORIGIN || 'http://127.0.0.1:4326';
const out = resolve(process.env.ECO_PDF_PREVIEW_OUTPUT || '/private/tmp/eco-pdf-preview');
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'pdf@example.test', displayName: 'PDF FIXTURE ADMIN', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const bytes = syntheticPdf(), results = [];
await mkdir(out, { recursive: true });

async function fixture(context, theme) {
  const state = { user: structuredClone(user), writes: [] };
  await context.addInitScript(theme => {
    localStorage.setItem('ecosystem.theme.v1', theme);
    window.__pdfLifecycle = { urls: new Set(), workers: 0, terminated: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__pdfLifecycle.urls.add(url); return url; };
    URL.revokeObjectURL = url => { window.__pdfLifecycle.urls.delete(url); revoke(url); };
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url, options) { super(url, options); this.pdf = String(url).includes('pdf.worker'); if (this.pdf) window.__pdfLifecycle.workers++; }
      terminate() { if (this.pdf) { window.__pdfLifecycle.terminated++; this.pdf = false; } return super.terminate(); }
    };
  }, theme);
  await context.route('**/api/**', route => {
    if (route.request().method() !== 'GET') state.writes.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, json: { message: 'Unconfigured isolated fixture.' } });
  });
  await installEmptyLiveInbox(context);
  await context.route('**/api/access/**', route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    return route.fulfill({ json: path === 'session' ? { user: state.user, preview: null } : path === 'users' ? { users: [state.user], offices: [] } : { requests: [] } });
  });
  await context.route('**/api/admin/**', route => route.fulfill({ json: { items: [], count: 0, source: 'shared-feedback' } }));
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: false } }));
  await context.route('**/api/profile-tabs/**', route => route.fulfill({ json: { shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
  return state;
}

const engines = (process.env.ECO_PDF_PREVIEW_ENGINES || 'chromium,webkit').split(',');
const widths = (process.env.ECO_PDF_PREVIEW_WIDTHS || '1440,320,390').split(',').map(Number);
const themes = (process.env.ECO_PDF_PREVIEW_THEMES || 'light,dark').split(',');
for (const engine of engines) {
  const browser = await ({ chromium, webkit })[engine].launch({ headless: true });
  try { for (const width of widths) for (const theme of themes) {
    const name = `${engine}-${width}-${theme}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, reducedMotion: 'reduce' });
    await installStagingCookies(context, base);
    const state = await fixture(context, theme), page = await context.newPage();
    page.setDefaultTimeout(15000);
    const failures = [], pdfRequests = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('request', request => { if (request.url().includes('/pdf-preview/')) pdfRequests.push(request.url()); });
    const shot = async label => page.screenshot({ path: `${out}/${name}-${label}.png` });
    try {
      await page.goto(base);
      await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await button(nav, 'Ports & Suppliers').click(); await button(nav, 'Countries & Ports').click();
      const workspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
      await button(workspace, 'Port Index').click();
      await workspace.getByLabel('Country or port', { exact: true }).fill('Singapore');
      await workspace.locator('.location-table').getByRole('button', { name: 'Singapore', exact: true }).click();
      await workspace.locator('.knowledge-header .attachments-trigger').first().click();
      const files = page.getByRole('dialog', { name: 'Attachments', exact: true });
      await expect(button(files, 'Upload files')).toBeEnabled();
      await files.getByLabel('Upload attachments', { exact: true }).setInputFiles([
        { name: 'Synthetic report.PDF', mimeType: 'application/octet-stream', buffer: bytes },
        { name: 'Broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\ninvalid') },
        { name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Case-sensitive original text.') },
      ]);
      await expect(files.locator('.attachment-file-tile')).toHaveCount(3);
      assert.equal(pdfRequests.length, 0, 'PDF renderer is never part of initial/app or Files loading');
      await files.locator('.attachment-file-tile').filter({ hasText: 'Synthetic report.PDF' }).click();
      let preview = page.getByRole('dialog', { name: 'PDF PREVIEW', exact: true });
      await expect(preview).toHaveAttribute('data-window-size', 'expanded');
      const canvas = preview.getByRole('img', { name: 'PDF page 1', exact: true });
      await expect(canvas).toBeVisible();
      await expect(preview).toContainText('PAGE 1 / 2');
      assert.equal(await page.evaluate(() => window.__pdfExecuted), undefined, 'PDF OpenAction scripts never execute');
      assert.ok(pdfRequests.length >= 2 && pdfRequests.every(url => new URL(url).origin === new URL(base).origin), 'Renderer/worker/fonts load only from ECO');
      assert.ok(!pdfRequests.some(url => /sandbox|quickjs/.test(url)), 'No PDF script engine is loaded');
      await shot('page-one');
      assert.ok(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Dialog has no horizontal overflow');
      const firstWidth = await canvas.evaluate(node => node.getBoundingClientRect().width);
      await button(preview, 'Zoom in').click(); await expect(canvas).toBeVisible();
      await expect.poll(() => canvas.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(firstWidth + 1);
      await button(preview, 'FIT WIDTH').click(); await expect(canvas).toBeVisible();
      await button(preview, 'Next page').click();
      await expect(preview.getByRole('img', { name: 'PDF page 2', exact: true })).toBeVisible();
      await expect(button(preview, 'Next page')).toBeDisabled();
      await button(preview, 'TEXT').click(); await expect(preview.locator('pre')).toContainText('Case-sensitive document text 2');
      await shot('text'); await button(preview, 'TEXT').click();
      await button(preview, 'Shrink window').click(); await expect(preview).toHaveAttribute('data-window-size', 'compact');
      await expect(preview).toContainText('PAGE 2 / 2');
      await button(preview, 'Expand window').click(); await expect(preview.getByRole('img', { name: 'PDF page 2' })).toBeVisible();
      const event = page.waitForEvent('download'); await preview.getByRole('link', { name: 'DOWNLOAD', exact: true }).click();
      const download = await event; assert.equal(download.suggestedFilename(), 'Synthetic report.PDF');
      const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), bytes, 'Download retains original bytes');
      await button(preview, 'Close dialog').click();
      await expect(preview).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.__pdfLifecycle.workers - window.__pdfLifecycle.terminated)).toBe(0);
      await button(files, 'Close attachment details').click();
      await expect.poll(() => page.evaluate(() => window.__pdfLifecycle.urls.size)).toBe(0);
      await files.locator('.attachment-file-tile').filter({ hasText: 'Broken.pdf' }).click();
      preview = page.getByRole('dialog', { name: 'PDF PREVIEW', exact: true });
      await expect(preview.getByRole('alert')).toHaveText('PDF COULD NOT BE PREVIEWED. DOWNLOAD TO OPEN.');
      await expect(preview.getByRole('link', { name: 'DOWNLOAD', exact: true })).toBeVisible();
      await shot('invalid'); await button(preview, 'Close dialog').click();
      await files.locator('.attachment-file-tile').filter({ hasText: 'Notes.txt' }).click();
      await expect(files.locator('.attachment-preview pre')).toHaveText('Case-sensitive original text.');
      if (engine === 'chromium') {
        // Old browser records keep their Blob shape; no migration may destroy
        // or rewrite those bytes. WebKit's current test runtime rejects writing
        // old Blob records, which is the reason for the new byte format.
        await page.evaluate(async data => {
          const database = await new Promise((resolve, reject) => { const request = indexedDB.open('ecosystem.attachments.v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          await new Promise((resolve, reject) => {
            const transaction = database.transaction(['items', 'blobs'], 'readwrite');
            const request = transaction.objectStore('items').getAll();
            request.onsuccess = () => {
              const original = request.result.find(item => item.name === 'Synthetic report.PDF');
              transaction.objectStore('items').put({ ...original, id: 'legacy-blob-fixture', name: 'Legacy Blob.pdf' });
              transaction.objectStore('blobs').put({ id: 'legacy-blob-fixture', blob: new Blob([new Uint8Array(data)], { type: 'application/pdf' }) });
            };
            transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
          });
          database.close(); const channel = new BroadcastChannel('ecosystem.attachments.v1'); channel.postMessage('changed'); channel.close();
        }, [...bytes]);
        await files.locator('.attachment-file-tile').filter({ hasText: 'Legacy Blob.pdf' }).click();
        const legacyPreview = page.getByRole('dialog', { name: 'PDF PREVIEW', exact: true });
        await expect(legacyPreview.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
        await button(legacyPreview, 'Close dialog').click();
      }
      await files.locator('.attachment-file-tile').filter({ hasText: 'Synthetic report.PDF' }).click();
      preview = page.getByRole('dialog', { name: 'PDF PREVIEW', exact: true });
      await expect(preview.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
      state.user = { ...user, id: '20000000-0000-4000-8000-000000000002', displayName: 'SECOND FIXTURE USER' };
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(preview).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.__pdfLifecycle.urls.size)).toBe(0);
      await expect.poll(() => page.evaluate(() => window.__pdfLifecycle.workers - window.__pdfLifecycle.terminated)).toBe(0);
      state.user = null; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Attachments', exact: true })).toHaveCount(0);
      await shot('signed-out');
      assert.deepEqual(state.writes, []); assert.deepEqual(failures, []);
      results.push({ engine, width, theme, passed: true });
      console.log(`PASS ${name}: lazy PDF, rendering/navigation/zoom/text/download, invalid file, actor switch and resource cleanup`);
    } catch (error) { await shot('failure'); results.push({ engine, width, theme, passed: false, error: String(error) }); throw error; }
    finally { await context.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
  } } finally { await browser.close(); }
}

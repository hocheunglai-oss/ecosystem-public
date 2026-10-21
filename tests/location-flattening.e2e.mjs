import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_LOCATION_UI_ORIGIN || 'http://127.0.0.1:4318';
const out = resolve(process.env.ECO_LOCATION_UI_OUTPUT || 'output/location-flattening-ui');
await mkdir(out, { recursive: true });
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const key = `ecosystem.live.v1:${user.id}:state`;
const results = [];
async function mock(context) {
  await installEmptyLiveInbox(context);
  await context.route('**/api/profile-tabs/list?**', route => { const url = new URL(route.request().url()); return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }); });
  await context.route('**/api/access/**', route => { const path = new URL(route.request().url()).pathname.split('/api/access/')[1]; return route.fulfill({ status: path === 'session' || path === 'users' || path === 'phone-requests' ? 200 : 403, json: path === 'session' ? { user, effectiveUser: user, preview: null } : path === 'users' ? { users: [user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } : path === 'phone-requests' ? { requests: [] } : { message: 'Unexpected access request' } }); });
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-09T00:00:00Z', periodEnd: '2026-10-15T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } }));
}
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    await installStagingCookies(context, base); await mock(context);
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
    const shot = async name => { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': viewport overflow'); const box = await page.getByRole('dialog').last().boundingBox(); assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, name + ': dialog clipping'); };
    try {
      await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      await expect.poll(() => page.evaluate(key => Boolean(localStorage.getItem(key)), key)).toBe(true);
      const before = await page.evaluate(async ({ key, withBlob }) => {
        const state = JSON.parse(localStorage.getItem(key)); delete state.locationStructureVersion;
        state.locationAreas = [{ id: 'old-tokyo-bay', name: 'Tokyo Bay', country: 'Japan' }];
        state.ports.find(port => port.id === 'port-chiba').areaId = 'old-tokyo-bay';
        state.knowledgeRecords['area:old-tokyo-bay'] = { version: 8, layoutVersion: 2, sections: [{ id: 'original-section', title: 'Original notes', blocks: [{ id: 'original-block', title: 'Original note', type: 'text', text: 'Preserve this exact user-authored record.' }] }] };
        const document = state.knowledgeRecords['area:old-tokyo-bay'];
        state.knowledgeHistory ??= []; state.knowledgeHistory.push({ target: { kind: 'area', id: 'old-tokyo-bay' }, version: 8, at: '2026-10-12T00:00:00Z', by: 'otto', reason: 'Original', before: { ...document, version: 7 }, after: structuredClone(document) });
        localStorage.setItem(key, JSON.stringify(state));
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('ecosystem.attachments.v1', 1); r.onupgradeneeded = () => { for (const name of ['items', 'folders', 'blobs']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath: 'id' }); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const scope = { target: { kind: 'area', id: 'old-tokyo-bay' } };
        await new Promise((resolve, reject) => { const tx = db.transaction(['items', 'folders', 'blobs'], 'readwrite'); tx.objectStore('folders').put({ id: 'area:old-tokyo-bay', parentId: 'country:Japan', name: 'Tokyo Bay (Area)', scope }); tx.objectStore('items').put({ id: 'preserved-file', folderId: 'area:old-tokyo-bay', scope, name: 'ORIGINAL SOURCE.txt', type: withBlob ? 'file' : 'link', url: withBlob ? undefined : 'https://example.test/original.txt', mime: 'text/plain', size: 15, createdAt: '2026-10-12T00:00:00Z', createdBy: 'otto' }); if (withBlob) { const blobWrite = tx.objectStore('blobs').put({ id: 'preserved-file', blob: new Blob(['ORIGINAL BYTES']) }); blobWrite.onerror = () => reject(new Error(`Fixture Blob write: ${blobWrite.error?.name}: ${blobWrite.error?.message}`)); } tx.oncomplete = resolve; tx.onabort = () => reject(new Error(`Fixture attachment write failed: ${tx.error?.name}: ${tx.error?.message}`)); }); db.close();
        return { document, history: state.knowledgeHistory, outcomes: state.outcomes, ports: state.ports.map(({ areaId, ...port }) => port) };
      }, { key, withBlob: engine === 'chromium' });
      await page.reload(); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      const migrated = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
      assert.equal(migrated.locationAreas, undefined); assert.equal(migrated.locationStructureVersion, 1); assert.deepEqual(migrated.ports, before.ports); assert.deepEqual(migrated.knowledgeRecords['area:old-tokyo-bay'], before.document); assert.deepEqual(migrated.knowledgeHistory, before.history); assert.deepEqual(migrated.outcomes, before.outcomes);
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' }), group = nav.getByRole('button', { name: 'Ports & Suppliers', exact: true }); if (await group.getAttribute('aria-expanded') !== 'true') await group.click(); await nav.getByRole('button', { name: 'Countries & Ports', exact: true }).click();
      const workspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
      await workspace.getByRole('button', { name: 'Port Index', exact: true }).click(); await workspace.getByLabel('Country or port', { exact: true }).fill('Chiba'); await expect(workspace.getByRole('columnheader', { name: 'Country', exact: true })).toBeVisible(); await expect(workspace.getByText('Tokyo Bay', { exact: true })).toHaveCount(0); await shot('directory');
      await workspace.locator('.location-table').getByRole('button', { name: 'Chiba', exact: true }).click(); await expect(workspace.getByRole('heading', { name: 'Chiba', exact: true })).toBeVisible(); await expect(workspace.locator('.location-parent-path')).toContainText('Japan'); await expect(workspace.locator('.location-parent-path')).not.toContainText('Tokyo Bay'); await shot('port');
      await workspace.locator('.location-parent-path').getByRole('button', { name: 'Japan', exact: true }).click(); await workspace.getByRole('tab', { name: /^Ports$/i }).click(); await expect(workspace.getByRole('region', { name: 'Ports in this country' })).toContainText('Chiba'); await shot('country');
      await workspace.locator('.knowledge-header .attachments-trigger').click(); const attachments = page.getByRole('dialog', { name: 'Attachments', exact: true }); await attachments.locator('.attachment-folder-tile').filter({ hasText: /Tokyo Bay/i }).click(); await expect(attachments.locator('.attachment-file-tile').filter({ hasText: 'ORIGINAL SOURCE.txt' })).toBeVisible(); await expect(attachments.getByText('(Area)', { exact: false })).toHaveCount(0); await shot('preserved-files');
      await attachments.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await workspace.getByRole('button', { name: 'Add location', exact: true }).click(); let editor = page.getByRole('dialog', { name: 'Add location', exact: true }); assert.deepEqual(await editor.getByLabel('Type', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['country', 'port']); await expect(editor.getByLabel('Area (optional)', { exact: true })).toHaveCount(0); await shot('add-port');
      await editor.getByLabel('Type', { exact: true }).selectOption('country'); await editor.getByLabel('Name', { exact: true }).fill('NEW TEST COUNTRY'); await editor.getByRole('button', { name: 'Add location', exact: true }).click(); await expect(workspace.getByRole('heading', { name: 'NEW TEST COUNTRY', exact: true })).toBeVisible();
      await workspace.getByRole('button', { name: 'Add location', exact: true }).click(); editor = page.getByRole('dialog', { name: 'Add location', exact: true }); await editor.getByLabel('Name', { exact: true }).fill('NEW TEST PORT'); await editor.getByRole('button', { name: 'Add location', exact: true }).click(); await expect(workspace.getByRole('heading', { name: 'NEW TEST PORT', exact: true })).toBeVisible();
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key); assert.equal(saved.ports.find(port => port.name === 'NEW TEST PORT').country, 'NEW TEST COUNTRY'); assert.ok(saved.ports.every(port => !('areaId' in port))); assert.deepEqual(errors, []);
      if (engine === 'chromium') assert.equal(await page.evaluate(async () => { const db = await new Promise((resolve, reject) => { const r = indexedDB.open('ecosystem.attachments.v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); const saved = await new Promise((resolve, reject) => { const r = db.transaction('blobs').objectStore('blobs').get('preserved-file'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return saved.blob.text(); }), 'ORIGINAL BYTES');
      results.push({ engine, width, theme, status: 'passed', originalBlobBytesVerified: engine === 'chromium', ...(engine === 'webkit' ? { fixtureNote: 'Link metadata used: this isolated WebKit runtime rejects IndexedDB Blob writes with UnknownError while preparing Blob/File data.' } : {}) });
    } catch (error) { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-FAILURE.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: results.length, output: out }));

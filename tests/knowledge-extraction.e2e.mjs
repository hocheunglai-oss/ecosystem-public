import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const API = 'https://spc.fcuno.com/api/ecosystem/knowledge-extract';
const OUT = new URL('../artifacts/knowledge-extraction/', import.meta.url);
const SOURCE = 'LOCAL AGENT CIRCULAR · EXTRACTION BROWSER TEST';
const RAW = [
  'Japan: obtain written agent confirmation before nominating a delivery.',
  'Chiba receiving schedule: berth names and delivery windows are listed below.',
  ...Array.from({ length: 21 }, (_, i) => `Berth ${i + 1}: Window ${i + 1}`),
  'Hong Kong: debunkering is common.',
  'Bay desk note: reconfirm the final receiving position. The exact bay is unclear.',
  'Singapore: this optional note should not be published.',
].join('\n').toUpperCase();
const EDITED = 'JAPAN: CONFIRM THE FINAL RECEIVING POSITION WITH THE APPOINTED AGENT BEFORE NOMINATION.';
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const readActivity = page => page.evaluate(async () => {
  const { contributionActivity } = await import('/src/lib/contributionActivity.ts');
  return contributionActivity(JSON.parse(localStorage.getItem('ecosystem.demo.v1')), 'otto');
});
const stateEvidence = state => ({
  records: state.knowledgeRecords, history: state.knowledgeHistory,
  contributions: state.contributions, audit: state.audit,
  ports: state.ports.map(port => ({ id: port.id, keyInfo: port.intelligenceKeyInfo })),
});
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

function extraction(body) {
  const location = (name, kind) => {
    const found = body.locations.find(item => item.name === name && (!kind || item.kind === kind));
    assert.ok(found, `Missing test location ${name}`);
    return found.key;
  };
  const proposal = values => ({
    locationKey: null, locationName: '', section: "Trader's Remarks", title: '', kind: 'text',
    text: '', columns: [], rows: [], field: null, value: null, evidence: '', warning: null, ...values,
  });
  return { warnings: ['The bay name needs confirmation.'], proposals: [
    proposal({ locationKey: location('Japan', 'country'), locationName: 'Japan', title: 'Delivery confirmation', text: RAW.split('\n')[0], evidence: RAW.split('\n')[0] }),
    proposal({ locationKey: location('Chiba', 'port'), locationName: 'Chiba', title: 'Receiving schedule', kind: 'table', columns: ['Berth', 'Window'], rows: Array.from({ length: 21 }, (_, i) => [`Berth ${i + 1}`, `Window ${i + 1}`]), evidence: RAW.split('\n')[1] }),
    proposal({ locationKey: location('Hong Kong', 'port'), locationName: 'Hong Kong', section: 'Key Info', title: 'Debunkering', kind: 'keyInfo', field: 'debunkering', value: 'Common', evidence: 'Hong Kong: debunkering is common.' }),
    proposal({ locationName: 'Bay', title: 'Receiving position', text: 'Reconfirm the final receiving position.', evidence: 'Bay desk note: reconfirm the final receiving position. The exact bay is unclear.', warning: 'Select the bay this note applies to.' }),
    proposal({ locationKey: location('Singapore', 'port'), locationName: 'Singapore', title: 'Optional note', text: 'This optional note should not be published.', evidence: 'Singapore: this optional note should not be published.' }),
  ] };
}

async function enter(page) {
  await page.goto(BASE);
  const profile = page.getByLabel('Demo profile', { exact: true });
  if (await profile.isVisible()) {
    await profile.selectOption('otto');
    await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  }
}
async function directory(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const item = nav.getByRole('button', { name: 'Countries & Ports', exact: true });
  if (!(await item.isVisible())) await nav.getByRole('button', { name: 'Ports & Suppliers', exact: true }).click();
  await item.click();
  return page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
}
async function openExtractor(page, workspace) {
  const back = workspace.getByRole('button', { name: /^(Back to )?Countries & Ports$/, exact: true });
  if (await back.isVisible()) await back.click();
  const dialog = workspace.getByRole('region', { name: 'Information extractor', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function fillInput(dialog) {
  await dialog.getByLabel('Information', { exact: true }).fill(RAW);
  await dialog.getByLabel('Source (optional)', { exact: true }).fill(SOURCE);
  await dialog.getByLabel('Source date (optional)', { exact: true }).fill('2026-10-05');
}
async function noOverflow(page, dialog) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Page should fit viewport');
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Dialog should not overflow horizontally');
}

try {
  const layouts = [[1440, 'light'], [1440, 'dark'], [390, 'light'], [850, 'dark']]
    .filter(([width]) => !process.env.ECO_EXTRACT_WIDTH || width === Number(process.env.ECO_EXTRACT_WIDTH));
  for (const [width, theme] of layouts) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', isMobile: width < 1000, hasTouch: width < 1000 });
    await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), theme);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', event => { if (event.type() === 'error' && !event.text().includes('status of 401')) errors.push(event.text()); });
    let mode = width === 1440 && theme === 'light' ? 'unauthorized' : 'success';
    let requests = 0;
    let pending;
    let latestRequest;
    await page.route(API, async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': new URL(BASE).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      requests++;
      latestRequest = route.request().postDataJSON();
      assert.equal(latestRequest.text, RAW);
      assert.equal(latestRequest.source, SOURCE);
      assert.equal(latestRequest.sourceDate, '2026-10-05');
      assert.equal(latestRequest.contextKey, null);
      assert.ok(latestRequest.locations.every(record => !('sections' in record)), 'Only destination metadata sent');
      assert.ok(latestRequest.locations.every(record => record.kind !== 'area'), 'Areas are grouping metadata, not publication destinations');
      for (const name of ['Hong Kong', 'Singapore', 'Gibraltar']) {
        const destinations = latestRequest.locations.filter(record => record.name === name);
        assert.equal(destinations.length, 1, `${name} has one extraction destination`);
        assert.equal(destinations[0].kind, 'port');
      }
      if (mode === 'pending') { pending = route; return; }
      if (mode === 'unauthorized') return route.fulfill({ status: 401, json: { error: 'Authentication required' } });
      if (mode === 'invalid') return route.fulfill({ status: 200, json: { proposals: [{ kind: 'text' }], warnings: [] } });
      return route.fulfill({ status: 200, json: extraction(latestRequest) });
    });
    try {
      await enter(page);
      let workspace = await directory(page);
      const initial = await readState(page);
      const initialActivity = await readActivity(page);
      const activityButton = page.getByRole('button', { name: /contributions in the last 28 days$/, includeHidden: true });
      await expect(activityButton).toHaveCount(width >= 1000 ? 1 : 0);
      let dialog = await openExtractor(page, workspace);
      await expect(dialog.getByRole('button', { name: 'Extract', exact: true })).toBeDisabled();
      await fillInput(dialog);
      await noOverflow(page, dialog);
      await page.screenshot({ path: new URL(`paste-${width}-${theme}.png`, OUT).pathname });
      await dialog.getByRole('button', { name: 'Extract', exact: true }).click();
      if (mode === 'unauthorized') {
        await expect(dialog.getByRole('alert')).toContainText('Sign in to FC UNO or SPC');
        const signIn = dialog.getByRole('link', { name: /Sign in to FC UNO/ });
        await expect(signIn).toHaveAttribute('href', /^https:\/\/spc\.fcuno\.com\/?$/);
        await expect(signIn).toHaveAttribute('target', '_blank');
        await expect(dialog.getByLabel('Information', { exact: true })).toHaveValue(RAW);
        await expect(dialog.getByLabel('Source (optional)', { exact: true })).toHaveValue(SOURCE);
        assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(initial));
        mode = 'success';
        await dialog.getByRole('button', { name: 'Retry extraction', exact: true }).click();
      }
      await expect(dialog.getByRole('heading', { name: 'Check changes', exact: true })).toBeVisible();
      await expect(dialog.getByRole('article')).toHaveCount(5);
      await expect(dialog.getByLabel('Include change 4', { exact: true })).not.toBeChecked();
      await expect(dialog.getByText('4 / 5 selected', { exact: true })).toBeVisible();
      assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(initial), 'Extraction must not publish or record activity');
      await dialog.getByLabel('Information for change 1', { exact: true }).fill(EDITED);
      const first = dialog.getByRole('article', { name: 'Change 1', exact: true });
      await first.locator('.extract-evidence summary').click();
      await expect(first.locator('blockquote')).toHaveText(RAW.split('\n')[0]);
      await noOverflow(page, dialog);
      await dialog.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: new URL(`review-${width}-${theme}.png`, OUT).pathname });
      const table = dialog.getByRole('article', { name: 'Change 2', exact: true });
      await table.getByLabel('Row 1 column 2 for change 2', { exact: true }).fill('08:00–12:00');
      await expect(table.locator('tbody tr')).toHaveCount(20);
      await table.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(table.locator('tbody tr')).toHaveCount(1);
      await table.getByLabel('Row 21 column 2 for change 2', { exact: true }).fill('ON REQUEST');
      await table.getByRole('button', { name: 'Previous', exact: true }).click();
      await expect(table.getByLabel('Row 1 column 2 for change 2', { exact: true })).toHaveValue('08:00–12:00');
      await noOverflow(page, dialog);
      const unmatched = dialog.getByLabel('Location for change 4', { exact: true });
      await unmatched.fill('Tokyo Bay');
      await expect(dialog.getByRole('option', { name: /Tokyo Bay$/ })).toHaveCount(0);
      await dialog.getByRole('option', { name: /Yokohama$/ }).click();
      await dialog.getByLabel('Include change 4', { exact: true }).check();
      await dialog.getByLabel('Include change 5', { exact: true }).uncheck();
      await expect(dialog.getByText('4 / 5 selected', { exact: true })).toBeVisible();
      assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(initial));
      await dialog.getByRole('button', { name: /^Update(?:\s|$)/ }).click();
      await expect(dialog).toHaveCount(0);
      const saved = await readState(page);
      assert.equal(saved.contributions.length, initial.contributions.length + 1, 'One contribution for the complete batch');
      const contribution = saved.contributions[0];
      assert.equal(contribution.status, 'approved');
      assert.equal(contribution.publication, 'direct');
      assert.equal(contribution.author, 'otto');
      assert.equal(contribution.extractionBatch.changes.length, 4);
      assert.equal(contribution.extractionBatch.intelligenceChanges.length, 1);
      assert.match(saved.audit[0].detail, /contribution recorded\./i);
      assert.doesNotMatch(saved.audit[0].detail, /Gold|reward|awarded/i);
      const publishedActivity = await readActivity(page);
      assert.equal(publishedActivity.total, initialActivity.total + 1, 'One published AI batch adds one contribution');
      const batchActivity = publishedActivity.entries.find(entry => entry.contributionIds.includes(contribution.id));
      assert.equal(batchActivity.kind, 'ai-import');
      assert.equal(batchActivity.recordCount, 4, 'Japan, Chiba, Hong Kong and Yokohama are four distinct updated profiles');
      if (width >= 1000) await expect(activityButton).toHaveAttribute('aria-label', `${publishedActivity.total} contributions in the last 28 days`);
      assert.deepEqual(saved.economy, initial.economy, 'Publication does not grant a new reward balance');
      assert.deepEqual(saved.hats, initial.hats, 'AI publication does not award Hats');
      assert.equal(saved.knowledgeHistory.length, (initial.knowledgeHistory?.length || 0) + 4);
      const blocks = contribution.extractionBatch.changes.flatMap(change => change.document.sections.flatMap(section => section.blocks));
      assert.ok(blocks.some(block => block.text === EDITED));
      assert.ok(!blocks.some(block => block.text === 'This optional note should not be published.'));
      const savedTable = blocks.find(block => block.title === 'Receiving schedule');
      assert.equal(savedTable.rows[0].cells[1], '08:00–12:00');
      assert.equal(savedTable.rows[20].cells[1], 'ON REQUEST');
      assert.equal(savedTable.provenance.source, SOURCE);
      assert.equal(savedTable.provenance.date, '2026-10-05');
      assert.equal(saved.ports.find(port => port.name === 'Hong Kong').intelligenceKeyInfo.debunkering, 'Common');
      await workspace.getByRole('button', { name: /^History/ }).click();
      await expect(workspace.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
      await expect(workspace.getByRole('button', { name: /Updated from pasted information/ })).toBeVisible();
      await page.reload();
      assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(saved), 'Published batch survives reload without recording another contribution');
      assert.equal((await readActivity(page)).total, publishedActivity.total);
      workspace = await directory(page);

      // The full failure/abort suite is run once; all layouts exercise publication.
      if (width === 1440 && theme === 'light') {
        dialog = await openExtractor(page, workspace);
        await fillInput(dialog);
        await workspace.getByRole('button', { name: 'Country Index', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(saved));
        mode = 'invalid';
        dialog = await openExtractor(page, workspace);
        await fillInput(dialog);
        await dialog.getByRole('button', { name: 'Extract', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('Could not read the extracted information');
        await expect(dialog.getByRole('article')).toHaveCount(0);
        assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(saved));
        mode = 'pending';
        const count = requests;
        await dialog.getByRole('button', { name: 'Retry extraction', exact: true }).click();
        await expect.poll(() => requests).toBe(count + 1);
        await expect(dialog.getByRole('status')).toHaveText('Extracting information…');
        const canceledRoute = pending;
        await dialog.getByRole('button', { name: 'Cancel extraction', exact: true }).click();
        assert.equal(requests, count + 1, 'Cancel must not trigger another paid extraction request');
        // Resolve Playwright's intercepted route so Chromium can finish processing cancellation.
        await canceledRoute.fulfill({ status: 200, json: extraction(latestRequest) }).catch(() => {});
        await expect(dialog.getByRole('button', { name: 'Extract', exact: true })).toBeVisible();
        await expect(dialog.getByLabel('Information', { exact: true })).toHaveValue(RAW);
        await expect(dialog.getByRole('article')).toHaveCount(0);
        assert.deepEqual(stateEvidence(await readState(page)), stateEvidence(saved), 'A canceled request cannot publish or record activity');
        await workspace.getByRole('button', { name: 'Country Index', exact: true }).click();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px ${theme}: extract, edit, destinations, evidence, atomic update, one batch/four profiles, activity, history, persistence${width === 1440 && theme === 'light' ? ', 401 retry, invalid output, cancel and abort' : ''}`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_PARSER_REVIEW_ORIGIN || 'http://127.0.0.1:4394';
const out = resolve(process.env.ECO_PARSER_REVIEW_OUTPUT || 'output/parser-review-ui');
await mkdir(out, { recursive: true });
const user = { capabilities: { appearancePreview: true, testWorkspace: true }, id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'SAMPLE TRADER', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const generation = '30000000-0000-4000-8000-000000000001';
const now = '2026-10-16T10:00:00.000Z';
const results = [];
const fields = { vessel: 'SYNTHETIC ALPHA', imo: '', buyerText: 'SYNTHETIC BUYER', portText: 'SINGAPORE', eta: '20 OCT 2026', hsfo: '', vlsfo: '500', lsmgo: '', remarks: 'COQ REQUIRED' };
const raw = 'VESSEL: SYNTHETIC ALPHA\nBUYER: SYNTHETIC BUYER\nPORT: SINGAPORE\nETA: 20 OCT 2026\nVLSFO: 500 MT\nCOQ REQUIRED';

async function openReports(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await page.getByRole('navigation', { name: 'Administration', exact: true }).getByRole('button', { name: 'Import Activity', exact: true }).click();
  const region = page.getByRole('region', { name: 'Parser reports', exact: true });
  await expect(region).toBeVisible();
  return region;
}
async function nonParserRoute(route, state) {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/api/access/session') return route.fulfill(state.signedIn ? { json: { user: state.user, preview: state.preview } } : { status: 401, json: { message: 'Sign in required.' } });
  if (url.pathname === '/api/access/logout') { state.signedIn = false; return route.fulfill({ json: { ok: true } }); }
  if (url.pathname === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: true, generation: state.generation } });
  if (url.pathname === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
  if (url.pathname.startsWith('/api/access/')) return route.fulfill({ json: { requests: [], users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
  return route.fulfill({ json: { count: 0, items: [], nextCursor: null, page: 1, pageSize: 100, total: 0, periodStart: now, periodEnd: now, timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
}
function makeReport(index = 1, kind = 'complete') {
  const id = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const parsed = { ...fields, vessel: `SYNTHETIC ${index}` }, corrected = { ...parsed, vessel: `SUBMITTED ${index}` };
  const snapshot = fields => ({ fields, standardText: `VESSEL: ${fields.vessel}\nPORT: SINGAPORE\nVLSFO: 500 MT`, warnings: [], rmk: false, viscosity: [] });
  const result = { requestId: '60000000-0000-4000-8000-000000000001', sourceRevision: '70000000-0000-4000-8000-000000000001', sourceHash: 'a'.repeat(64), parserVersion: 'eco-fcuno-2026-10-15-v2', model: 'synthetic-ui-model', suggestions: [{ field: 'vessel', value: 'UNAPPLIED AI VESSEL', evidence: 'SYNTHETIC ALPHA' }], warnings: ['VERIFY VESSEL AGAINST THE SOURCE.'] };
  return { id, requestId: id, createdAt: now, createdBy: user.id, dataMode: 'test', generation, rawText: raw, parsed, corrected, notes: 'SYNTHETIC REPORT NOTE', sourceRevision: '70000000-0000-4000-8000-000000000002', sourceHash: 'a'.repeat(64), parserVersion: result.parserVersion, buildFingerprint: kind === 'legacy' ? null : 'b'.repeat(64), ...(kind === 'legacy' ? {} : { capture: { original: snapshot(parsed), submitted: snapshot(corrected), originalRevision: '70000000-0000-4000-8000-000000000001', parseOrigin: index === 3 ? 'reparsed' : 'initial' } }), originalAi: kind === 'legacy' ? null : { requestId: result.requestId, state: kind, input: { requestId: result.requestId, rawText: raw, sourceRevision: result.sourceRevision, parserVersion: result.parserVersion, current: parsed, dataMode: 'test', generation }, result: kind === 'complete' ? result : null, errorCode: kind === 'failed' ? 'PROVIDER_TIMEOUT' : null }, workflow: { revision: 1, stage: 'pending_user', expected: null, notes: '', aiReview: null, replay: null }, history: [] };
}
async function mocks(context, options = {}) {
  const state = { user: options.user ?? user, preview: options.preview ?? null, signedIn: options.signedIn ?? true, generation, reports: [makeReport(1), makeReport(2, 'failed'), makeReport(3, 'pending'), makeReport(4, 'legacy')], queries: [], mutations: [], aiRequests: [], conflict: false, aiFailure: false, pending: null, delayDetail: false };
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/api/parser/')) return nonParserRoute(route, state);
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    if (body) { assert.equal(request.headers()['x-eco-request'], '1'); assert.equal(body.dataMode, 'test'); assert.equal(body.generation, state.generation); }
    if (url.pathname === '/api/parser/reports') {
      state.queries.push(Object.fromEntries(url.searchParams));
      assert.equal(url.searchParams.get('dataMode'), 'test'); assert.equal(url.searchParams.get('generation'), generation);
      if (url.searchParams.has('id')) {
        const report = state.reports.find(item => item.id === url.searchParams.get('id')); assert.ok(report);
        if (state.delayDetail) { state.pending = () => route.fulfill({ json: report }); return; }
        return route.fulfill({ json: report });
      }
      const stage = url.searchParams.get('stage'), cursor = url.searchParams.get('cursor'); assert.equal(url.searchParams.get('summary'), 'true');
      assert.ok(['pending_user', 'pending_ai', 'reviewed', 'all'].includes(stage));
      const list = state.reports.filter(item => stage === 'all' || item.workflow.stage === stage), offset = cursor ? 2 : 0;
      return route.fulfill({ json: { items: list.slice(offset, offset + 2).map(({ id, createdAt, createdBy, dataMode, parsed, corrected, workflow }) => ({ id, createdAt, createdBy, dataMode, parsed, corrected, workflow: { revision: workflow.revision, stage: workflow.stage } })), nextCursor: list.length > offset + 2 ? 'synthetic-next-cursor' : null } });
    }
    const report = state.reports.find(item => item.id === body.reportId); assert.ok(report);
    if (url.pathname === '/api/parser/review') {
      state.mutations.push(body);
      if (state.conflict) { state.conflict = false; report.workflow.revision++; return route.fulfill({ status: 409, json: { message: 'REPORT CHANGED. RELOAD BEFORE SAVING.' } }); }
      assert.equal(body.expectedRevision, report.workflow.revision);
      const previous = structuredClone(report.workflow);
      if (body.action === 'approve') { assert.equal(previous.stage, 'pending_user'); report.workflow = { ...previous, stage: 'pending_ai', expected: body.expected, notes: body.notes, revision: previous.revision + 1 }; }
      else if (body.action === 'complete') { assert.equal(previous.stage, 'pending_ai'); assert.equal(body.aiRequestId, previous.aiReview.requestId); report.workflow = { ...previous, stage: 'reviewed', revision: previous.revision + 1 }; }
      else if (body.action === 'reopen') { report.workflow = { ...previous, stage: 'pending_user', revision: previous.revision + 1, aiReview: null, replay: null }; }
      else if (body.action === 'replay') { report.workflow = { ...previous, revision: previous.revision + 1, replay: { status: 'different', actual: report.capture.original, differences: ['vessel'], directorySensitiveDifferences: [], provenance: { reportId: report.id, reportRevision: previous.revision, sourceRevision: report.sourceRevision, sourceHash: report.sourceHash, parserVersion: report.parserVersion, buildFingerprint: report.buildFingerprint }, executedWith: { parserVersion: report.parserVersion, buildFingerprint: 'c'.repeat(64) } } }; }
      else assert.fail(`Unexpected action: ${body.action}`);
      report.history.push({ id: body.requestId, revision: report.workflow.revision, action: body.action, actor: user.id, createdAt: now, data: {} });
      return route.fulfill({ json: report });
    }
    if (url.pathname === '/api/parser/review-ai') {
      state.aiRequests.push(body); assert.equal(body.expectedRevision, report.workflow.revision); assert.equal(report.workflow.stage, 'pending_ai');
      if (state.aiFailure) { state.aiFailure = false; return route.fulfill({ status: 503, json: { message: 'AI REVIEW UNAVAILABLE.', operationState: 'failed' } }); }
      const analysis = { requestId: body.requestId, reportId: report.id, revision: body.expectedRevision, model: 'synthetic-review-model', diagnosis: 'VESSEL PREFIX WAS RETAINED IN THE ORIGINAL PARSE.', proposedFix: 'NORMALIZE ONLY THE SOURCE VESSEL PREFIX AND KEEP THE ORIGINAL MESSAGE.', regressionExamples: [{ rawText: 'VESSEL: SYNTHETIC ALPHA', reason: 'VERIFY PREFIX NORMALIZATION.' }], warnings: ['CODE CHANGES REQUIRE REGRESSION CHECKS.'] };
      report.workflow.aiReview = analysis; return route.fulfill({ json: analysis });
    }
    assert.fail(`Unexpected parser route: ${url.pathname}`);
  });
  return state;
}

for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await kind.launch({ headless: true });
  try {
    for (const width of [1440, 1920, 320, 390]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, isMobile: width < 600, hasTouch: width < 600, reducedMotion: 'reduce', colorScheme: theme, acceptDownloads: true });
      await installStagingCookies(context, base);
      const state = await mocks(context), page = await context.newPage(), errors = [];
      page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      const shot = name => page.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), animations: 'disabled', fullPage: true });
      const noOverflow = async () => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow'); assert.ok(await page.locator('.workspace-window').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'No horizontal workspace overflow'); };
      try {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        const testButton = page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true }); await expect(testButton).toBeEnabled(); await testButton.click(); await expect(testButton).toHaveAttribute('aria-pressed', 'true');
        const region = await openReports(page); await expect(region.getByRole('button', { name: /SUBMITTED 1/ })).toBeVisible(); await region.scrollIntoViewIfNeeded(); await shot('queue');
        await region.getByRole('button', { name: /SUBMITTED 1/ }).click(); const detail = page.getByRole('complementary', { name: 'Parser report details', exact: true }); await expect(detail).toBeVisible();
        await expect(detail.locator('.parser-report-diff').first()).toContainText('SYNTHETIC 1'); await expect(detail.locator('.parser-report-diff').first()).toContainText('SUBMITTED 1'); await expect(detail.getByRole('region', { name: 'Original AI result' })).toContainText('UNAPPLIED AI VESSEL');
        await detail.locator('.parser-report-diff').first().scrollIntoViewIfNeeded(); await shot('original-submitted'); await detail.getByRole('region', { name: 'Original AI result' }).scrollIntoViewIfNeeded(); await shot('original-ai');
        const vessel = detail.getByRole('textbox', { name: 'Reviewed VESSEL', exact: true }); await vessel.fill('REVIEWED ALPHA'); await detail.getByRole('textbox', { name: 'Review note', exact: true }).fill('SOURCE VESSEL REVIEWED.');
        await region.getByRole('combobox', { name: 'Review queue' }).selectOption('reviewed'); await expect(region.getByText('UNSAVED CHANGES', { exact: true })).toBeVisible(); await region.getByRole('button', { name: 'KEEP EDITING', exact: true }).click(); await expect(vessel).toHaveValue('REVIEWED ALPHA'); await expect(region.getByRole('combobox', { name: 'Review queue' })).toHaveValue('pending_user');
        state.conflict = true; await detail.getByRole('button', { name: 'SEND TO AI REVIEW', exact: true }).click(); await expect(region.getByRole('alert')).toContainText('REPORT CHANGED'); await expect(vessel).toHaveValue('REVIEWED ALPHA');
        await region.getByRole('button', { name: 'RELOAD LATEST', exact: true }).click(); await expect(region.getByText('UNSAVED CHANGES', { exact: true })).toBeVisible(); await region.getByRole('button', { name: 'DISCARD CHANGES', exact: true }).click(); await expect(vessel).toHaveValue('SUBMITTED 1');
        await vessel.fill('REVIEWED ALPHA'); await detail.getByRole('textbox', { name: 'Reviewed cautions', exact: true }).fill('WARNING: REVIEWED TEST CAUTION'); await detail.getByRole('textbox', { name: 'Review note', exact: true }).fill('SOURCE VESSEL REVIEWED.'); if (width < 600) for (const checkbox of await detail.locator('.access-checkbox').all()) assert.ok((await checkbox.boundingBox()).height >= 44, 'Phone checkbox label has a 44px target'); await detail.getByRole('region', { name: 'Reviewed correction' }).scrollIntoViewIfNeeded(); await shot('human-review'); await noOverflow();
        const immutable = JSON.stringify({ rawText: state.reports[0].rawText, parsed: state.reports[0].parsed, corrected: state.reports[0].corrected, capture: state.reports[0].capture, originalAi: state.reports[0].originalAi });
        await detail.getByRole('button', { name: 'SEND TO AI REVIEW', exact: true }).click(); await expect(vessel).toBeDisabled(); assert.match(state.reports[0].workflow.expected.standardText, /REVIEWED ALPHA/); await expect(detail.getByRole('button', { name: 'COMPLETE AI REVIEW', exact: true })).toBeDisabled();
        state.aiFailure = true; await detail.getByRole('button', { name: 'RUN AI REVIEW', exact: true }).click(); await expect(region.getByRole('alert')).toContainText('AI REVIEW UNAVAILABLE'); await expect(detail.getByRole('button', { name: 'COMPLETE AI REVIEW', exact: true })).toBeDisabled();
        await detail.getByRole('button', { name: 'RUN AI REVIEW', exact: true }).click(); await expect(detail.getByRole('region', { name: 'AI review result' })).toContainText('VESSEL PREFIX'); assert.notEqual(state.aiRequests[0].requestId, state.aiRequests[1].requestId, 'Definitive provider failure allows a fresh attempt'); await detail.getByRole('region', { name: 'AI review result' }).scrollIntoViewIfNeeded(); await shot('ai-review');
        await detail.getByRole('button', { name: 'COMPLETE AI REVIEW', exact: true }).click(); await expect(detail.getByRole('button', { name: 'EXPORT REVIEWED CASE', exact: true })).toBeEnabled(); await expect(detail.getByText('AI REVIEW DOES NOT UPDATE THE PARSER OR TRAIN THE MODEL.', { exact: true })).toBeVisible();
        await detail.getByRole('button', { name: 'REPLAY CURRENT PARSER', exact: true }).click(); await expect(detail.getByRole('region', { name: 'Current parser replay' })).toContainText('DIFFERS FROM REVIEWED CORRECTION'); await detail.getByRole('region', { name: 'Current parser replay' }).scrollIntoViewIfNeeded(); await shot('replay');
        const downloadPromise = page.waitForEvent('download'); await detail.getByRole('button', { name: 'EXPORT REVIEWED CASE', exact: true }).click(); const download = await downloadPromise; assert.match(download.suggestedFilename(), /^eco-parser-case-/); const stream = await download.createReadStream(); const buffers = []; for await (const chunk of stream) buffers.push(chunk); const exported = JSON.parse(Buffer.concat(buffers).toString()); assert.equal(exported.dataMode, 'test'); assert.equal(exported.report.workflow.expected.fields.vessel, 'REVIEWED ALPHA'); assert.equal(exported.report.workflow.aiReview.requestId, state.aiRequests[1].requestId); assert.deepEqual(exported.report.workflow.expected.warnings, ['WARNING: REVIEWED TEST CAUTION']);
        await detail.getByRole('button', { name: 'REOPEN REVIEW', exact: true }).click(); await expect(vessel).toBeEnabled(); await expect(vessel).toHaveValue('REVIEWED ALPHA'); await expect(detail.getByRole('region', { name: 'AI review result' })).toHaveCount(0); await expect(detail.getByRole('region', { name: 'Current parser replay' })).toHaveCount(0); assert.equal(state.reports[0].workflow.stage, 'pending_user');
        assert.equal(JSON.stringify({ rawText: state.reports[0].rawText, parsed: state.reports[0].parsed, corrected: state.reports[0].corrected, capture: state.reports[0].capture, originalAi: state.reports[0].originalAi }), immutable, 'Review never replaces original/submitted evidence');
        await detail.getByRole('button', { name: 'CLOSE', exact: true }).click(); await region.getByRole('combobox', { name: 'Review queue' }).selectOption('all'); await region.getByRole('button', { name: /SUBMITTED 2/ }).click(); await expect(detail.getByRole('region', { name: 'Original AI result' })).toContainText('PROVIDER TIMEOUT'); await detail.getByRole('region', { name: 'Original AI result' }).scrollIntoViewIfNeeded(); await shot('failed-original-ai');
        await detail.getByRole('button', { name: 'CLOSE', exact: true }).click(); await region.getByRole('button', { name: 'NEXT', exact: true }).click(); assert.ok(state.queries.some(query => query.cursor === 'synthetic-next-cursor')); await region.getByRole('button', { name: /SUBMITTED 3/ }).click(); await expect(detail.getByRole('region', { name: 'Original AI result' })).toContainText('AI REQUEST IS PENDING.'); await expect(detail).toContainText('CURRENT REPARSE CAPTURED. THE HISTORICAL INITIAL PARSE WAS NOT AVAILABLE.'); await detail.getByRole('button', { name: 'CLOSE', exact: true }).click(); await region.getByRole('button', { name: /SUBMITTED 4/ }).click(); await expect(detail).toContainText('LEGACY REPORT: STANDARD FORMAT AND CAUTION SNAPSHOTS WERE NOT CAPTURED.'); await expect(detail.getByRole('region', { name: 'Original AI result' })).toContainText('LEGACY REPORTS MAY OMIT UNAPPLIED AI RESULTS'); await detail.locator('.parser-source').first().scrollIntoViewIfNeeded(); await shot('legacy'); await noOverflow();
        await detail.getByRole('button', { name: 'CLOSE', exact: true }).click(); state.delayDetail = true; await region.getByRole('button', { name: /SUBMITTED 4/ }).click(); await expect.poll(() => Boolean(state.pending)).toBe(true); state.user = { ...user, capabilities: undefined, id: '10000000-0000-4000-8000-000000000002', email: 'trader@example.test', isAdmin: false }; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(region).toHaveCount(0); await state.pending().catch(() => {}); state.pending = null; await expect(page.getByRole('complementary', { name: 'Parser report details', exact: true })).toHaveCount(0);
        assert.deepEqual(errors, []); results.push({ engine, width, theme, passed: true, checks: ['original parse/AI/submitted evidence', 'human correction', 'unsaved navigation guard', 'revision conflict', 'successful AI prerequisite', 'replay mismatch', 'private export', 'reopen preserves expected/history', 'editable cautions', 'reparse provenance', 'failed/pending/legacy AI', 'pagination', 'account-switch stale response'] }); console.log(`PASS ${engine} ${width} ${theme}`);
      } catch (error) { await shot('failure').catch(() => {}); throw error; } finally { await context.close(); }
    }
    if (!process.env.ECO_TEST_WIDTH) for (const role of ['trader', 'preview', 'signed-out']) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme }); await installStagingCookies(context, base);
      const state = await mocks(context, role === 'trader' ? { user: { ...user, capabilities: undefined, isAdmin: false } } : role === 'preview' ? { preview: { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true } } : { signedIn: false });
      const page = await context.newPage(); await page.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      try { await page.goto(base); if (role === 'signed-out') await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); else { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.getByRole('button', { name: 'Administration', exact: true })).toHaveCount(0); } await expect(page.getByRole('region', { name: 'Parser reports', exact: true })).toHaveCount(0); assert.deepEqual(state.queries, []); assert.deepEqual(state.mutations, []); await page.screenshot({ path: resolve(out, `${engine}-390-${theme}-${role}.png`), fullPage: true }); results.push({ engine, width: 390, theme, role, passed: true }); } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ results }, null, 2));

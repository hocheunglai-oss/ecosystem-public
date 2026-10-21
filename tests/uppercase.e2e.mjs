import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Each run owns a headless browser and fresh contexts; never attach to a personal profile.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4176';
const OUT = new URL('../artifacts/uppercase/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const ci = value => new RegExp(`^${RegExp.escape(value)}$`, 'i');
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const dialog = (page, name) => page.getByRole('dialog', { name: ci(name), exact: true });
const supplier = (stem, grade) => stem.getByRole('combobox', { name: ci(`${grade} supplier`), exact: true });

async function open(page, group, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const toggle = nav.getByRole('button', { name: ci(group), exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await nav.getByRole('button', { name: ci(name), exact: true }).click();
  const workspace = dialog(page, name);
  await expect(workspace).toBeVisible();
  return workspace;
}
async function close(page) { await page.getByRole('button', { name: ci('Close workspace'), exact: true }).click(); }
async function noOverflow(page, scope) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits viewport');
  assert.ok(await scope.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Dialog fits viewport');
}
async function isUppercase(locator) {
  assert.equal(await locator.evaluate(el => getComputedStyle(el).textTransform), 'uppercase');
}

async function browserInputCases(page, input) {
  await input.fill('alpha omega');
  await expect(input).toHaveValue('ALPHA OMEGA');
  await input.evaluate(el => el.setSelectionRange(6, 6));
  await page.keyboard.insertText('ß');
  await expect(input).toHaveValue('ALPHA SSOMEGA');
  assert.equal(await input.evaluate(el => el.selectionStart), 8, 'Expanding Unicode keeps caret after inserted character');
  await page.keyboard.insertText('x');
  await expect(input).toHaveValue('ALPHA SSXOMEGA');
  await input.evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '中文 berth');
    el.dispatchEvent(new InputEvent('input', { data: '中文 berth', inputType: 'insertCompositionText', bubbles: true, isComposing: true }));
  });
  await expect(input).toHaveValue('中文 berth');
  await input.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文 berth', bubbles: true })));
  await expect(input).toHaveValue('中文 BERTH');
  // Force an unrelated controlled form state update so a DOM-only mutation cannot pass.
  await input.press('Tab');
  await expect(input).toHaveValue('中文 BERTH');
  await input.fill('contact Desk.Case@Example.com at https://Example.com/PortData?Key=AbC');
  await expect(input).toHaveValue('CONTACT Desk.Case@Example.com AT https://Example.com/PortData?Key=AbC');
}

async function credentialCases(page) {
  await page.evaluate(() => {
    const section = document.createElement('section');
    section.id = 'uppercase-test-credentials';
    section.style.cssText = 'position:fixed;top:0;left:0;z-index:999999;background:white;padding:6px';
    const fields = [
      ['password', 'password', ''], ['current', 'text', 'current-password'],
      ['new', 'text', 'new-password'], ['email', 'email', 'email'],
      ['email-mode', 'text', ''], ['link', 'url', ''], ['preserved', 'text', ''],
    ];
    for (const [name, type, autocomplete] of fields) {
      const input = document.createElement('input');
      input.type = type; input.setAttribute('aria-label', `Synthetic ${name}`);
      if (autocomplete) input.autocomplete = autocomplete;
      if (name === 'email-mode') input.inputMode = 'email';
      if (name === 'preserved') input.dataset.preserveCase = '';
      section.append(input);
    }
    Array.from(document.querySelectorAll('dialog, [role="dialog"]')).at(-1).append(section);
  });
  for (const name of ['password', 'current', 'new', 'email', 'email-mode', 'link', 'preserved']) {
    const input = page.getByLabel(ci(`Synthetic ${name}`), { exact: true });
    const value = name.includes('email') ? 'Desk.Case@Example.com' : name === 'link' ? 'https://Example.com/PortData?Key=AbC' : 'MiXeD-Test-Only';
    await input.fill(value);
    await expect(input).toHaveValue(value);
    assert.equal(await input.evaluate(el => getComputedStyle(el).textTransform), name === 'link' ? 'uppercase' : 'none', `${name} has the expected presentation`);
  }
  await page.locator('#uppercase-test-credentials').evaluate(el => el.remove());
}

try {
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [850, 'dark']]) {
    if (process.env.ECO_TEST_WIDTH && width !== Number(process.env.ECO_TEST_WIDTH)) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', isMobile: width < 1000, hasTouch: width < 1000 });
    await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), theme);
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await isUppercase(page.getByRole('button', { name: ci('ENTER ECOSYSTEM'), exact: true }));
      await page.getByLabel(ci('Demo profile'), { exact: true }).selectOption('otto');
      await page.getByRole('button', { name: ci('ENTER ECOSYSTEM'), exact: true }).click();
      await page.getByRole('button', { name: ci('Personal details'), exact: true }).click();
      const profile = width < 1000 ? page.getByRole('region', { name: ci('Personal details'), exact: true }) : dialog(page, 'Personal details');
      const email = profile.getByLabel(ci('Email'), { exact: true });
      await email.fill('Otto.Mixed@Example.com');
      await expect(email).toHaveValue('Otto.Mixed@Example.com');
      assert.equal(await email.evaluate(el => getComputedStyle(el).textTransform), 'none');
      await profile.getByRole('button', { name: ci('Save'), exact: true }).click();
      await expect(profile).not.toBeVisible();
      assert.equal((await readState(page)).profiles.otto.email, 'otto.mixed@example.com', 'Existing email save normalization is retained');

      let center = await open(page, 'Trading', 'Enquiries');
      await isUppercase(center.getByRole('tab', { name: ci('Enquiry'), exact: true }));
      await isUppercase(center.getByLabel(ci('Vessel'), { exact: true }));
      await center.getByRole('button', { name: ci('New enquiry'), exact: true }).click();
      const vessel = `uppercase vessel ${width} ${theme}`;
      const raw = `Buyer: Meridian Shipping Pte Ltd\nVessel: ${vessel}\nIMO: 9876543\nPort: Singapore\nETA: 2-4 October\nHSFO: 350-400 MT\nVLSFO: 500-600 MT\nLSMGO: 60 MT`;
      await center.getByLabel(ci('Raw enquiry'), { exact: true }).fill(raw);
      await expect(center.getByLabel(ci('Raw enquiry'), { exact: true })).toHaveValue(raw.toUpperCase());
      await expect(center.getByLabel(ci('Vessel'), { exact: true })).toHaveValue(vessel.toUpperCase());
      await center.getByRole('textbox', { name: ci('Remarks'), exact: true }).fill('lowercase shipping remarks');
      await center.getByRole('tab', { name: ci('Intelligence'), exact: true }).click();
      await center.getByRole('tab', { name: ci('Enquiry'), exact: true }).click();
      await expect(center.getByRole('textbox', { name: ci('Remarks'), exact: true })).toHaveValue('LOWERCASE SHIPPING REMARKS');
      await noOverflow(page, center);
      await page.screenshot({ path: new URL(`enquiry-${width}-${theme}.png`, OUT).pathname });
      await center.getByRole('button', { name: ci('Confirm'), exact: true }).click();
      await expect.poll(async () => (await readState(page)).enquiries.find(item => item.vessel === vessel.toUpperCase())?.status).toBe('sent');
      const enquiry = (await readState(page)).enquiries.find(item => item.vessel === vessel.toUpperCase());
      assert.equal(enquiry.remarks, 'LOWERCASE SHIPPING REMARKS', 'Controlled uppercase value is persisted');
      await center.locator(`[data-enquiry-id="${enquiry.id}"]`).getByRole('button', { name: /^stem$/i }).click();
      const stem = dialog(page, 'STEM');
      await supplier(stem, 'HSFO').fill('meridian');
      await expect(supplier(stem, 'HSFO')).toHaveValue('MERIDIAN');
      await stem.getByRole('option', { name: ci('MERIDIAN BUNKER SUPPLY · DEMO'), exact: true }).click();
      for (const grade of ['HSFO', 'VLSFO', 'LSMGO']) await expect(supplier(stem, grade)).toHaveValue('MERIDIAN BUNKER SUPPLY · DEMO');
      await supplier(stem, 'VLSFO').fill('harbourline');
      await stem.getByRole('option', { name: ci('HARBOURLINE MARINE FUELS · DEMO'), exact: true }).click();
      await supplier(stem, 'HSFO').fill('pacific');
      await stem.getByRole('option', { name: ci('PACIFIC CURRENT ENERGY · DEMO'), exact: true }).click();
      await expect(supplier(stem, 'VLSFO')).toHaveValue('HARBOURLINE MARINE FUELS · DEMO');
      await expect(supplier(stem, 'LSMGO')).toHaveValue('PACIFIC CURRENT ENERGY · DEMO');
      for (const [grade, price] of [['HSFO', '420'], ['VLSFO', '530'], ['LSMGO', '670']]) await stem.getByLabel(ci(`${grade} buy price (USD / MT)`), { exact: true }).fill(price);
      const note = stem.getByRole('textbox', { name: ci('Private note'), exact: true });
      if (width === 1440 && theme === 'light') {
        await browserInputCases(page, note);
        await credentialCases(page);
      }
      await note.fill('中文 berth — final private note');
      for (const name of ['Compliance', 'Credit']) await stem.getByRole('checkbox', { name: ci(name), exact: true }).check();
      await expect(note).toHaveValue('中文 BERTH — FINAL PRIVATE NOTE');
      await noOverflow(page, stem);
      await page.screenshot({ path: new URL(`stem-${width}-${theme}.png`, OUT).pathname });
      await stem.getByRole('button', { name: ci('Save'), exact: true }).click();
      await expect(stem).not.toBeVisible();
      let saved = await readState(page);
      const outcome = saved.outcomes.find(item => item.enquiryId === enquiry.id);
      assert.deepEqual(outcome.stemProducts.map(item => item.supplierId), ['supplier-pacific', 'supplier-harbourline', 'supplier-pacific']);
      assert.equal(saved.privateNotes[outcome.id].text, '中文 BERTH — FINAL PRIVATE NOTE');
      await close(page); await page.reload({ waitUntil: 'domcontentloaded' });
      const fixtures = await open(page, 'Trading', 'Fixtures');
      await fixtures.getByRole('textbox', { name: ci('Search records'), exact: true }).fill(vessel);
      await expect(fixtures.getByRole('textbox', { name: ci('Search records'), exact: true })).toHaveValue(vessel.toUpperCase());
      const rows = fixtures.locator(`tbody[data-record-id="${outcome.id}"] tr`);
      await expect(rows).toHaveCount(3);
      await isUppercase(rows.first().locator('td').first());
      await noOverflow(page, fixtures);
      await page.screenshot({ path: new URL(`fixtures-${width}-${theme}.png`, OUT).pathname });
      await close(page);

      const workspace = await open(page, 'Ports & Suppliers', 'Countries & Ports');
      await workspace.getByLabel(ci('Country or port'), { exact: true }).fill('hong kong');
      await workspace.getByRole('button', { name: ci('Hong Kong'), exact: true }).click();
      await workspace.getByRole('button', { name: ci('Add Section'), exact: true }).click();
      const editor = dialog(page, 'Update information');
      await editor.getByLabel(ci('Section title'), { exact: true }).fill('uppercase checklist');
      await editor.getByRole('button', { name: ci('Add Table'), exact: true }).click();
      await editor.getByLabel(ci('Block 1 title'), { exact: true }).fill('delivery contacts');
      await editor.getByLabel(ci('Row 1, Name'), { exact: true }).evaluate(el => {
        const data = new DataTransfer();
        data.setData('text/plain', 'agent\tDesk.Case@Example.com\ndelivery\tconfirmed');
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await expect(editor.getByLabel(ci('Row 1, Name'), { exact: true })).toHaveValue('AGENT');
      await expect(editor.getByLabel(ci('Row 2, Name'), { exact: true })).toHaveValue('DELIVERY');
      const emailCell = editor.getByLabel(ci('Row 1, Details'), { exact: true });
      await expect(emailCell).toHaveValue('Desk.Case@Example.com');
      assert.equal(await emailCell.evaluate(el => getComputedStyle(el).textTransform), 'none', 'Email-only table cell keeps its original visible case');
      await emailCell.fill('new receiving instructions');
      await expect(emailCell).toHaveValue('NEW RECEIVING INSTRUCTIONS');
      await isUppercase(emailCell);
      await emailCell.fill('Desk.Case@Example.com');
      await expect(emailCell).toHaveValue('Desk.Case@Example.com');
      assert.equal(await emailCell.evaluate(el => getComputedStyle(el).textTransform), 'none');
      await editor.getByRole('textbox', { name: ci('Reason'), exact: true }).fill('updated desk checklist');
      await noOverflow(page, editor);
      await page.screenshot({ path: new URL(`knowledge-${width}-${theme}.png`, OUT).pathname });
      await editor.getByRole('button', { name: ci('Update'), exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(workspace.getByRole('heading', { name: ci('UPPERCASE CHECKLIST'), exact: true })).toBeVisible();
      const savedEmail = workspace.getByRole('cell', { name: 'Desk.Case@Example.com', exact: true });
      await expect(savedEmail).toBeVisible();
      assert.equal(await savedEmail.evaluate(el => getComputedStyle(el).textTransform), 'none', 'Published table preserves email presentation');
      saved = await readState(page);
      const snapshot = JSON.stringify(saved.knowledgeRecords);
      assert.ok(snapshot.includes('UPPERCASE CHECKLIST') && snapshot.includes('DELIVERY CONTACTS') && snapshot.includes('CONFIRMED'));
      assert.ok(snapshot.includes('Desk.Case@Example.com'), 'Pasted email case survives to storage');
      if (width === 1440 && theme === 'light') {
        const api = 'https://spc.fcuno.com/api/ecosystem/knowledge-extract';
        const original = 'Hong Kong: receiving window must be confirmed with local agent. Contact Desk.Case@Example.com';
        const submitted = 'HONG KONG: RECEIVING WINDOW MUST BE CONFIRMED WITH LOCAL AGENT. CONTACT Desk.Case@Example.com';
        let calls = 0;
        await page.route(api, async route => {
          calls++;
          const body = route.request().postDataJSON();
          assert.equal(body.text, submitted);
          assert.equal(body.source, 'AGENT CIRCULAR');
          const location = body.locations.find(item => item.name === 'Hong Kong' && item.kind === 'port');
          assert.ok(location);
          await route.fulfill({ status: 200, json: { warnings: [], proposals: [{
            locationKey: location.key, locationName: location.name, section: 'Operations', title: 'Receiving confirmation',
            kind: 'text', text: body.text, columns: [], rows: [], field: null, value: null, evidence: body.text, warning: null,
          }] } });
        });
        const before = await readState(page);
        await workspace.getByRole('button', { name: ci('Paste information'), exact: true }).click();
        const extractor = dialog(page, 'Paste information');
        await extractor.getByRole('textbox', { name: ci('Information'), exact: true }).fill(original);
        await extractor.getByLabel(ci('Source (optional)'), { exact: true }).fill('agent circular');
        await extractor.getByRole('button', { name: ci('Extract'), exact: true }).click();
        await expect(extractor.getByRole('heading', { name: ci('Check changes'), exact: true })).toBeVisible();
        const proposal = extractor.getByRole('article', { name: ci('Change 1'), exact: true });
        await proposal.locator('.extract-evidence summary').click();
        await expect(proposal.locator('blockquote')).toHaveText(submitted);
        await proposal.getByLabel(ci('Information for change 1'), { exact: true }).fill('confirm the final berth with the agent');
        await expect(proposal.getByLabel(ci('Information for change 1'), { exact: true })).toHaveValue('CONFIRM THE FINAL BERTH WITH THE AGENT');
        await page.screenshot({ path: new URL('extraction-1440-light.png', OUT).pathname });
        await extractor.getByRole('button', { name: ci('Close dialog'), exact: true }).click();
        assert.equal(calls, 1);
        const after = await readState(page);
        assert.deepEqual(after.knowledgeRecords, before.knowledgeRecords, 'Extraction draft does not publish');
        assert.deepEqual(after.contributions, before.contributions, 'Extraction draft does not reward');
        assert.deepEqual(writes, [api], 'Only the mocked extraction endpoint is called');
      } else assert.deepEqual(writes, [], 'Test cannot write remotely');
      assert.deepEqual(errors, [], 'No browser errors');
      results.push({ width, theme, passed: true });
      console.log(`PASS ${width}px ${theme}: uppercase display, saved input, parser, per-grade fixtures, spreadsheet paste, email exception`);
    } catch (error) {
      results.push({ width, theme, passed: false, error: error.stack });
      console.error(`FAIL ${width}px ${theme}: ${error.message}`);
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname, fullPage: true }).catch(() => {});
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
}
assert.ok(results.length > 0 && results.every(result => result.passed), 'All uppercase browser scenarios pass');

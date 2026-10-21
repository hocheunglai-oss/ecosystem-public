import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Dedicated headless contexts only; never use the user's browser profile.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const OUT = new URL('../artifacts/profile-manager/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const inbox = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
async function login(page, id = 'otto') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
}
async function profile(page) {
  await page.getByRole('button', { name: 'Personal details', exact: true }).click();
  return page.getByRole('region', { name: 'Personal details', exact: true });
}
async function switchRole(page, id) {
  await (await profile(page)).getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, id);
}
async function close(page) {
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
}
async function open(page, group, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const toggle = nav.getByRole('button', { name: group, exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await nav.getByRole('button', { name, exact: true }).click();
  return dialog(page, name);
}
async function arrival(page, channel) {
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('region', { name: 'Enquiries', exact: true }).getByRole('button', { name: `${channel} (demo)`, exact: true }).click();
  await page.getByRole('button', { name: 'Normal enquiry', exact: true }).click();
}
async function scenario(name, run, width = 1440) {
  if (process.env.ECO_TEST_FILTER && !name.includes(process.env.ECO_TEST_FILTER)) return;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await run(page);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ animations: 'disabled', path: new URL(`failure-${results.length}.png`, OUT).pathname }).catch(() => {});
  } finally { await context.close(); }
}

await scenario('Six profiles, personal details and sign-out location', async page => {
  await expect(page.getByLabel('Demo profile').locator('option')).toHaveText(['SAMPLE TRADER', 'SAMPLE MANAGER A', 'SAMPLE MANAGER B', 'SAMPLE TRADER B', 'SAMPLE CREDIT REVIEWER', 'SAMPLE ADMINISTRATOR']);
  for (const [id, name, role] of [['otto', 'SAMPLE TRADER', 'Trader'], ['gianmichele', 'SAMPLE MANAGER A', 'Manager'], ['silvia', 'SAMPLE MANAGER B', 'Manager'], ['filippo', 'SAMPLE TRADER B', 'Trader'], ['elena', 'SAMPLE CREDIT REVIEWER', 'Credit'], ['marco', 'SAMPLE ADMINISTRATOR', 'Admin']]) {
    await login(page, id);
    await expect(page.locator('.hud-identity')).toContainText(`${name}${role}`);
    await expect(page.locator('[data-resource]')).toHaveCount(2);
    await expect(page.locator('.fleet-berth, .resource-icon-oil')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Transport now', exact: true })).toHaveCount(0);
    await expect(page.locator('.demo-reset-control')).toHaveCount(role === 'Admin' ? 1 : 0);
    if (['Trader', 'Manager'].includes(role)) {
      await expect(page.locator('.hud-achievements-toggle')).toContainText('Achievements');
      const before = await state(page);
      await page.locator('.hud-achievements-toggle').click();
      const achievements = page.locator('#hud-achievements');
      await expect(achievements.getByRole('columnheader', { name: 'Contributions', exact: true })).toBeVisible();
      await expect(achievements.getByRole('columnheader', { name: 'Hats received', exact: true })).toBeVisible();
      await expect(achievements).not.toContainText(/transported|total volume|Oil earned|remaining Oil/i);
      await page.keyboard.press('Escape');
      assert.deepEqual(await state(page), before, 'Reading achievements does not change contributions, Hats or business data');
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(dialog(page, 'Settings').getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    if (role === 'Manager') await expect(dialog(page, 'Settings').getByRole('region', { name: 'Team performance' })).toBeVisible();
    await close(page);
    const panel = await profile(page);
    await expect(panel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Personal details', exact: true })).toBeFocused();
    await (await profile(page)).getByRole('button', { name: 'Sign out', exact: true }).click();
  }
});

await scenario('Profile edits persist, route future arrivals and preserve historical owners', async page => {
  await login(page);
  await arrival(page, 'Email');
  const first = (await inbox(page))[0];
  const panel = await profile(page);
  await panel.getByLabel('Phone number').fill('+852 1111 2222');
  await panel.getByLabel('Email').fill('OTTO.NEW@ECOSYSTEM.EXAMPLE');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel).not.toBeVisible();
  assert.deepEqual((await state(page)).profiles.otto, { phone: '+85211112222', email: 'otto.new@ecosystem.example' });
  await arrival(page, 'WhatsApp'); await arrival(page, 'Email');
  let records = await inbox(page);
  assert.equal(records.length, 3);
  assert.ok(records.some(item => item.sender === '+85211112222' && item.owner === 'otto'));
  assert.ok(records.some(item => item.sender === 'otto.new@ecosystem.example' && item.owner === 'otto'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  records = await inbox(page);
  assert.deepEqual(records.find(item => item.id === first.id), first);
  const saved = await profile(page);
  await expect(saved.getByLabel('Email')).toHaveValue('otto.new@ecosystem.example');
  await saved.getByLabel('Email').fill('vincent@ecosystem.example');
  await saved.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved).toBeVisible();
  assert.equal((await state(page)).profiles.otto.email, 'otto.new@ecosystem.example');
  await page.screenshot({ animations: 'disabled', path: new URL('personal-details.png', OUT).pathname });
  await saved.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'gianmichele');
  await expect((await profile(page)).getByLabel('Email')).toHaveValue('vincent@ecosystem.example');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.locator('.inbox-notification-row')).toHaveCount(0);
});

await scenario('Manager activity and Hats are scoped; trading volume does not count as contributions', async page => {
  await login(page, 'gianmichele');
  const original = await page.evaluate(async () => {
    const { contributionActivity } = await import('/src/lib/contributionActivity.ts');
    const { teamById } = await import('/src/lib/model.ts');
    const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
    return { manager: contributionActivity(state, 'gianmichele').total, own: contributionActivity(state, teamById('team-gianmichele').memberIds).total, italy: contributionActivity(state, teamById('team-italy').memberIds).total };
  });
  await page.evaluate(() => {
    const key = 'ecosystem.demo.v1', value = JSON.parse(localStorage.getItem(key)), now = new Date().toISOString();
    const base = value.outcomes.find(item => item.kind === 'fixture');
    value.outcomes.push({ ...base, id: 'team-manager', enquiryId: 'team-manager-enquiry', owner: 'gianmichele', quantity: 100 }, { ...base, id: 'team-luca', enquiryId: 'team-luca-enquiry', owner: 'luca', quantity: 200 }, { ...base, id: 'outside-team', enquiryId: 'outside-team-enquiry', owner: 'other-person', quantity: 99999 }, { ...base, id: 'pending-team', enquiryId: 'pending-team-enquiry', owner: 'gianmichele', quantity: 99999, commercialStatus: 'pending' });
    value.contributions.push({ ...value.contributions[0], id: 'manager-contribution', author: 'gianmichele', status: 'approved', reviewedAt: now }, { ...value.contributions[0], id: 'outside-contribution', author: 'other-person', status: 'approved', reviewedAt: now });
    value.privateNotes['team-luca'] = { owner: 'luca', text: 'LUCA PRIVATE NOTE', updatedAt: now };
    localStorage.setItem(key, JSON.stringify(value));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = dialog(page, 'Settings'), team = settings.getByRole('region', { name: 'Team performance' });
  await expect(team.locator('[data-team-member]')).toHaveCount(2);
  await expect(settings.locator('[data-office-summary="team-gianmichele"] [data-activity-total]')).toHaveText((original.own + 1).toLocaleString('en-US'));
  await expect(team.locator('[data-team-member="gianmichele"] td').first()).toHaveText((original.manager + 1).toLocaleString('en-US'));
  await expect(team.locator('[data-team-member="gianmichele"] td').last()).toHaveText('0');
  await expect(team).not.toContainText(/transported|total volume|Oil earned|remaining Oil/i);
  await settings.getByRole('tab', { name: 'Compare offices', exact: true }).click();
  await expect(settings.getByRole('table', { name: 'Office comparison' }).getByRole('row').filter({ hasText: 'Italy' })).toContainText(original.italy.toLocaleString('en-US'));
  await settings.getByRole('tab', { name: 'Hong Kong', exact: true }).click();
  await expect(team).not.toContainText('LUCA PRIVATE NOTE');
  await expect(team).not.toContainText(/Target volume|Profit|Drops/);
  for (const name of ['Lost reasons', 'Audit trail', 'Reset demo']) await expect(settings.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: new URL('team-performance.png', OUT).pathname });
});

await scenario('Manager can confirm and STEM own enquiry without Admin credit controls', async page => {
  await login(page, 'gianmichele');
  const center = await open(page, 'Trading', 'Enquiries');
  await center.getByLabel('Raw enquiry', { exact: true }).fill('Buyer: Aster Ocean Navigation Pte Ltd\nVessel: MANAGER STAR\nIMO: 9876543\nPort: Singapore\nETA: 2-4 October\nVLSFO: 500-600 MT');
  await expect(center.getByLabel('Vessel', { exact: true })).toHaveValue('MANAGER STAR');
  await center.getByRole('button', { name: 'Confirm', exact: true }).click();
  const saved = (await state(page)).enquiries.find(item => item.vessel === 'MANAGER STAR');
  assert.equal(saved.owner, 'gianmichele'); assert.equal(saved.status, 'sent');
  await center.locator(`[data-enquiry-id="${saved.id}"]`).getByRole('button', { name: 'Stem', exact: true }).click();
  const stem = dialog(page, 'STEM');
  await stem.getByRole('combobox', { name: 'VLSFO supplier', exact: true }).fill('Aster');
  await stem.getByRole('option', { name: /ASTER MARINE SUPPLY/ }).click();
  await stem.getByLabel('VLSFO buy price (USD / MT)', { exact: true }).fill('525');
  await stem.getByLabel('Private note', { exact: true }).fill('MANAGER PRIVATE NOTE');
  await stem.getByRole('checkbox', { name: 'Compliance', exact: true }).check();
  await stem.getByRole('checkbox', { name: 'Credit', exact: true }).check();
  await stem.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(stem).not.toBeVisible(); await close(page);
  const fixtures = await open(page, 'Trading', 'Fixtures');
  await expect(fixtures).toContainText('MANAGER STAR'); await expect(fixtures).toContainText('MANAGER PRIVATE NOTE');
  await close(page);
  const requests = await open(page, 'Buyers and Credit', 'Credit Requests');
  await expect(requests.getByRole('button', { name: 'Review request', exact: true })).toHaveCount(0);
  await close(page); await switchRole(page, 'marco');
  const adminFixtures = await open(page, 'Trading', 'Fixtures');
  await expect(adminFixtures).toContainText('MANAGER STAR'); await expect(adminFixtures).not.toContainText('MANAGER PRIVATE NOTE');
});

for (const width of [390, 1280]) await scenario(`Manager profile and office comparison fit ${width}px`, async page => {
  await login(page, 'gianmichele');
  const name = await page.locator('.hud-identity').boundingBox(), icon = await page.getByRole('button', { name: 'Personal details', exact: true }).boundingBox();
  assert.ok(icon.x >= name.x + name.width - 1);
  const panel = await profile(page); const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ animations: 'disabled', path: new URL(`profile-${width}.png`, OUT).pathname });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const team = dialog(page, 'Settings');
  await expect(team.getByRole('region', { name: 'Team performance', exact: true }).locator('[data-team-member]')).toHaveCount(2);
  await expect(team.locator('.tanker-achievements, .team-destination, .office-volume-track')).toHaveCount(0);
  await expect(team.getByRole('columnheader', { name: 'Contributions', exact: true })).toBeVisible();
  await expect(team.getByRole('columnheader', { name: 'Hats received', exact: true })).toBeVisible();
  await expect(team.getByRole('button', { name: /^Transport/ })).toHaveCount(0);
  const box = await team.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
  await page.screenshot({ animations: 'disabled', path: new URL(`team-${width}.png`, OUT).pathname });
  await team.getByRole('tab', { name: 'Compare offices', exact: true }).click();
  const comparison = team.getByRole('table', { name: 'Office comparison', exact: true });
  await expect(comparison.locator('tbody tr')).toHaveCount(2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ animations: 'disabled', path: new URL(`office-comparison-${width}.png`, OUT).pathname });
  await comparison.getByRole('button', { name: 'Italy office performance', exact: true }).click();
  await expect(team.locator('[data-team-member] th strong')).toHaveText(['SAMPLE MANAGER B', 'SAMPLE TRADER B']);
  await expect(team.getByRole('button', { name: 'Transport', exact: true })).toHaveCount(0);
}, width);

await browser.close();
await writeFile(new URL('results.json', OUT), JSON.stringify({ results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;

import { expect } from '@playwright/test';
export const testGeneration = '10000000-0000-4000-8000-000000000010';
/** Isolated browser fixture only. Never supplies a production session or credentials. */
export async function installTestWorkspacePolicy(context) {
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: true, generation: testGeneration } }));
}
export async function activateTestWorkspace(page) {
  const toggle = page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
  await expect(toggle).toBeEnabled();
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}
/** Exercise normal LIVE permissions using one explicitly created, isolated test record. */
export async function createLiveFixtureBuyer(page, name, capture) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = nav.getByRole('button', { name: 'Buyers and Credit', exact: true });
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await nav.getByRole('button', { name: 'Buyer Profiles', exact: true }).click();
  const workspace = page.getByRole('dialog', { name: 'Buyer Profiles', exact: true });
  await workspace.getByRole('button', { name: 'New lead', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New lead', exact: true });
  await form.getByLabel('Legal company name', { exact: true }).fill(name);
  const seller = form.getByLabel('Selling entity', { exact: true }); await expect(seller).toHaveValue(''); await expect(seller).toHaveAttribute('required', ''); await seller.fill('BROWSER FIXTURE SELLER');
  await form.getByLabel('Country', { exact: true }).fill('Singapore');
  await form.getByLabel('Reason', { exact: true }).fill('ISOLATED BROWSER VERIFICATION');
  if (capture) await capture();
  await form.getByRole('button', { name: 'Create lead & request credit', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(workspace.getByRole('button', { name, exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Close workspace', exact: true }).click();
}

import { expect } from '@playwright/test';

export async function openBackgroundSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Personal details', exact: true }).click();
  const choice = dialog.getByLabel('Background', { exact: true });
  await expect(choice).toBeVisible();
  return choice;
}
export async function chooseBackground(page, value) {
  const choice = await openBackgroundSettings(page);
  await choice.selectOption(value);
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await expect(choice).toBeHidden();
}

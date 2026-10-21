import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Attribution stays readable in place; eligible readers receive a keyboard-accessible Hats action. */
export async function assertKnowledgeAttribution(page, container, expectedActor) {
  const attribution = container.locator('.knowledge-entry-audit').first();
  await page.mouse.move(1, 1);
  await expect(attribution).toBeVisible();
  await expect(attribution.locator('.knowledge-attribution-name')).toContainText(expectedActor);
  await expect(attribution.locator('time')).toBeVisible();
  assert.ok(Number.isFinite(Date.parse(await attribution.locator('time').getAttribute('datetime'))));
  await expect(attribution.locator('.lucide-history')).toHaveCount(0);
  await expect(container.locator('.knowledge-entry-update')).toHaveCount(0);
  const action = attribution.getByRole('button');
  if (await action.count()) {
    await expect(action).toHaveAccessibleName(/^Hats Off to /i);
    await page.keyboard.press('Tab');
    await action.focus();
    await expect(action.locator('.knowledge-hat-action')).toBeVisible();
    await expect(action.locator('.knowledge-hat-action')).toContainText(expectedActor);
    await action.evaluate(element => element.blur());
    await page.mouse.move(1, 1);
  }
}

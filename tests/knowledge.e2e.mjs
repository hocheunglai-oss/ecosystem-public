import { assertKnowledgeAttribution } from './knowledge-attribution-assertions.mjs';
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const BASE = process.env.ECO_DEMO_URL || "http://127.0.0.1:4173";
const OUT = new URL("../artifacts/knowledge-direct/", import.meta.url);
const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ecosystem.demo.v1")));
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });

async function section(profile, name) {
  await profile.getByRole("tab", { name, exact: true }).click();
}
async function manager(page, profile) {
  await profile.getByRole("button", { name: "Manage Tabs", exact: true }).click();
  return page.getByRole("dialog", { name: "Manage Tabs", exact: true });
}
async function tabRow(dialog, title) {
  const rows = dialog.locator(".knowledge-manage-row");
  for(let index = 0; index < await rows.count(); index++)
    if((await rows.nth(index).getByRole("textbox").inputValue()).toLowerCase() === title.toLowerCase()) return rows.nth(index);
  throw new Error("Missing managed tab " + title);
}
async function historyFor(page, container, expectedActor) {
  await assertKnowledgeAttribution(page, container, new RegExp(({otto:"SAMPLE TRADER",elena:"SAMPLE CREDIT REVIEWER",marco:"SAMPLE ADMINISTRATOR",gianmichele:"SAMPLE MANAGER A"})[expectedActor], "i"));
}

try {
  const layouts = [[1440, "light", "otto"], [1440, "dark", "elena"], [390, "light", "otto"], [320, "dark", "marco"], [850, "light", "gianmichele"]]
    .filter(([width]) => !process.env.ECO_KNOWLEDGE_WIDTH || width === Number(process.env.ECO_KNOWLEDGE_WIDTH));
  for (const [width, theme, actor] of layouts) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    await context.addInitScript((mode) => localStorage.setItem("ecosystem.theme.v1", mode), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(BASE);
      await page.getByLabel("Demo profile", { exact: true }).selectOption(actor);
      await page.getByRole("button", { name: "ENTER ECOSYSTEM", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Workspace navigation" });
      await nav.getByRole("button", { name: "Ports & Suppliers", exact: true }).click();
      await nav.getByRole("button", { name: "Countries & Ports", exact: true }).click();
      const profile = page.getByRole("dialog", { name: "Countries & Ports", exact: true });
      await profile.getByRole("button", { name: "Port Index", exact: true }).click();
      await profile.getByLabel("Country or port", { exact: true }).fill("Hong Kong");
      await profile.getByRole("button", { name: "Hong Kong", exact: true }).click();

      const firstTab = profile.getByRole("tab", { name: "Port Information", exact: true });
      await firstTab.focus();
      await firstTab.press("End");
      const prices = profile.getByRole("tab", { name: "Price History", exact: true });
      await expect(prices).toHaveAttribute("aria-selected", "true");
      await expect(profile.getByRole("button", { name: "Buy prices", exact: true })).toHaveCount(0);
      await prices.press("Home");
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      await section(profile, "Suppliers");
      const header = profile.locator(".knowledge-header").first();
      await expect(header.getByRole("button", { name: /^Update(?:\s|$)/ })).toBeVisible();
      await expect(header.getByRole("button", { name: /^History(?:\s|$)/ })).toBeVisible();
      await expect(profile.getByRole("heading", { name: "Hong Kong", exact: true })).toBeVisible();
      await expect(profile.getByRole("button", { name: "Manage Tabs", exact: true })).toBeVisible();
      await expect(profile.getByRole("button", { name: "Add Section", exact: true })).toHaveCount(0);
      await expect(profile.locator(".knowledge-table-wrap tbody tr")).toHaveCount(4);
      await expect(profile.locator(".knowledge-section-toolbar")).toHaveCount(0);
      await expect(profile.getByLabel("Search all tabs", { exact: true })).toBeVisible();
      for (const name of ["Add Text", "Add Table", "Add file link"]) await expect(profile.getByRole("button", { name, exact: true })).toHaveCount(0);
      await page.screenshot({ path: new URL(`profile-${width}-${theme}.png`, OUT).pathname });

      await profile.getByRole("button", { name: "Update Supplier comparison · Demo", exact: true }).click();
      let editor = page.getByRole("dialog", { name: "Update information", exact: true });
      await expect(editor.locator(".knowledge-block-detail")).toHaveCount(1);
      await expect(editor.getByLabel("Reason", { exact: true })).toHaveCount(0);
      await expect(editor.getByLabel("Source", { exact: true })).toHaveCount(0);
      const updated = "UPDATED RECEIVING ARRANGEMENT CONFIRMED WITH THE AGENT.";
      await editor.getByLabel("Row 1, Remarks", { exact: true }).fill(updated);
      await expect(editor.getByRole("button", { name: "Row 1 actions", exact: true })).toBeVisible();
      await expect(editor.getByRole("button", { name: "Column 1 actions", exact: true })).toBeVisible();
      await expect(editor.getByLabel("Row actions", { exact: true })).toHaveCount(0);
      await expect(editor.getByLabel("Column actions", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: new URL(`editor-${width}-${theme}.png`, OUT).pathname });
      await expect(editor.getByRole("button", { name: "Preview changes", exact: true })).toHaveCount(0);
      await editor.getByRole("button", { name: "Update", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const saved = await state(page);
      assert.equal(saved.contributions[0].status, "approved");
      assert.equal(saved.contributions[0].publication, "direct");
      assert.equal(saved.contributions[0].author, actor);
      const total = saved.contributions.length;
      const row = profile.getByRole("row").filter({ hasText: updated });
      await historyFor(page, row, actor);

      let tabDialog = await manager(page, profile);
      await tabDialog.getByRole("button", { name: "Add Tab", exact: true }).click();
      await tabDialog.locator(".knowledge-manage-row").last().getByRole("textbox").fill("DELIVERY CHECKLIST");
      await tabDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(tabDialog).toHaveCount(0);
      await section(profile, "DELIVERY CHECKLIST");
      await header.getByRole("button", { name: /^Update(?:\s|$)/ }).click();
      editor = page.getByRole("dialog", { name: "Update information", exact: true });
      await editor.getByRole("button", { name: "Add Table", exact: true }).click();
      await expect(editor.locator(".knowledge-block-detail")).toHaveCount(1);
      await editor.getByLabel("Block 1 title", { exact: true }).fill("Checklist");
      await editor.getByLabel("Row 1, Name", { exact: true }).evaluate((element) => {
        const data = new DataTransfer();
        data.setData("text/plain", "Agent\tConfirmed\nDelivery\tBarge");
        element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await expect(editor.getByLabel("Row 2, Name", { exact: true })).toHaveValue("DELIVERY");
      await editor.getByLabel("Row 1, Name", { exact: true }).focus();
      await editor.getByLabel("Row 1, Name", { exact: true }).press("Enter");
      await expect(editor.getByLabel("Row 2, Name", { exact: true })).toBeFocused();
      await editor.getByLabel("Row 2, Name", { exact: true }).press("Tab");
      await expect(editor.getByLabel("Row 2, Information", { exact: true })).toBeFocused();
      await editor.getByLabel("Row 2, Name", { exact: true }).focus();
      await editor.getByRole("button", { name: "Row 2 actions", exact: true }).click();
      await editor.getByRole("menuitem", { name: "Insert row above", exact: true }).click();
      await expect(editor.getByLabel("Row 3, Name", { exact: true })).toHaveValue("DELIVERY");
      await editor.getByRole("button", { name: "Row 2 actions", exact: true }).click();
      await editor.getByRole("menuitem", { name: "Delete row", exact: true }).click();
      await expect(editor.getByLabel("Row 2, Name", { exact: true })).toHaveValue("DELIVERY");
      await editor.getByRole("button", { name: "Column 1 actions", exact: true }).click();
      await editor.getByRole("menuitem", { name: "Move column right", exact: true }).click();
      await expect(editor.getByLabel("Column 1 name", { exact: true })).toHaveValue("Information");
      await expect(editor.getByLabel("Row 2, Name", { exact: true })).toHaveValue("DELIVERY");
      await editor.getByRole("button", { name: "Column 2 actions", exact: true }).click();
      await editor.getByRole("menuitem", { name: "Move column left", exact: true }).click();
      await expect(editor.getByLabel("Column 1 name", { exact: true })).toHaveValue("Name");
      for (let step = 0; step < 6; step++) await editor.getByRole("button", { name: "Resize column 1", exact: true }).press("ArrowRight");
      await editor.getByRole("button", { name: "Update", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(profile.getByText("CONFIRMED", { exact: true })).toBeVisible();
      tabDialog = await manager(page, profile);
      await (await tabRow(tabDialog, "DELIVERY CHECKLIST")).getByRole("textbox").fill("DELIVERY PROCEDURES");
      await tabDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(tabDialog).toHaveCount(0);
      await section(profile, "DELIVERY PROCEDURES");
      await expect(profile.getByRole("tab", { name: "DELIVERY CHECKLIST", exact: true })).toHaveCount(0);
      await expect(profile.getByText("CONFIRMED", { exact: true })).toBeVisible();
      assert.equal((await state(page)).contributions.length, total + 3, "Add tab, add table and rename each publish one change");
      await header.getByRole("button", { name: /^Update(?:\s|$)/ }).click();
      editor = page.getByRole("dialog", { name: "Update information", exact: true });
      await expect(editor.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();

      await section(profile, "Port Information");
      await profile.locator(".knowledge-facts").getByRole("button", { name: /^Update/ }).click();
      const keyInfo = page.getByRole("dialog", { name: "Update Key Info", exact: true });
      await keyInfo.getByRole("textbox", { name: "ISO Specs", exact: true }).fill("ALL");
      await keyInfo.getByLabel("Reason", { exact: true }).fill("Updated information.");
      await keyInfo.getByRole("button", { name: "Update", exact: true }).click();
      const field = profile.locator(".knowledge-facts dl > div").filter({ has: page.getByText("ISO Specs", { exact: true }) });
      await historyFor(page, field, actor);
      assert.equal((await state(page)).ports.find((item) => item.id === "port-hong-kong").intelligenceEntryUpdates.isoSpecs.updatedBy, actor);
      await header.getByRole("button", { name: /^History(?:\s|$)/ }).click();
      await expect(profile.getByRole("heading", { name: "History", exact: true })).toBeVisible();
      await expect(profile.getByRole("button", { name: /DELIVERY CHECKLIST updated/i })).toBeVisible();
      await profile.getByRole("button", { name: /DELIVERY CHECKLIST updated/i }).click();
      await expect(profile.locator(".knowledge-comparison")).toBeVisible();
      await expect(profile.locator(".knowledge-comparison")).toContainText("CONFIRMED");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "No page overflow");
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px ${theme} ${actor}: compact header, price tab, visible attribution and detailed history, focused editor, table paste, add/rename tabs, no-op save, key info and history`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

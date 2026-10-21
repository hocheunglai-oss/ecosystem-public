import { assertKnowledgeAttribution } from './knowledge-attribution-assertions.mjs';
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const BASE = process.env.ECO_DEMO_URL || "http://127.0.0.1:4173";
const OUT = new URL("../artifacts/compact-location-profiles/", import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const readState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ecosystem.demo.v1")));
async function enter(page) {
  await page.goto(BASE);
  const profile = page.getByLabel("Demo profile", { exact: true });
  if (await profile.isVisible()) {
    await profile.selectOption("otto");
    await page.getByRole("button", { name: "ENTER ECOSYSTEM", exact: true }).click();
  }
}
async function directory(page) {
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const button = nav.getByRole("button", { name: "Countries & Ports", exact: true });
  if (!(await button.isVisible())) await nav.getByRole("button", { name: "Ports & Suppliers", exact: true }).click();
  await button.click();
  return page.getByRole("dialog", { name: "Countries & Ports", exact: true });
}

try {
  for (const width of [1440, 390, 320].filter(width => !process.env.ECO_COMPACT_WIDTH || width === Number(process.env.ECO_COMPACT_WIDTH))) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    try {
      await enter(page);
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem("ecosystem.demo.v1"));
        const doc = (kind, by, at, version, content) => ({ version, sections: [{ id: "trader-remarks", title: "Trader's Remarks", blocks: [{ id: "legacy-shared-id", type: "text", title: `${kind} record`, text: content, update: { updatedBy: by, updatedAt: at } }] }] });
        const country = doc("Country", "elena", "2026-10-01T08:00:00.000Z", 2, "COUNTRY LEGACY CONDITION");
        const port = doc("Port", "otto", "2026-10-02T08:00:00.000Z", 3, "PORT LEGACY CONDITION");
        country.sections.push({ id: "country-custom", title: "Country legacy notes", blocks: [{ id: "country-only-note", type: "text", title: "Country custom entry", text: "COUNTRY CUSTOM DETAILS" }] });
        state.knowledgeRecords ??= {};
        state.knowledgeRecords["country:Hong Kong"] = country;
        state.knowledgeRecords["port:port-hong-kong"] = port;
        const revision = (target, document, by, at, reason) => ({ target, version: document.version, before: { version: document.version - 1, sections: [] }, after: document, by, at, reason });
        state.knowledgeHistory ??= [];
        state.knowledgeHistory.unshift(
          revision({ kind: "port", id: "port-hong-kong" }, port, "otto", "2026-10-02T08:00:00.000Z", "Port legacy revision"),
          revision({ kind: "country", id: "Hong Kong" }, country, "elena", "2026-10-01T08:00:00.000Z", "Country legacy revision"),
        );
        localStorage.setItem("ecosystem.demo.v1", JSON.stringify(state));
        localStorage.setItem("ecosystem.locations.recent.otto", JSON.stringify(["country:Hong Kong", "port:port-hong-kong", "country:Singapore", "port:port-singapore", "country:Gibraltar", "port:port-gibraltar"]));
      });
      await page.reload();
      await enter(page);
      const profile = await directory(page);
      const recents = profile.getByRole("region", { name: "Recently viewed", exact: true });
      for (const name of ["Hong Kong", "Singapore", "Gibraltar"]) await expect(recents.getByRole("button", { name, exact: true })).toHaveCount(1);
      await expect(recents.getByRole("button")).toHaveCount(3);
      await expect(recents.locator("small")).toHaveCount(0);
      await recents.getByRole("button", { name: "Hong Kong", exact: true }).click();
      await expect(profile.getByRole("heading", { name: "Hong Kong", exact: true })).toBeVisible();
      await expect(profile.locator(".knowledge-local-time")).toBeVisible();
      await profile.getByRole("tab", { name: "Country legacy notes", exact: true }).click();
      await expect(profile.getByText("COUNTRY CUSTOM DETAILS", { exact: true })).toBeVisible();
      await profile.getByRole("button", { name: "Manage Tabs", exact: true }).click();
      const rename = page.getByRole("dialog", { name: "Manage Tabs", exact: true });
      const rows = rename.locator(".knowledge-manage-row");
      for(let index=0; index<await rows.count(); index++) {
        const input=rows.nth(index).getByRole("textbox");
        if((await input.inputValue()).toLowerCase()==="country legacy notes") await input.fill("COUNTRY REGULATIONS");
      }
      await rename.getByRole("button", { name: "Save", exact: true }).click();
      await expect(rename).toHaveCount(0);
      await profile.getByRole("tab", { name: "COUNTRY REGULATIONS", exact: true }).click();
      await expect(profile.getByText("COUNTRY CUSTOM DETAILS", { exact: true })).toBeVisible();
      assert.ok((await readState(page)).knowledgeRecords["country:Hong Kong"].sections.some((section) => section.id === "country-custom" && section.title === "COUNTRY REGULATIONS"));
      await profile.getByRole("tab", { name: "Trader's Remarks", exact: true }).click();
      const countryEntry = profile.getByRole("article").filter({ hasText: "COUNTRY LEGACY CONDITION" });
      const portEntry = profile.getByRole("article").filter({ hasText: "PORT LEGACY CONDITION" });
      await expect(countryEntry).toBeVisible();
      await expect(portEntry).toBeVisible();
      await assertKnowledgeAttribution(page, countryEntry, /SAMPLE CREDIT REVIEWER/i);
      await profile.locator(".knowledge-header").getByRole("button", { name: /^History(?:\s|$)/ }).click();
      await expect(profile.getByRole("button", { name: /Country legacy revision/i })).toBeVisible();
      await expect(profile.getByRole("button", { name: /Port legacy revision/i })).toBeVisible();
      await profile.getByRole("button", { name: "Close information panel", exact: true }).click();
      await countryEntry.getByRole("button", { name: "Update Country record", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Update information", exact: true });
      await expect(editor.locator(".knowledge-block-detail")).toHaveCount(1);
      await editor.getByLabel("Block 1 text", { exact: true }).fill("COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE");
      await editor.getByRole("button", { name: "Update", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(profile.getByText("COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE", { exact: true })).toBeVisible();
      await expect(profile.getByText("PORT LEGACY CONDITION", { exact: true })).toBeVisible();
      const saved = await readState(page);
      const countryBlocks = saved.knowledgeRecords["country:Hong Kong"].sections.flatMap((section) => section.blocks);
      const portBlocks = saved.knowledgeRecords["port:port-hong-kong"].sections.flatMap((section) => section.blocks);
      assert.ok(countryBlocks.some((block) => block.text === "COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE"));
      assert.ok(portBlocks.some((block) => block.text === "PORT LEGACY CONDITION"));
      assert.ok(!portBlocks.some((block) => block.text === "COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE"));
      assert.equal(saved.knowledgeHistory[0].target.kind, "country");
      assert.equal(saved.knowledgeHistory[0].by, "otto");
      await page.screenshot({ path: new URL(`combined-${width}.png`, OUT).pathname });
      await profile.getByRole("button", { name: "Manage Tabs", exact: true }).click();
      let management = page.getByRole("dialog", { name: "Manage Tabs", exact: true });
      let managedRows = management.locator(".knowledge-manage-row");
      for(let index=0; index<await managedRows.count(); index++) {
        const input=managedRows.nth(index).getByRole("textbox");
        if((await input.inputValue()).toLowerCase()==="trader's remarks") await input.fill("SHARED REMARKS");
      }
      await management.getByRole("button", { name: "Save", exact: true }).click();
      await expect(management).toHaveCount(0);
      await profile.getByRole("tab", { name: "SHARED REMARKS", exact: true }).click();
      await expect(profile.getByText("COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE", { exact: true })).toBeVisible();
      await expect(profile.getByText("PORT LEGACY CONDITION", { exact: true })).toBeVisible();
      const renamed = await readState(page);
      for(const key of ["country:Hong Kong", "port:port-hong-kong"]) {
        const originalBlock=saved.knowledgeRecords[key].sections.flatMap(section=>section.blocks).find(block=>block.id==="legacy-shared-id");
        const renamedSection=renamed.knowledgeRecords[key].sections.find(section=>section.title==="SHARED REMARKS");
        assert.ok(renamedSection, "Both source documents are renamed");
        assert.deepEqual(renamedSection.blocks.find(block=>block.id==="legacy-shared-id").update, originalBlock.update, "Renaming does not restamp content audit");
      }
      await profile.getByRole("button", { name: "Manage Tabs", exact: true }).click();
      management = page.getByRole("dialog", { name: "Manage Tabs", exact: true });
      await management.getByRole("button", { name: "Remove tab SHARED REMARKS", exact: true }).click();
      await management.getByRole("button", { name: "Save", exact: true }).click();
      await expect(management).toHaveCount(0);
      await expect(profile.getByRole("tab", { name: "SHARED REMARKS", exact: true })).toHaveCount(0);
      const removed=await readState(page);
      for(const key of ["country:Hong Kong", "port:port-hong-kong"]) assert.ok(!removed.knowledgeRecords[key].sections.some(section=>section.title==="SHARED REMARKS"));
      assert.ok(JSON.stringify(removed.knowledgeHistory).includes("COUNTRY CONDITION REVISED THROUGH THE COMBINED PROFILE"));
      assert.ok(JSON.stringify(removed.knowledgeHistory).includes("PORT LEGACY CONDITION"));
      const windowActions = profile.locator(".window-foot-actions");
      const [windowFeedback, windowTheme] = await Promise.all([
        windowActions.getByRole("button", { name: "Feedback for ecosystem", exact: true }).boundingBox(),
        windowActions.getByRole("button", { name: /^(Dark|Light) mode$/ }).boundingBox(),
      ]);
      assert.ok(windowFeedback && windowTheme);
      assert.ok(Math.abs(windowFeedback.y + windowFeedback.height / 2 - windowTheme.y - windowTheme.height / 2) < 8, "Workspace feedback sits beside the theme action");
      await page.screenshot({ path: new URL(`workspace-footer-${width}.png`, OUT).pathname });
      await profile.getByRole("button", { name: "Close workspace", exact: true }).click();
      const feedback = page.locator(".home-display-controls").getByRole("button", { name: "Feedback for ecosystem", exact: true });
      const theme = page.locator(".home-display-controls").getByRole("button", { name: /^(Dark|Light) mode$/ });
      await expect(feedback).toBeVisible();
      const [feedbackBox, themeBox] = await Promise.all([feedback.boundingBox(), theme.boundingBox()]);
      assert.ok(feedbackBox && themeBox);
      assert.ok(Math.abs(feedbackBox.y + feedbackBox.height / 2 - themeBox.y - themeBox.height / 2) < 8, "Feedback sits beside the theme action");
      await page.screenshot({ path: new URL(`home-footer-${width}.png`, OUT).pathname });
      await feedback.click();
      await expect(page.getByRole("dialog", { name: /Feedback|Contribute/i })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: combined HK country/port data and histories survive colliding block IDs, country edits and manage-tab rename/remove preserve source audits, legacy recents deduplicate, footer feedback`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

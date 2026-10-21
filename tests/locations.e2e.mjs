import { assertKnowledgeAttribution } from './knowledge-attribution-assertions.mjs';
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const BASE = process.env.ECO_DEMO_URL || "http://127.0.0.1:4173";
const OUT = new URL("../artifacts/locations/", import.meta.url);
const LOG = "/tmp/eco-locations-e2e.log";
const TITLE = "Countries & Ports";
const TABS = ["Suppliers", "Refineries", "Grades and delivery modes", "Tax and regulations", "Trader's Remarks", "Uploaded Documents"];
const RAW = "Buyer: Meridian Shipping Pte Ltd\nVessel: LOCATION TEST VESSEL\nPort: Singapore\nETA: 15 October\nVLSFO: 500 MT".toUpperCase();
await mkdir(OUT, { recursive: true });
await writeFile(LOG, "");
const report = async (message) => {
  console.log(message);
  await appendFile(LOG, `${message}\n`);
};
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const readState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ecosystem.demo.v1")));
const search = (directory) => directory.getByRole("textbox", { name: /Country.*port/i });

async function enter(page) {
  await page.goto(BASE);
  const login = page.getByLabel("Demo profile", { exact: true });
  if (await login.isVisible()) {
    await login.selectOption("otto");
    await page.getByRole("button", { name: "ENTER ECOSYSTEM", exact: true }).click();
  }
}

async function openDirectory(page) {
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const item = nav.getByRole("button", { name: TITLE, exact: true });
  if (!(await item.isVisible())) await nav.getByRole("button", { name: "Ports & Suppliers", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Port data", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Country data", exact: true })).toHaveCount(0);
  await item.click();
  return page.getByRole("dialog", { name: TITLE, exact: true });
}

async function landing(directory) {
  const back = directory.getByRole("button", { name: /^(Back to )?Countries & Ports$/, exact: true });
  if (await back.isVisible()) await back.click();
  await search(directory).fill("");
}

async function index(directory, kind, name) {
  await directory.getByRole("button", { name: `${kind} Index`, exact: true }).click();
  await search(directory).fill(name);
  const table = directory.locator(".location-table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /updated/i })).toHaveCount(0);
  await table.getByRole("button", { name, exact: true }).click();
  await expect(directory.getByRole("heading", { name, exact: true, level: 2 })).toBeVisible();
}

async function addLocation(page, directory, type, name, country) {
  await directory.getByRole("button", { name: "Add location", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add location", exact: true });
  await editor.getByLabel("Type", { exact: true }).selectOption(type);
  await editor.getByLabel("Name", { exact: true }).fill(name);
  if (country) await editor.getByLabel("Country", { exact: true }).selectOption({ label: country });
  await expect(editor.getByRole("option", { name: "Area", exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "Add location", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(directory.getByRole("heading", { name, exact: true, level: 2 })).toBeVisible();
  await landing(directory);
}

async function profile(directory, kind) {
  const tabs = directory.getByRole("tablist", { name: "Information sections" });
  await expect(tabs).toBeVisible();
  assert.deepEqual(await tabs.getByRole("tab").allTextContents(), kind === "Port" ? ["Port Information", ...TABS, "Price History"] : TABS);
  await expect(tabs.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await expect(directory.getByRole("button", { name: /^Files\b/ })).toHaveCount(0);
  await expect(directory.locator(".knowledge-metadata")).toHaveCount(0);
  await expect(directory.locator(".knowledge-header:visible").first()).not.toContainText(/Port \/ Country|\d{1,2} [A-Z][a-z]{2} \d{4}/);
  const clock = directory.locator(".knowledge-local-time:visible");
  if (kind === "Port") await expect(clock).toBeVisible();
  else await expect(clock).toHaveCount(0);
}

try {
  const layouts = [[1440, "light"], [1440, "dark"], [390, "light"], [850, "light"]]
    .filter(([width]) => !process.env.ECO_LOCATIONS_WIDTH || width === Number(process.env.ECO_LOCATIONS_WIDTH));
  for (const [width, theme] of layouts) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce", isMobile: width < 1000, hasTouch: width < 1000 });
    await context.addInitScript((mode) => localStorage.setItem("ecosystem.theme.v1", mode), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await enter(page);
      const nav = page.getByRole("navigation", { name: "Workspace navigation" });
      await nav.getByRole("button", { name: "Contribute", exact: true }).click();
      await expect(nav.getByRole("button", { name: "Ports and countries", exact: true })).toHaveCount(0);
      const feedback = page.locator(".home-display-controls").getByRole("button", { name: "Feedback for ecosystem", exact: true });
      await expect(feedback).toBeVisible();
      let directory = await openDirectory(page);
      await expect(search(directory)).toBeVisible();
      await expect(directory.getByRole("button", { name: "Paste information", exact: true })).toHaveCount(0);
      await expect(directory.getByRole("button", { name: /^(Areas|Area Index)$/ })).toHaveCount(0);
      await expect(directory.locator(".location-table")).toHaveCount(0);
      const extractor = directory.getByRole("region", { name: "Information extractor", exact: true });
      await expect(extractor).toBeVisible();
      await expect(extractor.getByLabel("Information", { exact: true })).toBeVisible();
      for (const action of ["Add location", "Country Index", "Port Index"])
        await expect(directory.locator(".location-toolbar").getByRole("button", { name: action, exact: true })).toBeVisible();
      await page.screenshot({ path: new URL(`landing-${width}-${theme}.png`, OUT).pathname });

      await directory.getByRole("button", { name: "Country Index", exact: true }).click();
      for (const name of ["Hong Kong", "Singapore", "Gibraltar"]) {
        await search(directory).fill(name);
        await expect(directory.locator(".location-table").getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      await index(directory, "Country", "Japan");
      await profile(directory, "Country");
      await page.screenshot({ path: new URL(`country-${width}-${theme}.png`, OUT).pathname });
      await index(directory, "Port", "Hong Kong");
      await profile(directory, "Port");
      const header = directory.locator(".knowledge-header").first();
      await expect(header).toContainText("Hong Kong");
      await expect(directory.locator(".location-breadcrumb")).toHaveCount(0);
      await page.screenshot({ path: new URL(`port-${width}-${theme}.png`, OUT).pathname });

      await directory.getByRole("tab", { name: "Suppliers", exact: true }).click();
      await directory.getByRole("button", { name: "Update Supplier comparison · Demo", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Update information", exact: true });
      const updated = "AGENT RECONFIRMED THE RECEIVING ARRANGEMENT.";
      await editor.getByLabel("Row 1, Remarks", { exact: true }).fill(updated);
      await expect(editor.getByLabel("Reason", { exact: true })).toHaveCount(0);
      await editor.getByRole("button", { name: "Update", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const entry = directory.getByRole("article").filter({ has: page.getByRole("heading", { name: "Supplier comparison · Demo", exact: true }) });
      await expect(entry).toContainText(updated);
      await expect(entry.locator(".knowledge-entry-update")).toHaveCount(0);
      const saved = await readState(page);
      assert.equal(saved.contributions[0].author, "otto");
      assert.equal(saved.contributions[0].status, "approved");
      const row = entry.getByRole("row").filter({ hasText: updated });
      await assertKnowledgeAttribution(page, row, /SAMPLE TRADER/i);
      await expect(header).not.toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}/);

      await index(directory, "Port", "Chiba");
      let breadcrumb = directory.locator(".knowledge-header");
      await expect(breadcrumb).toContainText("Japan");
      await expect(breadcrumb).toContainText("Tokyo Bay");
      await expect(breadcrumb.getByRole("button", { name: "Tokyo Bay", exact: true })).toHaveCount(0);
      await index(directory, "Country", "Japan");
      await profile(directory, "Country");
      const children = directory.getByRole("region", { name: "Ports in this country" });
      await expect(children.getByRole("button", { name: /^Tokyo Bay/ })).toHaveCount(0);
      for (const port of ["Chiba", "Tokyo", "Yokohama", "Osaka"])
        await expect(children.getByRole("button", { name: new RegExp(`^${port}\\b`) })).toBeVisible();
      await landing(directory);
      await expect(directory.getByText("Recently viewed", { exact: true })).toBeVisible();
      await expect(directory.locator(".location-recents button small")).toHaveCount(0);
      await expect(extractor).toBeVisible();
      const order = await directory.evaluate((element) => {
        const recent = element.querySelector(".location-recents");
        const extract = element.querySelector(".location-extractor");
        return Boolean(recent && extract && recent.compareDocumentPosition(extract) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      assert.equal(order, true, "Information extractor follows Recently viewed");
      await expect(directory.locator(".location-table")).toHaveCount(0);

      await directory.getByRole("button", { name: "Add location", exact: true }).click();
      const invalid = page.getByRole("dialog", { name: "Add location", exact: true });
      await invalid.getByLabel("Type", { exact: true }).selectOption("port");
      await invalid.getByLabel("Name", { exact: true }).fill("UNASSIGNED PORT");
      await invalid.getByLabel("Country", { exact: true }).selectOption("");
      await invalid.getByRole("button", { name: "Add location", exact: true }).click();
      await expect(invalid).toBeVisible();
      assert.equal((await readState(page)).ports.some((port) => port.name === "UNASSIGNED PORT"), false);
      await invalid.getByRole("button", { name: "Cancel", exact: true }).click();
      await addLocation(page, directory, "country", "DEMO TEST COUNTRY");
      await addLocation(page, directory, "port", "DEMO TEST PORT", "DEMO TEST COUNTRY");
      await page.reload();
      const login = page.getByLabel("Demo profile", { exact: true });
      if (await login.isVisible()) {
        await login.selectOption("otto");
        await page.getByRole("button", { name: "ENTER ECOSYSTEM", exact: true }).click();
      }
      directory = page.getByRole("dialog", { name: TITLE, exact: true });
      if (!(await directory.isVisible())) directory = await openDirectory(page);
      await index(directory, "Port", "DEMO TEST PORT");
      breadcrumb = directory.locator(".knowledge-header");
      await expect(breadcrumb).toContainText("DEMO TEST COUNTRY");
      await expect(breadcrumb).not.toContainText("DEMO TEST AREA");
      await expect(breadcrumb).toContainText("DEMO TEST PORT");
      await expect(breadcrumb.getByRole("button", { name: "DEMO TEST AREA", exact: true })).toHaveCount(0);
      await directory.getByRole("button", { name: "Close workspace", exact: true }).click();
      await nav.getByRole("button", { name: "Trading", exact: true }).click();
      await nav.getByRole("button", { name: "Enquiries", exact: true }).click();
      const center = page.getByRole("dialog", { name: "Enquiries", exact: true });
      await center.getByLabel("Raw enquiry", { exact: true }).fill(RAW);
      await expect(center.getByRole("combobox", { name: "Port", exact: true })).toHaveValue("SINGAPORE");
      await center.getByRole("tab", { name: "Ports & Suppliers", exact: true }).click();
      await expect(center.getByRole("heading", { name: "Singapore", exact: true })).toBeVisible();
      await profile(center.getByRole("tabpanel", { name: "Ports & Suppliers", exact: true }), "Port");
      await center.getByRole("button", { name: "Close workspace", exact: true }).click();
      directory = await openDirectory(page);
      await index(directory, "Port", "Singapore");
      await expect(directory.getByRole("heading", { name: "Singapore", exact: true })).toBeVisible();
      await profile(directory, "Port");
      await directory.getByRole("button", { name: "Close workspace", exact: true }).click();
      await nav.getByRole("button", { name: "Trading", exact: true }).click();
      await nav.getByRole("button", { name: "Enquiries", exact: true }).click();
      await center.getByRole("tab", { name: "Enquiries", exact: true }).click();
      await expect(center.getByLabel("Raw enquiry", { exact: true })).toHaveValue(RAW);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "No page overflow");
      assert.deepEqual(errors, []);
      await report(`PASS ${width}px ${theme}: landing/extractor, single port aliases, default tabs, port clock, hidden entry history, country requirement, country/port hierarchy, persistence, enquiry return`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }).catch(() => {});
      await report(`FAIL ${width}px ${theme}: ${error.stack || error}`);
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

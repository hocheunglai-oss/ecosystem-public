import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { installStagingCookies } from "./fixtures/protection-cookies.mjs";
const base = process.env.ECO_ADMIN_UI_ORIGIN || "http://127.0.0.1:4287";
const output = resolve(
  process.env.ECO_TEST_OUTPUT || "output/shared-contribution-availability",
);
await mkdir(output, { recursive: true });
const user = {
  capabilities: { appearancePreview: true, testWorkspace: true },
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  displayName: "SAMPLE TRADER",
  phone: "+6591815902",
  officeId: "HONG KONG",
  officeName: "HONG KONG",
  isAdmin: true,
  isSpcTrader: false,
  isManager: false,
  isActive: true,
  activated: true,
  passwordChangeSuggested: false,
  revision: 1,
};
const key = `ecosystem.live.v1:${user.id}:state:v2`;
const reports = [];
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser = await type.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390])
      for (const theme of ["light", "dark"]) {
        if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          isMobile: width < 760,
          hasTouch: width < 760,
          reducedMotion: "reduce",
        });
        await installStagingCookies(context, base);
        let mode = "loading",
          count = 0;
        const pending = [],
          writes = [];
        await installEmptyLiveInbox(context);
        await installSharedLocations(context,{user:()=>user,now:()=> '2026-10-14T10:00:00Z'});
        await installSharedAttachments(context,{user:()=>user});
        await context.route("**/api/access/**", (route) => {
          const path = new URL(route.request().url()).pathname.replace(
            "/api/access/",
            "",
          );
          if (route.request().method() !== "GET") writes.push(path);
          return route.fulfill({
            json:
              path === "session"
                ? { user, preview: null }
                : path === "users"
                  ? {
                      users: [user],
                      offices: [{ id: "HONG KONG", name: "HONG KONG" }],
                    }
                  : { requests: [] },
          });
        });
        await context.route("**/api/admin/**", (route) => {
          if (route.request().method() !== "GET")
            writes.push(route.request().url());
          if (mode === "loading") {
            pending.push(route);
            return;
          }
          if (mode === "error")
            return route.fulfill({
              status: 503,
              json: { message: "Count unavailable." },
            });
          return route.fulfill({
            json: {
              count,
              previousCount: 0,
              items: [],
              periodStart: "2026-10-07T16:00:00Z",
              periodEnd: "2026-10-14T16:00:00Z",
              source: "shared-feedback",
              timeZone: "Asia/Hong_Kong",
            },
          });
        });
        await context.addInitScript(
          (theme) => localStorage.setItem("ecosystem.theme.v1", theme),
          theme,
        );
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.clock.setFixedTime(new Date("2026-10-14T10:00:00Z"));
        const trigger = page.locator(".hud-resource-activity"),
          panel = page.locator("#hud-contribution-activity");
        const shot = async (name) => {
          await page.screenshot({
            path: `${output}/${engine}-${width}-${theme}-${name}.png`,
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
            "No horizontal overflow",
          );
          for (const locator of [
            trigger,
            trigger.locator(".contribution-tier"),
            panel,
          ]) {
            const box = await locator.boundingBox();
            assert.ok(
              box && box.x >= -1 && box.x + box.width <= width + 1,
              "Panel and badge fit",
            );
          }
          assert.ok(
            await trigger
              .locator(".contribution-tier")
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
            "Badge label not clipped",
          );
          if (width > 760) {
            const box = await panel.boundingBox(),
              footer = await page
                .locator(".home-display-controls")
                .boundingBox();
            assert.ok(
              box.y + box.height <= footer.y - 2,
              "Panel stays above footer",
            );
          }
        };
        const refresh = () =>
          page.evaluate(() =>
            window.dispatchEvent(new Event("eco-feedback-updated")),
          );
        try {
          await page.goto(base);
          await page
            .getByRole("main", { name: "ECOSYSTEM workspace" })
            .waitFor();
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "CHECKING",
          );
          await trigger.click();
          await expect(
            panel.locator(".activity-tier-heading .contribution-tier"),
          ).toHaveText("CHECKING");
          await expect(panel.getByRole("progressbar")).toHaveCount(0);
          await expect(panel.locator("[data-activity-total]")).toHaveText("0");
          await expect(panel).toContainText("LOCAL CONTRIBUTIONS");
          await expect(panel.getByRole("status")).toHaveText("CHECKING SHARED CONTRIBUTIONS.");
          await shot("loading");
          mode = "error";
          await Promise.all(
            pending
              .splice(0)
              .map((route) =>
                route
                  .fulfill({
                    status: 503,
                    json: { message: "Count unavailable." },
                  })
                  .catch(() => {}),
              ),
          );
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "UNAVAILABLE",
          );
          await expect(
            panel.locator(".activity-tier-heading .contribution-tier"),
          ).toHaveText("UNAVAILABLE");
          await shot("unavailable");
          const selector = page.getByRole("combobox", {
            name: "Contribution appearance preview",
          });
          for (const [status, total] of [
            ["inactive", 0],
            ["active", 5],
            ["outstanding", 11],
          ]) {
            await selector.selectOption(status);
            await expect(trigger.locator(".contribution-tier")).toHaveText(
              status.toUpperCase(),
            );
            await expect(panel.locator("[data-activity-total]")).toHaveText(
              String(total),
            );
            await expect(panel.getByRole("progressbar")).toHaveAttribute(
              "aria-valuenow",
              String(total),
            );
            await expect(panel).not.toContainText("COUNT UNAVAILABLE");
          }
          await selector.selectOption("actual");
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "UNAVAILABLE",
          );
          mode = "ready";
          count = 2;
          await refresh();
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "ACTIVE",
          );
          await expect(panel.locator("[data-activity-total]")).toHaveText("2");
          await shot("recovered");
          count = 0;
          await refresh();
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "INACTIVE",
          );
          await expect(panel.locator("[data-activity-total]")).toHaveText("0");
          await page.evaluate(
            ({ key, id }) => {
              const state = JSON.parse(localStorage.getItem(key));
              state.contributions = Array.from({ length: 3 }, (_, i) => ({
                id: `existing-local-${i}`,
                createdAt: "2026-10-13T01:00:00Z",
                publishedAt: "2026-10-13T01:00:00Z",
                title: `LOCAL UPDATE ${i}`,
                body: `EXISTING LOCAL INFORMATION ${i}`,
                author: id,
                status: "approved",
                publication: "direct",
                targetType: "feedback",
                targetId: "ecosystem",
              }));
              state.drops = [];
              localStorage.setItem(key, JSON.stringify(state));
            },
            { key, id: user.id },
          );
          mode = "error";
          await page.reload();
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "UNAVAILABLE",
          );
          await trigger.click();
          await expect(panel.locator("[data-activity-total]")).toHaveText("3");
          await expect(panel).toContainText("LOCAL CONTRIBUTIONS");
          await expect(panel.getByRole("progressbar")).toHaveCount(0);
          await shot("known-local");
          mode = "ready";
          count = 8;
          await refresh();
          await expect(trigger.locator(".contribution-tier")).toHaveText(
            "OUTSTANDING",
          );
          await expect(panel.locator("[data-activity-total]")).toHaveText("11");
          await expect(panel.getByRole("progressbar")).toHaveAttribute(
            "aria-valuenow",
            "11",
          );
          await shot("combined");
          assert.deepEqual(writes, []);
          assert.deepEqual(sharedLocations(page).requests, [], 'Status checks never write shared location records');
          assert.deepEqual(errors, []);
          reports.push({ engine, width, theme, passed: true });
          console.log(`PASS ${engine} ${width} ${theme}`);
        } catch (error) {
          await page
            .screenshot({
              path: `${output}/${engine}-${width}-${theme}-failure.png`,
              fullPage: true,
            })
            .catch(() => {});
          throw error;
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
}
await writeFile(`${output}/results.json`, JSON.stringify(reports, null, 2));

import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installStagingCookies } from "./fixtures/protection-cookies.mjs";
const base = process.env.ECO_ADMIN_UI_ORIGIN || "http://127.0.0.1:4287";
const out = resolve(
  process.env.ECO_ADMIN_UI_OUTPUT || "output/administration-ui",
);
await mkdir(out, { recursive: true });
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  displayName: "SAMPLE TRADER",
  officeId: "HONG KONG",
  officeName: "HONG KONG",
  isAdmin: true,
  isActive: true,
  isManager: false,
  isSpcTrader: false,
  activated: true,
  passwordChangeSuggested: false,
  revision: 1,
};
const reports = [];
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await installStagingCookies(context, base);
  const page = await context.newPage();
  let serverTime = Date.parse("2026-10-14T10:00:00Z"),
    healthRequests = 0,
    fail = false;
  await installEmptyLiveInbox(context);
  await context.route("**/api/access/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/access/",
      "",
    );
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
    const path = new URL(route.request().url()).pathname.replace(
      "/api/admin/",
      "",
    );
    if (path === "feedback/contributions")
      return route.fulfill({
        json: {
          count: 0,
          items: [],
          source: "shared-feedback",
          periodStart: new Date(serverTime).toISOString(),
          periodEnd: new Date(serverTime).toISOString(),
          timeZone: "Asia/Hong_Kong",
        },
      });
    if (path !== "system-health")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    healthRequests++;
    if (fail)
      return route.fulfill({
        status: 503,
        json: { message: "Health probe unavailable." },
      });
    const observedAt = new Date(serverTime).toISOString();
    return route.fulfill({
      json: {
        schemaVersion: 1,
        status: "healthy",
        observedAt,
        expiresAt: new Date(serverTime + 30000).toISOString(),
        cacheTtlSeconds: 30,
        checks: [
          { id: 'email-intake', label: 'EMAIL INTAKE', status: healthRequests === 1 ? 'healthy' : 'degraded', checkedAt: observedAt,
            detail: healthRequests === 1 ? 'VERIFIED RECEIVER CHECKPOINT IS CURRENT.' : 'EMAIL RECEIVING REQUIRES ATTENTION.',
            metrics: { enabled_email_sources: 1, stale_leases: healthRequests === 1 ? 0 : 1, last_checkpoint: healthRequests === 1 ? observedAt : '2026-10-14T09:00:00Z' } },
          {
            id: "database",
            label: "DATABASE CONNECTION",
            status: "healthy",
            detail: "LIVE DATABASE CHECK.",
            checkedAt: observedAt,
            latencyMs: 35,
          },
        ],
      },
    });
  });
  try {
    await page.clock.install({ time: new Date(serverTime) });
    await page.goto(base);
    await page.getByRole("main", { name: "ECOSYSTEM workspace" }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Administration", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Administration" })
      .getByRole("button", { name: "System Health", exact: true })
      .click();
    await expect(page.locator(".admin-panel").filter({ has: page.getByRole("heading", { name: "DATABASE CONNECTION", exact: true }) }).locator(".admin-status")).toHaveText(
      "healthy",
    );
    await expect(page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'EMAIL INTAKE', exact: true }) }).locator('.admin-status')).toHaveText('healthy');
    assert.equal(healthRequests, 1);
    serverTime += 31000;
    await page.clock.fastForward(31000);
    await expect.poll(() => healthRequests).toBe(2);
    await expect(page.locator(".admin-panel").filter({ has: page.getByRole("heading", { name: "DATABASE CONNECTION", exact: true }) }).locator(".admin-status")).toHaveText(
      "healthy",
    );
    await expect(page.getByText(/These checks have expired/)).toHaveCount(0);
    await expect(page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'EMAIL INTAKE', exact: true }) }).locator('.admin-status')).toHaveText('degraded');
    fail = true;
    serverTime += 31000;
    await page.clock.fastForward(31000);
    await expect.poll(() => healthRequests).toBe(3);
    await expect(page.getByRole("alert")).toContainText(
      "Health probe unavailable.",
    );
    await expect(page.locator(".admin-panel").filter({ has: page.getByRole("heading", { name: "DATABASE CONNECTION", exact: true }) }).locator(".admin-status")).toHaveCount(0);
    reports.push({
      engine,
      passed: true,
      checked:
        "Refresh at 30-second server expiry; failure removes stale healthy result",
    });
    console.log(`PASS ${engine} health expiry and failure`);
  } finally {
    await context.close();
    await browser.close();
  }
}
await writeFile(
  `${out}/health-refresh-results.json`,
  JSON.stringify(reports, null, 2),
);

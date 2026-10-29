import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { installStagingCookies } from "./fixtures/protection-cookies.mjs";

const base = process.env.ECO_ADMIN_UI_ORIGIN || "http://127.0.0.1:4286";
const out = resolve(
  process.env.ECO_ADMIN_UI_OUTPUT || "output/administration-ui",
);
await mkdir(out, { recursive: true });
const reports = [];
const user = {
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
const now = "2026-10-14T10:00:00Z";
const item = {
  id: "20000000-0000-4000-8000-000000000001",
  title: "Delivery window needs clarification",
  description:
    "Please include the delivery time window in the Singapore port information.",
  category: "data",
  status: "new",
  priority: "normal",
  pagePath: "/ports",
  submitterId: user.id,
  submitterName: user.displayName,
  officeName: user.officeName,
  assigneeId: null,
  assigneeName: null,
  resolution: "",
  createdAt: now,
  updatedAt: now,
  revision: 1,
};
const health = {
  schemaVersion: 1,
  status: "unknown",
  observedAt: now,
  expiresAt: "2026-10-14T10:02:00Z",
  cacheTtlSeconds: 120,
  checks: [
    {
      id: "database",
      label: "Database connectivity",
      status: "healthy",
      detail: "Authenticated database probe completed.",
      checkedAt: now,
      latencyMs: 36,
    },
    {
      id: "imports",
      label: "Import processing",
      status: "degraded",
      detail: "One import needs attention.",
      checkedAt: now,
      metrics: { pending_imports: 0, failed_imports: 1 },
    },
    {
      id: "backup",
      label: "Database backup",
      status: "unknown",
      detail: "No verified backup evidence is connected.",
      checkedAt: null,
    },
    {
      id: "restore",
      label: "Recovery test",
      status: "unknown",
      detail: "No verified restore test is recorded.",
      checkedAt: null,
    },
  ],
};
function emailHealth(status = 'unknown') {
  return { id: 'email-intake', label: 'EMAIL INTAKE', status, checkedAt: status === 'unknown' ? null : now,
    detail: status === 'unknown' ? 'EMAIL INTAKE HAS NOT BEEN VERIFIED.' : status === 'healthy' ? 'VERIFIED RECEIVER CHECKPOINT IS CURRENT.' : 'EMAIL RECEIVING REQUIRES ATTENTION.',
    metrics: { configured_sources: status === 'unknown' ? 0 : 1, enabled_sources: status === 'unknown' ? 0 : 1, enabled_email_sources: status === 'unknown' ? 0 : 1,
      last_checkpoint: status === 'unknown' ? null : status === 'healthy' ? now : '2026-10-14T09:00:00Z', quarantined: 0, failed_sources: 0, stale_leases: status === 'degraded' ? 1 : 0 } };
}
const info = {
  schemaVersion: 1,
  application: { name: "ECO", version: "0.1.0" },
  build: {
    builtAt: now,
    releaseId: "eco-20261014-a13fe59",
    sourceSha256: "a".repeat(64),
    sourceFileCount: 85,
    lockfileSha256: "b".repeat(64),
    gitCommit: null,
    gitWorktree: "dirty",
  },
  dependencies: [
    { name: "react", version: "19.3.0", scope: "runtime" },
    { name: "@supabase/supabase-js", version: "2.117.3", scope: "runtime" },
    { name: "typescript", version: "7.0.2", scope: "development" },
  ],
  migrations: {
    bundledHead: "20261014100000_eco_administration",
    count: 5,
    sha256: "c".repeat(64),
  },
  targets: {
    databaseRegion: "ap-southeast-1",
    databaseProjectRef: "test-project",
    computeRegions: ["sin1"],
    identityMode: "independent-password",
  },
  runtime: {
    node: "24.10.0",
    requiredNode: "24.x",
    environment: "preview",
    deploymentId: "dpl_ui_fixture",
    region: "sin1",
  },
};

async function mock(context, options = {}) {
  const state = {
    user: options.user ?? user,
    preview: options.preview ?? null,
    items: [{ ...item }],
    requests: [],
    parserRequests: [],
    emailHealth: "unknown",
    mode: "data",
  };
  await installEmptyLiveInbox(context);
  await context.route("**/api/access/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/access/",
      "",
    );
    if (options.signedOut)
      return route.fulfill({
        status: 401,
        json: { message: "Sign in required." },
      });
    if (path === "session")
      return route.fulfill({
        json: {
          user: state.user,
          effectiveUser: state.user,
          preview: state.preview,
        },
      });
    if (path === "users")
      return route.fulfill({
        json: {
          users: [user],
          offices: [{ id: "HONG KONG", name: "HONG KONG" }],
        },
      });
    if (path === "phone-requests")
      return route.fulfill({ json: { requests: [] } });
    return route.fulfill({
      status: 403,
      json: { message: "Unexpected access request" },
    });
  });
  // Administration uses LIVE data; its Import Activity view also loads the
  // authenticated parser-report list, even when that list is empty.
  await context.route("**/api/enquiries/test-policy", (route) =>
    route.fulfill({ json: { enabled: false, generation: "" } }),
  );
  await context.route("**/api/parser/reports?*", (route) => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.method(), "GET");
    assert.equal(url.searchParams.get("dataMode"), "live");
    assert.equal(url.searchParams.has("generation"), false);
    state.parserRequests.push(url.searchParams.toString());
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await context.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname.replace("/api/admin/", ""),
      method = route.request().method();
    state.requests.push({ path, method, query: url.searchParams.toString() });
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "feedback/contributions")
      return reply({
        count: 0,
        items: [],
        periodStart: now,
        periodEnd: now,
        timeZone: "Asia/Hong_Kong",
        source: "shared-feedback",
      });
    if (state.mode === "error")
      return reply({ message: "Service temporarily unavailable." }, 503);
    if (path === "feedback" && method === "POST") {
      const body = route.request().postDataJSON();
      assert.match(body.requestId, /^[a-f0-9-]{36}$/);
      assert.ok(!body.submitterId);
      const created = {
        ...item,
        ...body,
        description: body.description,
        id: "20000000-0000-4000-8000-000000000002",
      };
      state.items.unshift(created);
      return reply({ item: created });
    }
    if (path === "feedback/triage") {
      const body = route.request().postDataJSON();
      assert.equal(
        body.expectedRevision,
        state.items.find((x) => x.id === body.id).revision,
      );
      const updated = {
        ...state.items.find((x) => x.id === body.id),
        ...body,
        revision: body.expectedRevision + 1,
        assigneeName: body.assigneeId ? user.displayName : null,
      };
      state.items = state.items.map((x) => (x.id === body.id ? updated : x));
      return reply({ item: updated });
    }
    if (path === "feedback") {
      let items = state.mode === "empty" ? [] : state.items;
      if (url.searchParams.get("status"))
        items = items.filter(
          (x) => x.status === url.searchParams.get("status"),
        );
      if (url.searchParams.get("search"))
        items = items.filter((x) =>
          x.title
            .toLowerCase()
            .includes(url.searchParams.get("search").toLowerCase()),
        );
      return reply({
        items,
        nextCursor: url.searchParams.has("cursor") ? null : "fixture-page-2",
      });
    }
    if (path === "audit")
      return reply({
        items:
          state.mode === "empty"
            ? []
            : [
                {
                  id: "30000000-0000-4000-8000-000000000001",
                  occurredAt: now,
                  actorId: user.id,
                  actorName: user.displayName,
                  action: "feedback.triaged",
                  targetId: item.id,
                  source: "administration",
                  details: {
                    before: { status: "new" },
                    after: { status: "resolved" },
                  },
                },
              ],
        nextCursor: null,
      });
    if (path === "imports")
      return reply({
        items:
          state.mode === "empty"
            ? []
            : [
                {
                  id: "40000000-0000-4000-8000-000000000001",
                  kind: "document",
                  sourceName: "Singapore delivery guidance.pdf",
                  sourceType: "application/pdf",
                  status: "failed",
                  provenance: "client-reported",
                  submitterId: user.id,
                  submitterName: user.displayName,
                  createdAt: now,
                  updatedAt: now,
                  attempt: 2,
                  revision: 3,
                  warningCount: 1,
                  errorCode: "SOURCE_UNREADABLE",
                  summary:
                    "Source could not be read. Select the original document again.",
                },
              ],
        nextCursor: null,
      });
    if (path === "system-health") return reply({ ...health, checks: [...health.checks, emailHealth(state.emailHealth)] });
    if (path === "system-information") return reply(info);
    return reply({ message: "Unexpected request" }, 404);
  });
  return state;
}

async function selectRecord(record) {
  const paint = () => record.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, shadow: style.boxShadow,
      geometry: [style.padding, style.fontSize, style.lineHeight,
        style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
  });
  await expect(record).toHaveAttribute("aria-pressed", "false");
  const before = await paint();
  await record.click();
  await expect(record).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await paint()).background).not.toBe(before.background);
  const selected = await paint();
  assert.match(selected.shadow, /inset/, "Selected administration record has a visible selection marker");
  assert.deepEqual(selected.geometry, before.geometry, "Selection paint keeps record typography, padding and border widths");
}

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine)
    continue;
  const browser = await type.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390])
      for (const theme of ["light", "dark"]) {
        if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width)
          continue;
        if (process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme)
          continue;
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          isMobile: width < 760,
          hasTouch: width < 760,
          reducedMotion: "reduce",
        });
        await installStagingCookies(context, base);
        const state = await mock(context);
        await context.addInitScript(
          (theme) => localStorage.setItem("ecosystem.theme.v1", theme),
          theme,
        );
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.clock.setFixedTime(new Date(now));
        const shot = async (name) => {
          await page.screenshot({
            path: `${out}/${engine}-${width}-${theme}-${name}.png`,
            fullPage: true,
          });
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
            `${name}: horizontal overflow`,
          );
          for (const box of await page
            .locator(
              ".admin-content,.admin-detail,.admin-panel,.admin-feedback-form",
            )
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const r = node.getBoundingClientRect();
                return { x: r.x, right: r.right };
              }),
            ))
            assert.ok(
              box.x >= -1 && box.right <= width + 1,
              `${name}: clipped panel`,
            );
          if (width < 760)
            for (const box of await page
              .locator(
                ".admin-navigation button,.admin-content .ui-button,.admin-feedback-form .ui-button,.eco-administration input,.eco-administration select,.eco-feedback-portal input,.eco-feedback-portal select",
              )
              .evaluateAll((nodes) =>
                nodes
                  .map((node) => node.getBoundingClientRect().height)
                  .filter((height) => height > 0),
              ))
              assert.ok(box >= 43, `${name}: phone touch target`);
        };
        try {
          await page.goto(base);
          await page
            .getByRole("main", { name: "ECOSYSTEM workspace" })
            .waitFor();
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Administration", exact: true })
            .click();
          const nav = page.getByRole("navigation", {
            name: "Administration",
            exact: true,
          });
          await expect(nav).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: /Delivery window needs clarification/,
            }),
          ).toBeVisible();
          await shot("feedback");
          await selectRecord(page
            .getByRole("button", {
              name: /Delivery window needs clarification/,
            }));
          const detail = page.getByRole("complementary", {
            name: "Feedback details",
          });
          await expect(detail).toBeVisible();
          await detail
            .getByLabel("Status", { exact: true })
            .selectOption("resolved");
          await detail
            .getByLabel("Resolution", { exact: true })
            .fill("Port delivery guidance updated and checked.");
          await detail
            .getByLabel("Assigned to", { exact: true })
            .selectOption(user.id);
          await shot("feedback-detail");
          await detail
            .getByRole("button", { name: "Save changes", exact: true })
            .click();
          await expect(page.locator(".admin-notice[role=status]")).toContainText(
            /Feedback updated/i,
          );
          await page
            .getByLabel("Search Feedback", { exact: true })
            .fill("unknown feedback");
          await expect(
            page.getByText("No matching feedback", { exact: true }),
          ).toBeVisible();
          await page
            .locator(".admin-toolbar")
            .getByRole("button", { name: "Clear", exact: true })
            .click();
          await expect(
            page.getByRole("button", {
              name: /Delivery window needs clarification/,
            }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Next", exact: true }).click();
          await expect(page.getByText(/Page 2 ·/)).toBeVisible();
          // A cleared search must not leave a debounce timer that silently resets
          // pagination. Deliberately cross that timer boundary before returning.
          await page.waitForTimeout(350);
          await expect(page.getByText(/Page 2 ·/)).toBeVisible();
          await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
          await page
            .getByRole("button", { name: "Previous", exact: true })
            .click();
          await expect(page.getByText(/Page 1 ·/)).toBeVisible();
          await nav
            .getByRole("button", { name: "Audit Log", exact: true })
            .click();
          await selectRecord(page.getByRole("button", { name: /feedback.triaged/ }));
          await shot("audit");
          await expect(page.locator(".admin-code")).toContainText("resolved");
          await nav
            .getByRole("button", { name: "Import Activity", exact: true })
            .click();
          await selectRecord(page
            .getByRole("button", { name: /Singapore delivery guidance.pdf/ })
          );
          await expect(
            page.getByRole("region", { name: "Parser reports", exact: true }),
          ).toContainText("NO PARSER REPORTS.");
          assert.equal(state.parserRequests.length, 1);
          await shot("imports");
          await expect(
            page.getByRole("complementary", { name: "Import details" }),
          ).toContainText("Browser-reported");
          await expect(
            page.getByRole("button", { name: "Retry", exact: true }),
          ).toHaveCount(0);
          await nav
            .getByRole("button", { name: "System Health", exact: true })
            .click();
          await expect(
            page.getByText("No verified backup evidence is connected."),
          ).toBeVisible();
          await shot("health");
          const email = page.locator('.admin-panel').filter({ has: page.getByRole('heading', { name: 'EMAIL INTAKE', exact: true }) });
          await expect(email.locator('.admin-status')).toHaveText('unknown');
          for (const status of ['unknown', 'degraded', 'healthy']) {
            if (status !== 'unknown') { state.emailHealth = status; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); }
            await expect(email.locator('.admin-status')).toHaveText(status);
            await email.scrollIntoViewIfNeeded(); await shot(`email-health-${status}`);
            const textGaps = await email.locator('.admin-facts').evaluate(list => [...list.querySelectorAll('dt')].map(label => {
              const labelRange = document.createRange(), valueRange = document.createRange();
              labelRange.selectNodeContents(label); valueRange.selectNodeContents(label.nextElementSibling);
              const labelRight = Math.max(...[...labelRange.getClientRects()].map(rect => rect.right));
              const valueLeft = Math.min(...[...valueRange.getClientRects()].map(rect => rect.left));
              return { label: label.textContent, gap: valueLeft - labelRight };
            }));
            assert.ok(textGaps.every(({ gap }) => gap >= 1), `Email intake ${status} labels do not overlap values: ${JSON.stringify(textGaps)}`);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Email intake ${status} does not overflow`);
          }
          await nav
            .getByRole("button", { name: "System Information", exact: true })
            .click();
          await expect(page.getByText("19.3.0", { exact: true })).toBeVisible();
          await page.getByText("Build verification", { exact: true }).click();
          await shot("system");
          state.mode = "error";
          await page
            .getByRole("button", { name: "Refresh", exact: true })
            .click();
          await expect(page.getByRole("alert")).toContainText(
            "Service temporarily unavailable",
          );
          await expect(page.getByText("19.3.0", { exact: true })).toHaveCount(
            0,
          );
          await shot("error");
          state.mode = "empty";
          await nav
            .getByRole("button", { name: "Audit Log", exact: true })
            .click();
          await expect(
            page.getByText("No matching audit events", { exact: true }),
          ).toBeVisible();
          await shot("empty");
          state.mode = "data";
          await page
            .getByRole("button", { name: "Close workspace", exact: true })
            .click();
          await page
            .getByRole("button", {
              name: "Feedback for ecosystem",
              exact: true,
            })
            .click();
          // The portal preserves an unsent draft while users check their shared status.
          const composer = page.getByRole("form", {
            name: "Submit feedback",
            exact: true,
          });
          await expect(composer).toBeVisible();
          await composer
            .getByLabel("Title", { exact: true })
            .fill("Navigation needs clearer labels");
          await composer
            .getByLabel("Details", { exact: true })
            .fill(
              "Please make the enquiry navigation labels clearer for new traders.",
            );
          await composer
            .getByLabel("Page (optional)", { exact: true })
            .selectOption("enquiry");
          const feedbackTabs = page.locator(".eco-feedback-portal > .tabs");
          await feedbackTabs
            .getByRole("button", { name: "My feedback", exact: true })
            .click();
          await expect(
            page.getByRole("region", { name: "My feedback", exact: true }),
          ).toContainText("Delivery window needs clarification");
          await feedbackTabs
            .getByRole("button", { name: "Submit feedback", exact: true })
            .click();
          await expect(
            composer.getByLabel("Title", { exact: true }),
          ).toHaveValue("NAVIGATION NEEDS CLEARER LABELS");
          await shot("submit");
          await composer
            .getByRole("button", { name: "Submit feedback", exact: true })
            .click();
          await expect.poll(() => state.items.length).toBe(2);
          await expect(composer.getByRole("status")).toContainText(
            "Feedback submitted.",
          );
          await expect(
            composer.getByLabel("Title", { exact: true }),
          ).toHaveValue("");
          await feedbackTabs
            .getByRole("button", { name: "My feedback", exact: true })
            .click();
          await expect(
            page.getByRole("region", { name: "My feedback", exact: true }),
          ).toContainText("NAVIGATION NEEDS CLEARER LABELS");
          await shot("my-feedback");
          assert.ok(
            state.requests.some(
              (request) =>
                request.path === "feedback" &&
                request.query.includes("scope=mine"),
            ),
          );
          assert.equal(state.items[0].pagePath, "/enquiry");
          assert.equal(
            state.requests.filter(
              (x) => x.method === "POST" && x.path === "feedback",
            ).length,
            1,
          );
          assert.deepEqual(errors, []);
          reports.push({ engine, width, theme, passed: true });
          console.log(`PASS ${engine} ${width} ${theme}`);
        } catch (error) {
          await shot("failure").catch(() => {});
          await writeFile(
            `${out}/${engine}-${width}-${theme}-failure.html`,
            await page.content(),
          );
          console.log("PAGE ERRORS", errors);
          throw error;
        } finally {
          await context.close();
        }
      }
    if (!process.env.ECO_TEST_WIDTH)
      for (const role of ["trader", "preview", "signed-out"]) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        });
        await installStagingCookies(context, base);
        const state = await mock(
          context,
          role === "trader"
            ? { user: { ...user, isAdmin: false } }
            : role === "preview"
              ? {
                  preview: {
                    role: "trader",
                    officeId: "HONG KONG",
                    officeName: "HONG KONG",
                    readOnly: true,
                  },
                }
              : { signedOut: true },
        );
        const page = await context.newPage();
        try {
          await page.goto(base);
          if (role === "signed-out") {
            await expect(
              page.getByLabel("Email", { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole("button", { name: "Administration", exact: true }),
            ).toHaveCount(0);
          } else {
            await page
              .getByRole("button", { name: "Settings", exact: true })
              .click();
            await expect(
              page.getByRole("button", { name: "Administration", exact: true }),
            ).toHaveCount(0);
            await page
              .getByRole("button", { name: "Close workspace", exact: true })
              .click();
            await page
              .getByRole("button", {
                name: "Feedback for ecosystem",
                exact: true,
              })
              .click();
            const composer = page.getByRole("form", {
              name: "Submit feedback",
            });
            await expect(composer).toBeVisible();
            if (role === "preview")
              await expect(
                composer.getByRole("button", {
                  name: "Submit feedback",
                  exact: true,
                }),
              ).toBeDisabled();
            await page
              .locator(".eco-feedback-portal > .tabs")
              .getByRole("button", { name: "My feedback", exact: true })
              .click();
            await expect(
              page.getByRole("region", { name: "My feedback", exact: true }),
            ).toContainText("Delivery window needs clarification");
            assert.ok(
              state.requests.some(
                (request) =>
                  request.path === "feedback" &&
                  request.query.includes("scope=mine"),
              ),
            );
          }
          assert.ok(
            !state.requests.some((x) =>
              ["audit", "system-health", "system-information"].includes(x.path),
            ),
          );
          assert.deepEqual(state.parserRequests, []);
          reports.push({ engine, role, passed: true });
          console.log(`PASS ${engine} ${role}`);
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
}
await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2));

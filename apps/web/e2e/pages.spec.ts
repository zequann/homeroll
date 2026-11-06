import { expect, test } from "@playwright/test";
import {
  axeViolations,
  connect,
  LENDER,
  OWNER,
  RAHIM,
  resetDemo,
  settled,
  withoutErrors,
} from "./helpers";

// Every page a visitor can open, before and after connecting. The done pages need a real
// receipt, so demo.spec.ts checks them inside the flow.
const PAGES = [
  "/",
  "/owner",
  "/owner?tab=invoices",
  "/owner?tab=workers",
  "/owner?tab=agent-keys",
  "/owner?tab=activity",
  "/worker",
  "/worker/send",
  "/worker/cashout",
  "/lab",
  "/lender",
];

test.beforeAll(async ({ browser }) => {
  // These tests only read pages. On testnet a reset is an RPC burst they do not need.
  if (process.env.E2E_CHAIN === "testnet") return;
  const page = await browser.newPage();
  await resetDemo(page);
  await page.close();
});

for (const path of PAGES) {
  test(`${path} opens with a heading, no errors and no WCAG 2.1 AA violations`, async ({
    page,
  }) => {
    await withoutErrors(page, async () => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1").first()).toBeAttached();
      await expect(page.getByRole("main")).toBeVisible();
    });
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("the owner console passes the same checks once connected, on every tab", async ({ page }) => {
  await page.goto("/owner");
  await connect(page, OWNER);
  for (const tab of ["pay-lines", "invoices", "workers", "agent-keys", "activity"]) {
    await withoutErrors(page, async () => {
      await page.goto(`/owner?tab=${tab}`);
      await expect(page.getByRole("main")).toBeVisible();
    });
    expect(await axeViolations(page), tab).toEqual([]);
  }
});

test("the toolbar reaches every page", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Pages" });
  for (const [label, path] of [
    ["Owner", "/owner"],
    ["Worker", "/worker"],
    ["Lab", "/lab"],
    ["Lender", "/lender"],
  ] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(path);
    await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("link", { name: "Homeroll" }).click();
  await expect(page).toHaveURL("/");
  for (const label of ["Owner console", "Worker app", "Attack lab", "Lender"]) {
    await expect(
      page.getByRole("navigation", { name: "Surfaces" }).getByRole("link", { name: label }),
    ).toBeVisible();
  }
});

test("each wallet sees only its own pages, and switching wallet takes you there", async ({
  page,
}) => {
  const links = page.getByRole("navigation", { name: "Pages" }).getByRole("link");
  await page.goto("/lender");
  await expect(links).toHaveText(["Owner", "Worker", "Lab", "Lender"]);

  await connect(page, LENDER);
  await expect(links).toHaveText(["Lender"]);
  await page.goto("/owner");
  await expect(page).toHaveURL("/lender");

  await connect(page, OWNER);
  await expect(page).toHaveURL("/owner");
  await expect(links).toHaveText(["Owner", "Lab"]);
  await page.goto("/lab");
  await expect(page).toHaveURL("/lab");
  await page.goto("/worker/send");
  await expect(page).toHaveURL("/owner");

  await connect(page, RAHIM);
  await expect(page).toHaveURL("/worker");
  await expect(links).toHaveText(["Worker"]);
  await page.goto("/lender");
  await expect(page).toHaveURL("/worker");
  // The owner console no longer carries Rahim's phone
  await connect(page, OWNER);
  await expect(page.getByRole("complementary", { name: "Rahim's phone" })).toHaveCount(0);
});

test("the wallet sheet opens, closes, connects and disconnects", async ({ page }) => {
  await page.goto("/lab");
  const wallet = page.locator('header button[aria-haspopup="dialog"]');
  await wallet.click();
  const sheet = page.getByRole("dialog", { name: "Connect wallet" });
  await expect(sheet).toBeVisible();
  await settled(sheet);
  expect(await axeViolations(page)).toEqual([]);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // Opened from a page's own Connect wallet button, the sheet highlights that account
  await page.goto("/owner");
  await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).first().click();
  await expect(sheet).toBeVisible();
  await settled(sheet);
  expect(await axeViolations(page), "sheet with a highlighted account").toEqual([]);
  await sheet.getByRole("button", { name: "Close" }).click();

  await connect(page, OWNER);
  await expect(wallet).toContainText("Perabot Jaya");
  await wallet.click();
  await sheet.getByRole("button", { name: "Disconnect" }).click();
  await expect(wallet).toHaveText(/Connect wallet/);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const path of ["/worker", "/worker/send", "/worker/cashout", "/"]) {
    test(`${path} fits the screen with no sideways scroll`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});

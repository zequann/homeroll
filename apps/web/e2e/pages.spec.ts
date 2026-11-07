import { expect, test } from "@playwright/test";
import { axeViolations, resetDemo, withoutErrors } from "./helpers";

// Every page a visitor can open. There is no wallet step: each page signs as its own shared demo
// account. The done pages need a real receipt, so demo.spec.ts checks them inside the flow.
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
  await page.getByRole("link", { name: "Start the demo" }).click();
  await expect(page).toHaveURL("/owner");
});

test("no page asks for a wallet or a sign-in, and Reset demo is in the toolbar once", async ({
  page,
}) => {
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.getByText(/Connect wallet|Sign in/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset demo" })).toHaveCount(1);
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Reset demo" }),
    ).toBeVisible();
  }
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

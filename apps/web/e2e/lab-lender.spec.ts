import { expect, test } from "@playwright/test";
import { connect, LENDER, resetDemo, withoutErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await resetDemo(page);
  await page.close();
});

const ATTACKS = [
  ["01", "ERR_PAYEE_NOT_ACTIVE"],
  ["02", "ERR_ABOVE_WAGE_CAP"],
  ["03", "ERR_INVOICE_ALREADY_REGISTERED"],
  ["04", "ERR_ADVANCE_ABOVE_CAP"],
  ["05", "DepositWithFunctionCall"],
  ["06", "R17:bad-signature"],
] as const;

test("each of the six attacks is refused and moves no money", async ({ page }) => {
  await withoutErrors(page, async () => {
    await page.goto("/lab");
    for (const [id, code] of ATTACKS) {
      const card = page.locator(`article[aria-labelledby="attack-${id}"]`);
      await card.getByRole("button", { name: "Run attack" }).click();
      await expect(card).toContainText("said no");
      await expect(card).toContainText(code);
      await expect(card).toContainText("No money moved.");
    }
  });
});

test("a private deposit reaches the pool from the lender's pseudonymous account", async ({
  page,
}) => {
  await withoutErrors(page, async () => {
    await page.goto("/lender");
    await connect(page, LENDER);
    await expect(page.getByText("l-4f9t2c.", { exact: false }).first()).toBeVisible();

    const amount = page.getByRole("textbox", { name: "USDT" });
    await amount.fill("1000");
    await expect(page.getByText("≈ 999.00 USDC into the pool")).toBeVisible();
    for (const badge of ["Sample quote", "Mock routing", "Mock delivery"]) {
      await expect(page.getByText(badge, { exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Deposit privately" }).click();
    await expect(page.getByRole("status")).toContainText("Deposited 999.00 USDC.");
    await expect(page.getByRole("status")).toContainText("Your name is not on-chain.");

    // R16: the mock solver delivers at most 50,000 USDC per deposit
    await amount.fill("60000");
    await expect(page.getByText("≈ 59,940.00 USDC into the pool")).toBeVisible();
    await page.getByRole("button", { name: "Deposit privately" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "at most 50,000.00 USDC per deposit" }),
    ).toBeVisible();

    // Another asset and chain prices in its own units
    await page.getByRole("combobox", { name: "From" }).selectOption({ label: "ETH on Ethereum" });
    await page.getByRole("textbox", { name: "ETH" }).fill("1");
    await expect(page.getByText("≈ 2,497.50 USDC into the pool")).toBeVisible();
  });
});

test("the mock 1Click routes answer in 1Click's shapes", async ({ request }) => {
  const status = await request.get("/api/mock/1click/v0/status?depositAddress=mock:none");
  expect(status.status()).toBe(404);
  expect(await status.json()).toMatchObject({ mock: true, reason: "unknown-quote" });
  const quote = await request.post("/api/mock/1click/v0/quote", { data: { nope: true } });
  expect(quote.status()).toBe(400);
  const submit = await request.post("/api/mock/1click/v0/submit-intent", {
    data: { type: "swap_transfer", signedData: { standard: "nep413" } },
  });
  expect(submit.status()).toBe(400);
  expect(await submit.json()).toMatchObject({ mock: true, reason: "unknown-intent" });
  const agent = await request.post("/api/agents/payroll");
  expect(agent.status()).toBe(401);
});

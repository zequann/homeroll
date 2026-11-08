import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { axeViolations, resetDemo, withoutErrors } from "./helpers";

// SPEC §14 E2E: invoice → advance → payroll → send home → settle, then Reset demo and the
// same path again. One page for the whole file, because the steps build on each other.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  // A context of our own: axe opens a helper page in it
  context = await browser.newContext();
  page = await context.newPage();
});
test.afterAll(async () => {
  await context.close();
});

const invoice = (number: string) =>
  page.getByRole("listitem").filter({ has: page.getByText(number, { exact: true }) });
const ownerTab = async (name: string) => {
  await page
    .getByRole("navigation", { name: "Owner sections" })
    .getByRole("link", { name })
    .click();
};

async function happyPath() {
  await withoutErrors(page, async () => {
    // Start: RM18,400 against RM78,000 of wages
    // No wallet step: the owner page signs as the shared demo employer
    await page.goto("/owner");
    await expect(page.getByText(/Short by RM64,600\.00\./)).toBeVisible();

    // The Grade C invoice alone still leaves payroll short (a demo moment)
    await ownerTab("Invoices");
    await invoice("INV-2026-1047").getByRole("button", { name: "Check with agent" }).click();
    await expect(invoice("INV-2026-1047")).toContainText("Grade C");
    await invoice("INV-2026-1047").getByRole("button", { name: "Take advance" }).click();
    await expect(page.getByText(/Short by RM39,400\.00\./)).toBeVisible();

    // The invoice with no MyInvois record is declined
    await invoice("INV-2026-1050").getByRole("button", { name: "Check with agent" }).click();
    await expect(invoice("INV-2026-1050")).toContainText("Grade D · declined");

    // Grade A: RM120,000 advance, then payroll fits
    await invoice("INV-2026-1043").getByRole("button", { name: "Check with agent" }).click();
    await expect(invoice("INV-2026-1043")).toContainText("Grade A");
    await expect(invoice("INV-2026-1043")).toContainText("RM120,000.00");
    await invoice("INV-2026-1043").getByRole("button", { name: "Take advance" }).click();
    await expect(page.getByText("RM85,600.00 left after this run.")).toBeVisible();

    // Run payroll: the contract checks the run, the owner approves the payout intent, it pays
    await page.getByRole("button", { name: "Run payroll" }).click();
    await expect(page.getByText("October paid · 40 workers · RM78,000.00")).toBeVisible();
    const payout = page.getByRole("region", { name: "Payout" });
    await expect(payout).toContainText("Confidential layer: simulated");
    await expect(payout).toContainText("Paid · 40 transfer intents · RM78,000.00");
    // One payout transaction per pay_run batch (40 lines, 20 per call)
    await expect(payout.getByRole("listitem")).toHaveCount(2);
    // The deployed page shows what happened, not how production would differ
    await expect(payout).not.toContainText("In production");

    await ownerTab("Pay lines");
    await expect(page.getByRole("row", { name: /Rahim Uddin/ })).toContainText("Paid");
    await ownerTab("Activity");
    const activity = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Method" }),
    });
    await expect(activity).toContainText("pay_run");
    // Each row names the button that started it
    for (const button of ["Run payroll", "Take advance", "Check with agent"]) {
      await expect(activity.getByRole("cell", { name: button, exact: true }).first()).toBeVisible();
    }
    // On testnet every transaction links to NearBlocks; the fake chain's hashes are made up
    if (process.env.E2E_CHAIN === "testnet") {
      await expect(activity.getByRole("link", { name: /on NearBlocks/ }).first()).toHaveAttribute(
        "href",
        /^https:\/\/testnet\.nearblocks\.io\/txns\//,
      );
    }
    await ownerTab("Agent keys");
    await expect(page.getByRole("main")).toContainText("submit_run");

    // Rahim's phone shows his wage
    // Rahim's phone needs no sign-in: the worker page signs as his demo account
    await page.goto("/worker");
    await expect(page.getByText("RM1,950.00").first()).toBeAttached();

    // Send home RM800 through the relayer to the mock partner
    await page.getByRole("link", { name: "Send home" }).click();
    await expect(page).toHaveURL("/worker/send");
    await expect(page.getByText(/Amma receives ৳/)).toBeVisible();
    await page.getByRole("button", { name: "Send home" }).click();
    await expect(page).toHaveURL(/\/worker\/send\/done/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await axeViolations(page), "send done page").toEqual([]);
    await page.getByRole("link", { name: "Done" }).click();
    await expect(page).toHaveURL("/worker");

    // Cash out RM200 to TNG through the mock off-ramp
    await page.getByRole("link", { name: "Cash out" }).click();
    await expect(page).toHaveURL("/worker/cashout");
    await page.getByRole("radio", { name: /TNG eWallet/ }).check();
    await page.getByRole("button", { name: "Cash out" }).click();
    await expect(page).toHaveURL(/\/worker\/cashout\/done/);
    await expect(page.getByText("DuitNow reference")).toBeVisible();
    expect(await axeViolations(page), "cash out done page").toEqual([]);
    await page.getByRole("link", { name: "Done" }).click();
    await expect(page).toHaveURL("/worker");

    // The buyer pays: the pool is repaid, the rest reaches the treasury
    await page.goto("/owner?tab=invoices");
    await invoice("INV-2026-1043").getByRole("button", { name: "Buyer paid" }).click();
    await expect(invoice("INV-2026-1043")).toContainText(
      "Pool repaid RM121,800.00, you received RM28,200.00.",
    );
    await expect(invoice("INV-2026-1043")).toContainText("Settled");
  });
}

test("the demo runs end to end", async () => {
  await resetDemo(page);
  await happyPath();
});

test("after Reset demo, the same path runs again", async () => {
  await resetDemo(page);
  await page.goto("/owner");
  await expect(page.getByText(/Short by RM64,600\.00\./)).toBeVisible();
  await happyPath();
});

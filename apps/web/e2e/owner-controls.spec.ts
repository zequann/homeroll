import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { connect, OWNER, resetDemo, withoutErrors } from "./helpers";

// Every owner button outside the happy path: reserve, cancel, remove a worker mid-run, finish
// paying, add back, pay a missed worker, add a payee (SPEC §9.1, README "Try it" step 7).
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  // A context of our own: axe opens a helper page in it
  context = await browser.newContext();
  page = await context.newPage();
  await resetDemo(page);
  await page.goto("/owner");
  await connect(page, OWNER);
});
test.afterAll(async () => {
  await context.close();
});

const invoice = (number: string) =>
  page.getByRole("listitem").filter({ has: page.getByText(number, { exact: true }) });
const ownerTab = (name: string) =>
  page.getByRole("navigation", { name: "Owner sections" }).getByRole("link", { name }).click();
const worker = (name: string) => page.getByRole("row", { name: new RegExp(name) });

test("Take advance on the shortfall line opens the invoices", async () => {
  await withoutErrors(page, async () => {
    await expect(page.getByText(/Short by RM64,600\./)).toBeVisible();
    await page.getByRole("button", { name: "Take advance" }).click();
    await expect(page).toHaveURL(/tab=invoices/);
  });
});

test("Run payroll while short is refused by the contract, and nothing is reserved", async () => {
  await withoutErrors(page, async () => {
    await page.getByRole("button", { name: "Run payroll" }).click();
    await expect(page.getByText("ERR_BELOW_BUFFER")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reserve only" })).toBeHidden();
  });
});

test("Reserve only, then Cancel run, puts the money back", async () => {
  await withoutErrors(page, async () => {
    await invoice("INV-2026-1043").getByRole("button", { name: "Check with agent" }).click();
    await invoice("INV-2026-1043").getByRole("button", { name: "Take advance" }).click();
    await expect(page.getByText("RM60,400 left after this run.")).toBeVisible();

    await page.getByRole("button", { name: "Reserve only" }).click();
    await expect(page.getByText("40 pay lines reserved. Nothing is paid yet.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByText("RM60,400 left after this run.")).toBeVisible();
  });
});

test("a worker removed from a reserved run is skipped, and Add back starts the hold", async () => {
  await withoutErrors(page, async () => {
    await page.getByRole("button", { name: "Reserve only" }).click();
    await expect(page.getByText("40 pay lines reserved. Nothing is paid yet.")).toBeVisible();

    await ownerTab("Workers");
    await worker("Sujan Tamang").getByRole("button", { name: "Remove" }).click();
    await expect(worker("Sujan Tamang")).toContainText("Removed");

    await page.getByRole("button", { name: "Finish paying" }).click();
    await expect(page.getByText(/October paid · .* · 1 not paid/)).toBeVisible();

    await worker("Sujan Tamang").getByRole("button", { name: "Add back" }).click();
    await expect(worker("Sujan Tamang")).toContainText("48-hour hold");
  });
});

test("Pay missed worker is refused while the 48-hour hold runs (R3)", async () => {
  await withoutErrors(page, async () => {
    await ownerTab("Pay lines");
    await worker("Sujan Tamang").getByRole("button", { name: "Pay missed worker" }).click();
    await expect(worker("Sujan Tamang")).toContainText("ERR_PAYEE_NOT_ACTIVE");
  });
});

test("Add payee checks its fields, then adds a payee on hold", async () => {
  await withoutErrors(page, async () => {
    await ownerTab("Workers");
    await page.getByRole("button", { name: "Add payee" }).click();
    // Next adds its own empty route announcer with role="alert", so match the message text
    await expect(page.getByRole("alert").filter({ hasText: /\w/ })).toBeVisible();

    // 40 is the payee limit (R15), so one goes first
    await worker("Kyaw Zin").getByRole("button", { name: "Remove" }).click();
    await expect(worker("Kyaw Zin")).toContainText("Removed");
    await page.getByRole("textbox", { name: "Made-up name" }).fill("Test Payee");
    await page.getByRole("textbox", { name: "Role" }).fill("Packing");
    await page.getByRole("textbox", { name: "Wage cap (RM)" }).fill("2500");
    await page.getByRole("button", { name: "Add payee" }).click();
    await expect(worker("Test Payee")).toContainText("48-hour hold");
    await expect(worker("Test Payee")).toContainText(/w-[a-z0-9]{6}\./);
  });
});

import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

export const OWNER = "Perabot Jaya Sdn Bhd";
export const RAHIM = "Rahim Uddin";
export const LENDER = "Seri Capital";

/** Opens the toolbar wallet sheet and connects one demo account. */
export async function connect(page: Page, name: string): Promise<void> {
  await page.locator('header button[aria-haspopup="dialog"]').click();
  const sheet = page.getByRole("dialog", { name: "Connect wallet" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: new RegExp(name) }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('header button[aria-haspopup="dialog"]')).not.toHaveText(
    /Connect wallet/,
  );
}

/** Reset demo needs two presses within four seconds (SPEC §9.6). */
export async function resetDemo(page: Page): Promise<void> {
  await page.goto("/lab");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Press again to reset" }).click();
  await expect(page.getByRole("button", { name: "Reset demo" })).toBeEnabled();
}

/** Disconnects whichever wallet is connected, if any. */
export async function disconnect(page: Page): Promise<void> {
  const wallet = page.locator('header button[aria-haspopup="dialog"]');
  if (/Connect wallet/.test(await wallet.innerText())) return;
  await wallet.click();
  await page
    .getByRole("dialog", { name: "Connect wallet" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(wallet).toHaveText(/Connect wallet/);
}

/** The worker app's mock sign-in: the code is shown on screen (SPEC §9.2). */
export async function signInWorker(page: Page): Promise<void> {
  // Another wallet would be sent to its own page, so sign in from no wallet at all
  await disconnect(page);
  await page.goto("/worker");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByRole("textbox", { name: "Code" }).fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Send home" })).toBeVisible();
}

/** Fails on any page error or console error while `run` drives the page. */
export async function withoutErrors(page: Page, run: () => Promise<void>): Promise<void> {
  const errors: string[] = [];
  const onPageError = (e: Error) => errors.push(`pageerror: ${e.message}`);
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  try {
    await run();
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
  expect(errors).toEqual([]);
}

/** WCAG 2.1 A and AA checks with axe. Returns every violation; callers assert on them. */
export async function axeViolations(page: Page) {
  // Scan the final colours, not a frame of an entrance fade
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
  }));
}

/** Waits until a fading element and every ancestor are fully opaque, so axe sees final colours. */
export async function settled(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((el) => {
        let opacity = 1;
        for (let n: Element | null = el; n; n = n.parentElement) {
          opacity *= Number(getComputedStyle(n).opacity);
        }
        return opacity;
      }),
    )
    .toBe(1);
  // The scrim behind the sheet fades in 150 ms alongside it
  await locator.page().waitForTimeout(200);
}

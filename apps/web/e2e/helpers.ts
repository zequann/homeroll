import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Reset demo, in the toolbar of every page, needs two presses within four seconds (SPEC §9.6). */
export async function resetDemo(page: Page): Promise<void> {
  await page.goto("/lab");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Press again to reset" }).click();
  await expect(page.getByRole("button", { name: "Reset demo" })).toBeEnabled();
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

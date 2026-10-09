import { test, expect } from "@playwright/test";
for (const theme of ["light", "dark"])
  test(`reviewed ${theme} schematic symbol gallery`, async ({ page }) => {
    await page.goto("/?symbol-gallery");
    if (theme === "dark")
      await page.getByRole("button", { name: "Theme: light" }).click();
    await expect(page.locator(".symbol-gallery svg")).toHaveCount(27);
    await expect(page.locator(".symbol-gallery-grid")).toHaveScreenshot(
      `symbols-${theme}.png`,
      { animations: "disabled" },
    );
  });

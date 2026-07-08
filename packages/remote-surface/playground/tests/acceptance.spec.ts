import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __remoteSurfacePlayground: {
      setOverlayFieldValue(selector: string, value: string): boolean;
    };
  }
}

async function runAcceptanceJourney(page: Page): Promise<void> {
  await expect(page.locator("#empty-state")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-testid="check-streamStable"]')).toHaveAttribute("data-state", "pass", { timeout: 15_000 });

  await page.getByRole("button", { name: "Tap email" }).click();
  await expect(page.locator('[data-testid="check-oneTap"]')).toHaveAttribute("data-state", "pass");
  await expect(page.locator('[data-testid="check-keyboardStable"]')).toHaveAttribute("data-state", "pass");

  await page.locator("#stage").click({ button: "right" });
  await expect(page.locator('[data-testid="check-noLongPressSave"]')).toHaveAttribute("data-state", "pass");

  await page.getByRole("button", { name: "Email", exact: true }).click();
  await expect(page.locator('[data-testid="check-emailEntry"]')).toHaveAttribute("data-state", "pass");

  await page.getByRole("button", { name: "Password", exact: true }).click();
  await expect(page.locator('[data-testid="check-passwordEntry"]')).toHaveAttribute("data-state", "pass");

  await page.getByRole("button", { name: "2FA", exact: true }).click();
  await expect(page.locator('[data-testid="check-otpEntry"]')).toHaveAttribute("data-state", "pass");

  await page.getByRole("button", { name: "Backspace + enter" }).click();
  await expect(page.locator('[data-testid="check-backspaceEnter"]')).toHaveAttribute("data-state", "pass");

  await page.getByRole("button", { name: "Keyboard inset" }).click();
  await expect(page.locator('[data-testid="check-viewportSurvivesKeyboard"]')).toHaveAttribute("data-state", "pass");
}

test("streams the probe and measures the direct Android acceptance subset", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Connected")).toBeVisible();
  await runAcceptanceJourney(page);

  await expect(page.locator('[data-testid="input-log"]')).toContainText("package:Input.insertText");
  await expect(page.locator('[data-testid="input-log"]')).toContainText('"t":package:Input.insertText');
  await expect(page.locator("#geometry-metrics")).toContainText("scale");
  await expect(page.locator("#pointer-metrics")).toContainText("error");

  await page.reload();
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.locator('[data-testid="check-streamStable"]')).toHaveAttribute("data-state", "pass", { timeout: 15_000 });
});

test("streams the probe and measures the form-overlay Android acceptance subset", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Connected")).toBeVisible();
  await page.getByLabel("Form overlay").check();
  await expect(page.locator('[data-testid="overlay-field-email"]')).toBeVisible({ timeout: 15_000 });

  await runAcceptanceJourney(page);
  await expect(page.locator('[data-testid="input-log"]')).toContainText('"t":overlay-commit');

  await page.evaluate(() => {
    window.__remoteSurfacePlayground.setOverlayFieldValue("#password", "correct mare");
  });
  await expect(page.locator('[data-testid="input-log"]')).toContainText("password=correct mare");

  await page.evaluate(() => {
    window.__remoteSurfacePlayground.setOverlayFieldValue("#email", "pasted@example.com");
  });
  await expect(page.locator('[data-testid="input-log"]')).toContainText("email=pasted@example.com");
});

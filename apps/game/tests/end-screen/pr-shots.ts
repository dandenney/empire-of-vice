// PR screenshots (#136): written only when PR_SCREENSHOTS is set, next to the
// spec in pr-screenshots/. The baselines (toHaveScreenshot) are separate.

import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";

export async function prShot(target: Page | Locator, dir: string, name: string): Promise<void> {
  if (!process.env["PR_SCREENSHOTS"]) return;
  // Let the toasts finish sliding in.
  await ("page" in target ? target.page() : target).waitForTimeout(400);
  await target.screenshot({ path: join(dir, "pr-screenshots", `${name}.png`) });
}

import { launchPersistentContext, PROFILE_DIR } from "./browser-profile.ts";
import { PLATFORMS } from "./platform-probes.ts";

function fmtLine(label: string, status: string): string {
  let icon: string;
  if (status === "ok") {
    icon = "✓";
  } else if (status === "pending") {
    icon = "·";
  } else {
    icon = "?";
  }
  return `  ${icon} ${label.padEnd(12)} ${status}`;
}

export interface BootstrapBrowserOptions {
  platforms?: readonly string[];
}

export async function bootstrapBrowser({
  platforms = Object.keys(PLATFORMS),
}: BootstrapBrowserOptions = {}): Promise<Record<string, string>> {
  console.log(`Opening browser with persistent profile at ${PROFILE_DIR}`);
  console.log("Log into each tab, then close the browser when done.\n");

  const context = await launchPersistentContext({ headless: false });

  const targets: Array<{ key: string; platform: (typeof PLATFORMS)[string] }> = [];
  for (const key of platforms) {
    const p = PLATFORMS[key];
    if (!p) {
      continue;
    }
    const page = await context.newPage();
    await page.goto(p.bootstrapUrl, { waitUntil: "domcontentloaded" }).catch((): undefined => undefined);
    targets.push({ key, platform: p });
  }

  const status: Record<string, string> = Object.fromEntries(platforms.map((k) => [k, "pending"]));
  const poll = setInterval(async () => {
    for (const { key, platform } of targets) {
      if (status[key] === "ok") {
        continue;
      }
      try {
        const probe = await context.newPage();
        await probe.goto(platform.probeUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        const ok = await platform.isLoggedIn(probe, context);
        await probe.close().catch((): undefined => undefined);
        status[key] = ok ? "ok" : "pending";
      } catch {
        /* keep pending */
      }
    }
    console.log("\nStatus:");
    for (const k of platforms) {
      const p = PLATFORMS[k];
      if (p) {
        console.log(fmtLine(p.label, status[k] ?? "pending"));
      }
    }
    if (platforms.every((k) => status[k] === "ok")) {
      console.log("\nAll platforms logged in. You can close the browser.");
    }
  }, 20_000);

  await new Promise<void>((resolve) => context.once("close", () => resolve()));
  clearInterval(poll);

  console.log("\nBrowser closed. Final status:");
  for (const k of platforms) {
    const p = PLATFORMS[k];
    if (p) {
      console.log(fmtLine(p.label, status[k] ?? "pending"));
    }
  }
  console.log(`\nProfile saved at ${PROFILE_DIR}`);
  return status;
}

export async function probeBrowser({
  platforms = Object.keys(PLATFORMS),
}: BootstrapBrowserOptions = {}): Promise<Record<string, string>> {
  console.log(`Probing logged-in state headlessly against profile at ${PROFILE_DIR}\n`);
  const context = await launchPersistentContext({ headless: true });
  const status: Record<string, string> = {};
  for (const key of platforms) {
    const platform = PLATFORMS[key];
    if (!platform) {
      continue;
    }
    const page = await context.newPage();
    try {
      await page.goto(platform.probeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      status[key] = (await platform.isLoggedIn(page, context)) ? "ok" : "logged_out";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status[key] = `error: ${message.split("\n")[0]}`;
    } finally {
      await page.close().catch((): undefined => undefined);
    }
    console.log(fmtLine(platform.label, status[key] ?? "pending"));
  }
  await context.close();
  return status;
}

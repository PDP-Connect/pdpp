#!/usr/bin/env node
import { spawn } from "node:child_process";
import { bootstrapBrowser, probeBrowser } from "../src/bootstrap.ts";
import {
  daemonStatus,
  paths,
  startDaemon,
  stopDaemon,
} from "../src/browser-daemon.ts";

const [, , area, action, ...rest] = process.argv;

function printUsage(): void {
  console.error("Usage:");
  console.error("  pdpp-connectors browser bootstrap [platform...]");
  console.error("  pdpp-connectors browser probe     [platform...]");
  console.error("  pdpp-connectors browser start     [--headed] [--xvfb]");
  console.error("  pdpp-connectors browser stop");
  console.error("  pdpp-connectors browser status");
  console.error("  pdpp-connectors browser restart   [--headed] [--xvfb]");
  console.error("  pdpp-connectors browser logs");
  console.error("");
  console.error(
    "  --headed : render a real browser window instead of headless"
  );
  console.error(
    "  --xvfb   : wrap headful launch in a virtual X display (unattended headful)"
  );
  console.error(
    "             — required for Akamai-protected sites like Chase that detect headless Chromium."
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: simple if-else dispatch over CLI subcommands; decomposing is worse for readability here
async function main(): Promise<void> {
  if (area === "browser" && action === "bootstrap") {
    const status = await bootstrapBrowser(
      rest.length ? { platforms: rest } : {}
    );
    process.exit(Object.values(status).every((s) => s === "ok") ? 0 : 1);
  }
  if (area === "browser" && action === "probe") {
    const status = await probeBrowser(rest.length ? { platforms: rest } : {});
    process.exit(Object.values(status).every((s) => s === "ok") ? 0 : 1);
  }
  if (area === "browser" && action === "start") {
    const xvfb = rest.includes("--xvfb");
    // --xvfb implies --headed (running headless under Xvfb defeats the point)
    const headless = !(rest.includes("--headed") || xvfb);
    const info = await startDaemon({ headless, xvfb });
    console.log(
      `browser daemon running pid=${info.pid} ws=${info.wsEndpoint} xvfb=${xvfb}`
    );
    process.exit(0);
  }
  if (area === "browser" && action === "stop") {
    const result = await stopDaemon();
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  if (area === "browser" && action === "status") {
    const s = await daemonStatus();
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.running ? 0 : 1);
  }
  if (area === "browser" && action === "restart") {
    await stopDaemon();
    const xvfb = rest.includes("--xvfb");
    const headless = !(rest.includes("--headed") || xvfb);
    const info = await startDaemon({ headless, xvfb });
    console.log(
      `browser daemon running pid=${info.pid} ws=${info.wsEndpoint} xvfb=${xvfb}`
    );
    process.exit(0);
  }
  if (area === "browser" && action === "logs") {
    const child = spawn("tail", ["-f", paths.LOG_PATH], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  printUsage();
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

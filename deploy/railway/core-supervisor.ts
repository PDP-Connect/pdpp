#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

import { prepareFirstBoot } from "./core-first-boot.ts";

const children = new Map<string, ChildProcess>();
let shuttingDown = false;
let exitCode = 0;

const DEFAULT_XVFB_DISPLAY = ":99";
const DEFAULT_XVFB_SCREEN = "1920x1080x24";
const XVFB_START_TIMEOUT_MS = 10_000;
const DISPLAY_RE = /^:\d+$/u;
const SCREEN_RE = /^\d+x\d+x(?:8|16|24|32)$/u;

function configuredDisplay(): string {
  const display = process.env.PDPP_XVFB_DISPLAY?.trim() || DEFAULT_XVFB_DISPLAY;
  if (!DISPLAY_RE.test(display)) {
    throw new Error(`PDPP_XVFB_DISPLAY must be an X display such as :99, got ${display}`);
  }
  return display;
}

function configuredScreen(): string {
  const screen = process.env.PDPP_XVFB_SCREEN?.trim() || DEFAULT_XVFB_SCREEN;
  if (!SCREEN_RE.test(screen)) {
    throw new Error(`PDPP_XVFB_SCREEN must be WIDTHxHEIGHTxDEPTH, got ${screen}`);
  }
  return screen;
}

function displaySocket(display: string): string {
  return `/tmp/.X11-unix/X${display.slice(1)}`;
}

function start(name: string, command: string, args: string[], options: SpawnOptions) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (code !== 0 || signal) {
      exitCode = code ?? 1;
    }
    if (shuttingDown) {
      if (children.size === 0) {
        process.exit(exitCode);
      }
      return;
    }
    shuttingDown = true;
    for (const [otherName, other] of children.entries()) {
      console.error(`[core] ${name} exited; stopping ${otherName}`);
      other.kill("SIGTERM");
    }
    if (children.size === 0) {
      process.exit(exitCode);
    }
  });
  return child;
}

async function waitForManagedDisplay(child: ChildProcess, display: string): Promise<void> {
  const socket = displaySocket(display);
  const deadline = Date.now() + XVFB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Xvfb exited before ${display} became ready`);
    }
    if (existsSync(socket)) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: this is a bounded readiness poll for the supervisor-owned X socket
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Xvfb did not create ${socket} within ${String(XVFB_START_TIMEOUT_MS)}ms`);
}

async function startManagedDisplay(): Promise<string | undefined> {
  // This is the one deployment-level escape hatch: headless mode does not
  // need a virtual display and therefore keeps the advanced minimal path
  // free of an Xvfb child.
  if (process.env.PDPP_BROWSER_HEADLESS === "1") {
    return;
  }
  const display = configuredDisplay();
  const xvfb = start("xvfb", "Xvfb", [display, "-screen", "0", configuredScreen(), "-nolisten", "tcp", "-ac"], {
    cwd: "/app",
    env: process.env,
  });
  await waitForManagedDisplay(xvfb, display);
  console.log(`[core] managed Xvfb ready on ${display}`);
  return display;
}

function stop(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children.values()) {
    child.kill(signal);
  }
  if (children.size === 0) {
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function main(): Promise<void> {
  // Standalone-image credential bootstrap: generate (first boot) or load
  // (subsequent boots) an owner password when the platform did not supply one,
  // so owner data is gated by default. See ./core-first-boot.ts.
  const firstBoot = prepareFirstBoot();
  const display = await startManagedDisplay();
  const childBaseEnv = { ...process.env };
  if (display) {
    childBaseEnv.DISPLAY = display;
  } else {
    childBaseEnv.DISPLAY = undefined;
  }

  const referenceEnv = {
    ...childBaseEnv,
    ...firstBoot.env,
    AS_PORT: "7662",
    RS_PORT: "7663",
    PDPP_AS_URL: "http://127.0.0.1:7662",
    PDPP_RS_URL: "http://127.0.0.1:7663",
  };

  const consoleEnv = {
    ...childBaseEnv,
    ...firstBoot.env,
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
    PORT: process.env.PORT || "3000",
    PDPP_AS_URL: "http://127.0.0.1:7662",
    PDPP_RS_URL: "http://127.0.0.1:7663",
  };

  for (const line of firstBoot.bannerLines) {
    console.log(line);
  }

  if (process.env.PDPP_CORE_RUNTIME_ORACLE === "1") {
    start(
      "runtime-oracle",
      process.execPath,
      ["--import", "tsx", "/app/scripts/core-headed-patchright-runtime-oracle.ts"],
      {
        cwd: "/app",
        env: referenceEnv,
      }
    );
    return;
  }

  start("reference", process.execPath, ["/app/reference-implementation/server/index.ts"], {
    cwd: "/app",
    env: referenceEnv,
  });
  start("console", process.execPath, ["/console/apps/console/server.js"], {
    cwd: "/console",
    env: consoleEnv,
  });
}

main().catch((error: unknown) => {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[core] startup failed: ${message}`);
  stop("SIGTERM");
});

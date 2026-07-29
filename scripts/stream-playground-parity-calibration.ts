#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const referenceUrl = process.argv[2] || process.env.PDPP_STREAM_PARITY_REFERENCE_URL;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!referenceUrl) {
  process.stderr.write(
    "usage: stream-playground-parity-calibration.ts <referenceUrl>\n" +
      "  (or set PDPP_STREAM_PARITY_REFERENCE_URL) — no default reference URL is provided.\n"
  );
  process.exit(1);
}

function report(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ authority: "informational-calibration-only", ...result })}\n`);
}

type OracleOutcome =
  | { status: "unavailable"; reason: string }
  | { status: "passed" }
  | { status: "failed"; exitCode: number | null; signal: NodeJS.Signals | null };

function runLocalOracle(): Promise<OracleOutcome> {
  return new Promise((resolveLocal) => {
    const child = spawn("pnpm", ["stream:parity:oracle"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    child.once("error", (error) => resolveLocal({ status: "unavailable", reason: error.message }));
    child.once("exit", (code, signal) => {
      resolveLocal(code === 0 ? { status: "passed" } : { status: "failed", exitCode: code, signal });
    });
  });
}

async function probe(url: string) {
  const localOracle = await runLocalOracle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    report({
      external: { referenceUrl: url, status: response.ok ? "reachable" : "http-error", statusCode: response.status },
      localOracle,
    });
  } catch (error) {
    report({
      external: {
        referenceUrl: url,
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      },
      localOracle,
    });
  } finally {
    clearTimeout(timeout);
  }
}

await probe(referenceUrl);

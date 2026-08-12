// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const REFERENCE_ROOT = resolve(import.meta.dirname, "../..");

function runPortfolio(): Promise<string> {
  const files = [
    "test/agent-cli.test.ts",
    "test/security-consent-token-handoff.test.ts",
    "test/batch-consent-per-source-gate.test.ts",
    "test/auth-consent-device-postgres-path.test.ts",
  ];
  const childEnv = { ...process.env };
  childEnv.NODE_TEST_CONTEXT = undefined;
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
      cwd: REFERENCE_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`durable handoff portfolio failed (${code ?? "signal"}:${signal ?? "none"})\n${output}`));
        return;
      }
      resolveOutput(output);
    });
  });
}

test("durable consent handoff portfolio passes on SQLite and PostgreSQL", async () => {
  assert.ok(process.env.PDPP_TEST_POSTGRES_URL, "live PostgreSQL is required");
  const output = await runPortfolio();
  for (const required of [
    "an exchange code survives a SQLite-backed server restart",
    "an already-committed approval can create a fresh HTML handoff",
    "concurrent SQLite redemptions converge on one stored transition",
    "agent-connect: approval committed before completion recovers at poll time",
    "agent-connect: approved attempt that expires before delivery revokes the stranded bearer",
    "agent-connect: approved attempt fails closed when the grant is revoked before delivery",
    "agent-connect: live Postgres approved expiry and revocation fail closed before delivery",
    "HTML approval hands off the package token durably",
    "a revoked package is not delivered by a stored exchange code",
    "concurrent Postgres redemption converges on one persisted token",
    "Postgres package delivery works and revocation fails closed",
  ]) {
    assert.match(output, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

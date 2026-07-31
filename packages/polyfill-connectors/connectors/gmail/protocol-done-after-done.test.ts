// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the live "Connector emitted DONE after DONE"
 * connector_protocol_violation (2026-07-31 fleet-gmail-green triage).
 *
 * Root cause: `fail()` used to be `void`-returning — it emitted a failed
 * DONE and called the (async, non-blocking) `flushAndExit(1)`, then
 * returned normally. Every call site followed it with a local `return;`,
 * which only exits the immediately-enclosing function. When `fail()` was
 * called from a helper like `resolvePassword()` (on a credentials error)
 * and that helper's own `return null` bubbled back up to `main()`, `main()`
 * would see the falsy result, call `fail()` a SECOND time — or, for a
 * `fail()` reachable only from deep inside `runAllMailPasses`, would let
 * that inner function `return` normally and fall through to `main()`'s own
 * unconditional trailing success DONE. Either way, two `{"type":"DONE",...}`
 * lines land on stdout in one run, which the runtime's `handleMsg` rejects
 * as `Connector emitted DONE after DONE` (reference-implementation/runtime/
 * index.ts) — classified `connector_protocol_violation`, and because the
 * failure lands after real records were already staged, the run's
 * checkpoint never commits: the next run re-walks the same window and can
 * hit the same failure again (a poison-pill loop).
 *
 * Fix: `fail()` now throws a `ConnectorFailure` after emitting the failed
 * DONE, so every caller propagates instead of returning normally, and
 * `main()`'s single top-level catch (`handleMainRejection`) recognizes
 * `ConnectorFailure` and does NOT emit a second DONE for it.
 *
 * This test reproduces the credentials-error double-fail shape end-to-end
 * through a real subprocess (no IMAP connection needed — the failure fires
 * before `client.connect()`): withhold Gmail credentials from the
 * environment, answer the resulting INTERACTION with a non-success
 * response so `requireCredentialsOrAsk` rejects, and assert exactly one
 * DONE reaches stdout.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";

const ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));

interface DrivenRunResult {
  code: number | null;
  doneCount: number;
  messages: EmittedMessage[];
  stderr: string;
}

/**
 * Spawn the real gmail connector and drive it interactively: reply to the
 * first INTERACTION with a failing status so credential resolution rejects
 * quickly, then collect every message it writes until the process exits.
 * Unlike `runConnectorProtocolSubprocess` (test-harness.ts), this keeps
 * stdin open so it can answer an INTERACTION mid-run.
 */
function runAndRejectCredentialsInteraction(): Promise<DrivenRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRYPOINT], {
      env: {
        ...process.env,
        GMAIL_ADDRESS: "",
        GMAIL_USER: "",
        GOOGLE_APP_PASSWORD_PDPP: "",
        GMAIL_APP_PASSWORD: "",
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages: EmittedMessage[] = [];
    let stderr = "";
    let buffer = "";
    let settled = false;
    let respondedToInteraction = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`test timed out; stderr=${stderr}`));
      }
    }, 15_000);

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        const msg = JSON.parse(line) as EmittedMessage;
        messages.push(msg);
        if (msg.type === "INTERACTION" && !respondedToInteraction) {
          respondedToInteraction = true;
          child.stdin?.end(
            stringifyForJsonl({
              type: "INTERACTION_RESPONSE",
              request_id: msg.request_id,
              status: "error",
            })
          );
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => finish(() => reject(err)));

    child.on("close", (code) => {
      const doneCount = messages.filter((m) => m.type === "DONE").length;
      finish(() => resolve({ code, doneCount, messages, stderr }));
    });

    child.stdin?.write(
      stringifyForJsonl({
        type: "START",
        scope: { streams: [{ name: "messages" }] },
      })
    );
  });
}

test("gmail connector: credentials rejection emits exactly one DONE (regression for DONE-after-DONE protocol violation)", async () => {
  const result = await runAndRejectCredentialsInteraction();

  assert.equal(
    result.doneCount,
    1,
    `expected exactly one DONE message, got ${String(result.doneCount)}; messages=${JSON.stringify(result.messages)}; stderr=${result.stderr}`
  );
  const done = result.messages.find((m) => m.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.equal(result.code, 1);
});

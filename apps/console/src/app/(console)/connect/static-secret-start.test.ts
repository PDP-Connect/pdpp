// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { FirstSyncStartError, runIdAfterCapture } from "./static-secret/[connectorId]/static-secret-start.ts";

const PROVIDER_SECRET_RE = /provider secret/;

test("runIdAfterCapture accepts a run confirmed by auto-resume", async () => {
  let started = false;
  const runId = await runIdAfterCapture(
    "connection-1",
    { auto_resume: { confirming_run: { run_id: "run-auto" }, status: "started" } },
    () => {
      started = true;
      return Promise.resolve({ run_id: "run-fallback" });
    }
  );

  assert.equal(runId, "run-auto");
  assert.equal(started, false);
});

test("runIdAfterCapture retries a blocked auto-resume and requires a run id", async () => {
  const startedFor: string[] = [];
  const runId = await runIdAfterCapture(
    "connection-2",
    { auto_resume: { confirming_run: null, status: "blocked" } },
    (connectionId) => {
      startedFor.push(connectionId);
      return Promise.resolve({ run_id: "run-retry" });
    }
  );

  assert.equal(runId, "run-retry");
  assert.deepEqual(startedFor, ["connection-2"]);
});

test("runIdAfterCapture explicitly requests setup admission for its fallback run", async () => {
  let receivedOptions: { runAdmission?: string } | undefined;
  const runId = await runIdAfterCapture("connection-setup", { auto_resume: null }, (_connectionId, options) => {
    receivedOptions = options;
    return Promise.resolve({ run_id: "run-setup" });
  });

  assert.equal(runId, "run-setup");
  assert.deepEqual(receivedOptions, { runAdmission: "setup" });
});

test("runIdAfterCapture turns an unconfirmed start into a terminal error", async () => {
  await assert.rejects(
    runIdAfterCapture("connection-3", { auto_resume: null }, () => Promise.resolve({ trace_id: "trace-only" })),
    (error: unknown) => {
      assert.ok(error instanceof FirstSyncStartError);
      assert.equal(error.code, "run_start_unconfirmed");
      assert.equal(error.message, "run_start_unconfirmed");
      return true;
    }
  );
});

test("runIdAfterCapture does not expose a start failure or accept an active run without its id", async () => {
  await assert.rejects(
    runIdAfterCapture("connection-4", { auto_resume: { confirming_run: null, status: "active_run_exists" } }, () =>
      Promise.resolve({ run_id: "should-not-start" })
    ),
    (error: unknown) => error instanceof FirstSyncStartError && error.code === "auto_resume_unconfirmed"
  );
  await assert.rejects(
    runIdAfterCapture("connection-5", { auto_resume: null }, () =>
      Promise.reject(new Error("provider secret should not cross this boundary"))
    ),
    (error: unknown) => {
      assert.ok(error instanceof FirstSyncStartError);
      assert.equal(error.code, "run_start_failed");
      assert.equal(error.message, "run_start_failed");
      assert.doesNotMatch(error.message, PROVIDER_SECRET_RE);
      return true;
    }
  );
});

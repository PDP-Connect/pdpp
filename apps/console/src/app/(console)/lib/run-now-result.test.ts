// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_NOW_ALREADY_ACTIVE_MESSAGE,
  RunNowRequestError,
  runNowFailureMessage,
  safeRunNowErrorBody,
} from "./run-now-result.ts";

const NO_SECRET_RE = /secret|req_private/;
const NO_PROXY_SECRET_RE = /do-not-show/;
const NO_UNKNOWN_CODE_SECRET_RE = /do-not-show|secret/;

test("typed 409 preserves only the stable code and validated incumbent run id", () => {
  const error = new RunNowRequestError(409, {
    error: {
      code: "run_already_active",
      message: "Connector token=secret already has an active run",
      request_id: "req_private",
      run_id: "run_active_123",
    },
  });

  assert.equal(error.status, 409);
  assert.equal(error.code, "run_already_active");
  assert.equal(error.runId, "run_active_123");
  assert.deepEqual(error.body, { code: "run_already_active", run_id: "run_active_123" });
  assert.equal(error.message, RUN_NOW_ALREADY_ACTIVE_MESSAGE);
  assert.doesNotMatch(error.message, NO_SECRET_RE);
});

test("run id is not recovered from an upstream message", () => {
  const error = new RunNowRequestError(409, {
    error: {
      code: "run_already_active",
      message: "Connector already has an active run: run_from_message",
    },
  });

  assert.equal(error.runId, null);
  assert.deepEqual(error.body, { code: "run_already_active", run_id: null });
});

test("malformed error bodies become a precise status-only safe failure", () => {
  const error = new RunNowRequestError(502, "proxy secret=do-not-show");

  assert.deepEqual(error.body, { code: null, run_id: null });
  assert.equal(runNowFailureMessage(error), "The reference server rejected the sync request (HTTP 502).");
  assert.doesNotMatch(error.message, NO_PROXY_SECRET_RE);
});

test("unknown stable codes remain safe and do not become already-running", () => {
  const body = {
    error: {
      code: "future_error_code",
      message: "provider secret=do-not-show",
      run_id: "run_invalid?secret",
    },
  };
  const error = new RunNowRequestError(409, body);

  assert.equal(error.code, "future_error_code");
  assert.equal(error.runId, null);
  assert.equal(
    runNowFailureMessage(error),
    "The reference server rejected the sync request with code future_error_code (HTTP 409)."
  );
  assert.doesNotMatch(error.message, NO_UNKNOWN_CODE_SECRET_RE);
});

test("the active code without a typed 409 stays a precise server failure", () => {
  const error = new RunNowRequestError(500, {
    error: { code: "run_already_active", run_id: "run_active_123" },
  });

  assert.equal(
    error.message,
    "The reference server rejected the sync request with code run_already_active (HTTP 500)."
  );
});

test("malformed code and run id fields are discarded", () => {
  assert.deepEqual(
    safeRunNowErrorBody({
      error: {
        code: "run_already_active;secret",
        run_id: "run_valid_but_extra?secret",
      },
    }),
    { code: null, run_id: null }
  );
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Subprocess-driven protocol tests for the Google Messages connector.
 * Drives the real connector process (via runConnectorProtocolSubprocess)
 * against a fake `gmcli` binary (fixtures/fake-gmcli.mjs) selected via
 * GMCLI_BIN + FAKE_GMCLI_MODE, so these tests prove the real START -> RECORD
 * / SKIP_RESULT / DONE wire protocol without requiring a real gmcli binary
 * or a real paired Android device.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { messagesSchema } from "./schemas.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_messages", "index.ts");
const FAKE_GMCLI = join(PACKAGE_ROOT, "connectors", "google_messages", "fixtures", "fake-gmcli.mjs");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function skips(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
}

function detailCoverage(
  messages: readonly EmittedMessage[],
  stream: string
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages.find(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      m.type === "DETAIL_COVERAGE" && m.stream === stream
  );
}

function runGoogleMessages(streams: string[], env: Record<string, string>, opts: { allowFailedDone?: boolean } = {}) {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      ...env,
    },
    start: {
      scope: { streams: streams.map((name) => ({ name })) },
      state: {},
      type: "START",
    },
    ...opts,
  });
}

test("healthy run emits messages + coverage_diagnostics=collected", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "healthy",
  });
  const messages = records(result.messages, "messages");
  assert.equal(messages.length, 2);
  for (const message of messages) {
    const parsed = messagesSchema.safeParse(message);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  }
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.store, "gmcli_archive");
  assert.equal(coverage[0]?.stream, "messages");
  assert.equal(coverage[0]?.status, "collected");

  // `messages` is the connector's only required stream — it must prove its
  // own coverage on a normal successful run, or it can never reach
  // `complete` regardless of how much real data it collected.
  const messagesCoverage = detailCoverage(result.messages, "messages");
  assert.ok(messagesCoverage, "messages must emit DETAIL_COVERAGE");
  assert.equal(messagesCoverage.considered, 2);
  assert.equal(messagesCoverage.covered, 2);
});

test("empty archive: zero messages, coverage still collected", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "empty",
  });
  assert.equal(records(result.messages, "messages").length, 0);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage[0]?.status, "collected");

  // A genuine zero-message archive is still a measured zero, not silence.
  const messagesCoverage = detailCoverage(result.messages, "messages");
  assert.ok(messagesCoverage, "messages must emit DETAIL_COVERAGE even for a zero-considered run");
  assert.equal(messagesCoverage.considered, 0);
  assert.equal(messagesCoverage.covered, 0);
});

test("missing gmcli binary: SKIP_RESULT reason gmcli_not_installed, coverage=missing, zero records, clean run", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: join(PACKAGE_ROOT, "connectors", "google_messages", "does-not-exist-gmcli-binary"),
  });
  const skip = skips(result.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "expected a messages SKIP_RESULT");
  assert.equal(skip?.reason, "gmcli_not_installed");
  assert.match(skip?.message ?? "", /gmcli binary not found/);
  assert.equal(records(result.messages, "messages").length, 0);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.status, "missing");
  const done = result.messages.findLast((m) => m.type === "DONE");
  assert.equal(done?.status, "succeeded");
});

test("not paired: SKIP_RESULT reason gmcli_not_paired tells the user to run gmcli auth manually", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "not_paired",
  });
  const skip = skips(result.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "expected a messages SKIP_RESULT");
  assert.equal(skip?.reason, "gmcli_not_paired");
  assert.match(skip?.message ?? "", /gmcli auth/);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage[0]?.status, "excluded");
});

test("schema drift: malformed chats output produces a typed error, not a silent wrong-shape emit", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "malformed_chats",
  });
  const skip = skips(result.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "expected a messages SKIP_RESULT for malformed gmcli chats output");
  assert.equal(skip?.reason, "gmcli_schema_drift");
  assert.equal(records(result.messages, "messages").length, 0);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage[0]?.status, "unsupported");
});

test("schema drift: malformed messages output produces a typed error, not a silent wrong-shape emit", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "malformed_messages",
  });
  const skip = skips(result.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "expected a messages SKIP_RESULT for malformed gmcli messages output");
  assert.equal(skip?.reason, "gmcli_query_failed");
  assert.equal(records(result.messages, "messages").length, 0);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage[0]?.status, "unsupported");
});

test("per-chat limit reached: SKIP_RESULT reason gmcli_per_chat_limit_reached, records still emitted", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "full_page",
    GMCLI_MESSAGES_PER_CHAT_LIMIT: "10",
  });
  const messages = records(result.messages, "messages");
  assert.equal(messages.length, 10);
  const skip = skips(result.messages).find((s) => s.reason === "gmcli_per_chat_limit_reached");
  assert.ok(skip, "expected a gmcli_per_chat_limit_reached SKIP_RESULT");
  assert.match(skip?.message ?? "", /per-chat message limit/);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage[0]?.status, "collected");
  assert.match(String(coverage[0]?.reason), /hit the per-chat limit/);
});

test("non-JSON gmcli output produces a typed error", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "not_json",
  });
  const skip = skips(result.messages).find((s) => s.stream === "messages");
  assert.ok(skip, "expected a messages SKIP_RESULT for non-JSON gmcli output");
  assert.equal(skip?.reason, "gmcli_schema_drift");
});

test("coverage_diagnostics is not emitted when not requested", async () => {
  const result = await runGoogleMessages(["messages"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "healthy",
  });
  assert.equal(records(result.messages, "coverage_diagnostics").length, 0);
});

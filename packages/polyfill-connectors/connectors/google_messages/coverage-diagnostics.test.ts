// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves google_messages emits an honest coverage_diagnostics row for its
 * one known local store (gmcli_archive) on every run — including when
 * gmcli is missing, not paired, or query-fails — so the connection-health
 * rollup never gets stuck at coverage_unknown for a genuinely-drained local
 * collector. Mirrors apple_photos/coverage-diagnostics.test.ts.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_messages", "index.ts");
const FAKE_GMCLI = join(PACKAGE_ROOT, "connectors", "google_messages", "fixtures", "fake-gmcli.mjs");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function runGoogleMessages(streams: string[], env: Record<string, string>) {
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
  });
}

test("coverage_diagnostics reports status=missing when gmcli is not installed", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: join(PACKAGE_ROOT, "connectors", "google_messages", "does-not-exist-gmcli"),
  });
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.store, "gmcli_archive");
  assert.equal(coverage[0]?.stream, "messages");
  assert.equal(coverage[0]?.status, "missing");
});

test("coverage_diagnostics reports status=collected when gmcli is installed, paired, and readable", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "healthy",
  });
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.status, "collected");
});

test("coverage_diagnostics is still emitted alongside real message records on a healthy run", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "healthy",
  });
  assert.equal(records(result.messages, "messages").length, 2);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.status, "collected");
});

test("coverage_diagnostics is emitted even on the not-paired failure path", async () => {
  const result = await runGoogleMessages(["messages", "coverage_diagnostics"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "not_paired",
  });
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.status, "excluded");
});

test("coverage_diagnostics is skipped (not emitted) when not requested", async () => {
  const result = await runGoogleMessages(["messages"], {
    GMCLI_BIN: FAKE_GMCLI,
    FAKE_GMCLI_MODE: "healthy",
  });
  assert.equal(records(result.messages, "coverage_diagnostics").length, 0);
});

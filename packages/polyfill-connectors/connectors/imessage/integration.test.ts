// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "imessage", "index.ts");

test("iMessage reports failed DONE when chat.db exists but cannot be queried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-imessage-"));
  const dbPath = join(dir, "chat.db");
  writeFileSync(dbPath, "not a sqlite database");

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { IMESSAGE_DB_PATH: dbPath },
    start: {
      type: "START",
      scope: { streams: [{ name: "messages" }] },
      state: {},
    },
  });

  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.equal(done?.records_emitted, 0);
  assert.match(done?.error?.message ?? "", /imessage_db_query_failed/);
  assert.equal(
    result.messages.some((msg) => msg.type === "STATE"),
    false
  );
});

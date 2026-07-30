// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";

const CONNECTOR_ID = "chatgpt";
const CONNECTOR_INSTANCE_ID = "cin_chatgpt_personal";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "ChatGPT",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
  version: "1.0.0",
};

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-needs-human-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

// A minimal, production-shaped admission fixture: mints a deterministic
// default-account connector_instance_id per (ownerSubjectId, connectorId) and
// refuses any other claimed id — the same authority shape
// `admitOwnerRunConnection` enforces in production, without a real store.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

test("manual owner run clears the needs-human gate before attempting repair", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: {
      error: () => {
        // Intentionally silent test logger.
      },
      warn: () => {
        // Intentionally silent test logger.
      },
    },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
  });

  controller.markNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID });
  assert.equal(controller.isNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID }), true);

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_repair",
  });

  assert.equal(controller.isNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID }), false);
  await controller.drainActiveRuns(1000);
  assert.equal(calls.length, 1, "manual repair run should still execute");
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";

const CONNECTOR_ID = "chatgpt";
const CONNECTOR_INSTANCE_ID = "cin_chatgpt_personal";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "ChatGPT",
  version: "1.0.0",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
};

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-needs-human-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

test("manual owner run clears the needs-human gate before attempting repair", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => {}, warn: () => {} },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({ status: "succeeded", records_emitted: 0 });
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

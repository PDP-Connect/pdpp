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

test("a SCHEDULED run that succeeds clears the needs-human gate", async (t) => {
  // The live defect, pinned. Before this, the gate cleared only for
  // `triggerKind === "manual"`, so an automatic run could succeed forever while
  // the connection kept rendering `AttentionClear=false
  // reason=needs_human_attention` and a "Missing data" pill.
  //
  // Observed on ChatGPT `cin_484604984db7c091bd08b259`: runs at 19:39 and 20:40
  // BOTH succeeded with every stream complete and zero open rows in
  // `connector_attention_records`, and the row still read needs_attention. The
  // flag is process-local with no durable backing (`connector_schedules` has no
  // `human_attention_needed` column), so nothing else could correct it.
  freshDb(t);

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ records_emitted: 3, status: "succeeded" }),
  });

  controller.markNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID });
  assert.equal(controller.isNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID }), true);

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_scheduled_success",
    triggerKind: "schedule",
  } as never);
  // `runNow` resolves on ADMISSION; the clear happens when the run completes.
  await controller.drainActiveRuns(1000);

  assert.equal(
    controller.isNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID }),
    false,
    "success is the evidence, not the trigger — an automatic run that collected everything answered what the human was for"
  );
});

test("a SCHEDULED run that FAILS leaves the needs-human gate set", async (t) => {
  // The control that makes the clear meaningful. Clearing on any completion
  // would silently drop a real owner request — the opposite failure, and the
  // worse one: the owner would never learn they were needed.
  freshDb(t);

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "failed" }),
  });

  controller.markNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID });

  await controller
    .runNow(CONNECTOR_ID, {
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_scheduled_failure",
      triggerKind: "schedule",
    } as never)
    .catch(() => undefined);
  await controller.drainActiveRuns(1000);

  assert.equal(
    controller.isNeedsHuman(CONNECTOR_ID, { connectorInstanceId: CONNECTOR_INSTANCE_ID }),
    true,
    "a failed run proves nothing about the owner's outstanding action; the gate must survive it"
  );
});

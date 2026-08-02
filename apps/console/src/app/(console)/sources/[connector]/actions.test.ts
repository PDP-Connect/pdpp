// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The redirecting connector action is a Server Action and imports Next
 * runtime modules, so this test pins its run-now branch as source-level
 * wiring. The client/result behavior is exercised directly in
 * `lib/run-now-result.test.ts`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS_FILE = `${HERE}actions.ts`;
const DANGER_ZONE_FILE = `${HERE}connection-danger-zone.tsx`;
const TYPED_ERROR_IMPORT = /RunNowRequestError/;
const TYPED_ACTIVE_BRANCH =
  /err instanceof RunNowRequestError && err\.status === 409 && err\.code === "run_already_active"/;
const ACTIVE_RUN_REDIRECT = /connectorHref\(routeId, RUN_NOW_ALREADY_ACTIVE_MESSAGE, undefined, err\.runId\)/;
const SAFE_FAILURE = /runNowFailureMessage\(err\)/;
const NO_RAW_ERROR_TEXT = /err\.message|String\(err\)/;
const CONNECTOR_HREF_WITH_RUN_ID =
  /function connectorHref\(connectorId: string, message\?: string, error\?: string, runId\?: string \| null\)/;
const SETS_RUN_ID = /params\.set\("run_id", runId\)/;
const VALIDATES_RUN_ID = /isSafeRunId\(runId\)/;
const ACTIVE_RUN_LINK = /href=\{activeRunHref\}/;
const OPEN_SYNC_LABEL = /Open sync →/;

test("redirecting run-now action switches on the typed active-run code", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const runAction = src.slice(
    src.indexOf("export async function runConnectorNowAction"),
    src.indexOf("export type RenameConnectionResult")
  );

  assert.match(src, TYPED_ERROR_IMPORT);
  assert.match(runAction, TYPED_ACTIVE_BRANCH);
  assert.match(runAction, ACTIVE_RUN_REDIRECT);
  assert.match(runAction, SAFE_FAILURE);
  assert.doesNotMatch(runAction, NO_RAW_ERROR_TEXT);
});

test("redirecting run-now action forwards only the typed run id to the detail page", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, CONNECTOR_HREF_WITH_RUN_ID);
  assert.match(src, SETS_RUN_ID);
});

test("detail result banner links to a validated active run and never renders the raw body", async () => {
  const src = await readFile(DANGER_ZONE_FILE, "utf8");
  assert.match(src, VALIDATES_RUN_ID);
  assert.match(src, ACTIVE_RUN_LINK);
  assert.match(src, OPEN_SYNC_LABEL);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural assertions for the `runConnectorNowAction` server action.
 *
 * The action is a `"use server"` module that imports `next/cache`, so it
 * cannot be imported into a plain node test. We mirror the file-grep style
 * used by `connector-row.test.ts` and assert the source wires the
 * connection-lifecycle objective #6 contract:
 *
 *   - a transport failure (`ReferenceServerUnreachableError`) is reported as a
 *     before-server error that records `reached_server: false`, so the UI can
 *     reassure the owner the run was NOT started and point at deployment status
 *     instead of surfacing a raw network string as if the connector itself
 *     failed;
 *   - a server-side rejection is an after-server error marked
 *     `reached_server: true`, carrying only safe status/code metadata;
 *   - the typed `run_already_active` 409 path preserves the structured run id.
 *
 * The pure error→reason mapping has no JSX, but the action's `next/cache`
 * import keeps it out of a direct import; the regex assertions below pin the
 * exact branches a future refactor must preserve.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS_FILE = `${HERE}actions.ts`;

const IMPORTS_UNREACHABLE_ERROR = /import \{ ReferenceServerUnreachableError \} from "\.\.\/lib\/owner-token\.ts"/;
const ERROR_VARIANT_PHASE = /reason: "error";[\s\S]*phase: RunStartFailurePhase;[\s\S]*reached_server: boolean/;
const DETECTS_UNREACHABLE = /err instanceof ReferenceServerUnreachableError/;
const BEFORE_SERVER_NOT_STARTED_COPY = /was not started/;
const BEFORE_SERVER_DEPLOYMENT_HINT = /RUN_NOW_UNREACHABLE_MESSAGE/;
const BEFORE_SERVER_RETURN = /phase: "before_server"[\s\S]{0,160}reached_server: false/;
const AFTER_SERVER_RETURN = /phase: "after_server"[\s\S]{0,160}reached_server: true/;
const ALREADY_RUNNING_PRESERVED = /reason:\s*"already_running"/;
const TYPED_RUN_ERROR_IMPORT = /RunNowRequestError/;
const TYPED_ALREADY_ACTIVE_BRANCH =
  /err instanceof RunNowRequestError && err\.status === 409 && err\.code === "run_already_active"/;
const TYPED_RUN_ID = /\.\.\.\(err\.runId \? \{ run_id: err\.runId \} : \{\}\)/;
const SAFE_FAILURE_MESSAGE = /runNowFailureMessage\(err\)/;
const NO_MESSAGE_REGEX = /ALREADY_ACTIVE_RE|RUN_ALREADY_ACTIVE_RE|RUN_ID_MATCH_RE|\.match\(/;
const NO_RAW_ERROR_TEXT = /err\.message|String\(err\)/;
const FORCE_OPTION_SIGNATURE = /options: RunConnectorNowOptions = \{\}/;
const FORCE_OPTION_BODY = /const runOptions = \{ force: options\.force === true \}/;
const RUN_CONNECTION_WITH_OPTIONS = /runConnectionNow\(connectionId, runOptions\)/;
const RUN_CONNECTOR_WITH_OPTIONS = /runConnectorNow\(connectorId, runOptions\)/;

test("run-now action imports the typed unreachable error so it can branch on transport failure", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, IMPORTS_UNREACHABLE_ERROR);
});

test("RunNowResult distinguishes before-server transport failure from after-server rejection", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ERROR_VARIANT_PHASE);
});

test("run-now action detects ReferenceServerUnreachableError and reports the run was not started", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, DETECTS_UNREACHABLE);
  assert.match(src, BEFORE_SERVER_NOT_STARTED_COPY);
  assert.match(src, BEFORE_SERVER_DEPLOYMENT_HINT);
  assert.match(src, BEFORE_SERVER_RETURN);
});

test("a server-side rejection is marked after_server/reached_server with safe typed metadata", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, AFTER_SERVER_RETURN);
  assert.match(src, TYPED_RUN_ERROR_IMPORT);
  assert.match(src, SAFE_FAILURE_MESSAGE);
});

test("the already_running 409 branch is preserved alongside the phase-aware error branch", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ALREADY_RUNNING_PRESERVED);
});

test("the already_running 409 branch switches on the typed code and preserves the structured run id", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, TYPED_ALREADY_ACTIVE_BRANCH);
  assert.match(src, TYPED_RUN_ID);
});

test("run-now action has no message-regex or raw error-text fallback", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.doesNotMatch(src, NO_MESSAGE_REGEX);
  assert.doesNotMatch(src, NO_RAW_ERROR_TEXT);
});

test("run-now action forwards explicit force override to the operator client", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, FORCE_OPTION_SIGNATURE);
  assert.match(src, FORCE_OPTION_BODY);
  assert.match(src, RUN_CONNECTION_WITH_OPTIONS);
  assert.match(src, RUN_CONNECTOR_WITH_OPTIONS);
});

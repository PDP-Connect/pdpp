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
 *     `reached_server: true`, carrying the server's own envelope message;
 *   - the `already_running` 409 path is preserved.
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
const ERROR_VARIANT_PHASE = /reason: "error"; phase: RunStartFailurePhase; reached_server: boolean; message: string/;
const DETECTS_UNREACHABLE = /err instanceof ReferenceServerUnreachableError/;
const BEFORE_SERVER_NOT_STARTED_COPY = /was not started/;
const BEFORE_SERVER_DEPLOYMENT_HINT = /deployment is running/;
const BEFORE_SERVER_RETURN = /phase: "before_server"[\s\S]{0,160}reached_server: false/;
const AFTER_SERVER_RETURN = /phase: "after_server"[\s\S]{0,160}reached_server: true/;
const ALREADY_RUNNING_PRESERVED = /reason:\s*"already_running"/;
const ALREADY_RUNNING_RETURNS_FULL_RUN_ID = /run_id: match\?\.\[0\]/;
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

test("a server-side rejection is marked after_server/reached_server so the UI knows the request landed", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, AFTER_SERVER_RETURN);
});

test("the already_running 409 branch is preserved alongside the phase-aware error branch", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ALREADY_RUNNING_PRESERVED);
});

test("the already_running 409 branch preserves the full run id for linking", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.ok(src.includes("const RUN_ID_MATCH_RE = /\\brun[_:][A-Za-z0-9]+/;"));
  assert.match(src, ALREADY_RUNNING_RETURNS_FULL_RUN_ID);
});

test("run-now action forwards explicit force override to the operator client", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, FORCE_OPTION_SIGNATURE);
  assert.match(src, FORCE_OPTION_BODY);
  assert.match(src, RUN_CONNECTION_WITH_OPTIONS);
  assert.match(src, RUN_CONNECTOR_WITH_OPTIONS);
});

// The transport-failure detection must run BEFORE the generic message
// stringify, otherwise an unreachable error would fall through to the raw
// `error` reason and lose the "not started" reassurance.
test("unreachable detection precedes the generic error stringify", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const unreachableIdx = src.indexOf("err instanceof ReferenceServerUnreachableError");
  const stringifyIdx = src.indexOf("err instanceof Error ? err.message : String(err)");
  assert.ok(unreachableIdx > -1, "expected the unreachable branch to exist");
  assert.ok(stringifyIdx > -1, "expected the generic stringify to exist");
  assert.ok(unreachableIdx < stringifyIdx, "unreachable branch must come first");
});

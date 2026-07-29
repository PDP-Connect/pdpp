// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `revokeConnection` / `deleteConnection` client-wrapper
 * outcome mappings.
 *
 * The pure `(status, body, code)` → outcome classifiers live in
 * `connection-control-result.ts` (not `operator-runs.ts`) specifically so they
 * can be imported and executed under `node --test`: `operator-runs.ts`
 * transitively imports `owner-token.ts`, which does `import "server-only"` and
 * throws outside the React Server runtime. We unit-test the classifiers directly
 * and separately assert (via source regex, below) that the wrappers feed the
 * real response status/body/error-code through them and hit the shared
 * owner-session `/_ref` routes.
 *
 * Outcomes under test (tasks 2.1 / 2.2):
 *   Revoke: 200 → revoked; 400 connector_instance_inactive → already_revoked;
 *           else → typed thrown Error.
 *   Delete: 200 → deleted (+ record count); 409 connection_run_active →
 *           run_active; 409 default_account_delete_unsupported →
 *           default_account; 404 connector_instance_not_found → not_found;
 *           else → typed thrown Error.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyDeleteConnectionResponse,
  classifyRevokeConnectionResponse,
  connectionControlErrorCode,
} from "./connection-control-result.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OPERATOR_RUNS_FILE = `${HERE}operator-runs.ts`;

const REVOKE_THROWS_RE = /nope|connection revoke failed/;
const DELETE_THROWS_RE = /boom|connection delete failed/;
const WRAPPER_REVOKE_PATH_RE = /connectionControlPath\(connectionId, "\/revoke"\)/;
const WRAPPER_POST_RE = /method: "POST"/;
const WRAPPER_REVOKE_CLASSIFY_RE =
  /classifyRevokeConnectionResponse\(response\.status, body, connectionControlErrorCode\(body\)\)/;
const WRAPPER_DELETE_PATH_RE = /connectionControlPath\(connectionId, ""\)/;
const WRAPPER_DELETE_METHOD_RE = /method: "DELETE"/;
const WRAPPER_DELETE_CLASSIFY_RE =
  /classifyDeleteConnectionResponse\(response\.status, body, connectionControlErrorCode\(body\)\)/;

test("revoke 200 maps to revoked", () => {
  assert.deepEqual(classifyRevokeConnectionResponse(200, { status: "revoked" }, null), { status: "revoked" });
});

test("revoke 400 connector_instance_inactive maps to already_revoked", () => {
  const body = { error: { code: "connector_instance_inactive", message: "already revoked" } };
  assert.deepEqual(classifyRevokeConnectionResponse(400, body, connectionControlErrorCode(body)), {
    status: "already_revoked",
  });
});

test("revoke on an unexpected status throws a described error", () => {
  const body = { error: { code: "permission_error", message: "nope" } };
  assert.throws(() => classifyRevokeConnectionResponse(403, body, connectionControlErrorCode(body)), REVOKE_THROWS_RE);
});

test("delete 200 maps to deleted and carries the record count", () => {
  assert.deepEqual(classifyDeleteConnectionResponse(200, { deleted: true, deleted_record_count: 42 }, null), {
    deletedRecordCount: 42,
    status: "deleted",
  });
});

test("delete 200 without a record count still maps to deleted", () => {
  assert.deepEqual(classifyDeleteConnectionResponse(200, { deleted: true }, null), { status: "deleted" });
});

test("delete 409 connection_run_active maps to run_active", () => {
  const body = { error: { code: "connection_run_active", message: "a run is active" } };
  assert.deepEqual(classifyDeleteConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "run_active",
  });
});

test("delete 409 default_account_delete_unsupported maps to default_account", () => {
  const body = { error: { code: "default_account_delete_unsupported", message: "revoke instead" } };
  assert.deepEqual(classifyDeleteConnectionResponse(409, body, connectionControlErrorCode(body)), {
    status: "default_account",
  });
});

test("delete 404 connector_instance_not_found maps to not_found", () => {
  const body = { error: { code: "connector_instance_not_found", message: "unknown" } };
  assert.deepEqual(classifyDeleteConnectionResponse(404, body, connectionControlErrorCode(body)), {
    status: "not_found",
  });
});

test("delete on an unexpected status throws a described error", () => {
  const body = { error: { code: "api_error", message: "boom" } };
  assert.throws(() => classifyDeleteConnectionResponse(500, body, connectionControlErrorCode(body)), DELETE_THROWS_RE);
});

test("connectionControlErrorCode tolerates malformed bodies", () => {
  assert.equal(connectionControlErrorCode(null), null);
  assert.equal(connectionControlErrorCode("not json"), null);
  assert.equal(connectionControlErrorCode({ error: "string" }), null);
  assert.equal(connectionControlErrorCode({ error: { code: 7 } }), null);
  assert.equal(connectionControlErrorCode({ error: { code: "x" } }), "x");
});

test("operator-runs revokeConnection POSTs the shared owner-session revoke route through the classifier", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, WRAPPER_REVOKE_PATH_RE);
  assert.match(src, WRAPPER_POST_RE);
  assert.match(src, WRAPPER_REVOKE_CLASSIFY_RE);
});

test("operator-runs deleteConnection DELETEs the shared owner-session connection route through the classifier", async () => {
  const src = await readFile(OPERATOR_RUNS_FILE, "utf8");
  assert.match(src, WRAPPER_DELETE_PATH_RE);
  assert.match(src, WRAPPER_DELETE_METHOD_RE);
  assert.match(src, WRAPPER_DELETE_CLASSIFY_RE);
});

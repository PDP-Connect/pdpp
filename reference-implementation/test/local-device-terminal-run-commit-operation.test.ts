// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import { handleLocalDeviceTerminalRunCommit } from "../operations/local-device-terminal-collection.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  commitTerminalRun as commitTerminalRunToStore,
  type ResolvedTerminalRunCommit,
  TerminalRunCommitConflictError,
} from "../server/stores/terminal-run-commit-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

function responseCapture() {
  let status = 0;
  let body: unknown;
  return {
    response: {
      json(value: unknown) {
        body = value;
        return value;
      },
      status(code: number) {
        status = code;
        return this;
      },
    },
    snapshot: () => ({ body, status }),
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    collection_boundary: "unscoped",
    commit_id: "commit-1",
    connector_id: "codex",
    connector_instance_id: "cin-1",
    device_id: "dev-1",
    run_id: "run-1",
    source_instance_id: "src-1",
    state_delta: { sessions: { cursor: "c1" } },
    terminal_facts: [{ coverage_statuses: ["collected", "collected"], stream: "sessions" }],
    version: 1,
    ...overrides,
  };
}

test("terminal run commit resolves authorization before receipt lookup and passes canonical binding", async () => {
  const capture = responseCapture();
  let authorized = false;
  let committed: ResolvedTerminalRunCommit | null = null;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: (commitInput) => {
        assert.equal(authorized, true, "receipt store is unreachable before full source authorization");
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-1",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code) => {
        throw new Error(`unexpected ${status}:${code}`);
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () => {
      authorized = true;
      return Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "https://registry.pdpp.org/connectors/codex" },
      });
    },
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;
  assert.equal(resolved.connectorId, "codex");
  assert.equal(resolved.connectorInstanceId, "cin-1");
  assert.deepEqual(resolved.normalizedFacts[0]?.coverage_statuses, ["collected"]);
  assert.equal(
    resolved.envelopeHash,
    createHash("sha256")
      .update(canonicalTerminalRunCommitJson({ ...validBody(), version: 1 }))
      .digest("hex")
  );
});

test("wrong device cannot resolve a source or inspect a receipt", async () => {
  const capture = responseCapture();
  let resolved = false;
  let lookedUp = false;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: () => {
        lookedUp = true;
        throw new Error("receipt disclosed");
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code) => {
        capture.response.status(status).json({ code });
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-other" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () => {
      resolved = true;
      return Promise.resolve(null);
    },
  });
  assert.equal(capture.snapshot().status, 403);
  assert.equal(resolved, false);
  assert.equal(lookedUp, false);
});

test("divergent receipt conflict returns a typed non-disclosing 409", async () => {
  const capture = responseCapture();
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: () => Promise.reject(new TerminalRunCommitConflictError()),
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        capture.response.status(status).json({ code, message });
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex" },
      }),
  });
  assert.equal(capture.snapshot().status, 409);
  assert.deepEqual(capture.snapshot().body, {
    code: "terminal_run_commit_conflict",
    message: "Terminal run commit identity conflicts with an existing commit.",
  });
  assert.equal(JSON.stringify(capture.snapshot().body).includes("envelope_hash"), false);
});

test("SQLite route operation composes authorization with 201, exact response-loss replay, and non-disclosing 409", async () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-operation-sqlite-"));
  try {
    const now = "2026-08-12T12:00:00.000Z";
    getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)").run("codex", now);
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at
         ) VALUES ('cin-1', 'owner_local', 'codex', 'Codex', 'active',
           'local_device', 'device:source', '{}', ?, ?)`
      )
      .run(now, now);

    const invoke = async (body: Record<string, unknown>, authenticatedDeviceId = "dev-1") => {
      const capture = responseCapture();
      let resolved = false;
      await handleLocalDeviceTerminalRunCommit({
        ctx: {
          canonicalConnectorKey: () => "codex",
          commitTerminalRun: commitTerminalRunToStore,
          emitSpineEvent: () => Promise.resolve(),
          handleError: (_res, error) => {
            throw error;
          },
          pdppError: (_res, status, code, message) => capture.response.status(status).json({ code, message }),
        },
        req: {
          body,
          deviceExporter: { deviceId: authenticatedDeviceId },
          params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
        },
        res: capture.response,
        resolveAuthorizedSource: () => {
          resolved = true;
          return Promise.resolve({
            connectorInstance: { connectorInstanceId: "cin-1" },
            sourceInstance: { connectorId: "https://registry.pdpp.org/connectors/codex" },
          });
        },
      });
      return { ...capture.snapshot(), resolved };
    };

    const unauthorized = await invoke(validBody(), "dev-other");
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.resolved, false);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get() as { n: number }).n, 0);

    const first = await invoke(validBody());
    const replay = await invoke(validBody());
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);

    const conflict = await invoke(validBody({ state_delta: { sessions: { cursor: "different" } } }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, {
      code: "terminal_run_commit_conflict",
      message: "Terminal run commit identity conflicts with an existing commit.",
    });
    assert.equal(JSON.stringify(conflict.body).includes("envelope_hash"), false);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get() as { n: number }).n, 1);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM run_history").get() as { n: number }).n, 1);
  } finally {
    closeDb();
  }
});

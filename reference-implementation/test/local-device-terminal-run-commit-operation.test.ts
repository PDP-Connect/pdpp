// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import { handleLocalDeviceTerminalRunCommit } from "../operations/local-device-terminal-collection.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
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
        sourceInstance: { connectorId: "https://registry.pdpp.dev/connectors/codex" },
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

/**
 * Production defect, peregrine 2026-08-22: a terminal run commit dead-lettered
 * with `400 invalid_request` and blocked the Claude Code outbox for five days
 * (1 dead_letter behind 10,000 succeeded uploads).
 *
 * The device is configured `PDPP_COLLECTOR_CONNECTOR=claude_code` and sends
 * that spelling verbatim. The server canonicalized only ITS OWN side to
 * `claude-code` and then required the device to have sent that exact string.
 * The record-batch leg compares with `sameConnectorType`, which canonicalizes
 * BOTH sides — which is why 10,000 batches from the same device on the same
 * run succeeded while this one guard rejected the commit.
 *
 * The pre-existing cases here all use `codex`, which canonicalizes to itself,
 * and stub `canonicalConnectorKey: () => "codex"` — a constant that cannot
 * express a mismatch. This case uses the REAL canonicalizer so the alias is
 * actually exercised.
 */
test("a device sending the legacy connector alias still commits: both sides are canonicalized", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-alias",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      // The exact spelling the peregrine collector emits.
      body: validBody({ connector_id: "claude_code" }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(capture.snapshot().status, 201, "the legacy alias must not be rejected as an invalid binding");
  assert.ok(committed);
  assert.equal(
    (committed as ResolvedTerminalRunCommit).connectorId,
    "claude-code",
    "the committed binding is stored canonically regardless of which spelling the device sent"
  );
});

/**
 * Production defect, run 652780f6-3316-4e90-9c53-835cfb0af483: the alias fix
 * above made the GUARD alias-tolerant but left the HASH INPUT canonicalized.
 * The collector hashes the envelope it actually sent (`claude_code`); the
 * server rehashed a rewritten envelope (`claude-code`), so the two hashes
 * never matched and the collector dead-lettered every terminal commit
 * forever — 34 dead letters / 0 succeeded for claude_code, against
 * 182 succeeded / 0 dead letters for codex, whose key canonicalizes to
 * itself and therefore never diverged.
 *
 * The 201 assertion in the alias test above cannot catch this: the request is
 * accepted, and only the returned hash is wrong. This case pins the hash.
 */
test("the envelope hash is computed over the connector id the device SENT, not the canonicalized one", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({ connector_id: "claude_code" });
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-alias-hash",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      body: sentBody,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;

  // What the collector itself computes: the bytes it put on the wire.
  const clientHash = createHash("sha256")
    .update(canonicalTerminalRunCommitJson({ ...sentBody, version: 1 }))
    .digest("hex");
  // What canonicalizing the hash input would produce instead. Pinned as a
  // NEGATIVE so a regression cannot pass by making both sides equal.
  const rewrittenHash = createHash("sha256")
    .update(canonicalTerminalRunCommitJson({ ...sentBody, connector_id: "claude-code", version: 1 }))
    .digest("hex");
  assert.notEqual(clientHash, rewrittenHash, "the alias and canonical spellings must actually hash differently");
  assert.equal(
    resolved.envelopeHash,
    clientHash,
    "the server must rehash the bytes the device sent; canonicalizing the hash input dead-letters every underscore alias"
  );

  // Storage identity stays canonical — only the hash input follows the wire.
  assert.equal(resolved.connectorId, "claude-code");
});

test("an identity-alias connector still hashes correctly — the alias fix does not disturb the working path", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({ connector_id: "codex" });
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-codex-hash",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      body: sentBody,
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
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;
  assert.equal(
    resolved.envelopeHash,
    createHash("sha256")
      .update(canonicalTerminalRunCommitJson({ ...sentBody, version: 1 }))
      .digest("hex")
  );
  assert.equal(resolved.connectorId, "codex");
});

test("an unrelated connector id is still rejected — canonicalizing both sides does not make the guard permissive", async () => {
  const capture = responseCapture();
  let status = 0;
  let errorCode = "";
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: () => {
        throw new Error("a mismatched connector must never reach the receipt store");
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, code, errCode) => {
        status = code;
        errorCode = errCode;
      },
    },
    req: {
      // `codex` is a real key that canonicalizes to itself — and is NOT this
      // source's connector. Without this control, mapping every unknown value
      // through the alias table could silently accept a foreign binding.
      body: validBody({ connector_id: "codex" }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(status, 400, "a connector that is not this source's must still fail closed");
  assert.equal(errorCode, "invalid_request");
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
            sourceInstance: { connectorId: "https://registry.pdpp.dev/connectors/codex" },
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

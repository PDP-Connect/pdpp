// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the source-webhook ingestion validation in
// operations/ref-source-webhook-ingest/index.ts. No test imports it by name. This
// is a security-critical ingress: it enforces required headers, an HMAC signature,
// a timestamp replay window, idempotency, and payload validation before ingesting.
// The store/secret/clock dependencies are stubbed; the signature is computed with
// the real scheme so the happy path is exercised end-to-end.
//
// RED note: this is a credential-verifying ingress. Tests OBSERVE the accept/reject
// decisions with a stub secret; no real webhook credential is used.
//
// Mutation surface:
//   - missing source/event-id/timestamp/signature -> typed errors.
//   - unknown source (no secret) -> 404/unknown_source.
//   - a timestamp outside +/-5min -> 401/stale_timestamp (replay protection).
//   - a bad signature -> 401/invalid_signature.
//   - duplicate (claimEvent false) -> { accepted:true, duplicate:true }.
//   - ingest_records requires a stream + records array.
//   - an unsupported action -> invalid_payload.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  executeSourceWebhook,
  type SourceWebhookDependencies,
  type SourceWebhookInput,
} from "../operations/ref-source-webhook-ingest/index.ts";

const SECRET = "test-webhook-secret";
const NOW = 1_700_000_000_000; // fixed clock

function sign(timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
}

function makeDeps(overrides: Partial<SourceWebhookDependencies> = {}): SourceWebhookDependencies {
  return {
    claimEvent: async () => true,
    ingestRecords: async () => ({ errors: [], records_accepted: 1, records_rejected: 0, stream: "s" }),
    nowMs: () => NOW,
    resolveConnectorId: () => null,
    resolveSecret: () => SECRET,
    signalScheduler: () => Promise.resolve(),
    ...overrides,
  };
}

function freshInput(body: string, overrides: Partial<SourceWebhookInput> = {}): SourceWebhookInput {
  const timestamp = String(NOW / 1000);
  return {
    body,
    eventId: "evt-1",
    signature: sign(timestamp, body),
    sourceId: "my-source",
    timestamp,
    ...overrides,
  };
}

function expectCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  return assert.rejects(promise, (err: unknown) => {
    assert.ok(typeof err === "object" && err !== null);
    const typed = err as { code?: unknown; status?: unknown };
    assert.equal(typed.code, code, `expected ${code}, got ${String(typed.code)}`);
    if (status !== undefined) {
      assert.equal(typed.status, status);
    }
    return true;
  });
}

test("source-webhook: missing required headers throw typed errors", async () => {
  await expectCode(executeSourceWebhook(freshInput("{}", { sourceId: "" }), makeDeps()), "invalid_source");
  await expectCode(executeSourceWebhook(freshInput("{}", { eventId: "" }), makeDeps()), "missing_event_id");
  await expectCode(executeSourceWebhook(freshInput("{}", { timestamp: "" }), makeDeps()), "missing_timestamp");
  await expectCode(executeSourceWebhook(freshInput("{}", { signature: "" }), makeDeps()), "missing_signature");
});

test("source-webhook: an unknown source (no configured secret) is a 404 unknown_source", async () => {
  await expectCode(
    executeSourceWebhook(freshInput("{}"), makeDeps({ resolveSecret: () => null })),
    "unknown_source",
    404
  );
});

test("source-webhook: a timestamp outside the +/-5min window is a 401 stale_timestamp (replay protection)", async () => {
  const staleTs = String(NOW / 1000 - 10 * 60); // 10 minutes ago
  await expectCode(
    executeSourceWebhook({ ...freshInput("{}"), signature: sign(staleTs, "{}"), timestamp: staleTs }, makeDeps()),
    "stale_timestamp",
    401
  );
});

test("source-webhook: a timestamp just inside the window is accepted", async () => {
  const nearTs = String(NOW / 1000 - 4 * 60); // 4 minutes ago, within 5min tolerance
  const body = JSON.stringify({ action: "ingest_records", records: [{ id: 1 }], stream: "s" });
  const out = await executeSourceWebhook(
    { ...freshInput(body), signature: sign(nearTs, body), timestamp: nearTs },
    makeDeps()
  );
  assert.equal(out.accepted, true);
});

test("source-webhook: an invalid signature is a 401 invalid_signature", async () => {
  await expectCode(
    executeSourceWebhook({ ...freshInput("{}"), signature: "sha256=deadbeef" }, makeDeps()),
    "invalid_signature",
    401
  );
});

test("source-webhook: a duplicate event (claimEvent false) is accepted as a duplicate", async () => {
  const body = JSON.stringify({ action: "ingest_records", records: [], stream: "s" });
  const out = await executeSourceWebhook(freshInput(body), makeDeps({ claimEvent: async () => false }));
  assert.deepEqual(out, { accepted: true, duplicate: true, event_id: "evt-1", source_id: "my-source" });
});

test("source-webhook: ingest_records requires a stream and a records array", async () => {
  const noStream = JSON.stringify({ action: "ingest_records", records: [] });
  await expectCode(executeSourceWebhook(freshInput(noStream), makeDeps()), "invalid_payload");

  const noArray = JSON.stringify({ action: "ingest_records", records: "not-an-array", stream: "s" });
  await expectCode(executeSourceWebhook(freshInput(noArray), makeDeps()), "invalid_payload");
});

test("source-webhook: a valid ingest_records call ingests and reports the ingest result", async () => {
  const body = JSON.stringify({ action: "ingest_records", records: [{ id: 1 }, { id: 2 }], stream: "receipts" });
  let ingestArgs: { connectorId: string; streamName: string; body: string } | undefined;
  const out = await executeSourceWebhook(
    freshInput(body),
    makeDeps({
      ingestRecords: (a) => {
        ingestArgs = a;
        return Promise.resolve({ errors: [], records_accepted: 2, records_rejected: 0, stream: a.streamName });
      },
    })
  );
  assert.equal(out.action, "ingest_records");
  assert.equal(out.duplicate, false);
  assert.deepEqual(out.ingest, { errors: [], records_accepted: 2, records_rejected: 0, stream: "receipts" });
  assert.ok(ingestArgs, "expected ingestRecords to have been called");
  assert.equal(ingestArgs.streamName, "receipts");
  assert.equal(ingestArgs.body, '{"id":1}\n{"id":2}', "records are newline-joined JSON");
});

test("source-webhook: an unsupported action is invalid_payload", async () => {
  const body = JSON.stringify({ action: "do_something_weird" });
  await expectCode(executeSourceWebhook(freshInput(body), makeDeps()), "invalid_payload");
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.records.ingest`.
 *
 * Pins:
 *   - line splitting / non-empty filter and submittedRecordCount.
 *   - invalid_request when connector_id is missing.
 *   - not_found when the manifest does not declare the stream.
 *   - sequential per-line ingest (preserves durable write order; no
 *     parallelism).
 *   - one-line failures are isolated: increment records_rejected, append the
 *     error message, do NOT roll back earlier accepted records, do NOT halt.
 *   - the response envelope shape `{ stream, records_accepted,
 *     records_rejected, errors }`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RecordsIngestDependencies, RecordsIngestInput } from "../operations/rs-records-ingest/index.ts";
import {
  executeRecordsIngest,
  parseLines,
  RecordsIngestInvalidRequestError,
  RecordsIngestNotFoundError,
  RecordsIngestSystemicFailureError,
} from "../operations/rs-records-ingest/index.ts";

const REGEXP_1 = /store down/;
const DRIVER_CONNECTION_RESET_RE = /driver connection reset/;

function defaultDeps(overrides: Partial<RecordsIngestDependencies> = {}): RecordsIngestDependencies {
  return {
    hasManifestStream: () => true,
    ingestRecord: () => undefined,
    ...overrides,
  };
}

function defaultInput(overrides: Partial<RecordsIngestInput> = {}): RecordsIngestInput {
  return {
    body: '{"id":"r1"}\n{"id":"r2"}',
    connectorId: "gmail",
    streamName: "messages",
    ...overrides,
  };
}

test("parseLines splits NDJSON, filters empty lines, returns empty for null/undefined", () => {
  assert.deepEqual(parseLines(null), []);
  assert.deepEqual(parseLines(undefined), []);
  assert.deepEqual(parseLines(""), []);
  assert.deepEqual(parseLines("\n\n"), []);
  assert.deepEqual(parseLines("a\n\nb\n   \n"), ["a", "b"]);
});

test("rs.records.ingest reports submittedRecordCount derived from non-empty lines", async () => {
  const out = await executeRecordsIngest(defaultInput({ body: '{"id":"r1"}\n\n{"id":"r2"}\n   ' }), defaultDeps());
  assert.equal(out.submittedRecordCount, 2);
});

test("rs.records.ingest rejects null connector_id with invalid_request", async () => {
  await assert.rejects(
    () => executeRecordsIngest(defaultInput({ connectorId: null }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof RecordsIngestInvalidRequestError);
      assert.equal(err.code, "invalid_request");
      return true;
    }
  );
});

test("rs.records.ingest raises not_found when manifest is missing the stream", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(defaultInput({ streamName: "unknown" }), defaultDeps({ hasManifestStream: () => false })),
    (err) => {
      assert.ok(err instanceof RecordsIngestNotFoundError);
      assert.equal(err.code, "not_found");
      return true;
    }
  );
});

test("rs.records.ingest invokes ingestRecord sequentially in line order", async () => {
  const seen: unknown[] = [];
  await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}\n{"id":"r3"}' }),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecord: async (_cid, _cin, record) => {
        seen.push(record.id);
      },
    })
  );
  assert.deepEqual(seen, ["r1", "r2", "r3"]);
});

test("rs.records.ingest forwards { ...record, stream } to the dependency", async () => {
  let captured: { cid: string; cin: string | null; record: Record<string, unknown> } | undefined;
  await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1","x":1}', connectorInstanceId: "cin_gmail_work" }),
    defaultDeps({
      ingestRecord: (cid, cin, record) => {
        captured = { cid, cin, record };
      },
    })
  );
  assert.ok(captured);
  assert.equal(captured.cid, "gmail");
  assert.equal(captured.cin, "cin_gmail_work");
  assert.deepEqual(captured.record, { id: "r1", stream: "messages", x: 1 });
});

test("rs.records.ingest counts accepted vs rejected and collects error messages", async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\nNOT_JSON\n{"id":"r3"}' }),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecord: async (_cid, _cin, record) => {
        if (record.id === "r3") {
          const err = new Error("store down");
          (err as Error & { retryable?: boolean }).retryable = false;
          throw err;
        }
      },
    })
  );
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 2);
  assert.equal(out.envelope.errors.length, 2);
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const secondError = out.envelope.errors[1];
  assert.ok(secondError);
  assert.match(secondError, REGEXP_1);
});

test("rs.records.ingest envelope echoes the stream name", async () => {
  const out = await executeRecordsIngest(defaultInput(), defaultDeps());
  assert.equal(out.envelope.stream, "messages");
});

test("rs.records.ingest empty body yields zero counts and no errors", async () => {
  const out = await executeRecordsIngest(defaultInput({ body: "" }), defaultDeps());
  assert.deepEqual(out.envelope, {
    errors: [],
    records_accepted: 0,
    records_rejected: 0,
    stream: "messages",
  });
  assert.equal(out.submittedRecordCount, 0);
});

test("rs.records.ingest does not halt on a failing line; subsequent lines still ingest", async () => {
  let lateCalled = false;
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecord: async (_cid, _cin, record) => {
        if (record.id === "r1") {
          const err = new Error("first failed");
          (err as Error & { retryable?: boolean }).retryable = false;
          throw err;
        }
        lateCalled = true;
      },
    })
  );
  assert.equal(lateCalled, true, "second line must still be attempted after first fails");
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 1);
});

test("rs.records.ingest returns 2xx envelope when every rejection is permanent", async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
    defaultDeps({
      ingestRecord: (_cid, _cin, record) => {
        const err = new Error(`invalid ${String(record.id)}`);
        (err as Error & { retryable?: boolean }).retryable = false;
        throw err;
      },
    })
  );
  assert.equal(out.envelope.records_accepted, 0);
  assert.equal(out.envelope.records_rejected, 2);
  assert.deepEqual(out.envelope.errors, ["invalid r1", "invalid r2"]);
});

test("rs.records.ingest throws typed systemic failure when any line is retryable", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
        defaultDeps({
          ingestRecord: (_cid, _cin, record) => {
            if (record.id === "r2") {
              throw new Error("driver connection reset");
            }
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      assert.equal(err.code, "ingest_batch_storage_error");
      assert.equal(err.retryableFailureCount, 1);
      assert.match(err.message, DRIVER_CONNECTION_RESET_RE);
      return true;
    }
  );
});

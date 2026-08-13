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
 *   - a PERMANENT (non-retryable) per-record failure is isolated: increment
 *     records_rejected, append the error message, do NOT roll back earlier
 *     accepted records, do NOT halt, and the request stays a 200-equivalent
 *     envelope (executeRecordsIngest resolves, never throws).
 *   - a SYSTEMIC (retryable) per-record failure — anywhere in the batch,
 *     even mixed with accepted/permanently-rejected records — makes
 *     executeRecordsIngest THROW RecordsIngestSystemicFailureError instead
 *     of returning an envelope, so the host route can answer non-2xx.
 *   - the response envelope shape `{ stream, records_accepted,
 *     records_rejected, errors }`.
 *   - classification never inspects `.message` text — only a thrown error's
 *     own `.retryable` boolean.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  InsertOrReplayRejectionInput,
  RecordsIngestDependencies,
  RecordsIngestInput,
  RejectionReceipt,
} from "../operations/rs-records-ingest/index.ts";
import {
  executeRecordsIngest,
  parseLines,
  RecordsIngestInvalidRequestError,
  RecordsIngestNotFoundError,
  RecordsIngestResourceLimitError,
  RecordsIngestSystemicFailureError,
} from "../operations/rs-records-ingest/index.ts";

const STORE_DOWN_RE = /store down/;
const MALFORMED_REJECTION_RECEIPT_RE = /malformed rejection receipt/;
const REJECTION_RECEIPT_CODE_MISMATCH_RE = /rejection receipt code does not match classified line error/;
const SYSTEMIC_SUMMARY_RE = /systemic\/retryable record failure/;
const LINE_LIMIT_EXCEEDED_RE = /exceeds 4 bytes/;

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

// A thrown error the single-record `ingestRecord` dependency uses to signal
// a PERMANENT per-record data defect — mirrors how a real host decorates a
// classified error (server/index.ts's ingestRecord wrapper sets `.retryable`
// off `classifyIngestFailure`'s result) without depending on records.ts.
function permanentThrow(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_record_identity", retryable: false });
}

// A thrown error with no `.retryable` field at all — the "host never
// classified this" case, which must default to systemic/retryable.
function unclassifiedThrow(message: string): Error {
  return new Error(message);
}

test("parseLines splits NDJSON, filters empty lines, returns empty for null/undefined", () => {
  assert.deepEqual(parseLines(null), []);
  assert.deepEqual(parseLines(undefined), []);
  assert.deepEqual(parseLines(""), []);
  assert.deepEqual(parseLines("\n\n"), []);
  assert.deepEqual(
    parseLines("a\n\nb\n   \n").map((line) => line.toString("utf8")),
    ["a", "b"]
  );
});

test("parseLines returns bounded views without copying submitted line bytes", () => {
  const body = Buffer.from('{"id":"r1"}\n{"id":"r2"}');
  const lines = parseLines(body);

  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.buffer, body.buffer, "line should share the submitted request backing buffer");
  assert.equal(lines[0]?.byteOffset, body.byteOffset, "first line should be a view over the original body");
  assert.equal(lines[1]?.buffer, body.buffer, "later lines should also share the submitted request backing buffer");
});

test("parseLines enforces the configured line byte ceiling below, at, and above the boundary", () => {
  assert.deepEqual(
    parseLines(Buffer.from("abcd"), { maxLineBytes: 4 }).map((line) => line.toString()),
    ["abcd"]
  );
  assert.deepEqual(
    parseLines(Buffer.from("abc"), { maxLineBytes: 4 }).map((line) => line.toString()),
    ["abc"]
  );
  assert.throws(
    () => parseLines(Buffer.from("abcde"), { maxLineBytes: 4 }),
    (err) => {
      assert.ok(err instanceof RecordsIngestResourceLimitError);
      assert.equal(err.code, "resource_limit");
      assert.match(err.message, LINE_LIMIT_EXCEEDED_RE);
      return true;
    }
  );
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

test("rs.records.ingest counts accepted vs rejected and collects error messages (permanent failure)", async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\nNOT_JSON\n{"id":"r3"}' }),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecord: async (_cid, _cin, record) => {
        if (record.id === "r3") {
          throw permanentThrow("store down");
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
  assert.match(secondError, STORE_DOWN_RE);
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

test("rs.records.ingest does not halt on a failing line; subsequent lines still ingest (permanent failure)", async () => {
  let lateCalled = false;
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      ingestRecord: async (_cid, _cin, record) => {
        if (record.id === "r1") {
          throw permanentThrow("first failed");
        }
        lateCalled = true;
      },
    })
  );
  assert.equal(lateCalled, true, "second line must still be attempted after first fails");
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 1);
});

// ── Systemic/retryable classification (RecordsIngestSystemicFailureError) ──

test("RecordsIngestSystemicFailureError carries ONLY fixed, public-safe fields — no field retains the underlying classified failure's own text", async () => {
  const secretMarker = "sk_live_51StructuralAssertionMarkerMustNeverSurvive";
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ body: '{"id":"r1"}' }),
        defaultDeps({
          ingestRecord: () => {
            throw unclassifiedThrow(
              `duplicate key value violates unique constraint: Key (record_key)=(${secretMarker}) already exists`
            );
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      // Exhaustive own-property check: any future field added to this class
      // must be deliberately reviewed for external safety, not silently
      // inherited by every catch site that logs or serializes the error.
      // (`stack` is excluded — inherited from Error, not own-enumerable, and
      // legitimately carries source-location detail, not record data.)
      assert.deepEqual(
        Object.keys(err).sort(),
        ["code", "name", "retryableFailureCount"],
        "RecordsIngestSystemicFailureError must expose exactly its fixed public-safe fields — no additional field for classified-failure detail"
      );
      const serialized = JSON.stringify({ ...err, message: err.message });
      assert.ok(
        !serialized.includes(secretMarker),
        `no field on RecordsIngestSystemicFailureError may contain the underlying failure's own text; got: ${serialized}`
      );
      return true;
    }
  );
});

test("rs.records.ingest treats an UNCLASSIFIED thrown error as systemic by default (no .retryable field)", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ body: '{"id":"r1"}' }),
        defaultDeps({
          ingestRecord: () => {
            throw unclassifiedThrow("connection reset");
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      assert.equal(err.code, "ingest_batch_storage_error");
      assert.equal(err.retryableFailureCount, 1);
      return true;
    }
  );
});

test("rs.records.ingest: ALL records failing permanently (retryable: false) still resolves the 200-shaped envelope, never throws", async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}\n{"id":"r3"}' }),
    defaultDeps({
      ingestRecord: () => {
        throw permanentThrow("invalid record identity");
      },
    })
  );
  assert.equal(out.envelope.records_accepted, 0);
  assert.equal(out.envelope.records_rejected, 3);
  assert.equal(out.envelope.errors.length, 3);
});

test("rs.records.ingest: a SINGLE systemic failure mixed with accepted AND permanently-rejected records still throws (partial-systemic case)", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}\n{"id":"r3"}' }),
        defaultDeps({
          // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
          ingestRecord: async (_cid, _cin, record) => {
            if (record.id === "r1") {
              return; // accepted
            }
            if (record.id === "r2") {
              throw permanentThrow("malformed primary key"); // permanent, isolated
            }
            throw unclassifiedThrow("lock contention"); // systemic — must dominate the outcome
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      // Exactly one of the three lines was systemic; the accepted record and
      // the permanently-rejected record do not count toward this total —
      // this asserts the throw is driven by the retryable failure alone, not
      // by "any rejection at all."
      assert.equal(err.retryableFailureCount, 1);
      assert.match(err.message, SYSTEMIC_SUMMARY_RE);
      return true;
    }
  );
});

test("hosted ingest commits permanent receipt evidence before a later systemic sibling fails the request", async () => {
  const persisted: InsertOrReplayRejectionInput[] = [];
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"accepted"}\n{"id":"permanent"}\n{"id":"systemic"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: (_cid, _cin, record) => {
            if (record.id === "permanent") {
              throw permanentThrow("payload-bearing permanent detail");
            }
            if (record.id === "systemic") {
              throw unclassifiedThrow("database unavailable");
            }
          },
          insertOrReplayRejection: (input) => {
            persisted.push(input);
            return receiptFor(input);
          },
        })
      ),
    (error) => error instanceof RecordsIngestSystemicFailureError && error.retryableFailureCount === 1
  );

  assert.deepEqual(
    persisted.map(({ code, inputIndex, rawLine }) => ({ code, inputIndex, rawLine: rawLine.toString("utf8") })),
    [
      {
        code: "invalid_record_identity",
        inputIndex: 1,
        rawLine: '{"id":"permanent"}',
      },
    ]
  );
});

function receiptFor(input: InsertOrReplayRejectionInput): RejectionReceipt {
  return {
    code: input.code,
    input_index: input.inputIndex,
    receipt_id: input.rawLine.includes('"dup"') ? "rr_duplicate_exact_line" : `rr_${input.inputIndex}_${input.code}`,
  };
}

test("rs.records.ingest hosted receipts use zero-based non-empty-line indexes and exact raw lines", async () => {
  const persisted: InsertOrReplayRejectionInput[] = [];
  const out = await executeRecordsIngest(
    defaultInput({
      body: '\n  \n{"id":"ok"}\nNOT_JSON\n{"id":"bad"}',
      connectorInstanceId: "cin_gmail_work",
      hostedRejectionReceipts: true,
    }),
    defaultDeps({
      ingestRecord: (_cid, _cin, record) => {
        if (record.id === "bad") {
          throw permanentThrow("invalid record identity");
        }
      },
      insertOrReplayRejection: (input) => {
        persisted.push(input);
        return receiptFor(input);
      },
    })
  );

  assert.equal(out.submittedRecordCount, 3);
  assert.deepEqual(out.envelope, {
    errors: [],
    records_accepted: 1,
    records_attempted: 3,
    records_rejected: 2,
    rejections: [
      { code: "malformed_ndjson", input_index: 1, receipt_id: "rr_1_malformed_ndjson" },
      { code: "invalid_record_identity", input_index: 2, receipt_id: "rr_2_invalid_record_identity" },
    ],
    stream: "messages",
  });
  assert.deepEqual(
    persisted.map(({ code, inputIndex, rawLine }) => ({ code, inputIndex, rawLine: rawLine.toString("utf8") })),
    [
      { code: "malformed_ndjson", inputIndex: 1, rawLine: "NOT_JSON" },
      { code: "invalid_record_identity", inputIndex: 2, rawLine: '{"id":"bad"}' },
    ]
  );
});

test("rs.records.ingest quarantines invalid UTF-8 using the exact submitted bytes", async () => {
  const persisted: InsertOrReplayRejectionInput[] = [];
  const invalidBytes = Buffer.from([0xc0, 0xaf]);
  const out = await executeRecordsIngest(
    defaultInput({ body: invalidBytes, connectorInstanceId: "cin_gmail_work", hostedRejectionReceipts: true }),
    defaultDeps({
      insertOrReplayRejection: (input) => {
        persisted.push(input);
        return receiptFor(input);
      },
    })
  );

  assert.deepEqual(out.envelope.rejections, [
    { code: "invalid_utf8", input_index: 0, receipt_id: "rr_0_invalid_utf8" },
  ]);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0]?.rawLine, invalidBytes);
});

test("rs.records.ingest rejects an over-limit line before decode, parse, or storage", async () => {
  let touchedStorage = false;
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: Buffer.from('{"id":"too-long"}'),
          maxLineBytes: 4,
        }),
        defaultDeps({
          ingestRecord: () => {
            touchedStorage = true;
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestResourceLimitError);
      assert.equal(err.code, "resource_limit");
      return true;
    }
  );
  assert.equal(touchedStorage, false);
});

test("rs.records.ingest applies the line byte ceiling to UTF-8 bytes, not characters", async () => {
  const twoByteJson = Buffer.from('{"id":"é"}', "utf8");
  const atBoundary = await executeRecordsIngest(
    defaultInput({ body: twoByteJson, maxLineBytes: twoByteJson.length }),
    defaultDeps()
  );
  assert.equal(atBoundary.envelope.records_accepted, 1);

  await assert.rejects(
    () =>
      executeRecordsIngest(defaultInput({ body: twoByteJson, maxLineBytes: twoByteJson.length - 1 }), defaultDeps()),
    RecordsIngestResourceLimitError
  );
});

test("rs.records.ingest treats NUL-containing JSON text as malformed NDJSON with exact hosted receipt bytes", async () => {
  const persisted: InsertOrReplayRejectionInput[] = [];
  const nulBytes = Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x00, 0x7d]);
  const out = await executeRecordsIngest(
    defaultInput({ body: nulBytes, connectorInstanceId: "cin_gmail_work", hostedRejectionReceipts: true }),
    defaultDeps({
      insertOrReplayRejection: (input) => {
        persisted.push(input);
        return receiptFor(input);
      },
    })
  );

  assert.deepEqual(out.envelope.rejections, [
    { code: "malformed_ndjson", input_index: 0, receipt_id: "rr_0_malformed_ndjson" },
  ]);
  assert.deepEqual(persisted[0]?.rawLine, nulBytes);
});

test("rs.records.ingest hosted mode emits additive shape for accepted-only batches", async () => {
  const out = await executeRecordsIngest(
    defaultInput({
      body: '{"id":"ok"}',
      connectorInstanceId: "cin_gmail_work",
      hostedRejectionReceipts: true,
    }),
    defaultDeps({
      insertOrReplayRejection: () => {
        throw new Error("accepted-only hosted batch should not persist a rejection");
      },
    })
  );

  assert.deepEqual(out.envelope, {
    errors: [],
    records_accepted: 1,
    records_attempted: 1,
    records_rejected: 0,
    rejections: [],
    stream: "messages",
  });
});

test("rs.records.ingest hosted mode fails closed when the rejection dependency is missing", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"ok"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      assert.equal(err.code, "ingest_batch_storage_error");
      return true;
    }
  );
});

test("rs.records.ingest hosted receipts preserve parsed batch indexes and allow duplicate receipt ids at distinct indexes", async () => {
  const out = await executeRecordsIngest(
    defaultInput({
      body: '{"id":"dup"}\n{"id":"ok"}\n{"id":"dup"}',
      connectorInstanceId: "cin_gmail_work",
      hostedRejectionReceipts: true,
    }),
    defaultDeps({
      ingestRecord: (_cid, _cin, record) => {
        if (record.id === "dup") {
          const err = new Error("invalid record identity") as Error & { code: string; retryable: boolean };
          err.code = "invalid_record_identity";
          err.retryable = false;
          throw err;
        }
      },
      insertOrReplayRejection: receiptFor,
    })
  );

  assert.equal(out.envelope.records_attempted, 3);
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 2);
  assert.deepEqual(out.envelope.rejections, [
    { code: "invalid_record_identity", input_index: 0, receipt_id: "rr_duplicate_exact_line" },
    { code: "invalid_record_identity", input_index: 2, receipt_id: "rr_duplicate_exact_line" },
  ]);
});

test("rs.records.ingest rejects hosted receipts whose indexes do not exactly match rejected lines", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"bad"}\n{"id":"ok"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: (_cid, _cin, record) => {
            if (record.id === "bad") {
              throw permanentThrow("invalid record identity");
            }
          },
          insertOrReplayRejection: () => ({
            code: "invalid_record_identity",
            input_index: 1,
            receipt_id: "rr_wrong_index",
          }),
        })
      ),
    MALFORMED_REJECTION_RECEIPT_RE
  );
});

test("rs.records.ingest rejects malformed hosted receipt envelopes fail-closed", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"bad"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: () => {
            throw permanentThrow("invalid record identity");
          },
          insertOrReplayRejection: () => ({
            code: "invalid_record_identity",
            input_index: 99,
            receipt_id: "rr_out_of_range",
          }),
        })
      ),
    MALFORMED_REJECTION_RECEIPT_RE
  );
});

test("rs.records.ingest rejects stale replay receipts whose code no longer matches the current classifier", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"bad"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: () => {
            throw permanentThrow("invalid record identity");
          },
          insertOrReplayRejection: () => ({
            code: "malformed_ndjson",
            input_index: 0,
            receipt_id: "rr_stale_reason",
          }),
        })
      ),
    REJECTION_RECEIPT_CODE_MISMATCH_RE
  );
});

test("rs.records.ingest threads runId to hosted rejection persistence", async () => {
  const observed: InsertOrReplayRejectionInput[] = [];
  await executeRecordsIngest(
    defaultInput({
      body: "NOT_JSON",
      connectorInstanceId: "cin_gmail_work",
      hostedRejectionReceipts: true,
      runId: "run_123",
    }),
    defaultDeps({
      insertOrReplayRejection: (input) => {
        observed.push(input);
        return receiptFor(input);
      },
    })
  );

  assert.equal(observed[0]?.runId, "run_123");
});

test("rs.records.ingest hosted mode treats permanent failures without typed reason code as systemic", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"bad"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: () => {
            throw Object.assign(new Error("legacy permanent"), { retryable: false });
          },
          insertOrReplayRejection: receiptFor,
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      return true;
    }
  );
});

test("rs.records.ingest hosted mode treats rejection receipt persistence failure as systemic", async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({
          body: '{"id":"bad"}',
          connectorInstanceId: "cin_gmail_work",
          hostedRejectionReceipts: true,
        }),
        defaultDeps({
          ingestRecord: () => {
            throw permanentThrow("invalid record identity");
          },
          insertOrReplayRejection: () => {
            throw new Error("quarantine store unavailable");
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestSystemicFailureError);
      assert.equal(err.code, "ingest_batch_storage_error");
      return true;
    }
  );
});

test("rs.records.ingest leaves legacy callers on the count-only response shape", async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"bad"}', connectorInstanceId: "cin_gmail_work" }),
    defaultDeps({
      ingestRecord: () => {
        throw permanentThrow("invalid record identity");
      },
      insertOrReplayRejection: () => {
        throw new Error("legacy path should not persist receipts");
      },
    })
  );

  assert.deepEqual(Object.keys(out.envelope).sort(), ["errors", "records_accepted", "records_rejected", "stream"]);
  assert.equal(out.envelope.records_rejected, 1);
});

test("rs.records.ingest does not halt on a failing line; subsequent lines still ingest (systemic failure, still isolated per-line before the throw)", async () => {
  let lateCalled = false;
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
        defaultDeps({
          // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
          ingestRecord: async (_cid, _cin, record) => {
            if (record.id === "r1") {
              throw unclassifiedThrow("first failed systemically");
            }
            lateCalled = true;
          },
        })
      ),
    (err) => err instanceof RecordsIngestSystemicFailureError
  );
  assert.equal(lateCalled, true, "second line must still be attempted before the operation throws for the first");
});

test("rs.records.ingest hosted mode marks accepted replay bytes stale with bounded provenance", async () => {
  const acceptedMarks: unknown[] = [];
  const out = await executeRecordsIngest(
    defaultInput({
      body: '{"key":"ok","data":{"id":"ok"}}\n{"key":"bad","data":{"id":"nope"}}',
      connectorInstanceId: "cin_gmail_work",
      hostedRejectionReceipts: true,
      runId: "run_acceptance_probe",
    }),
    defaultDeps({
      ingestRecord: (_cid, _cin, record) => {
        if (record.key === "bad") {
          throw permanentThrow("invalid record identity");
        }
      },
      insertOrReplayRejection: receiptFor,
      markAcceptedRecordRejectionsStale: (input) => {
        acceptedMarks.push({
          ...input,
          rawLine: input.rawLine.toString("utf8"),
        });
      },
    })
  );

  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 1);
  assert.deepEqual(acceptedMarks, [
    {
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_work",
      rawLine: '{"key":"ok","data":{"id":"ok"}}',
      recordKey: "ok",
      runId: "run_acceptance_probe",
      stream: "messages",
    },
  ]);
});

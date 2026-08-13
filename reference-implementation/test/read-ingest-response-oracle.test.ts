// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { readIngestResponse } from "../runtime/ingest-failure.ts";

type BuildHttpFailure = Parameters<typeof readIngestResponse>[3]["buildHttpFailure"];
type IngestFailure = ReturnType<BuildHttpFailure>;

function deps(buildHttpFailure: BuildHttpFailure = () => new Error("unexpected HTTP failure")): {
  buildHttpFailure: BuildHttpFailure;
} {
  return { buildHttpFailure };
}

function isIngestFailure(value: unknown): value is IngestFailure & { ingest_failure: Record<string, unknown> } {
  if (!(value instanceof Error && "failure_reason" in value && "ingest_failure" in value)) {
    return false;
  }
  return typeof value.ingest_failure === "object" && value.ingest_failure !== null;
}

test("readIngestResponse returns accepted and rejected counts from an ok JSON response", async () => {
  const resp = new Response(
    JSON.stringify({
      records_accepted: 3,
      records_attempted: 4,
      records_rejected: 1,
      rejections: [{ code: "invalid_record_identity", input_index: 2, receipt_id: "rr_one" }],
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  const result = await readIngestResponse(resp, "orders", 4, deps());

  assert.deepEqual(result, {
    records_accepted: 3,
    records_attempted: 4,
    records_rejected: 1,
    rejections: [{ code: "invalid_record_identity", input_index: 2, receipt_id: "rr_one" }],
  });
});

test("readIngestResponse accepts duplicate receipt ids at distinct rejected input indexes", async () => {
  const resp = new Response(
    JSON.stringify({
      records_accepted: 0,
      records_attempted: 2,
      records_rejected: 2,
      rejections: [
        { code: "invalid_record_identity", input_index: 0, receipt_id: "rr_same" },
        { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_same" },
      ],
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  const result = await readIngestResponse(resp, "orders", 2, deps());

  assert.deepEqual(
    result.rejections.map((rejection) => rejection.receipt_id),
    ["rr_same", "rr_same"]
  );
});

test("readIngestResponse rejects prior count-only 2xx responses", async () => {
  const resp = new Response(JSON.stringify({ records_accepted: 2, records_rejected: 0 }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse annotates non-ok responses with HTTP ingest failure details", async () => {
  const bodyText = "upstream rejected snowman \u2603";
  const calls: Array<{ message: string; status: number; body: string }> = [];
  const httpFailure = new Error("ingest HTTP failure") as IngestFailure;
  const buildHttpFailure: BuildHttpFailure = (message, status, body) => {
    calls.push({ body, message, status });
    return httpFailure;
  };
  const resp = new Response(bodyText, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 503,
  });

  await assert.rejects(readIngestResponse(resp, "orders", 7, deps(buildHttpFailure)), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err, httpFailure);
    assert.equal(err.failure_reason, "ingest_http_error");
    assert.deepEqual(err.ingest_failure, {
      batch_size: 7,
      http_status: 503,
      phase: "http_response",
      response_body_bytes: Buffer.byteLength(bodyText, "utf8"),
      response_content_type: "text/plain; charset=utf-8",
      stream: "orders",
    });
    return true;
  });
  assert.deepEqual(calls, [{ body: bodyText, message: "Ingest failed for orders", status: 503 }]);
});

test("readIngestResponse reports invalid JSON as a parse_response failure", async () => {
  const resp = new Response("{not json", {
    headers: { "content-type": "application/json" },
    status: 200,
  });

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "parse_response");
    return true;
  });
});

test("readIngestResponse reports missing numeric counts as a validate_response failure", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: "3", records_attempted: 2, records_rejected: 0, rejections: [] }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects unbalanced attempted counts", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: 1, records_attempted: 3, records_rejected: 1, rejections: [] }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects negative and non-integer counts", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: 1.5, records_attempted: 2, records_rejected: -1, rejections: [] }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects missing rejection receipt entries", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: 1, records_attempted: 2, records_rejected: 1, rejections: [] }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects duplicate rejection input indexes", async () => {
  const resp = new Response(
    JSON.stringify({
      records_accepted: 0,
      records_attempted: 2,
      records_rejected: 2,
      rejections: [
        { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_one" },
        { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_two" },
      ],
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects out-of-range rejection input indexes", async () => {
  const resp = new Response(
    JSON.stringify({
      records_accepted: 1,
      records_attempted: 2,
      records_rejected: 1,
      rejections: [{ code: "invalid_record_identity", input_index: 2, receipt_id: "rr_one" }],
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse rejects malformed rejection receipt fields", async () => {
  const resp = new Response(
    JSON.stringify({
      records_accepted: 1,
      records_attempted: 2,
      records_rejected: 1,
      rejections: [{ code: "", input_index: 1, receipt_id: "" }],
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

test("readIngestResponse accepts all-accepted responses with an empty rejection vector", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: 2, records_attempted: 2, records_rejected: 0, rejections: [] }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  const result = await readIngestResponse(resp, "orders", 2, deps());

  assert.deepEqual(result, { records_accepted: 2, records_attempted: 2, records_rejected: 0, rejections: [] });
});

test("readIngestResponse rejects non-array rejection vectors", async () => {
  const resp = new Response(
    JSON.stringify({ records_accepted: 2, records_attempted: 2, records_rejected: 0, rejections: {} }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );

  await assert.rejects(readIngestResponse(resp, "orders", 2, deps()), (err: unknown) => {
    assert.ok(isIngestFailure(err));
    assert.equal(err.failure_reason, "ingest_response_invalid");
    assert.equal(err.ingest_failure.phase, "validate_response");
    return true;
  });
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createDetailGapPageReader, validateDetailGapsPageRequest } from "../runtime/detail-gap-paging.ts";

const REGEXP_1 = /reference_only/;
const REGEXP_2 = /reference_only/;
const REGEXP_3 = /request_id/;
const REGEXP_4 = /max_bytes/;
const REGEXP_5 = /streams/;
const REGEXP_6 = /streams/;
const REGEXP_7 = /undeclared stream/;

const scopeByStream = new Map([
  ["messages", {}],
  ["threads", {}],
]);

type DetailGapStoreParam = Parameters<typeof createDetailGapPageReader>[0]["detailGapStore"];

test("detail-gap page reader fails clearly when CAS leasing is unavailable", async () => {
  // Deliberately omits claimPendingGaps/markGapStatus: createDetailGapPageReader
  // checks `typeof detailGapStore.claimPendingGaps !== 'function'` at RUNTIME
  // (not just via its type), so this test must construct a genuinely
  // incomplete store to exercise that fail-clearly guard. Typed as a Partial
  // of the real param type and cast to it at the call boundary — the cast IS
  // the point (proving the runtime guard, not a type-safety hole to paper
  // over), not a suppression of an error that could otherwise be fixed.
  const incompleteDetailGapStore: Partial<DetailGapStoreParam> = {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listPendingGaps() {
      return [
        {
          detail_locator: "locator",
          gap_id: "gap-1",
          record_key: "record",
          status: "pending",
          stream: "messages",
        },
      ];
    },
  };

  const readDetailGapPage = createDetailGapPageReader({
    connectorId: "connector",
    connectorInstanceId: "instance",
    detailGapStore: incompleteDetailGapStore as DetailGapStoreParam,
    grantId: "grant",
    runId: "run",
  });

  await assert.rejects(readDetailGapPage(), { message: "detail-gap store must support CAS recovery leases" });
});

test("detail-gap pages and served leases preserve checkpoint-parent identity", async () => {
  const served = new Map<
    string,
    {
      attempted: boolean;
      gapId: string;
      leaseId: string;
      parentStream: string | null;
      recordKey: string | null;
      runId: string;
      stream: string | null;
    }
  >();
  const store: DetailGapStoreParam = {
    claimPendingGaps(gapIds) {
      return Promise.resolve(gapIds.filter((gapId): gapId is string => typeof gapId === "string"));
    },
    listPendingGaps() {
      return Promise.resolve([
        {
          detail_locator: "locator",
          gap_id: "gap-1",
          parent_stream: "group_messages",
          record_key: "shared-key",
          status: "pending",
          stream: "attachments",
        },
      ]);
    },
    markGapStatus() {
      return Promise.resolve();
    },
  };
  const readDetailGapPage = createDetailGapPageReader({
    allServedGapLeases: served,
    connectorId: "groupme",
    connectorInstanceId: "instance",
    detailGapStore: store,
    grantId: "grant",
    runId: "run",
  });

  const page = await readDetailGapPage();

  assert.equal(page.detailGaps[0]?.parent_stream, "group_messages");
  assert.equal(served.get("gap-1")?.parentStream, "group_messages");
});

test("BASELINE: validateDetailGapsPageRequest normalizes a valid page request", () => {
  assert.deepEqual(
    validateDetailGapsPageRequest(
      {
        max_bytes: 123.9,
        reference_only: true,
        request_id: "req1",
        streams: ["messages", "messages", "threads"],
      },
      scopeByStream
    ),
    {
      maxBytes: 123,
      requestId: "req1",
      streams: ["messages", "threads"],
    }
  );
});

test("validateDetailGapsPageRequest normalizes absent or empty streams to null", () => {
  for (const streams of [null, undefined, []]) {
    assert.equal(
      validateDetailGapsPageRequest(
        {
          max_bytes: 123,
          reference_only: true,
          request_id: "req1",
          streams,
        },
        scopeByStream
      ).streams,
      null
    );
  }
});

test("validateDetailGapsPageRequest rejects malformed page requests", () => {
  assert.throws(() => validateDetailGapsPageRequest({ max_bytes: 123, request_id: "req1" }, scopeByStream), REGEXP_1);
  assert.throws(
    () => validateDetailGapsPageRequest({ max_bytes: 123, reference_only: false, request_id: "req1" }, scopeByStream),
    REGEXP_2
  );
  assert.throws(
    () => validateDetailGapsPageRequest({ max_bytes: 123, reference_only: true, request_id: "   " }, scopeByStream),
    REGEXP_3
  );

  for (const max_bytes of [0, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateDetailGapsPageRequest({ max_bytes, reference_only: true, request_id: "req1" }, scopeByStream),
      REGEXP_4
    );
  }

  assert.throws(
    () =>
      validateDetailGapsPageRequest(
        {
          max_bytes: 123,
          reference_only: true,
          request_id: "req1",
          streams: "messages",
        },
        scopeByStream
      ),
    REGEXP_5
  );

  for (const stream of ["", "   ", 1]) {
    assert.throws(
      () =>
        validateDetailGapsPageRequest(
          {
            max_bytes: 123,
            reference_only: true,
            request_id: "req1",
            streams: [stream],
          },
          scopeByStream
        ),
      REGEXP_6
    );
  }

  assert.throws(
    () =>
      validateDetailGapsPageRequest(
        {
          max_bytes: 123,
          reference_only: true,
          request_id: "req1",
          streams: ["messages", "profiles"],
        },
        scopeByStream
      ),
    REGEXP_7
  );
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorSummaryPageCursorError,
  ConnectorSummaryPageRequestError,
  decodeConnectorSummaryPageCursor,
  encodeConnectorSummaryPageCursor,
  parseConnectorSummaryPageRequest,
} from "../operations/ref-connectors-list/pagination.ts";

const boundary = {
  connectorId: "github",
  connectorInstanceId: "conn_work",
  createdAt: "2026-07-29T12:00:00.000Z",
};
const cursorKey = process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ?? "test connector-summary cursor key";
const CURSOR_PREFIX_PATTERN = /^rcs1\./;
const CURSOR_SECRET_PATTERN = /github|conn_work|owner_a/;
process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= cursorKey;

test("connector summary cursor is versioned, opaque, and owner-scope bound", () => {
  const cursor = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey);
  assert.match(cursor, CURSOR_PREFIX_PATTERN);
  assert.doesNotMatch(cursor, CURSOR_SECRET_PATTERN);
  assert.deepEqual(decodeConnectorSummaryPageCursor(cursor, "owner_a", null, cursorKey), boundary);
  assert.throws(
    () => decodeConnectorSummaryPageCursor(cursor, "owner_b", null, cursorKey),
    ConnectorSummaryPageCursorError
  );
  assert.throws(
    () =>
      decodeConnectorSummaryPageCursor(
        `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
        "owner_a",
        null,
        cursorKey
      ),
    ConnectorSummaryPageCursorError
  );
  assert.throws(
    () => decodeConnectorSummaryPageCursor("bad", "owner_a", null, cursorKey),
    ConnectorSummaryPageCursorError
  );
  assert.throws(
    () => decodeConnectorSummaryPageCursor("rcs1.e30", "owner_a", null, cursorKey),
    ConnectorSummaryPageCursorError
  );
});

test("connector summary cursor rejects a connector_id filter mismatch", () => {
  const filtered = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey, "github");
  assert.deepEqual(decodeConnectorSummaryPageCursor(filtered, "owner_a", "github", cursorKey), boundary);
  assert.throws(
    () => decodeConnectorSummaryPageCursor(filtered, "owner_a", null, cursorKey),
    ConnectorSummaryPageCursorError,
    "a cursor issued under a connector_id filter must not resolve for an unfiltered request"
  );
  assert.throws(
    () => decodeConnectorSummaryPageCursor(filtered, "owner_a", "gitlab", cursorKey),
    ConnectorSummaryPageCursorError,
    "a cursor issued under one connector_id filter must not resolve for a different connector_id"
  );
  const unfiltered = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey);
  assert.throws(
    () => decodeConnectorSummaryPageCursor(unfiltered, "owner_a", "github", cursorKey),
    ConnectorSummaryPageCursorError,
    "an unfiltered cursor must not resolve for a connector_id-filtered request"
  );
});

test("connector summary page request requires an explicit bounded limit", () => {
  assert.equal(parseConnectorSummaryPageRequest({}, "owner_a"), null);
  assert.deepEqual(parseConnectorSummaryPageRequest({ limit: "100" }, "owner_a"), {
    connectorId: null,
    cursor: null,
    limit: 100,
  });
  for (const query of [{ cursor: "rcs1.e30" }, { limit: "0" }, { limit: "101" }, { limit: "1.5" }]) {
    assert.throws(
      () => parseConnectorSummaryPageRequest(query, "owner_a"),
      (error) => error instanceof ConnectorSummaryPageRequestError || error instanceof ConnectorSummaryPageCursorError
    );
  }
});

test("connector summary page request decodes the issued continuation", () => {
  const cursor = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey);
  assert.deepEqual(decodeConnectorSummaryPageCursor(cursor, "owner_a", null, cursorKey), boundary);
  assert.deepEqual(parseConnectorSummaryPageRequest({ cursor, limit: "7" }, "owner_a"), {
    connectorId: null,
    cursor: boundary,
    limit: 7,
  });
});

test("connector summary page request requires limit when connector_id is supplied", () => {
  assert.throws(
    () => parseConnectorSummaryPageRequest({ connector_id: "github" }, "owner_a"),
    ConnectorSummaryPageRequestError
  );
  assert.deepEqual(parseConnectorSummaryPageRequest({ connector_id: "github", limit: "10" }, "owner_a"), {
    connectorId: "github",
    cursor: null,
    limit: 10,
  });
});

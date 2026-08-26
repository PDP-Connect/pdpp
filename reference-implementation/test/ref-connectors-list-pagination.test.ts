// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
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

function encodeLegacyUnfilteredCursor(): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: boundary.connectorId,
      f: "",
      i: boundary.connectorInstanceId,
      s: createHash("sha256").update("pdpp-ref-connectors-page-v1:owner_a  ").digest().toString("base64url"),
      t: boundary.createdAt,
      v: 1,
    })
  );
  const key = createHash("sha256").update(`pdpp.ref-connectors-page.cursor.v1\n${cursorKey}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `rcs1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

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

test("legacy unfiltered cursors remain valid only on the unfiltered surface", () => {
  const legacy = encodeLegacyUnfilteredCursor();
  assert.deepEqual(decodeConnectorSummaryPageCursor(legacy, "owner_a", null, cursorKey, false), boundary);
  assert.throws(
    () => decodeConnectorSummaryPageCursor(legacy, "owner_a", null, cursorKey, true),
    ConnectorSummaryPageCursorError
  );
});

test("connector summary page request requires an explicit bounded limit", () => {
  assert.equal(parseConnectorSummaryPageRequest({}, "owner_a"), null);
  assert.deepEqual(parseConnectorSummaryPageRequest({ limit: "100" }, "owner_a"), {
    connectorId: null,
    cursor: null,
    includeFleetHealth: false,
    limit: 100,
    sourcesVisibility: false,
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
    includeFleetHealth: false,
    limit: 7,
    sourcesVisibility: false,
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
    includeFleetHealth: false,
    limit: 10,
    sourcesVisibility: false,
  });
});

test("connector summary page request accepts explicit complete-page fleet health only", () => {
  assert.deepEqual(parseConnectorSummaryPageRequest({ include_fleet_health: "1", limit: "10" }, "owner_a"), {
    connectorId: null,
    cursor: null,
    includeFleetHealth: true,
    limit: 10,
    sourcesVisibility: false,
  });
  assert.throws(
    () => parseConnectorSummaryPageRequest({ include_fleet_health: "true", limit: "10" }, "owner_a"),
    ConnectorSummaryPageRequestError
  );
});

test("connector summary page request parses the Sources page's sources_visibility opt-in and rejects it alongside connector_id/profile", () => {
  assert.deepEqual(parseConnectorSummaryPageRequest({ limit: "10", sources_visibility: "1" }, "owner_a"), {
    connectorId: null,
    cursor: null,
    includeFleetHealth: false,
    limit: 10,
    sourcesVisibility: true,
  });
  assert.deepEqual(parseConnectorSummaryPageRequest({ limit: "10", sources_visibility: "0" }, "owner_a"), {
    connectorId: null,
    cursor: null,
    includeFleetHealth: false,
    limit: 10,
    sourcesVisibility: false,
  });
  assert.throws(
    () => parseConnectorSummaryPageRequest({ limit: "10", sources_visibility: "yes" }, "owner_a"),
    ConnectorSummaryPageRequestError
  );
  assert.throws(
    () => parseConnectorSummaryPageRequest({ connector_id: "github", limit: "10", sources_visibility: "1" }, "owner_a"),
    ConnectorSummaryPageRequestError,
    "sources_visibility must not compose with a connector_id scope"
  );
  assert.throws(
    () =>
      parseConnectorSummaryPageRequest(
        { limit: "10", profile: "identity_inventory", sources_visibility: "1" },
        "owner_a"
      ),
    ConnectorSummaryPageRequestError,
    "sources_visibility must not compose with a profile"
  );
});

test("a cursor issued on the Sources (sources_visibility) surface is rejected when replayed on the unfiltered/Explore surface, and vice versa", () => {
  // Direct encode/decode: the Sources-only cursor must not decode for an
  // unfiltered request, and an unfiltered cursor must not decode for a
  // Sources request — the exact review finding: without sources_visibility
  // bound into the scope digest, a boundary tuple valid under one surface's
  // keyset ordering is not a valid resume position under the other's (rows
  // are excluded differently), so a cross-surface replay could skip visible
  // rows or leak a hidden fragment past the exclusion.
  const sourcesCursor = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey, null, true);
  const unfilteredCursor = encodeConnectorSummaryPageCursor(boundary, "owner_a", cursorKey, null, false);

  assert.deepEqual(
    decodeConnectorSummaryPageCursor(sourcesCursor, "owner_a", null, cursorKey, true),
    boundary,
    "a Sources-issued cursor decodes correctly when replayed on the Sources surface"
  );
  assert.deepEqual(
    decodeConnectorSummaryPageCursor(unfilteredCursor, "owner_a", null, cursorKey, false),
    boundary,
    "an unfiltered-issued cursor decodes correctly when replayed on the unfiltered surface"
  );
  assert.throws(
    () => decodeConnectorSummaryPageCursor(sourcesCursor, "owner_a", null, cursorKey, false),
    ConnectorSummaryPageCursorError,
    "a Sources-issued cursor must not decode on the unfiltered/Explore surface"
  );
  assert.throws(
    () => decodeConnectorSummaryPageCursor(unfilteredCursor, "owner_a", null, cursorKey, true),
    ConnectorSummaryPageCursorError,
    "an unfiltered-issued cursor must not decode on the Sources surface"
  );

  // Full request-parse-layer replay: a real `?cursor=...` from one surface
  // fed into the other surface's request (sources_visibility flag flipped)
  // must fail closed at parse time, not silently resolve a wrong page.
  assert.throws(
    () => parseConnectorSummaryPageRequest({ cursor: sourcesCursor, limit: "10" }, "owner_a"),
    ConnectorSummaryPageCursorError,
    "a Sources cursor replayed on a plain (non-sources_visibility) request must be rejected"
  );
  assert.throws(
    () =>
      parseConnectorSummaryPageRequest({ cursor: unfilteredCursor, limit: "10", sources_visibility: "1" }, "owner_a"),
    ConnectorSummaryPageCursorError,
    "an unfiltered cursor replayed on a sources_visibility request must be rejected"
  );

  // Round-trip through the parse layer on the MATCHING surface still works.
  const parsedSourcesRequest = parseConnectorSummaryPageRequest(
    { cursor: sourcesCursor, limit: "10", sources_visibility: "1" },
    "owner_a"
  );
  assert.deepEqual(parsedSourcesRequest?.cursor, boundary);
  assert.equal(parsedSourcesRequest?.sourcesVisibility, true);
});

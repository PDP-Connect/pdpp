// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPeekReadUrl } from "@pdpp/operator-ui/explore/peek-read-url";

test("buildPeekReadUrl matches the canonical record-read URL shape", () => {
  const url = buildPeekReadUrl({
    connectorId: "gmail",
    connectorInstanceId: "conn-abc",
    recordId: "rec-1",
    rsBaseUrl: "http://rs.test",
    stream: "messages",
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/v1/streams/messages/records/rec-1");
  assert.equal(parsed.searchParams.get("connector_id"), "gmail");
  assert.equal(parsed.searchParams.get("connector_instance_id"), "conn-abc");
});

test("buildPeekReadUrl encodes path-unsafe stream and record ids", () => {
  const url = buildPeekReadUrl({
    connectorId: "github",
    connectorInstanceId: null,
    recordId: "owner/repo#42",
    rsBaseUrl: "http://rs.test",
    stream: "issues/comments",
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/v1/streams/issues%2Fcomments/records/owner%2Frepo%2342");
  assert.equal(parsed.searchParams.get("connector_id"), "github");
  assert.equal(parsed.searchParams.has("connector_instance_id"), false);
});

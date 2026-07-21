// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPeekReadUrl } from "@pdpp/operator-ui/explore/peek-read-url";

test("buildPeekReadUrl matches the canonical record-read URL shape", () => {
  const url = buildPeekReadUrl({
    rsBaseUrl: "http://rs.test",
    connectorId: "gmail",
    stream: "messages",
    recordId: "rec-1",
    connectorInstanceId: "conn-abc",
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/v1/streams/messages/records/rec-1");
  assert.equal(parsed.searchParams.get("connector_id"), "gmail");
  assert.equal(parsed.searchParams.get("connector_instance_id"), "conn-abc");
});

test("buildPeekReadUrl encodes path-unsafe stream and record ids", () => {
  const url = buildPeekReadUrl({
    rsBaseUrl: "http://rs.test",
    connectorId: "github",
    stream: "issues/comments",
    recordId: "owner/repo#42",
    connectorInstanceId: null,
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/v1/streams/issues%2Fcomments/records/owner%2Frepo%2342");
  assert.equal(parsed.searchParams.get("connector_id"), "github");
  assert.equal(parsed.searchParams.has("connector_instance_id"), false);
});

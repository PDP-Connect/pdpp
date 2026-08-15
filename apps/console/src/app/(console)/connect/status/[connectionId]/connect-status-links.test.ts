// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { setupHref, sourceDetailHref, sourceRecordsHref } from "./connect-status-links.ts";

const STATIC_SECRET_HREF_WITH_QUERY = /^\/connect\/static-secret\/apple%20contacts\?/;

function status(overrides: Partial<Parameters<typeof setupHref>[0]> = {}) {
  return {
    connection_id: "cin_1f446755642eec0161a7c55f",
    connector_id: "steam",
    setup_kind: "static_secret",
    status: "draft",
    ...overrides,
  };
}

// The draft deadlock: a static-secret connection stuck in status='draft' with
// an already-captured credential can only reach the run-admitting REPLACE
// flow via a link that carries connection_id. Losing it here strands the
// connection permanently (it becomes an orphan the owner can never retry —
// only delete and re-add), because runAdmission: "setup" (which allows a
// draft to run) is only wired on the replace-credential action, and that
// action only renders when the static-secret page sees a connection_id query
// param.
test("setupHref for a static-secret connection carries connection_id so retry targets the REPLACE flow, not a new draft", () => {
  const href = setupHref(status());
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/connect/static-secret/steam");
  assert.equal(
    url.searchParams.get("connection_id"),
    "cin_1f446755642eec0161a7c55f",
    "static-secret setupHref must include connection_id — without it the static-secret page falls back to " +
      "createStaticSecretConnectionAction, minting a second, unrelated draft instead of repairing the stuck one"
  );
});

test("setupHref for a static-secret connection round-trips through the connector id encoding", () => {
  const href = setupHref(status({ connector_id: "apple contacts" }));
  assert.match(href, STATIC_SECRET_HREF_WITH_QUERY);
});

// All four static-secret connectors that declare setupFieldEnvVars (gmail,
// steam, jellyfin, apple_contacts — see
// packages/polyfill-connectors/src/static-secret-injection.ts) share this one
// setupHref code path with no connector-specific branch. Parameterized so a
// future connector-specific regression in any one of them cannot hide behind
// the others still passing.
for (const connectorId of ["gmail", "steam", "jellyfin", "apple_contacts"]) {
  test(`setupHref carries connection_id for the static-secret retry CTA (${connectorId})`, () => {
    const href = setupHref(status({ connector_id: connectorId }));
    const url = new URL(href, "https://example.test");
    assert.equal(url.pathname, `/connect/static-secret/${connectorId}`);
    assert.equal(url.searchParams.get("connection_id"), "cin_1f446755642eec0161a7c55f");
  });
}

test("sourceDetailHref and sourceRecordsHref still carry the connection identity", () => {
  assert.equal(sourceDetailHref(status()), "/sources/steam?connection_id=cin_1f446755642eec0161a7c55f");
  assert.equal(sourceRecordsHref(status()), "/explore?connection=cin_1f446755642eec0161a7c55f");
});

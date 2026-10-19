// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { DEFAULT_FIXTURES } from "../src/targets/reference-adapter.ts";
import { ReferenceServer } from "../src/targets/reference-server.ts";

const READABLE_SYNC_POSITION = /^sync:\d+:/;
const READABLE_PAGE_POSITION = /^ok:(?:asc|desc):\d+:/;

interface Page {
  data: {
    id: string;
    data?: Record<string, unknown>;
    deleted?: boolean;
    removal?: string;
    deleted_at?: string;
    emitted_at?: string;
  }[];
  error?: { code: string };
  next_changes_since?: string;
  next_cursor?: string;
}

async function fixture(t: TestContext) {
  const server = new ReferenceServer(DEFAULT_FIXTURES);
  await server.start();
  t.after(() => server.stop());
  const read = async (params: Record<string, string>, token = "owner-seeded") => {
    const response = await fetch(`${server.baseUrl}/v1/streams/conversations/records?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as Page };
  };
  const begin = async (params: Record<string, string> = {}, token = "owner-seeded") => {
    const result = await read({ ...params, changes_since: "beginning" }, token);
    assert.equal(result.status, 200);
    assert.ok(result.body.next_changes_since);
    return result.body.next_changes_since;
  };
  return { server, read, begin };
}

it("sync tokens and page cursors do not expose numeric positions", async (t) => {
  const { read, begin } = await fixture(t);
  const token = await begin();
  const page = await read({ changes_since: "beginning", limit: "1" });
  assert.ok(page.body.next_cursor);
  assert.doesNotMatch(token, READABLE_SYNC_POSITION);
  assert.doesNotMatch(page.body.next_cursor, READABLE_PAGE_POSITION);
  assert.equal((await read({ changes_since: page.body.next_cursor })).status, 400);
  assert.equal((await read({ cursor: token })).status, 400);
  assert.equal((await read({ changes_since: `${token}:forged` })).status, 400);
});

const projections: readonly Record<string, string>[] = [{ fields: "title" }, { view: "summary" }];
for (const params of projections) {
  it(`owner sync ignores hidden-field changes under ${JSON.stringify(params)}`, async (t) => {
    const { server, read, begin } = await fixture(t);
    const token = await begin(params);
    assert.ok(server.writeField("conversations", "conv_1", "source_created_at", "2026-04-01T00:00:00Z"));
    const delta = await read({ ...params, changes_since: token });
    assert.equal(delta.status, 200);
    assert.deepEqual(delta.body.data, []);
  });
}

it("sync compares endpoint projections rather than intermediate writes", async (t) => {
  const { server, read, begin } = await fixture(t);
  const token = await begin({ fields: "title" });
  assert.ok(server.writeField("conversations", "conv_1", "title", "temporary"));
  assert.ok(server.writeField("conversations", "conv_1", "title", "Trip planning"));
  assert.deepEqual((await read({ fields: "title", changes_since: token })).body.data, []);
});

it("owner sync excludes deletion outside its filter", async (t) => {
  const { server, read, begin } = await fixture(t);
  const params = { "filter[title]": "Trip planning" };
  const token = await begin(params);
  assert.ok(server.deleteRecord("conversations", "conv_2"));
  assert.deepEqual((await read({ ...params, changes_since: token })).body.data, []);
});

it("owner sync emits left_query without deletion timestamps", async (t) => {
  const { server, read, begin } = await fixture(t);
  const params = { "filter[title]": "Trip planning" };
  const token = await begin(params);
  assert.ok(server.writeField("conversations", "conv_1", "title", "Elsewhere"));
  assert.deepEqual((await read({ ...params, changes_since: token })).body.data, [
    { object: "record", id: "conv_1", stream: "conversations", deleted: true, removal: "left_query" },
  ]);
});

it("owner deletion tombstones carry deleted removal and timestamps", async (t) => {
  const { server, read, begin } = await fixture(t);
  const token = await begin();
  assert.ok(server.deleteRecord("conversations", "conv_1"));
  const [row] = (await read({ changes_since: token })).body.data;
  assert.ok(row);
  assert.equal(row.removal, "deleted");
  assert.equal(typeof row.deleted_at, "string");
  assert.equal(typeof row.emitted_at, "string");
  assert.equal(row.data, undefined);
});

it("client tombstones contain only the four permitted members", async (t) => {
  const { server, read, begin } = await fixture(t);
  const grant = server.issueGrant([{ name: "conversations", fields: ["id", "title"] }]);
  assert.ok(grant && "accessToken" in grant);
  const token = await begin({}, grant.accessToken);
  assert.ok(server.deleteRecord("conversations", "conv_1"));
  assert.deepEqual((await read({ changes_since: token }, grant.accessToken)).body.data, [
    { object: "record", id: "conv_1", stream: "conversations", deleted: true },
  ]);
});

it("sync rejects expansion rather than ignoring related-record changes", async (t) => {
  const { read } = await fixture(t);
  const result = await read({ changes_since: "beginning", "expand[]": "conversation_messages" });
  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "invalid_request");
});

it("sync orders live records and tombstones together by canonical key", async (t) => {
  const { server, read, begin } = await fixture(t);
  const token = await begin({ order: "desc" });
  assert.ok(server.deleteRecord("conversations", "conv_7"));
  assert.ok(server.writeField("conversations", "conv_1", "title", "Changed"));
  const delta = await read({ order: "desc", changes_since: token });
  assert.deepEqual(
    delta.body.data.map((row) => row.id),
    ["conv_7", "conv_1"]
  );
});

it("page cursors bind the input sync token and resolved view fields", async (t) => {
  const { server, read, begin } = await fixture(t);
  const token = await begin({ view: "summary" });
  const page = await read({ view: "summary", changes_since: "beginning", limit: "1" });
  assert.ok(page.body.next_cursor);
  assert.equal((await read({ view: "summary", cursor: page.body.next_cursor, changes_since: token })).status, 400);
  assert.ok(server.widenView("conversations", "summary", "source_created_at"));
  assert.equal((await read({ view: "summary", cursor: page.body.next_cursor })).status, 400);
});

it("opaque page handles do not expose offsets", async (t) => {
  const { read } = await fixture(t);
  const first = await read({ changes_since: "beginning", limit: "1" });
  assert.ok(first.body.next_cursor);
  assert.doesNotMatch(first.body.next_cursor, READABLE_PAGE_POSITION);
  assert.equal((await read({ cursor: `${first.body.next_cursor}:forged` })).status, 400);
});

it("owner page handles reject a changed resolved view", async (t) => {
  const { server, read } = await fixture(t);
  const first = await read({ view: "summary", changes_since: "beginning", limit: "1" });
  assert.ok(first.body.next_cursor);
  assert.ok(server.widenView("conversations", "summary", "source_created_at"));
  const next = await read({ view: "summary", cursor: first.body.next_cursor });
  assert.equal(next.status, 400);
});

it("deletion after page one does not shift offsets past another live record", async (t) => {
  const { server, read } = await fixture(t);
  const first = await read({ changes_since: "beginning", order: "asc", limit: "2" });
  assert.ok(first.body.next_cursor);
  const [delivered] = first.body.data;
  assert.ok(delivered);
  assert.ok(server.deleteRecord("conversations", delivered.id));
  const next = await read({ cursor: first.body.next_cursor, order: "asc", limit: "100" });
  assert.equal(next.status, 200);
  const ids = [...first.body.data, ...next.body.data].map((row) => row.id);
  assert.equal(new Set(ids).size, 7);
});

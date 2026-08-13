// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Focused unit tests for the hosted-MCP PackageRsClient fan-out adapter.
//
// These tests stub `fetch` and verify the per-route behavior of
// reference-implementation/server/package-rs-client.js without standing
// up the full hosted MCP OAuth flow. Behaviors covered:
//
//   - schema fan-out: per-source stream tagging + package metadata
//   - protected-resource metadata: server-global passthrough
//   - list_streams fan-out: rows tagged with source identity
//   - search fan-out: hits tagged with source identity
//   - search scoped by connection_id: single child call only
//   - query_records ambiguous: typed 409 + available_connections
//   - query_records with selector: routes to one child
//   - fetch_blob (getRaw) requires selector
//   - event subscription create: selector required when >1 child
//   - event subscription create: single-child package infers child
//   - event subscription list: fans out and merges
//   - event subscription get/patch/delete: locates owning child
//   - selector not in members: typed not_found
//
// Spec: openspec/changes/add-hosted-mcp-grant-packages

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPackageRsClient as createPackageRsClientUntyped } from "../server/package-rs-client.ts";

// server/package-rs-client.js is untyped JS (allowJs, checkJs:false). Every
// test in this file constructs a different ad-hoc JSON response/error shape
// (there is no single closed RS response schema this fan-out adapter
// enforces), so `body`/`error` on the result stay `unknown` at the boundary
// and each test narrows the specific fields it reads with a local `as`
// cast — matching this suite's own intent (per-route fan-out behavior),
// not a full protocol schema.
interface PackageRsMember {
  connection_id: string;
  grant?: { streams: { instance_ids: string[]; name: string }[] };
  grant_id: string;
  source: { kind: string; id: string };
  token: string;
}

interface PackageRsResult {
  body: unknown;
  error: unknown;
  ok: boolean;
  status: number;
}

interface FakeFetchRequest {
  body: unknown;
  method: string;
  path: string;
  query: URLSearchParams;
  token: string;
  url: URL;
}

type FakeFetch = typeof fetch;

function resultWithError(
  result: Awaited<ReturnType<typeof createPackageRsClientUntyped>> extends infer Client
    ? Client extends { getJson: (path: string) => Promise<infer Result> }
      ? Result
      : never
    : never
): PackageRsResult {
  if (result.ok) {
    return { body: result.body, error: null, ok: true, status: result.status };
  }
  return { body: null, error: result.error, ok: false, status: result.status };
}

function createPackageRsClient(opts: Parameters<typeof createPackageRsClientUntyped>[0]) {
  const client = createPackageRsClientUntyped(opts);
  return {
    deleteJson: async (path: string) => resultWithError(await client.deleteJson(path)),
    getJson: async (path: string, options?: Parameters<typeof client.getJson>[1]) =>
      resultWithError(await client.getJson(path, options)),
    getRaw: async (path: string) => resultWithError(await client.getRaw(path)),
    patchJson: async (path: string, options: { body: Record<string, unknown> }) =>
      resultWithError(await client.patchJson(path, options)),
    postJson: async (path: string, options: Parameters<typeof client.postJson>[1]) =>
      resultWithError(await client.postJson(path, options)),
  };
}

const PROVIDER = "https://pdpp.test";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const responseBody = status === 204 ? null : JSON.stringify(body);
  return new Response(responseBody, { headers: { "content-type": "application/json", ...headers }, status });
}

function makeRouter(routes: (req: FakeFetchRequest) => Promise<Response>): FakeFetch {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  return async function fakeFetch(input, init = {}) {
    const u = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init.headers);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    const token = (headers.get("authorization") || "").replace(/^Bearer\s+/, "");
    const body = typeof init.body === "string" ? init.body : undefined;
    const req: FakeFetchRequest = {
      body: body ? JSON.parse(body) : undefined,
      method: init.method || "GET",
      path: u.pathname,
      query: u.searchParams,
      token,
      url: u,
    };
    return routes(req);
  };
}

function memberA(): PackageRsMember {
  return {
    connection_id: "gh_main",
    grant: {
      streams: [
        { instance_ids: ["gh_main"], name: "repos" },
        { instance_ids: ["gh_main"], name: "issues" },
      ],
    },
    grant_id: "grant_A",
    source: { id: "github", kind: "connector" },
    token: "tok_A",
  };
}
function memberB(): PackageRsMember {
  return {
    connection_id: "slack_main",
    grant: {
      streams: [
        { instance_ids: ["slack_main"], name: "messages" },
        { instance_ids: ["slack_main"], name: "repos" },
      ],
    },
    grant_id: "grant_B",
    source: { id: "slack", kind: "connector" },
    token: "tok_B",
  };
}

// Recurring shape of the `error` half of a PackageRsResult across the
// ambiguous_connection / not_found envelopes this suite pins.
interface PackageRsErrorEnvelope {
  available_connection_count?: number;
  available_connections?: {
    connection_id?: string;
    grant_id?: string;
    connector_key?: string;
    connector_id?: string;
  }[];
  available_connections_omitted?: number;
  available_connections_truncated?: boolean;
  code?: string;
  discovery_hint?: string;
  message?: string;
  retry_with?: string;
  type?: string;
  unavailable_connections?: unknown;
}

test("schema fan-out merges streams per source and tags package metadata", async () => {
  const calls: { token: string; path: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: {
          granted_connections: [{ connection_id: "gh_main" }],
          streams: [{ name: "repos" }, { name: "issues" }],
        },
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          granted_connections: [{ connection_id: "slack_main" }],
          streams: [{ name: "messages" }],
        },
      });
    }
    return jsonResponse(500, { error: "unknown_token" });
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema");
  assert.equal(out.ok, true);
  const body = out.body as {
    data: {
      streams: { source?: { grant_id?: string; connector_key?: string; connector_id?: string } }[];
      package: { member_count: number; sources: unknown[] };
    };
    meta: { package: { member_count: number } };
  };
  assert.equal(body.data.streams.length, 3);
  for (const s of body.data.streams) {
    assert.ok(s.source?.grant_id, "every stream carries source identity");
    assert.equal(
      s.source.connector_key,
      s.source.connector_id,
      "source tag keeps connector_id compatibility while adding connector_key"
    );
  }
  assert.equal(body.data.package.member_count, 2);
  assert.equal(body.data.package.sources.length, 2);
  assert.equal(body.meta.package.member_count, 2);
  assert.equal(calls.length, 2);
});

test("schema fan-out understands the canonical { data: { connectors: [{ streams }] } } shape", async () => {
  // Mirror the real RS /v1/schema envelope: each child returns one
  // connector item under data.connectors[] with its streams nested inside.
  // This is the shape exercised by reference-implementation/test/hosted-mcp-oauth.test.js
  // ("multi-source hosted MCP picker..."), here as a focused unit test so a
  // future PackageRsClient regression is caught without the OAuth scaffold.
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: {
          connector_count: 1,
          connectors: [
            {
              connector_id: "github",
              object: "connector",
              source: { id: "github", kind: "connector" },
              stream_count: 2,
              streams: [{ granted_connections: [{ connection_id: "gh_main" }], name: "repos" }, { name: "issues" }],
            },
          ],
          object: "schema",
          stream_count: 2,
        },
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          connector_count: 1,
          connectors: [
            {
              connector_id: "slack",
              object: "connector",
              source: { id: "slack", kind: "connector" },
              stream_count: 1,
              streams: [{ name: "messages" }],
            },
          ],
          object: "schema",
          stream_count: 1,
        },
      });
    }
    return jsonResponse(500, { error: "unknown_token" });
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema");
  assert.equal(out.ok, true);
  const body = out.body as {
    data: {
      streams: { source?: { grant_id?: string } }[];
      package: { member_count: number; sources: unknown[] };
      connectors: unknown[];
      granted_connections: unknown[];
    };
    meta: { package: { member_count: number } };
  };
  assert.equal(body.data.streams.length, 3, "streams from every child connector are flattened");
  for (const s of body.data.streams) {
    assert.ok(s.source?.grant_id, "each stream carries source identity");
  }
  assert.equal(body.data.package.member_count, 2);
  assert.equal(body.data.package.sources.length, 2);
  assert.equal(body.meta.package.member_count, 2);
  // Canonical connectors[] is preserved so callers that already speak the
  // schema envelope keep working.
  assert.equal(body.data.connectors.length, 2);
  // Per-stream granted_connections are flattened to the top-level
  // package-fanout `granted_connections` so consumers get one list.
  assert.ok(Array.isArray(body.data.granted_connections));
  assert.equal(body.data.granted_connections.length, 1);
});

test("schema scoped to connection_id calls only that child and forwards the instance selector", async () => {
  const calls: { token: string; path: string; query: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, query: req.query.toString(), token: req.token });
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          granted_connections: [{ connection_id: "slack_main" }],
          streams: [{ name: "messages" }],
        },
      });
    }
    return jsonResponse(500, { error: "wrong_child" });
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema", { query: { connection_id: "slack_main", stream: "messages" } });

  assert.equal(out.ok, true);
  const body = out.body as { data: { streams: { name: string; source?: { connection_id?: string } }[] } };
  assert.equal(body.data.streams.length, 1);
  assert.equal(body.data.streams[0]?.name, "messages");
  assert.equal(body.data.streams[0]?.source?.connection_id, "slack_main");
  assert.deepEqual(calls, [{ path: "/v1/schema", query: "connection_id=slack_main&stream=messages", token: "tok_B" }]);
});

test("schema with unknown connection_id returns not_found without fanout", async () => {
  let called = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema", { query: { connection_id: "unknown" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal((out.error as PackageRsErrorEnvelope).code, "not_found");
  assert.equal(called, 0, "unknown connection_id is rejected before touching child grants");
});

test("schema detail=full rejects shared stream names before package full-schema fanout", async () => {
  const calls: { token: string; query: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ query: req.query.toString(), token: req.token });
    if (req.query.get("view") !== "compact") {
      return jsonResponse(500, { error: "full_schema_should_not_be_called" });
    }
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: {
          connectors: [
            {
              connector_id: "github",
              streams: [{ granted_connections: [{ connection_id: "gh_main" }], name: "messages" }],
            },
          ],
          object: "schema",
        },
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          connectors: [
            {
              connector_id: "slack",
              streams: [{ granted_connections: [{ connection_id: "slack_main" }], name: "messages" }],
            },
          ],
          object: "schema",
        },
      });
    }
    return jsonResponse(500, {});
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema", { query: { detail: "full", stream: "messages" } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_schema_detail");
  assert.equal(error.retry_with, "connection_id");
  assert.deepEqual((error.available_connections ?? []).map((entry) => entry.connection_id).sort(), [
    "gh_main",
    "slack_main",
  ]);
  assert.deepEqual(
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    calls.map((call) => call.query).sort(),
    ["stream=messages&view=compact", "stream=messages&view=compact"],
    "package client should only perform compact preflight before returning ambiguity"
  );
});

test("schema detail=full with a single matching package source routes to that child only", async () => {
  const calls: { token: string; query: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ query: req.query.toString(), token: req.token });
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: {
          connectors: [
            {
              connector_id: "github",
              streams: [],
            },
          ],
          object: "schema",
        },
      });
    }
    if (req.token === "tok_B" && req.query.get("view") === "compact") {
      return jsonResponse(200, {
        data: {
          connectors: [
            {
              connector_id: "slack",
              streams: [{ granted_connections: [{ connection_id: "slack_main" }], name: "messages" }],
            },
          ],
          object: "schema",
        },
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          connectors: [
            {
              connector_id: "slack",
              streams: [{ field_capabilities: { id: { schema: { type: "string" } } }, name: "messages" }],
            },
          ],
          object: "schema",
        },
      });
    }
    return jsonResponse(500, {});
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/schema", { query: { detail: "full", stream: "messages" } });

  assert.equal(out.ok, true);
  const body = out.body as { data: { connectors: { connector_id: string }[] } };
  assert.equal(body.data.connectors.length, 1);
  assert.equal(body.data.connectors[0]?.connector_id, "slack");
  assert.deepEqual(calls, [
    { query: "stream=messages&view=compact", token: "tok_A" },
    { query: "stream=messages&view=compact", token: "tok_B" },
    { query: "detail=full&stream=messages", token: "tok_B" },
  ]);
});

test("protected-resource metadata is a server-global passthrough, not a source-required read", async () => {
  const calls: { token: string; path: string; query: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, query: req.query.toString(), token: req.token });
    return jsonResponse(200, {
      capabilities: {
        client_event_subscriptions: {
          endpoint: "/v1/event-subscriptions",
          supported: true,
        },
      },
      resource: "https://pdpp.test/mcp",
    });
  });

  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/.well-known/oauth-protected-resource", {
    query: { resource: "https://pdpp.test/mcp" },
  });
  assert.equal(out.ok, true);
  const body = out.body as { capabilities: { client_event_subscriptions: { supported: boolean } } };
  assert.equal(body.capabilities.client_event_subscriptions.supported, true);
  assert.deepEqual(calls, [
    {
      path: "/.well-known/oauth-protected-resource",
      query: "resource=https%3A%2F%2Fpdpp.test%2Fmcp",
      token: "tok_A",
    },
  ]);
});

test("list_streams fan-out tags rows and exposes meta.package.member_count", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, { data: [{ name: "repos" }, { name: "issues" }] });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, { data: [{ name: "messages" }] });
    }
    return jsonResponse(500, { error: "unknown_token" });
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams");
  assert.equal(out.ok, true);
  const body = out.body as { data: { source?: unknown }[]; meta: { package: { member_count: number } } };
  assert.equal(body.data.length, 3);
  for (const row of body.data) {
    assert.ok(row.source);
  }
  assert.equal(body.meta.package.member_count, 2);
});

test("list_streams scoped to connection_id calls only that child", async () => {
  let aCalled = 0;
  let bCalled = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      aCalled += 1;
    }
    if (req.token === "tok_B") {
      bCalled += 1;
    }
    return jsonResponse(200, { data: [{ name: "messages" }] });
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  await rs.getJson("/v1/streams", { query: { connection_id: "slack_main" } });
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test("list_streams with unknown connection_id returns not_found without fanout", async () => {
  let called = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams", { query: { connection_id: "unknown" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "not_found");
  assert.equal((error.available_connections ?? []).length, 2);
  assert.equal(called, 0, "unknown connection_id is rejected before touching child grants");
});

test("search fan-out merges hits across children", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, { data: { results: [{ id: "a:1", title: "Repo One" }] } });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          results: [
            { id: "b:1", title: "Msg One" },
            { id: "b:2", title: "Msg Two" },
          ],
        },
      });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/search", { query: { q: "one" } });
  assert.equal(out.ok, true);
  const body = out.body as { data: { results: { source?: unknown }[] } };
  assert.equal(body.data.results.length, 3);
  for (const hit of body.data.results) {
    assert.ok(hit.source);
  }
});

test("search fan-out applies limit globally and exposes source mix", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: {
          results: [
            { id: "repo:1", stream: "repos", title: "Repo One" },
            { id: "repo:2", stream: "repos", title: "Repo Two" },
          ],
        },
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: {
          results: [
            { id: "msg:1", stream: "messages", title: "Msg One" },
            { id: "msg:2", stream: "messages", title: "Msg Two" },
          ],
        },
      });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/search", { query: { limit: 3, q: "one" } });

  assert.equal(out.ok, true);
  const body = out.body as {
    data: { results: { connection_id?: string }[] };
    has_more: boolean;
    meta: { package: { source_mix: unknown[] } };
  };
  assert.equal(body.data.results.length, 3, "limit must apply to merged fan-in result, not per child");
  assert.equal(body.has_more, true, "truncated merged fan-in result must advertise has_more");
  assert.deepEqual(
    body.data.results.map((hit) => hit.connection_id),
    ["gh_main", "gh_main", "slack_main"]
  );
  assert.deepEqual(body.meta.package.source_mix, [
    { connection_id: "gh_main", connector_key: "github", count: 2 },
    { connection_id: "slack_main", connector_key: "slack", count: 1 },
  ]);
});

test("search fan-out merges canonical list-envelope data arrays across children", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, {
        data: [{ connection_id: "gh_main", object: "search_result", record_key: "a" }],
        object: "list",
      });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, {
        data: [{ connection_id: "slack_main", object: "search_result", record_key: "b" }],
        object: "list",
      });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/search", { query: { q: "one" } });
  assert.equal(out.ok, true);
  const body = out.body as { data: { record_key: string; source?: unknown }[] };
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(body.data.map((hit) => hit.record_key).sort(), ["a", "b"]);
  for (const hit of body.data) {
    assert.ok(hit.source);
  }
});

test("search fan-out merges nested data.data envelopes across children", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, { data: { data: [{ object: "search_result", record_key: "a" }] } });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, { data: { data: [{ object: "search_result", record_key: "b" }] } });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/search", { query: { q: "one" } });
  assert.equal(out.ok, true);
  const body = out.body as { data: { data: { record_key: string }[] } };
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(body.data.data.map((hit) => hit.record_key).sort(), ["a", "b"]);
});

test("search fan-out intersects requested streams with each child grant", async () => {
  const calls: { token: string; streams: string[] }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    const streams = req.query.getAll("streams");
    calls.push({ streams, token: req.token });
    if (req.token === "tok_A") {
      assert.deepEqual(streams, ["conversations"]);
      return jsonResponse(200, {
        data: [{ object: "search_result", record_key: "c1", stream: "conversations" }],
        object: "list",
      });
    }
    if (req.token === "tok_B") {
      assert.deepEqual(streams, ["messages"]);
      return jsonResponse(200, {
        data: [{ object: "search_result", record_key: "m1", stream: "messages" }],
        object: "list",
      });
    }
    return jsonResponse(500, {});
  });
  const members = [
    { ...memberA(), grant: { streams: [{ instance_ids: ["gh_main"], name: "conversations" }] } },
    { ...memberB(), grant: { streams: [{ instance_ids: ["slack_main"], name: "messages" }] } },
  ];
  const rs = createPackageRsClient({ fetch, members, providerUrl: PROVIDER });

  const out = await rs.getJson("/v1/search", {
    query: { q: "redactable", streams: ["messages", "conversations", "comments"] },
  });

  assert.equal(out.ok, true);
  const body = out.body as { data: { record_key: string }[] };
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(body.data.map((hit) => hit.record_key).sort(), ["c1", "m1"]);
  assert.deepEqual(
    calls.map((call) => call.streams),
    [["conversations"], ["messages"]]
  );
});

test("search fan-out skips children with no requested streams in their grant", async () => {
  let aCalled = 0;
  let bCalled = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      aCalled += 1;
      return jsonResponse(400, { error: { code: "grant_stream_not_allowed", type: "permission_error" } });
    }
    if (req.token === "tok_B") {
      bCalled += 1;
      assert.deepEqual(req.query.getAll("streams"), ["messages"]);
      return jsonResponse(200, {
        data: [{ object: "search_result", record_key: "m1", stream: "messages" }],
        object: "list",
      });
    }
    return jsonResponse(500, {});
  });
  const members = [
    { ...memberA(), grant: { streams: [{ instance_ids: ["gh_main"], name: "conversations" }] } },
    { ...memberB(), grant: { streams: [{ instance_ids: ["slack_main"], name: "messages" }] } },
  ];
  const rs = createPackageRsClient({ fetch, members, providerUrl: PROVIDER });

  const out = await rs.getJson("/v1/search", { query: { q: "redactable", streams: ["messages"] } });

  assert.equal(out.ok, true);
  const body = out.body as { data: { record_key: string }[] };
  assert.deepEqual(
    body.data.map((hit) => hit.record_key),
    ["m1"]
  );
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test("search with unknown connection_id returns not_found without fanout", async () => {
  let called = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async () => {
    called += 1;
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/search", { query: { connection_id: "unknown", q: "one" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "not_found");
  assert.equal((error.available_connections ?? []).length, 2);
  assert.equal(called, 0, "unknown connection_id is rejected before touching child grants");
});

test("query_records without selector returns ambiguous_connection 409 with candidates", async () => {
  const calls: { path: string; token: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { limit: 10 } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_connection");
  assert.equal((error.available_connections ?? []).length, 2);
  assert.equal(error.available_connection_count, 2);
  assert.deepEqual(calls, [], "ambiguity is computed from package membership without probing child grants");
});

test("query_records with connection_id routes to one child only", async () => {
  let aCalled = 0;
  let bCalled = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      aCalled += 1;
    }
    if (req.token === "tok_B") {
      bCalled += 1;
    }
    return jsonResponse(200, { data: [{ record_id: "r1" }] });
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { connection_id: "gh_main" } });
  assert.equal(out.ok, true);
  assert.equal(aCalled, 1);
  assert.equal(bCalled, 0);
});

test("package routing derives every authorized instance from the relevant child grant", async () => {
  const tokensSeen: string[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test router preserves the Promise-based fetch contract.
  const fetch = makeRouter(async (req) => {
    tokensSeen.push(req.token);
    return jsonResponse(200, { data: [] });
  });
  const multiInstanceMember = {
    ...memberA(),
    connection_id: "stale-display-only",
    grant: {
      streams: [
        { instance_ids: ["gh_main", "gh_work"], name: "repos" },
        { instance_ids: ["gh_messages"], name: "messages" },
      ],
    },
  };
  const rs = createPackageRsClient({ fetch, members: [multiInstanceMember, memberB()], providerUrl: PROVIDER });

  const secondInstance = await rs.getJson("/v1/streams/repos/records", {
    query: { connection_id: "gh_work" },
  });
  assert.equal(secondInstance.ok, true);
  assert.deepEqual(tokensSeen, ["tok_A"]);

  tokensSeen.length = 0;
  const wrongStream = await rs.getJson("/v1/streams/messages/records", {
    query: { connection_id: "gh_main" },
  });
  assert.equal(wrongStream.ok, false);
  assert.equal(wrongStream.status, 404);
  assert.deepEqual(tokensSeen, []);

  const forgedMetadata = await rs.getJson("/v1/streams/repos/records", {
    query: { connection_id: "stale-display-only" },
  });
  assert.equal(forgedMetadata.ok, false);
  assert.equal(forgedMetadata.status, 404);
  assert.deepEqual(tokensSeen, []);
});

test("package routing treats instance handles as source- and stream-scoped", async () => {
  const calls: Array<{ path: string; query: string; token: string }> = [];
  const observedCalls = () => calls;
  // biome-ignore lint/suspicious/useAwait: localized test router preserves the Promise-based fetch contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, query: req.query.toString(), token: req.token });
    if (req.path === "/v1/schema") {
      return jsonResponse(200, { data: { connectors: [], object: "schema" } });
    }
    if (req.path === "/v1/streams") {
      return jsonResponse(200, { data: [] });
    }
    if (req.path === "/v1/search") {
      return jsonResponse(200, { data: [], object: "list" });
    }
    if (req.path === "/v1/event-subscriptions") {
      return jsonResponse(201, { subscription_id: "sub_shared" });
    }
    return jsonResponse(200, { data: [] });
  });
  const members = [
    {
      ...memberA(),
      connection_id: "display-a",
      grant: { streams: [{ instance_ids: ["shared"], name: "repos" }] },
    },
    {
      ...memberB(),
      connection_id: "display-b",
      grant: { streams: [{ instance_ids: ["shared"], name: "repos" }] },
    },
  ];
  const rs = createPackageRsClient({ fetch, members, providerUrl: PROVIDER });

  const ambiguous = await rs.getJson("/v1/streams/repos/records", {
    query: { connection_id: "shared" },
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.status, 409);
  assert.equal((ambiguous.error as PackageRsErrorEnvelope).code, "ambiguous_connection");
  assert.equal((ambiguous.error as PackageRsErrorEnvelope).retry_with, "source_id");
  assert.deepEqual(calls, []);

  await Promise.all(
    (
      [
        ["/v1/schema", { connection_id: "shared", stream: "repos" }],
        ["/v1/streams", { connection_id: "shared" }],
        ["/v1/search", { connection_id: "shared", q: "term", streams: ["repos"] }],
      ] as const
    ).map(async ([path, query]) => {
      const response = await rs.getJson(path, { query });
      assert.equal(response.ok, false, path);
      assert.equal(response.status, 409, path);
      assert.equal((response.error as PackageRsErrorEnvelope).retry_with, "source_id", path);
      assert.deepEqual(calls, [], path);
    })
  );
  const ambiguousEvent = await rs.postJson("/v1/event-subscriptions", {
    body: { callback_url: "https://x/y", connection_id: "shared" },
  });
  assert.equal(ambiguousEvent.ok, false);
  assert.equal(ambiguousEvent.status, 409);
  assert.equal((ambiguousEvent.error as PackageRsErrorEnvelope).retry_with, "source_id");
  assert.deepEqual(calls, []);

  const selected = await rs.getJson("/v1/streams/repos/records", {
    query: { connection_id: "shared", source_id: "github" },
  });
  assert.equal(selected.ok, true);
  assert.deepEqual(
    (calls as Array<{ token: string }>).map((call) => call.token),
    ["tok_A"]
  );
  assert.equal(
    (calls as Array<{ query: string }>)[0]?.query,
    "connection_id=shared",
    "package-only source selector is not forwarded"
  );

  calls.length = 0;
  const mismatch = await rs.getJson("/v1/streams/repos/records", {
    query: { connection_id: "shared", source_id: "missing" },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 404);
  assert.deepEqual(calls, []);

  const assertSelectedSurface = async (path: string, query: Record<string, string | string[]>) => {
    calls.length = 0;
    const response = await rs.getJson(path, { query });
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(response.error)}`);
    assert.deepEqual(
      (calls as Array<{ token: string }>).map((call) => call.token),
      ["tok_A"],
      path
    );
    const [firstCall] = observedCalls();
    assert.ok(firstCall);
    assert.equal(firstCall.query.includes("source_id"), false, path);
  };
  await assertSelectedSurface("/v1/schema", {
    connection_id: "shared",
    source_id: "github",
    stream: "repos",
  });
  await assertSelectedSurface("/v1/streams", { connection_id: "shared", source_id: "github" });
  await assertSelectedSurface("/v1/search", {
    connection_id: "shared",
    q: "term",
    source_id: "github",
    streams: ["repos"],
  });

  calls.length = 0;
  const event = await rs.postJson("/v1/event-subscriptions", {
    body: { callback_url: "https://x/y", connection_id: "shared", source_id: "github" },
  });
  assert.equal(event.ok, true);
  assert.deepEqual(
    (calls as Array<{ token: string }>).map((call) => call.token),
    ["tok_A"]
  );
});

test("query_records ambiguity is fast and does not probe child health", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { limit: 10 } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_connection");
  assert.deepEqual(
    (error.available_connections ?? []).map((entry) => entry.connection_id),
    ["gh_main", "slack_main"]
  );
  assert.equal(error.unavailable_connections, undefined);
});

test("query_records with selected invalid child preserves the child grant_invalid response", async () => {
  let aCalled = 0;
  let bCalled = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      aCalled += 1;
    }
    if (req.token === "tok_B") {
      bCalled += 1;
    }
    if (req.token === "tok_B" && req.path === "/v1/streams/repos/records") {
      return jsonResponse(403, {
        error: { code: "grant_invalid", message: "Grant is no longer usable", type: "grant_invalid" },
      });
    }
    return jsonResponse(200, { data: [] });
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { connection_id: "slack_main" } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal((out.error as PackageRsErrorEnvelope).code, "grant_invalid");
  assert.equal(aCalled, 0);
  assert.equal(bCalled, 1);
});

test("query_records with unknown connection_id returns not_found", async () => {
  const fetch = makeRouter(async () => jsonResponse(200, { data: [] }));
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { connection_id: "unknown" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal((out.error as PackageRsErrorEnvelope).code, "not_found");
});

test("fetch_blob (getRaw) requires selector and never returns multi-source default", async () => {
  const calls: { path: string; token: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(200, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getRaw("/v1/blobs/blob-xyz");
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.deepEqual(calls, [], "blob ambiguity is computed without child health probes");
});

test("create_event_subscription with multi-source package requires connection_id", async () => {
  const calls: { path: string; token: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    calls.push({ path: req.path, token: req.token });
    return jsonResponse(201, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.postJson("/v1/event-subscriptions", { body: { callback_url: "https://x/y" } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.deepEqual(calls, [], "event-sub ambiguity is computed without child health probes");
});

test("create_event_subscription with single-source package infers the child", async () => {
  const tokensSeen: string[] = [];
  const bodiesSeen: { callback_url?: string; connection_id?: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    tokensSeen.push(req.token);
    const body = req.body as { callback_url?: string; connection_id?: string };
    bodiesSeen.push(body);
    return jsonResponse(201, {
      callback_url: body.callback_url,
      created_at: "2026-05-27T00:00:00Z",
      secret: "whsec_x",
      status: "pending_verification",
      subscription_id: "sub_1",
    });
  });
  const rs = createPackageRsClient({ fetch, members: [memberA()], providerUrl: PROVIDER });
  const out = await rs.postJson("/v1/event-subscriptions", { body: { callback_url: "https://x/y" } });
  assert.equal(out.ok, true);
  assert.deepEqual(tokensSeen, ["tok_A"]);
  // connection_id key never forwarded to RS even if accidentally sent (single-source path doesn't pass one).
  assert.equal(bodiesSeen[0]?.connection_id, undefined);
});

test("create_event_subscription routes to selected child and strips connection_id from RS body", async () => {
  const tokensSeen: string[] = [];
  const bodiesSeen: { callback_url?: string; connection_id?: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    tokensSeen.push(req.token);
    bodiesSeen.push(req.body as { callback_url?: string; connection_id?: string });
    return jsonResponse(201, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  await rs.postJson("/v1/event-subscriptions", {
    body: { callback_url: "https://x/y", connection_id: "slack_main" },
  });
  assert.deepEqual(tokensSeen, ["tok_B"]);
  assert.equal(bodiesSeen[0]?.connection_id, undefined, "PackageRsClient strips selector before forwarding");
});

test("list_event_subscriptions fans out across children and merges with source tags", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.token === "tok_A") {
      return jsonResponse(200, { data: [{ subscription_id: "sub_a" }] });
    }
    if (req.token === "tok_B") {
      return jsonResponse(200, { data: [{ subscription_id: "sub_b1" }, { subscription_id: "sub_b2" }] });
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/event-subscriptions");
  assert.equal(out.ok, true);
  const body = out.body as { data: { source?: { grant_id?: string } }[] };
  assert.equal(body.data.length, 3);
  for (const row of body.data) {
    assert.ok(row.source?.grant_id);
  }
});

test("get_event_subscription locates owning child via per-member probe", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.path === "/v1/event-subscriptions/sub_xyz") {
      if (req.token === "tok_A") {
        return jsonResponse(404, { error: { code: "not_found", type: "not_found" } });
      }
      if (req.token === "tok_B") {
        return jsonResponse(200, { status: "active", subscription_id: "sub_xyz" });
      }
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/event-subscriptions/sub_xyz");
  assert.equal(out.ok, true);
  assert.equal((out.body as { subscription_id: string }).subscription_id, "sub_xyz");
});

test("delete_event_subscription locates owning child and forwards under that bearer", async () => {
  const deleteTokens: string[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    if (req.method === "GET" && req.path === "/v1/event-subscriptions/sub_xyz") {
      if (req.token === "tok_A") {
        return jsonResponse(404, { error: { type: "not_found" } });
      }
      if (req.token === "tok_B") {
        return jsonResponse(200, { subscription_id: "sub_xyz" });
      }
    }
    if (req.method === "DELETE" && req.path === "/v1/event-subscriptions/sub_xyz") {
      deleteTokens.push(req.token);
      return jsonResponse(204, null);
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.deleteJson("/v1/event-subscriptions/sub_xyz");
  assert.equal(out.ok, true);
  assert.deepEqual(deleteTokens, ["tok_B"]);
});

test("unknown event subscription returns adapter not_found without touching record/RS state", async () => {
  const fetch = makeRouter(async () => jsonResponse(404, { error: { type: "not_found" } }));
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/event-subscriptions/nope");
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal((out.error as PackageRsErrorEnvelope).code, "not_found");
});

// Spec: openspec/changes/canonicalize-connector-keys/specs/agent-consent-bundling/spec.md
// available_connections entries MUST include grant_id, connector_key, connection_id (not connector_id).
// These are regression tests for task 5.3.

test("ambiguous_connection error envelope includes grant_id and connector_key (not connector_id)", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/repos/records", { query: { limit: 10 } });
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_connection");
  const conns = error.available_connections ?? [];
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok("grant_id" in entry, "available_connections entry must carry grant_id");
    assert.ok("connector_key" in entry, "available_connections entry must carry connector_key (not connector_id)");
    assert.ok("connection_id" in entry, "available_connections entry must carry connection_id");
    assert.ok(!("connector_id" in entry), "available_connections entry must NOT advertise connector_id");
  }
  assert.equal(conns[0]?.grant_id, "grant_A");
  assert.equal(conns[0]?.connector_key, "github");
  assert.equal(conns[0]?.connection_id, "gh_main");
  assert.equal(conns[1]?.grant_id, "grant_B");
  assert.equal(conns[1]?.connector_key, "slack");
  assert.equal(conns[1]?.connection_id, "slack_main");
});

test("ambiguous_connection caps large packages and points callers at schema for the full index", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous read should not touch child grant ${req.token} ${req.path}`);
  });
  const members = Array.from({ length: 25 }, (_, index) => ({
    connection_id: `conn_${index}`,
    grant_id: `grant_${index}`,
    source: { id: index % 2 === 0 ? "slack" : "gmail", kind: "connector" },
    token: `tok_${index}`,
  }));
  const rs = createPackageRsClient({ fetch, members, providerUrl: PROVIDER });
  const out = await rs.getJson("/v1/streams/messages/records", { query: { limit: 10 } });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_connection");
  assert.equal((error.available_connections ?? []).length, 12);
  assert.equal(error.available_connection_count, 25);
  assert.equal(error.available_connections_truncated, true);
  assert.equal(error.available_connections_omitted, 13);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(error.discovery_hint ?? "", /schema/);
});

test("not_found error envelope includes grant_id and connector_key for event subscription create", async () => {
  const fetch = makeRouter(async () => jsonResponse(500, {}));
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.postJson("/v1/event-subscriptions", {
    body: { callback_url: "https://x/y", connection_id: "unknown_conn" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "not_found");
  const conns = error.available_connections ?? [];
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok("grant_id" in entry, "not_found envelope must carry grant_id per member");
    assert.ok("connector_key" in entry, "not_found envelope must carry connector_key (not connector_id)");
    assert.ok(!("connector_id" in entry), "not_found envelope must NOT advertise connector_id");
  }
});

test("create_event_subscription ambiguous envelope carries connector_key and grant_id", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    assert.fail(`ambiguous event-sub write should not touch child grant ${req.token} ${req.path}`);
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PROVIDER });
  const out = await rs.postJson("/v1/event-subscriptions", { body: { callback_url: "https://x/y" } });
  const error = out.error as PackageRsErrorEnvelope;
  assert.equal(error.code, "ambiguous_connection");
  const conns = error.available_connections ?? [];
  assert.equal(conns.length, 2);
  for (const entry of conns) {
    assert.ok("grant_id" in entry);
    assert.ok("connector_key" in entry);
    assert.ok(!("connector_id" in entry));
  }
});

// ---------------------------------------------------------------------------
// F1 regression — route hosted-MCP package-adapter self-calls to the internal
// base, not the public edge that 405s PATCH.
//
// Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
//
// `createPackageRsClient` takes a single `providerUrl` that becomes every
// child RsClient's fetch base. Before the fix, `handleHostedMcp` passed the
// public `resource` (the externally-fronted origin) here, so a server-internal
// PATCH self-call hairpinned through the public edge — which 405s PATCH —
// producing a typed `rs_error` `http_405`. After the fix the adapter passes the
// internal RS base (`referenceTopology.rsInternalUrl`) here while the advertised
// resource/discovery/`providerUrl` stay public; that split is exercised at the
// `createPackageRsClient` boundary below.
const PUBLIC_EDGE = "https://pdpp.test"; // advertised resource; edge 405s PATCH
const INTERNAL_BASE = "http://localhost:7663"; // configured internal RS; method-routes PATCH

// A 405 with no JSON body — exactly what a method-blocking reverse proxy
// returns. A non-JSON, empty body flows through rs-client's parseRsResponse →
// normalizeErrorEnvelope as the typed { type: 'rs_error', code: 'http_405' }.
function bodilessMethodNotAllowed(): Response {
  return new Response("", { headers: { "content-type": "text/plain" }, status: 405 });
}

interface RecordedCall {
  method: string;
  origin: string;
  token: string;
}

// Host-aware router: the public edge 405s every PATCH; the internal base
// method-routes PATCH. GET (the locate probe) is allowed on either host.
function makeHostAwareRouter(recorder: RecordedCall[] | null): FakeFetch {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  return makeRouter(async (req) => {
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const origin = req.url.origin;
    // Public edge drops PATCH regardless of path (measured behavior of the
    // external reverse proxy fronting the public origin).
    if (req.method === "PATCH" && origin === PUBLIC_EDGE) {
      return bodilessMethodNotAllowed();
    }
    // Locate probe: GET per child to find the owning grant. tok_B owns sub_xyz.
    if (req.method === "GET" && req.path === "/v1/event-subscriptions/sub_xyz") {
      if (req.token === "tok_B") {
        return jsonResponse(200, { status: "active", subscription_id: "sub_xyz" });
      }
      return jsonResponse(404, { error: { code: "not_found", type: "not_found" } });
    }
    // The actual PATCH self-call against the internal base (method-routed).
    if (req.method === "PATCH" && req.path === "/v1/event-subscriptions/sub_xyz" && origin === INTERNAL_BASE) {
      if (recorder) {
        recorder.push({ method: req.method, origin, token: req.token });
      }
      return jsonResponse(200, { subscription: { status: "disabled", subscription_id: "sub_xyz" } });
    }
    return jsonResponse(500, { error: { code: "unexpected_route", type: "unexpected" } });
  });
}

test("F1: package-token update routes PATCH to the internal base, not the public edge that 405s", async () => {
  const recorded: RecordedCall[] = [];
  const fetch = makeHostAwareRouter(recorded);
  // The fix passes the INTERNAL base as the child fetch base while the
  // advertised resource stays public; here we model that by constructing the
  // client against the internal base.
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: INTERNAL_BASE });
  const out = await rs.patchJson("/v1/event-subscriptions/sub_xyz", { body: { enabled: false } });

  assert.equal(out.ok, true, "PATCH succeeds when routed to the internal base");
  assert.equal(out.status, 200);
  // The regression guard: we did NOT inherit the public edge's 405.
  assert.notEqual((out.error as PackageRsErrorEnvelope | undefined)?.code, "http_405");
  // The self-call hit the internal base, not the public edge.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.origin, INTERNAL_BASE);
  assert.equal(recorded[0]?.method, "PATCH");
  // Owning-child bearer preserved — no authority widening.
  assert.equal(recorded[0]?.token, "tok_B");
});

test("F1 falsifiability: PATCH against the public edge yields http_405 (pre-fix behavior)", async () => {
  const fetch = makeHostAwareRouter(null);
  // Pre-fix: the adapter used the public resource as the child fetch base.
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PUBLIC_EDGE });
  const out = await rs.patchJson("/v1/event-subscriptions/sub_xyz", { body: { enabled: false } });

  assert.equal(out.ok, false, "PATCH fails when routed through the public edge");
  assert.equal(out.status, 405);
  assert.equal(
    (out.error as PackageRsErrorEnvelope).code,
    "http_405",
    "public-edge PATCH surfaces the typed http_405 error"
  );
});

test("F1 fallback parity: GET/POST/DELETE still succeed through the public base (only PATCH is edge-blocked)", async () => {
  // With the internal base unset the adapter falls back to the public resource.
  // GET/POST/DELETE pass the edge today; only PATCH is dropped — so the public
  // fallback preserves all non-PATCH behavior. Asserting GET here proves the
  // fix is needed precisely (and only) for the method the edge blocks.
  let getProbes = 0;
  let deletes = 0;
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const fetch = makeRouter(async (req) => {
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const origin = req.url.origin;
    if (req.method === "PATCH" && origin === PUBLIC_EDGE) {
      return bodilessMethodNotAllowed();
    }
    if (req.method === "GET" && req.path === "/v1/event-subscriptions/sub_xyz") {
      getProbes += 1;
      if (req.token === "tok_B") {
        return jsonResponse(200, { status: "active", subscription_id: "sub_xyz" });
      }
      return jsonResponse(404, { error: { code: "not_found", type: "not_found" } });
    }
    if (req.method === "DELETE" && req.path === "/v1/event-subscriptions/sub_xyz") {
      deletes += 1;
      return jsonResponse(204, null);
    }
    return jsonResponse(500, {});
  });
  const rs = createPackageRsClient({ fetch, members: [memberA(), memberB()], providerUrl: PUBLIC_EDGE });

  const got = await rs.getJson("/v1/event-subscriptions/sub_xyz");
  assert.equal(got.ok, true, "GET passes the public edge (fallback parity)");
  assert.ok(getProbes >= 1);

  const deleted = await rs.deleteJson("/v1/event-subscriptions/sub_xyz");
  assert.equal(deleted.ok, true, "DELETE passes the public edge (fallback parity)");
  assert.equal(deletes, 1);
});

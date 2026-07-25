// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer, handleStreamableHttpRequest } from "../src/server.ts";
import { __internal } from "../src/tools.ts";

const PDPP_SCHEMA_CONNECTORS_STREAMS = /PDPP schema: connectors=1 streams=1/;
const STREAM_NAME_CONVERSATIONS = /stream name="conversations"/;
const CONNECTOR_KEY_CLAUDE_CODE = /connector_key="claude-code"/;
const DISPLAY_NAME_CLAUDE_CODE = /display_name="Claude Code"/;
const CONNECTIONS_CONNECTION_ID_CONN_WORK = /connections=\{connection_id:conn_work,display_name:Work_Claude\}/;
const CALL_SCHEMA_STREAM_CONNECTION_ID = /call schema\(stream, connection_id\?\) for per-field capability flags/;
const ID_T_STRING_EQ = /id\[t=string,eq\]/;
const T_STRING = /t=string/;
const EQ = /(^|,)eq(,|$)/;
const R_GTE_LT = /r=gte\|lt/;
const FIELD_CAPABILITY_LEGEND = /field_capability_legend/;
const CREATED_AT_T_TIMESTAMP_R = /created_at\[t=timestamp,r=gte\|lt,a=group_by_time\]/;
const SENDER_T_STRING_EQ_A = /sender\[t=string,eq,a=count_distinct\|group_by\]/;
const AGGREGATIONS_COUNT_DISTINCT_SENDER_GROUP =
  /aggregations=count_distinct=sender;group_by=sender;group_by_time=created_at/;
const SEE_STRUCTUREDCONTENT_DATA = /See structuredContent\.data/;
const RECORDS_FROM_STREAM_ORDERS_RECORD = /records from stream "orders": 2 record\(s\)/;
const HAS_MORE_TRUE = /has_more=true/;
const NEXT_CURSOR_CURSOR_ORDERS_PAGE = /next_cursor="cursor_orders_page_2"/;
const NEXT_CHANGES_SINCE_CHANGES_ORDERS = /next_changes_since="changes_orders_next"/;
const COUNT_EXACT = /count=exact:42/;
const RECORD_ID_O_AMOUNT = /record\[0\] \{"id":"o1","amount":12\}/;
const RECORD_ID_O_AMOUNT_2 = /record\[1\] \{"id":"o2","amount":99\}/;
const PDPP_RECORD = /pdpp:\/\/record\//;
const BINARY_FIELD = /binary_field/;
const BINARY_ONLY = /binary-only/;
const QUJDQUJDQUJDQUJD = /QUJDQUJDQUJDQUJD/;
const UNSUPPORTED_EXTRA_UNRECOGNIZED_KEY = /unsupported_extra|Unrecognized key/;
const PDPP_FIELD_WINDOW = /pdpp:\/\/field-window\//;
const PASTA_ORDER = /Pasta order /;
const SEARCH_HIT = /search: 1 hit/i;
const NEXT_CURSOR_SEARCH_CURSOR_PAGE = /next_cursor="search_cursor_page_2"/;
const ID_CONN_ORDERS_ORDERS_O = /id=conn_orders\/orders:o2/;
const CONNECTION_ID = /connection_id=/;
const PASTA_ORDER_2 = /Pasta order/;
const STRUCTUREDCONTENT = /structuredContent/;
const EVIDENCE_EXCERPTS = /Evidence excerpts:/;
const FIELD_PATH_TEXT_SNIPPET_PASTA = /field_path=text snippet="Pasta order for \$99\."/;
const READ_READ_RECORD_FIELD = /read=read_record_field/;
const JEREMY_AND_I_HAD_A = /Jeremy and I had a call with Redactable yesterday/;
const ID_S = /id=([^\s]+)/;
const RECORD_CONN_ORDERS_ORDERS_O = /record=conn_orders\/orders:o2/;
const NEXT_CURSOR = /next_cursor=12/;
const EXCLUSIVE = /exclusive/;
const CURSOR = /cursor/;
const PDPP_RECORD_A_ZA_Z = /^pdpp:\/\/record\/[A-Za-z0-9_-]+$/;
const O = /[:/]o2$/;
const NEXT_READ_RECORD_FIELD_ARGS = /next read_record_field args=/;
const ID_CONN_ORDERS_ORDERS_O_2 = /"id":"conn_orders\/orders:o2"/;
const FIELD_PATH_TEXT = /"field_path":"text"/;
const MALFORMED_RESOURCE_HANDLE = /malformed|Resource handle/;
const INVALID_CHARACTERS = /invalid characters/;

interface FetchCall {
  auth: string | undefined;
  method: string;
  url: string;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function firstText(result: { [key: string]: unknown; content?: readonly unknown[] }): string {
  const first = result.content?.[0] as { text?: string; type?: string } | undefined;
  assert.equal(first?.type, "text", "first content block must be text");
  return first?.text ?? "";
}

function contentParts(result: { [key: string]: unknown; content?: readonly unknown[] }): Array<{
  text?: string;
  type?: string;
}> {
  return (result.content ?? []) as Array<{ text?: string; type?: string }>;
}

interface LadderField {
  encoding?: string;
  field_path?: string;
  mime_type?: string;
  preview_status?: string;
  preview_text?: string;
  read?: { args?: Record<string, unknown>; tool?: string };
  resource_uri?: unknown;
  text_like?: boolean;
}

interface LadderRecord {
  binary_fields?: LadderField[];
  field_windows?: LadderField[];
  id?: string;
  json_fields?: LadderField[];
  record_uri?: unknown;
}

interface ContentLadder {
  kind?: string;
  records?: LadderRecord[];
}

function resourceText(content: unknown): string {
  assert.ok(content && typeof content === "object", "expected at least one resource content entry");
  const { text } = content as Record<string, unknown>;
  assert.equal(typeof text, "string", "expected a text resource content entry");
  return text as string;
}

function contentLadder(result: { [key: string]: unknown; structuredContent?: unknown }): ContentLadder {
  const structuredContent = result.structuredContent as { content_ladder?: ContentLadder } | undefined;
  const ladder = structuredContent?.content_ladder;
  assert.ok(ladder, "result must carry a content_ladder");
  return ladder;
}

/**
 * Build a fetch implementation that emulates the PDPP RS for one scoped token. The same
 * fixture is used for direct comparisons so tests can assert MCP output matches what a
 * direct curl-style call would return under the same token.
 */
function makeFakeRs() {
  const SCHEMA = { version: "1", streams: ["orders", "emails"] };
  const STREAMS = { streams: [{ name: "orders" }, { name: "emails" }] };
  const ORDERS = {
    records: [
      { id: "o1", amount: 12 },
      { id: "o2", amount: 99 },
    ],
    has_more: true,
    next_cursor: "cursor_orders_page_2",
    next_changes_since: "changes_orders_next",
    meta: { count: { kind: "exact", value: 42 } },
  };
  // Mirrors the real RS lexical-search envelope: a hit carries `snippet` plus
  // first-class `evidence_excerpts` (field_path + preview_text), and NO
  // `match_windows`. The MCP adapter must surface the excerpt text in visible
  // content from this shape alone.
  const SEARCH = {
    has_more: true,
    next_cursor: "search_cursor_page_2",
    hits: [
      {
        stream: "orders",
        id: "o2",
        title: "Order o2",
        url: "https://merchant.test/o2",
        connection_id: "conn_orders",
        display_name: "Merchant orders",
        snippet: { field: "text", text: "Pasta order for $99." },
        evidence_excerpts: [
          {
            object: "evidence_excerpt",
            field_path: "text",
            preview_text: "Pasta order for $99.",
            truncated: false,
            provenance: "lexical_match",
          },
        ],
        score: 0.7,
      },
    ],
  };
  const ORDER_O2 = {
    id: "o2",
    stream: "orders",
    title: "Order o2",
    text: "Pasta order for $99.",
    url: "https://merchant.test/o2",
    connection_id: "conn_orders",
    display_name: "Merchant orders",
    metadata: { amount: 99 },
  };
  const CONVERSATION_C1 = {
    object: "record",
    id: "c1",
    stream: "conversations",
    data: {
      id: "c1",
      title: "Redactable developer ODCs",
      content: "Jeremy and I had a call with Redactable yesterday and I was so unimpressed.",
      url: "https://chatgpt.test/c/c1",
      connection_id: "conn_chatgpt",
      connector_key: "chatgpt",
      display_name: "ChatGPT - user@example.com",
    },
    emitted_at: "2026-04-19T07:16:43.755Z",
    connection_id: "conn_chatgpt",
    connector_instance_id: "conn_chatgpt",
    display_name: "ChatGPT - user@example.com",
  };
  const SLACK_MESSAGE_M1 = {
    id: "m1",
    stream: "messages",
    text: "A Slack message without an explicit title.",
    sent_at: "2026-04-20T14:23:13.467Z",
    emitted_at: "2026-06-09T00:00:00.000Z",
    connection_id: "conn_slack",
    connector_key: "slack",
    display_name: "Acme Slack",
  };
  const STREAM_META = { name: "orders", record_count: 2 };
  const BLOB = Buffer.from([10, 20, 30, 40, 50]);
  const LARGE_IMAGE_BASE64 = "QUJD".repeat(96);
  const MEDIA = {
    records: [
      {
        id: "img1",
        filename: "cat.png",
        image_blob: {
          blob_id: "blob-1",
          mime_type: "image/png",
          size_bytes: BLOB.length,
          digest: "sha256:blob-1",
          fetch_url: "pdpp://blob/blob-1",
        },
        image_data: LARGE_IMAGE_BASE64,
        image_metadata: { width: 640, height: 480, labels: ["cat", "indoor"] },
      },
    ],
  };

  const calls: FetchCall[] = [];

  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url: url.toString(), auth, method: init.method ?? "GET" });

    if (auth !== "Bearer scoped-token") {
      return new Response(
        JSON.stringify({ error: { type: "authentication", code: "invalid_token", message: "bad token" } }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    }

    if (url.pathname === "/v1/schema") {
      if (url.searchParams.get("detail") === "full" && !url.searchParams.get("stream")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request",
              code: "invalid_request",
              param: "detail",
              message: 'schema detail "full" requires `stream`',
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return jsonResponse(schemaBodyForQuery(SCHEMA, url));
    }
    if (url.pathname === "/v1/streams") {
      return jsonResponse(STREAMS);
    }
    if (url.pathname === "/v1/streams/orders") {
      return jsonResponse(STREAM_META);
    }
    if (url.pathname === "/v1/streams/orders/records") {
      const limit = url.searchParams.get("limit");
      const fields = url.searchParams.getAll("fields");
      return jsonResponse({ ...ORDERS, _echo: { limit, fields } });
    }
    if (url.pathname === "/v1/streams/media/records") {
      return jsonResponse(MEDIA);
    }
    if (url.pathname === "/v1/streams/orders/records/o2") {
      return jsonResponse(ORDER_O2);
    }
    if (url.pathname === "/v1/streams/orders/records/o2/field-window") {
      if (url.searchParams.get("field") === "forbidden") {
        return new Response(
          JSON.stringify({
            error: {
              type: "authorization",
              code: "field_not_granted",
              message: "field 'forbidden' not within granted projection",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
      const source = ORDER_O2.text;
      const q = url.searchParams.get("q");
      const before = Number.parseInt(url.searchParams.get("before_chars") ?? "0", 10);
      const after = Number.parseInt(url.searchParams.get("after_chars") ?? "0", 10);
      const matchStart = q ? source.indexOf(q) : -1;
      const offset = q
        ? Math.max(0, matchStart - before)
        : Number.parseInt(url.searchParams.get("offset_chars") ?? "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit_chars") ?? "16", 10);
      const qEnd = q ? matchStart + q.length + after : null;
      const end = Math.min(source.length, qEnd ?? offset + limit);
      return jsonResponse({
        object: "field_window",
        stream: "orders",
        record_id: "o2",
        field: { path: url.searchParams.get("field") ?? "text", type: "string" },
        window: {
          text: source.slice(offset, end),
          start_chars: offset,
          end_chars: end,
          limit_chars: limit,
          total_chars: source.length,
          complete: end >= source.length,
          has_more: end < source.length,
          match_start_chars: q ? matchStart : null,
          match_end_chars: q ? matchStart + q.length : null,
          next_offset_chars: end < source.length ? end : null,
          previous_offset_chars: offset > 0 ? Math.max(0, offset - limit) : null,
        },
        url: url.pathname,
      });
    }
    if (url.pathname === "/v1/streams/conversations/records/c1") {
      return jsonResponse(CONVERSATION_C1);
    }
    if (url.pathname === "/v1/streams/messages/records/m1") {
      return jsonResponse(SLACK_MESSAGE_M1);
    }
    if (url.pathname === "/v1/streams/missing/records") {
      return new Response(
        JSON.stringify({
          error: { type: "invalid_request", code: "unsupported_query", message: "unknown stream" },
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    if (url.pathname === "/v1/search") {
      if (url.searchParams.get("q") === "untitled") {
        return jsonResponse({
          hits: [
            {
              stream: "messages",
              id: "m1",
              sent_at: "2026-04-20T14:23:13.467Z",
              emitted_at: "2026-06-09T00:00:00.000Z",
              connection_id: "conn_slack",
              connector_key: "slack",
              display_name: "Acme Slack",
              snippet: { text: "A Slack message without an explicit title." },
            },
          ],
        });
      }
      if (url.searchParams.get("q") === "nested-untitled") {
        return jsonResponse({
          hits: [
            {
              stream: "messages",
              id: "m2",
              data: { sent_at: "2026-04-08T16:57:06.018Z" },
              emitted_at: "2026-04-20T14:23:13.467Z",
              connection_id: "conn_slack",
              connector_key: "slack",
              display_name: "Acme Slack",
              snippet: { text: "A nested Slack message without an explicit title." },
            },
          ],
        });
      }
      return jsonResponse({ ...SEARCH, _echo: { q: url.searchParams.get("q") } });
    }
    if (url.pathname === "/v1/blobs/blob-1") {
      return new Response(BLOB, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    return new Response(JSON.stringify({ error: { type: "not_found", code: "not_found", message: url.pathname } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

interface FieldCapabilityOptions {
  aggregations?: string[];
  exact?: boolean;
  granted?: boolean;
  lexical?: boolean;
  rangeOps?: string[] | null;
  semantic?: boolean;
  type?: string;
}

function makeDiscoveryFakeRs() {
  const fieldCapability = ({
    type,
    granted = true,
    exact = false,
    rangeOps = null,
    lexical = false,
    semantic = false,
    aggregations = [],
  }: FieldCapabilityOptions) => ({
    ...(type ? { type } : {}),
    schema: { type: type === "timestamp" ? "string" : type || "string" },
    granted,
    exact_filter: { declared: exact, usable: exact && granted },
    range_filter: rangeOps
      ? { declared: true, usable: granted, operators: rangeOps }
      : { declared: false, usable: false },
    lexical_search: { declared: lexical, usable: lexical && granted },
    semantic_search: { declared: semantic, usable: semantic && granted },
    aggregation: Object.fromEntries(
      ["sum", "min", "max", "group_by", "group_by_time", "count_distinct"].map((name) => [
        name,
        { declared: aggregations.includes(name), usable: granted && aggregations.includes(name) },
      ])
    ),
  });

  const SCHEMA = {
    data: {
      object: "schema",
      connector_count: 1,
      stream_count: 1,
      connectors: [
        {
          object: "connector",
          connector_id: "claude-code",
          source: { kind: "connector", id: "claude-code", display_name: "Claude Code" },
          stream_count: 1,
          streams: [
            {
              object: "stream_metadata",
              name: "conversations",
              granted_connections: [{ connection_id: "conn_work", display_name: "Work Claude" }],
              field_capabilities: {
                id: fieldCapability({ type: "string", exact: true }),
                created_at: fieldCapability({
                  type: "timestamp",
                  rangeOps: ["gte", "lt"],
                  aggregations: ["group_by_time"],
                }),
                sender: fieldCapability({ type: "string", exact: true, aggregations: ["count_distinct", "group_by"] }),
                title: fieldCapability({ type: "text", lexical: true, semantic: true }),
              },
              expand_capabilities: [],
            },
          ],
        },
      ],
    },
  };
  const STREAMS = {
    object: "list",
    data: [
      {
        object: "stream",
        name: "conversations",
        record_count: 12,
        connection_id: "conn_work",
        display_name: "Work Claude",
        source: {
          grant_id: "grant_pkg_1",
          connector_key: "claude-code",
          connection_id: "conn_work",
          display_name: "Work Claude",
        },
      },
      {
        object: "stream",
        name: "messages",
        record_count: 5,
        connection_id: "conn_personal",
        display_name: "Personal Claude",
        source: {
          grant_id: "grant_pkg_2",
          connector_key: "claude-code",
          connection_id: "conn_personal",
          display_name: "Personal Claude",
        },
      },
    ],
  };

  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL) => {
    const url = new URL(urlInput.toString());
    if (url.pathname === "/v1/schema") {
      return jsonResponse(schemaBodyForQuery(SCHEMA, url));
    }
    if (url.pathname === "/v1/streams") {
      return jsonResponse(STREAMS);
    }
    return new Response(JSON.stringify({ error: { type: "not_found", code: "not_found", message: url.pathname } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, schemaBody: SCHEMA, streamsBody: STREAMS };
}

function schemaBodyForQuery(schema: Record<string, unknown>, url: URL): unknown {
  const streamName = url.searchParams.get("stream");
  if (!streamName) {
    return schema;
  }
  if (Array.isArray(schema.streams)) {
    const streams = schema.streams.filter((entry) => schemaStreamName(entry) === streamName);
    return { ...schema, streams, stream_count: streams.length };
  }
  const { data } = schema;
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).streams)) {
    const dataRecord = data as Record<string, unknown>;
    const streams = (dataRecord.streams as unknown[]).filter((entry) => schemaStreamName(entry) === streamName);
    return { ...schema, data: { ...dataRecord, streams, stream_count: streams.length } };
  }
  return schema;
}

function schemaStreamName(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry;
  }
  const row = entry as Record<string, unknown> | null | undefined;
  return (
    (row?.name as string | undefined) ??
    (row?.stream as string | undefined) ??
    (row?.stream_name as string | undefined) ??
    null
  );
}

async function connectClient(fakeFetch: typeof fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: "https://provider.test",
    accessToken: "scoped-token",
    fetch: fakeFetch,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("lists the expected tools and annotates read-only tools as read-only", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]);

  const READ_ONLY = new Set(["aggregate", "schema", "query_records", "search", "fetch", "read_record_field"]);
  for (const tool of tools.tools) {
    assert.ok(READ_ONLY.has(tool.name), `${tool.name} must be part of the read-only normal surface`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint=true`);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
  }

  await client.close();
  await server.close();
});

test("schema detail=full requires stream to avoid global schema blowups", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: "schema", arguments: { detail: "full" } });
  assert.equal(result.isError, true);
  const errorContent = result.structuredContent as { error?: { code?: string; param?: string } };
  assert.equal(errorContent.error?.code, "invalid_request");
  assert.equal(errorContent.error?.param, "detail");
  assert.equal(
    calls.filter((call) => new URL(call.url).pathname === "/v1/schema").length,
    1,
    "global full rejection is canonical RS behavior, not MCP-local preflight"
  );

  const scoped = await client.callTool({ name: "schema", arguments: { stream: "orders", detail: "full" } });
  assert.equal(scoped.isError, undefined);
  const scopedContent = scoped.structuredContent as { data?: unknown };
  assert.deepEqual(scopedContent.data, { version: "1", streams: ["orders"], stream_count: 1 });
  const schemaCall = calls.find((call) => new URL(call.url).pathname === "/v1/schema");
  assert.ok(schemaCall, "scoped full must hit /v1/schema");
  assert.equal(schemaCall.auth, "Bearer scoped-token");
  const schemaCalls = calls
    .filter((call) => new URL(call.url).pathname === "/v1/schema")
    .map((call) => new URL(call.url));
  assert.equal(schemaCalls.length, 2, "global full and scoped full should each forward once to RS");
  const [, secondSchemaCall] = schemaCalls;
  assert.ok(secondSchemaCall, "scoped full call must be recorded");
  assert.equal(secondSchemaCall.searchParams.has("view"), false, "full fetch must not request compact view");
  assert.equal(secondSchemaCall.searchParams.get("detail"), "full");
  assert.equal(
    secondSchemaCall.searchParams.get("stream"),
    "orders",
    "scoped full must ask the RS for the selected stream"
  );

  await client.close();
  await server.close();
});

test("discovery tools include parseable stream and schema facts in text content", async () => {
  const { fetch } = makeDiscoveryFakeRs();
  const { client, server } = await connectClient(fetch);

  const schemaResult = await client.callTool({ name: "schema", arguments: {} });
  assert.equal(schemaResult.isError, undefined);
  interface DiscoverySchemaStream {
    field_capabilities?: Record<string, string>;
    granted_connections?: unknown;
  }
  interface DiscoverySchemaConnector {
    granted_connections?: unknown;
    streams: DiscoverySchemaStream[];
  }
  const schemaStructuredContent = schemaResult.structuredContent as {
    data: { connectors: DiscoverySchemaConnector[]; detail?: string };
  };
  // Default detail is compact index-only: stream/source identity survives, but
  // per-field capability detail waits for schema(stream).
  const [compactConnector] = schemaStructuredContent.data.connectors;
  assert.ok(compactConnector, "schema must include at least one connector");
  const [compactStream] = compactConnector.streams;
  assert.ok(compactStream, "connector must include at least one stream");
  assert.equal(compactStream.field_capabilities, undefined, "global schema is an index, not field detail");
  assert.deepEqual(
    compactConnector.granted_connections,
    [{ connection_id: "conn_work", display_name: "Work Claude" }],
    "compact schema must preserve shared connection identity at connector level"
  );
  assert.equal(
    compactStream.granted_connections,
    undefined,
    "compact schema must not repeat shared connection identity per stream"
  );
  assert.equal(schemaStructuredContent.data.detail, "compact");
  const schemaText = firstText(schemaResult);
  assert.match(schemaText, PDPP_SCHEMA_CONNECTORS_STREAMS);
  assert.match(schemaText, STREAM_NAME_CONVERSATIONS);
  assert.match(schemaText, CONNECTOR_KEY_CLAUDE_CODE);
  assert.match(schemaText, DISPLAY_NAME_CLAUDE_CODE);
  assert.match(schemaText, CONNECTIONS_CONNECTION_ID_CONN_WORK);
  assert.match(schemaText, CALL_SCHEMA_STREAM_CONNECTION_ID);
  assert.doesNotMatch(schemaText, ID_T_STRING_EQ);

  const scopedSchema = await client.callTool({ name: "schema", arguments: { stream: "conversations" } });
  const scopedSchemaStructuredContent = scopedSchema.structuredContent as {
    data: { connectors: DiscoverySchemaConnector[] };
  };
  const [scopedConnector] = scopedSchemaStructuredContent.data.connectors;
  assert.ok(scopedConnector, "scoped schema must include at least one connector");
  const [scopedStream] = scopedConnector.streams;
  assert.ok(scopedStream, "scoped connector must include at least one stream");
  assert.equal(typeof scopedStream.field_capabilities?.id, "string", "scoped schema field is a terse flag string");
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — assert.match requires a string argument and field_capabilities?.id/.created_at is string | undefined here; dropping ?? "" fails tsc (TS2769).
  assert.match(scopedStream.field_capabilities?.id ?? "", T_STRING, "scoped flag string keeps declared field type");
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — assert.match requires a string argument and field_capabilities?.id/.created_at is string | undefined here; dropping ?? "" fails tsc (TS2769).
  assert.match(scopedStream.field_capabilities?.id ?? "", EQ, "scoped flag string keeps usable capability flags");
  assert.match(
    // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — assert.match requires a string argument and field_capabilities?.id/.created_at is string | undefined here; dropping ?? "" fails tsc (TS2769).
    scopedStream.field_capabilities?.created_at ?? "",
    R_GTE_LT,
    "scoped flag string keeps usable range operators"
  );
  const scopedText = firstText(scopedSchema);
  assert.match(scopedText, FIELD_CAPABILITY_LEGEND);
  assert.match(scopedText, ID_T_STRING_EQ);
  assert.match(scopedText, CREATED_AT_T_TIMESTAMP_R);
  assert.match(scopedText, SENDER_T_STRING_EQ_A);
  assert.match(scopedText, AGGREGATIONS_COUNT_DISTINCT_SENDER_GROUP);
  assert.doesNotMatch(schemaText, SEE_STRUCTUREDCONTENT_DATA);

  await client.close();
  await server.close();
});

test("query_records forwards supported query params", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "orders", limit: 25, fields: ["id", "amount"] },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { data: { records: unknown } };
  assert.deepEqual(structuredContent.data.records, [
    { id: "o1", amount: 12 },
    { id: "o2", amount: 99 },
  ]);
  const text = firstText(result);
  assert.match(text, RECORDS_FROM_STREAM_ORDERS_RECORD);
  assert.match(text, HAS_MORE_TRUE);
  assert.match(text, NEXT_CURSOR_CURSOR_ORDERS_PAGE);
  assert.match(text, NEXT_CHANGES_SINCE_CHANGES_ORDERS);
  assert.match(text, COUNT_EXACT);
  assert.match(text, RECORD_ID_O_AMOUNT);
  assert.match(text, RECORD_ID_O_AMOUNT_2);
  const scoped = await client.callTool({
    name: "query_records",
    arguments: { stream: "orders", connection_id: "conn_orders", limit: 2 },
  });
  const scopedLadder = contentLadder(scoped);
  assert.equal(scopedLadder.kind, "record_set");
  const scopedLadderRecord = scopedLadder.records?.[0];
  assert.ok(scopedLadderRecord, "content ladder must include at least one record");
  assert.equal(scopedLadderRecord.id, "conn_orders/orders:o1");
  assert.equal(scopedLadderRecord.record_uri, undefined);
  assert.doesNotMatch(JSON.stringify(scopedLadder), PDPP_RECORD);

  const call = calls.find((entry) => entry.url.includes("/v1/streams/orders/records"));
  assert.ok(call, "query_records call must be recorded");
  const callUrl = new URL(call.url);
  assert.equal(callUrl.searchParams.get("limit"), "25");
  assert.deepEqual(callUrl.searchParams.getAll("fields"), ["id", "amount"]);
  assert.equal(callUrl.searchParams.get("cursor"), null);

  await client.close();
  await server.close();
});

test("query_records keeps binary fields metadata-only in text previews and content_ladder", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "media", connection_id: "conn_media", limit: 1 },
  });

  assert.equal(result.isError, undefined);
  const text = firstText(result);
  assert.match(text, BINARY_FIELD);
  assert.match(text, BINARY_ONLY);
  assert.doesNotMatch(text, QUJDQUJDQUJDQUJD);
  const ladderRecord = contentLadder(result).records?.[0];
  assert.ok(ladderRecord, "content ladder must include at least one record");
  assert.equal(ladderRecord.id, "conn_media/media:img1");
  assert.equal(ladderRecord.binary_fields?.length, 2);
  assert.equal(ladderRecord.binary_fields?.[0]?.field_path, "image_blob");
  assert.equal(ladderRecord.binary_fields?.[0]?.mime_type, "image/png");
  assert.equal(ladderRecord.binary_fields?.[1]?.field_path, "image_data");
  assert.equal(ladderRecord.binary_fields?.[1]?.encoding, "base64");
  assert.equal(
    ladderRecord.field_windows?.some((field) => field.field_path === "image_data"),
    false
  );
  assert.equal(ladderRecord.json_fields?.length, 1);
  assert.equal(ladderRecord.json_fields?.[0]?.field_path, "image_metadata");
  assert.equal(ladderRecord.json_fields?.[0]?.read?.tool, "fetch");
  assert.deepEqual(ladderRecord.json_fields?.[0]?.read?.args?.fields, ["image_metadata"]);
  await server.close();
});

test("query_records encodes typed expand_limit as bracket query params", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "orders", expand: ["line_items"], expand_limit: { line_items: 3 } },
  });

  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.url.includes("/v1/streams/orders/records"));
  assert.ok(call, "query_records call must be recorded");
  const callUrl = new URL(call.url);
  assert.deepEqual(callUrl.searchParams.getAll("expand"), ["line_items"]);
  assert.equal(callUrl.searchParams.get("expand_limit[line_items]"), "3");
  assert.equal(callUrl.searchParams.get("expand_limit"), null, "must not forward expand_limit as a JSON object string");

  await client.close();
  await server.close();
});

test("query_records rejects empty or pre-encoded expand_limit objects before hitting RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  for (const expand_limit of [{}, { "expand_limit[line_items]": 3 }]) {
    // biome-ignore lint/performance/noAwaitInLoops: calls share one already-connected client/fake-RS across cases and must run in order to keep the stateful fixture's call recording and assertions deterministic; Promise.all would race the shared state.
    const result = await client.callTool({
      name: "query_records",
      arguments: { stream: "orders", expand: ["line_items"], expand_limit },
    });
    assert.equal(result.isError, true, `expand_limit ${JSON.stringify(expand_limit)} must be rejected`);
    const errorContent = result.structuredContent as { error?: { code?: string } };
    assert.equal(errorContent.error?.code, "invalid_expand");
  }

  assert.equal(
    calls.some((entry) => entry.url.includes("/v1/streams/orders/records")),
    false
  );

  await client.close();
  await server.close();
});

test("query_records rejects unsupported MCP arguments before hitting RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "orders", unsupported_extra: true },
  });

  assert.equal(result.isError, true);
  assert.equal(
    calls.some((entry) => entry.url.includes("/v1/streams/orders/records")),
    false
  );
  assert.match(firstText(result), UNSUPPORTED_EXTRA_UNRECOGNIZED_KEY);

  await client.close();
  await server.close();
});

test("query_records preserves RS error envelope on unsupported query", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "missing" },
  });

  assert.equal(result.isError, true);
  const errorContent = result.structuredContent as { error?: { code?: string }; http_status?: number };
  assert.equal(errorContent.error?.code, "unsupported_query");
  assert.equal(errorContent.http_status, 400);

  await client.close();
  await server.close();
});

test("search tool forwards q and returns hits", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "search",
    arguments: { q: "pasta" },
  });

  assert.equal(result.isError, undefined);
  interface SearchHitEvidence {
    field_path?: string;
    preview_text?: string;
  }
  interface SearchHit {
    evidence_excerpts?: SearchHitEvidence[];
    id?: string;
  }
  const structuredContent = result.structuredContent as {
    data: { _echo?: { q?: string }; hits?: unknown; result_count?: number; results_ref?: string };
    results: SearchHit[];
  };
  assert.equal(structuredContent.data._echo?.q, "pasta");
  assert.equal(structuredContent.data.results_ref, "structuredContent.results");
  assert.equal(structuredContent.data.result_count, 1);
  assert.equal(structuredContent.data.hits, undefined);
  assert.deepEqual(structuredContent.results, [
    {
      // The id is a self-contained fetch handle: the hit's connection is
      // encoded so a model carries ONE opaque value into `fetch`.
      id: "conn_orders/orders:o2",
      title: "Order o2",
      url: "https://merchant.test/o2",
      stream: "orders",
      record_key: "o2",
      connection_id: "conn_orders",
      display_name: "Merchant orders",
      snippet: "Pasta order for $99.",
      // The adapter SYNTHESIZES these from the server's raw `evidence_excerpts`
      // (which carry no read hint of their own): a bounded match window plus a
      // model-callable read_record_field continuation built from the hit id +
      // matched field. This is the seam that makes search excerpts visible.
      match_windows: [
        {
          field_path: "text",
          text: "Pasta order for $99.",
          preview_text: "Pasta order for $99.",
          complete: true,
          read: {
            tool: "read_record_field",
            args: {
              id: "conn_orders/orders:o2",
              field_path: "text",
            },
          },
        },
      ],
      evidence_excerpts: [
        {
          field_path: "text",
          preview_text: "Pasta order for $99.",
          preview_status: "complete",
          read: {
            tool: "read_record_field",
            args: {
              id: "conn_orders/orders:o2",
              field_path: "text",
            },
          },
        },
      ],
    },
  ]);
  const ladder = contentLadder(result);
  assert.equal(ladder.kind, "search_results");
  const ladderRecord = ladder.records?.[0] as (LadderRecord & { evidence_excerpts?: SearchHitEvidence[] }) | undefined;
  assert.ok(ladderRecord, "content ladder must include at least one record");
  assert.equal(ladderRecord.id, "conn_orders/orders:o2");
  assert.equal(ladderRecord.record_uri, undefined);
  assert.equal(
    ladderRecord.field_windows?.some((field) => field.resource_uri),
    false
  );
  assert.doesNotMatch(JSON.stringify(structuredContent.results), PDPP_RECORD);
  assert.doesNotMatch(JSON.stringify(ladder), PDPP_RECORD);
  assert.doesNotMatch(JSON.stringify(structuredContent.results), PDPP_FIELD_WINDOW);
  assert.doesNotMatch(JSON.stringify(ladder), PDPP_FIELD_WINDOW);
  assert.match(structuredContent.results[0]?.evidence_excerpts?.[0]?.preview_text ?? "", PASTA_ORDER);
  assert.match(ladderRecord.evidence_excerpts?.[0]?.preview_text ?? "", PASTA_ORDER);
  assert.match(ladderRecord.field_windows?.[0]?.preview_text ?? "", PASTA_ORDER);
  // Prose content is a concise, agent-visible preview, not a JSON dump.
  const text = firstText(result);
  assert.match(text, SEARCH_HIT);
  assert.match(text, HAS_MORE_TRUE);
  assert.match(text, NEXT_CURSOR_SEARCH_CURSOR_PAGE);
  assert.match(text, ID_CONN_ORDERS_ORDERS_O);
  // The connection is embedded in the id, so the preview must not spend
  // budget repeating it as a second model-carried handle.
  assert.doesNotMatch(text, CONNECTION_ID);
  assert.match(text, PASTA_ORDER_2);
  assert.match(text, STRUCTUREDCONTENT);
  // B1 regression guard: the matched evidence excerpt is VISIBLE in prose
  // content (not only in structuredContent), built from the server's
  // `evidence_excerpts` shape, and carries a model-callable read continuation.
  assert.match(text, EVIDENCE_EXCERPTS);
  assert.match(text, FIELD_PATH_TEXT_SNIPPET_PASTA);
  assert.match(text, READ_READ_RECORD_FIELD);

  await client.close();
  await server.close();
});

test("search fallback title uses authored timestamp before emitted_at", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "search",
    arguments: { q: "untitled" },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { results: Array<{ connector_key?: string; title?: string }> };
  assert.equal(structuredContent.results[0]?.title, "Acme Slack / messages / 2026-04-20T14:23:13.467Z");
  assert.equal(structuredContent.results[0]?.connector_key, "slack");

  await client.close();
  await server.close();
});

test("search fallback title uses nested authored timestamp before top-level emitted_at", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "search",
    arguments: { q: "nested-untitled" },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { results: Array<{ title?: string }> };
  assert.equal(structuredContent.results[0]?.title, "Acme Slack / messages / 2026-04-08T16:57:06.018Z");

  await client.close();
  await server.close();
});

test("fetch tool returns ChatGPT-compatible document shape", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "orders:o2" },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as {
    [key: string]: unknown;
    content_ladder?: LadderRecord;
    data?: unknown;
    id?: string;
    metadata?: { amount?: number; connection_id?: string; display_name?: string };
    text?: string;
    title?: string;
    url?: string;
  };
  assert.equal(structuredContent.id, "orders:o2");
  assert.equal(structuredContent.title, "Order o2");
  assert.equal(structuredContent.text, "Pasta order for $99.");
  assert.equal(structuredContent.url, "https://merchant.test/o2");
  assert.deepEqual(structuredContent.metadata?.amount, 99);
  assert.equal(structuredContent.data, undefined);
  const mirrored = JSON.parse(firstText(result));
  const { content_ladder: ladder, ...structuredDocument } = structuredContent;
  assert.deepEqual(mirrored, structuredDocument);
  assert.equal(
    contentParts(result).some((part) => part.type === "resource_link"),
    false,
    "ordinary fetch results must not trigger resource/file materialization"
  );
  assert.ok(ladder, "fetch must expose a content ladder");
  assert.equal(ladder.record_uri, undefined);
  assert.equal(ladder.id, "conn_orders/orders:o2");
  assert.doesNotMatch(JSON.stringify(ladder), PDPP_RECORD);
  const mirroredMetadata = mirrored.metadata as { connection_id?: string; display_name?: string } | undefined;
  assert.equal(mirroredMetadata?.connection_id, "conn_orders");
  assert.equal(mirroredMetadata?.display_name, "Merchant orders");
  assert.ok(calls.some((entry) => entry.url.endsWith("/v1/streams/orders/records/o2")));

  await client.close();
  await server.close();
});

test("fetch content text mirrors document JSON for hosts that hide structured output", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "conversations:c1", connection_id: "conn_chatgpt" },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as {
    [key: string]: unknown;
    content_ladder?: LadderRecord;
    id?: string;
    text?: string;
    title?: string;
    url?: string;
  };
  assert.equal(structuredContent.id, "conversations:c1");
  assert.equal(structuredContent.title, "Redactable developer ODCs");
  assert.equal(structuredContent.text, "Jeremy and I had a call with Redactable yesterday and I was so unimpressed.");
  assert.equal(structuredContent.url, "https://chatgpt.test/c/c1");

  // This is the model-visible path for clients that hide structuredContent.
  const text = JSON.parse(firstText(result));
  const { content_ladder: ladder, ...structuredDocument } = structuredContent;
  assert.deepEqual(text, structuredDocument);
  assert.ok(ladder, "fetch must expose a content ladder");
  assert.equal(ladder.record_uri, undefined);
  assert.equal(ladder.id, "conn_chatgpt/conversations:c1");
  assert.doesNotMatch(JSON.stringify(ladder), PDPP_RECORD);
  const textMetadata = text.metadata as
    | { connection_id?: string; connector_key?: string; display_name?: string }
    | undefined;
  assert.equal(textMetadata?.connection_id, "conn_chatgpt");
  assert.equal(textMetadata?.connector_key, "chatgpt");
  assert.equal(textMetadata?.display_name, "ChatGPT - user@example.com");
  assert.match(text.text as string, JEREMY_AND_I_HAD_A);

  await client.close();
  await server.close();
});

test("fetch fallback title uses source identity and authored timestamp", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "messages:m1", connection_id: "conn_slack" },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { metadata?: { connector_key?: string }; title?: string };
  assert.equal(structuredContent.title, "Acme Slack / messages / 2026-04-20T14:23:13.467Z");
  assert.equal(structuredContent.metadata?.connector_key, "slack");

  await client.close();
  await server.close();
});

test("search to fetch journey is executable from model-visible text alone", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const searchResult = await client.callTool({
    name: "search",
    arguments: { q: "pasta" },
  });
  const searchText = firstText(searchResult);
  const id = ID_S.exec(searchText)?.[1];

  assert.equal(id, "conn_orders/orders:o2");

  // The id is the ONLY handle the model carries between tools — no separate
  // connection_id argument (the live ChatGPT failure mode this guards).
  const fetchResult = await client.callTool({
    name: "fetch",
    arguments: { id },
  });
  const fetchText = JSON.parse(firstText(fetchResult));

  assert.equal(fetchText.id, "conn_orders/orders:o2");
  assert.equal(fetchText.title, "Order o2");
  assert.equal(fetchText.metadata.connection_id, "conn_orders");
  assert.equal(fetchText.text, "Pasta order for $99.");

  // The embedded connection scope reaches the RS as the canonical query param.
  const recordCall = calls.find((entry) => entry.url.includes("/v1/streams/orders/records/o2"));
  assert.ok(recordCall, "record fetch must be recorded");
  assert.equal(new URL(recordCall.url).searchParams.get("connection_id"), "conn_orders");

  await client.close();
  await server.close();
});

test("read_record_field reads bounded windows and advertises adjacent cursors", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", field_path: "text", limit_chars: 12 },
  });

  assert.equal(result.isError, undefined);
  const text = firstText(result);
  assert.match(text, RECORD_CONN_ORDERS_ORDERS_O);
  assert.match(text, NEXT_CURSOR);
  interface FieldWindowStructuredContent {
    field?: { path?: string };
    record?: { id?: string };
    resource?: unknown;
    window: {
      match_start_chars?: number;
      next_cursor?: string;
      previous_cursor?: string;
      start_chars?: number;
      text?: string;
    };
    [key: string]: unknown;
  }
  const structuredContent = result.structuredContent as FieldWindowStructuredContent;
  assert.equal(structuredContent.record?.id, "conn_orders/orders:o2");
  assert.equal(structuredContent.field?.path, "text");
  assert.equal(structuredContent.window.text, "Pasta order ");
  assert.equal(structuredContent.window.next_cursor, "12");

  assert.equal(
    structuredContent.resource,
    undefined,
    "ordinary bounded reads must not expose a generic field-window resource URI when tool continuations are available"
  );
  assert.equal((result._meta as Record<string, unknown> | undefined)?.resource, undefined);

  const routeCall = calls.find((call) => call.url.includes("/v1/streams/orders/records/o2/field-window"));
  assert.ok(routeCall, "read_record_field must call the RS field-window route");
  const routeUrl = new URL(routeCall.url);
  assert.equal(routeUrl.searchParams.get("connection_id"), "conn_orders");
  assert.equal(routeUrl.searchParams.get("field"), "text");
  assert.equal(routeUrl.searchParams.get("limit_chars"), "12");

  const next = await client.callTool({
    name: "read_record_field",
    arguments: {
      id: "conn_orders/orders:o2",
      field_path: "text",
      cursor: structuredContent.window.next_cursor,
      limit_chars: 12,
    },
  });
  const nextStructuredContent = next.structuredContent as FieldWindowStructuredContent;
  assert.equal(nextStructuredContent.window.start_chars, 12);
  assert.equal(nextStructuredContent.window.previous_cursor, "0");
  await server.close();
});

test("read_record_field forwards q context selectors", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const result = await client.callTool({
    name: "read_record_field",
    arguments: {
      id: "conn_orders/orders:o2",
      field_path: "text",
      q: "order",
      before_chars: 6,
      after_chars: 4,
      limit_chars: 32,
    },
  });

  assert.equal(result.isError, undefined);
  const structuredContent = result.structuredContent as { window: { match_start_chars?: number; text?: string } };
  assert.equal(structuredContent.window.match_start_chars, 6);
  assert.equal(structuredContent.window.text, "Pasta order for");

  const routeCall = calls.find((call) => call.url.includes("/v1/streams/orders/records/o2/field-window"));
  assert.ok(routeCall, "read_record_field must call the RS field-window route");
  const routeUrl = new URL(routeCall.url);
  assert.equal(routeUrl.searchParams.get("q"), "order");
  assert.equal(routeUrl.searchParams.get("before_chars"), "6");
  assert.equal(routeUrl.searchParams.get("after_chars"), "4");
  await server.close();
});

test("read_record_field rejects mixed identity before calling RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const before = calls.length;
  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", connection_id: "conn_orders", field_path: "text" },
  });

  assert.equal(result.isError, true);
  assert.match(firstText(result), EXCLUSIVE);
  assert.equal(calls.length, before, "invalid identity should not reach the RS");
  await server.close();
});

test("read_record_field rejects q plus offset before calling RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const before = calls.length;
  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", field_path: "text", q: "order", offset_chars: 1 },
  });

  assert.equal(result.isError, true);
  assert.match(firstText(result), EXCLUSIVE);
  assert.equal(calls.length, before, "invalid selector should not reach the RS");
  await server.close();
});

test("read_record_field rejects stale or malformed cursors before calling RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const before = calls.length;
  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", field_path: "text", cursor: "expired_cursor" },
  });

  assert.equal(result.isError, true);
  assert.match(firstText(result), CURSOR);
  assert.equal(calls.length, before, "bad cursor should not reach the RS");
  await server.close();
});

test("read_record_field preserves RS out-of-grant errors", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);
  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", field_path: "forbidden" },
  });

  assert.equal(result.isError, true);
  const errorContent = result.structuredContent as { error?: { code?: string }; http_status?: number };
  assert.equal(errorContent.error?.code, "field_not_granted");
  assert.equal(errorContent.http_status, 403);
  await server.close();
});

test("record resource uri is readable through resources/read for capable clients", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const before = calls.length;
  const resource = await client.readResource({ uri: "pdpp://record/conn_orders%2Forders%3Ao2" });

  assert.equal(resource.contents.length, 1);
  assert.equal(resource.contents[0]?.mimeType, "application/json");
  assert.match(resourceText(resource.contents[0]), PASTA_ORDER_2);

  const resourceCall = calls.slice(before).find((call) => call.url.includes("/v1/streams/orders/records/o2"));
  assert.ok(resourceCall, "record resource read must call record detail route");
  const resourceUrl = new URL(resourceCall.url);
  assert.equal(resourceUrl.searchParams.get("connection_id"), "conn_orders");

  await server.close();
});

test("canonical base64url pdpp://record URI is accepted by read_record_field, fetch, and resources/read", async () => {
  // The record_uri the model actually sees in content ladders and resource
  // templates is `pdpp://record/{base64url-JSON}` — NOT the human-readable
  // self-contained form. This is the exact handle a ChatGPT-style client copies
  // out of search results, so all three model-callable continuations must take
  // it directly. (Live blocker B2.)
  const recordUri = __internal.encodeResourceUri("record", {
    connection_id: "conn_orders",
    stream: "orders",
    record_id: "o2",
  });
  assert.match(recordUri, PDPP_RECORD_A_ZA_Z);
  // Proves it is opaque base64url, not the colon/slash grammar.
  assert.doesNotMatch(recordUri, O);

  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  // read_record_field takes the canonical URI as `id`.
  const fieldResult = await client.callTool({
    name: "read_record_field",
    arguments: { id: recordUri, field_path: "text" },
  });
  assert.equal(fieldResult.isError ?? false, false);
  assert.match(firstText(fieldResult), PASTA_ORDER_2);
  const fieldCall = calls.find((call) => call.url.includes("/v1/streams/orders/records/o2/field-window"));
  assert.ok(fieldCall, "read_record_field must resolve the base64url URI to the field-window route");
  assert.equal(new URL(fieldCall.url).searchParams.get("connection_id"), "conn_orders");

  // fetch takes the canonical URI as `id`.
  const fetchResult = await client.callTool({
    name: "fetch",
    arguments: { id: recordUri },
  });
  assert.equal(fetchResult.isError ?? false, false);
  assert.match(firstText(fetchResult), PASTA_ORDER_2);

  // resources/read takes the canonical URI directly.
  const resource = await client.readResource({ uri: recordUri });
  assert.equal(resource.contents.length, 1);
  assert.match(resourceText(resource.contents[0]), PASTA_ORDER_2);

  await server.close();
});

test("parseRecordResultId accepts canonical base64url, plain self-contained URI, and bare id", () => {
  const canonical = __internal.encodeResourceUri("record", {
    connection_id: "conn_orders",
    stream: "orders",
    record_id: "o2",
  });
  const expected = { connectionId: "conn_orders", stream: "orders", recordId: "o2" };
  assert.deepEqual(__internal.parseRecordResultId(canonical), expected);
  assert.deepEqual(__internal.parseRecordResultId("pdpp://record/conn_orders%2Forders%3Ao2"), expected);
  assert.deepEqual(__internal.parseRecordResultId("conn_orders/orders:o2"), expected);
});

test("read_record_field omits dead field-window resources and exposes tool continuations", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "read_record_field",
    arguments: { id: "conn_orders/orders:o2", field_path: "text", limit_chars: 12 },
  });
  const visible = contentParts(result)
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");

  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError ?? false, false);
  assert.equal(
    contentParts(result).some((item) => item.type === "resource_link"),
    false,
    "ordinary small field reads must not trigger materialization"
  );
  const structuredContent = result.structuredContent as { resource?: unknown };
  assert.equal(
    structuredContent.resource,
    undefined,
    "field-window resource URIs are not model-visible unless generic resource reads are proven reliable"
  );
  assert.equal((result._meta as Record<string, unknown> | undefined)?.resource, undefined);
  assert.match(visible, NEXT_READ_RECORD_FIELD_ARGS);
  assert.match(visible, ID_CONN_ORDERS_ORDERS_O_2);
  assert.match(visible, FIELD_PATH_TEXT);
  assert.equal(
    calls.some((call) => call.url.includes("/v1/streams/orders/records/o2/field-window")),
    true,
    "bounded read must still use the field-window endpoint internally"
  );
});
test("field-window resource rejects malformed handles", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  await assert.rejects(
    client.readResource({ uri: "pdpp://field-window/not-base64url-json" }),
    MALFORMED_RESOURCE_HANDLE
  );
  await server.close();
});

test("fetch encodes typed expand_limit as bracket query params", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "orders:o2", expand: ["line_items"], expand_limit: { line_items: 2 } },
  });

  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.url.includes("/v1/streams/orders/records/o2"));
  assert.ok(call, "fetch call must be recorded");
  const callUrl = new URL(call.url);
  assert.deepEqual(callUrl.searchParams.getAll("expand"), ["line_items"]);
  assert.equal(callUrl.searchParams.get("expand_limit[line_items]"), "2");
  assert.equal(callUrl.searchParams.get("expand_limit"), null);

  await client.close();
  await server.close();
});

test("fetch tool rejects path-traversal result ids before hitting RS", async () => {
  const { fetch, calls } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "orders:../../etc/passwd" },
  });

  assert.equal(result.isError, true);
  const errorContent = result.structuredContent as { error?: { message?: string } };
  assert.match(errorContent.error?.message ?? "", INVALID_CHARACTERS);
  assert.equal(
    calls.some((entry) => entry.url.includes("/v1/streams/orders/records")),
    false
  );

  await client.close();
  await server.close();
});

test("invalid_token surfaces as isError without retry under broader credentials", async () => {
  // Force RS to reject by using a deliberately bad token.
  const { fetch, calls } = makeFakeRs();
  const { server } = createPdppMcpServer({
    providerUrl: "https://provider.test",
    accessToken: "wrong-token",
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const result = await client.callTool({ name: "schema", arguments: {} });
  assert.equal(result.isError, true);
  const errorContent = result.structuredContent as { error?: { code?: string }; http_status?: number };
  assert.equal(errorContent.error?.code, "invalid_token");
  assert.equal(errorContent.http_status, 401);

  // No retry: exactly one call, with the wrong token, no fallback retry on the same path.
  const schemaCalls = calls.filter((entry) => new URL(entry.url).pathname === "/v1/schema");
  assert.equal(schemaCalls.length, 1);
  assert.equal(schemaCalls[0]?.auth, "Bearer wrong-token");

  await client.close();
  await server.close();
});

test("resource template returns stream metadata", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === "pdpp://stream/{name}"));
  assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === "pdpp://record/{handle}"));
  assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === "pdpp://field-window/{handle}"));

  const result = await client.readResource({ uri: "pdpp://stream/orders" });
  assert.equal(result.contents.length, 1);
  const parsed = JSON.parse(resourceText(result.contents[0]));
  assert.equal(parsed.name, "orders");

  await client.close();
  await server.close();
});

test("tool descriptions are static (no manifest interpolation)", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = await client.listTools();
  for (const tool of tools.tools) {
    assert.ok(tool.description && tool.description.length > 0);
    assert.ok(
      !(tool.description.includes("orders") || tool.description.includes("emails")),
      `${tool.name} description must not interpolate connector/stream names`
    );
  }

  await client.close();
  await server.close();
});

test("tool output never contains the bearer token", async () => {
  const { fetch } = makeFakeRs();
  const { client, server } = await connectClient(fetch);

  const tools = ["schema", "query_records", "aggregate", "search", "fetch"];
  const argsByTool: Record<string, Record<string, unknown>> = {
    query_records: { stream: "orders" },
    aggregate: { stream: "orders", metric: "count" },
    search: { q: "orders" },
    fetch: { id: "orders:o1" },
  };
  for (const name of tools) {
    const args = argsByTool[name] ?? {};
    // biome-ignore lint/performance/noAwaitInLoops: calls share one already-connected client/fake-RS across cases and must run in order to keep the stateful fixture's call recording and assertions deterministic; Promise.all would race the shared state.
    const result = await client.callTool({ name, arguments: args });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("scoped-token"), `${name} result must not echo bearer token`);
  }

  await client.close();
  await server.close();
});

test("Streamable HTTP helper handles initialize and tools/list statelessly", async () => {
  const { fetch } = makeFakeRs();

  const initialize = await postMcpJson(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "0.0.0" },
      },
    },
    fetch
  );
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get("mcp-session-id"), null);
  interface InitializeResponse {
    result?: { serverInfo?: { icons?: unknown; name?: string } };
  }
  interface ToolsListResponse {
    result?: { tools: Array<{ name: string }> };
  }
  const initialized = (await initialize.json()) as InitializeResponse;
  assert.equal(initialized.result?.serverInfo?.name, "pdpp-mcp-server");
  assert.deepEqual(initialized.result?.serverInfo?.icons, [
    { src: "https://provider.test/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ]);

  const tools = await postMcpJson(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    fetch
  );
  assert.equal(tools.status, 200);
  assert.equal(tools.headers.get("x-pdpp-mcp-profile"), null);
  const listed = (await tools.json()) as ToolsListResponse;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — listed.result is genuinely optional (JSON-RPC only includes it on success); dropping ?. fails tsc (TS18048).
  // biome-ignore lint/suspicious/useArraySortCompare: tool names are ASCII identifiers, so default lexicographic string sort is correct and stable here.
  const names = listed.result?.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — listed.result is genuinely optional (JSON-RPC only includes it on success); dropping ?. fails tsc (TS18048).
  assert.ok(listed.result?.tools.some((tool) => tool.name === "fetch"));
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc disagrees — listed.result is genuinely optional (JSON-RPC only includes it on success); dropping ?. fails tsc (TS18048).
  assert.ok(listed.result?.tools.some((tool) => tool.name === "search"));
});

async function postMcpJson(message: unknown, fakeFetch: typeof fetch, path = "/mcp") {
  return await handleStreamableHttpRequest(
    new Request(`https://provider.test${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    }),
    {
      providerUrl: "https://provider.test",
      accessToken: "scoped-token",
      fetch: fakeFetch,
      serverIcons: [{ src: "https://provider.test/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
    }
  );
}

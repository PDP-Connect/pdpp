#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Token-based public read-surface smoke for a live PDPP origin.
//
// This is the reusable counterpart to railway-mcp-query-smoke.ts: it does not
// seed records or run owner OAuth. Instead it uses an existing client or MCP
// package bearer and exercises the same surface a ChatGPT MCP host, CLI client,
// or REST client depends on.
//
// Usage:
//   PDPP_READ_SURFACE_TOKEN=... node --import tsx scripts/read-surface-smoke.ts \
//     --origin https://pdpp.example --connection-id cin_... --stream messages

import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  establishOwnerSessionCookie,
  extractCsrfFieldValue,
  findSetCookiePair,
  getSetCookieList,
} from "./lib/owner-session.ts";

type JsonRecord = Record<string, unknown>;
type JsonValue = unknown;
type CheckStatus = "fail" | "pass" | "skip" | "warn";
interface CheckResult extends JsonRecord {
  detail: string;
  extra?: JsonRecord;
  name: string;
  status: CheckStatus;
  surface: string;
}
interface ClassifyVerdict {
  detail: string;
  extra?: JsonRecord;
  status: CheckStatus;
}
interface TextResponse {
  contentType: string | null;
  json: JsonValue;
  status: number;
  text: string;
}
interface McpResponse extends TextResponse {
  rpc: JsonRpcResponse | null;
}
interface JsonRpcResponse extends JsonRecord {
  error?: { code?: number | string; message?: string };
  id?: number | string;
  jsonrpc: string;
  result?: JsonRecord;
}
interface McpTool {
  inputSchema?: { properties?: JsonRecord };
  name?: string;
}
interface ParsedArgs {
  connectionId?: string;
  connectorId?: string;
  dateField: string;
  help?: boolean;
  json: boolean;
  origin?: string;
  ownerPassword?: string;
  ownerSubject?: string;
  searchQuery: string;
  since: string;
  skipCli: boolean;
  skipMcp: boolean;
  skipRest: boolean;
  stream: string;
  timeoutMs: number;
  token?: string;
}

const CORE_MCP_TOOLS = ["schema", "query_records", "aggregate", "search", "fetch", "fetch_blob", "read_record_field"];
const FORBIDDEN_NORMAL_MCP_TOOLS = [
  "list_streams",
  "discover_event_subscription_capabilities",
  "list_event_subscriptions",
  "create_event_subscription",
  "get_event_subscription",
  "send_test_event",
  "update_event_subscription",
  "delete_event_subscription",
];

const DEFAULT_STREAM = "messages";
const DEFAULT_SEARCH_QUERY = "test";
const DEFAULT_DATE_FIELD = "sent_at";
const DEFAULT_SINCE = "1970-01-01T00:00:00.000Z";
const DEFAULT_TIMEOUT_MS = 30_000;
const SCOPED_FULL_SCHEMA_BYTE_BUDGET = 200_000;
const NON_GRANT_BEARER = "pdpp-read-surface-smoke-non-grant-bearer";
const TRAILING_SLASHES_PATTERN = /\/+$/;
const NON_HOST_CHARACTERS_PATTERN = /[^a-zA-Z0-9.-]/g;
const QUERY_RECORDS_PATTERN = /\bquery[_-]?records\b/i;
const SEARCH_WORD_PATTERN = /\bsearch\b/i;
const AGGREGATE_WORD_PATTERN = /\baggregate\b/i;
const FETCH_WORD_PATTERN = /\bfetch\b/i;
const PDPP_CLI_PATTERN = /PDPP CLI/;
const AMBIGUOUS_OR_CONNECTION_ID_PATTERN = /ambiguous_connection|connection_id/i;

function jsonRecord(value: JsonValue): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}
function jsonArray(value: JsonValue): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: direct mechanical port of the pre-existing flat CLI argv-parsing switch, unchanged from the .mjs source
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = {
    json: false,
    skipCli: false,
    skipMcp: false,
    skipRest: false,
    stream: DEFAULT_STREAM,
    searchQuery: DEFAULT_SEARCH_QUERY,
    dateField: DEFAULT_DATE_FIELD,
    since: DEFAULT_SINCE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--skip-cli") {
      out.skipCli = true;
    } else if (arg === "--skip-mcp") {
      out.skipMcp = true;
    } else if (arg === "--skip-rest") {
      out.skipRest = true;
    } else if (arg === "--origin") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.origin = value;
      }
    } else if (arg === "--token") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.token = value;
      }
    } else if (arg === "--owner-password") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.ownerPassword = value;
      }
    } else if (arg === "--owner-subject") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.ownerSubject = value;
      }
    } else if (arg === "--connector-id") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.connectorId = value;
      }
    } else if (arg === "--connection-id") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.connectionId = value;
      }
    } else if (arg === "--stream") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.stream = value;
      }
    } else if (arg === "--search-query") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.searchQuery = value;
      }
    } else if (arg === "--date-field") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.dateField = value;
      }
    } else if (arg === "--since") {
      i += 1;
      const value = args[i];
      if (value !== undefined) {
        out.since = value;
      }
    } else if (arg === "--timeout-ms") {
      i += 1;
      out.timeoutMs = Number(args[i]);
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
    i += 1;
  }
  return out;
}

export function normalizeOrigin(origin: string | undefined): string {
  return String(origin || "").replace(TRAILING_SLASHES_PATTERN, "");
}

export function buildUrl(origin: string, path: string, params: Record<string, JsonValue> = {}): string {
  const url = new URL(path, normalizeOrigin(origin));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function mcpInitializeMessage(id = 1): JsonRecord {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pdpp-read-surface-smoke", version: "1" },
    },
  };
}

export function mcpToolsListMessage(id = 2): JsonRecord {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function mcpToolCallMessage(name: string, args: JsonRecord = {}, id = 3): JsonRecord {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export function parseMcpResponseText(contentType: string | null, text: string): JsonRpcResponse | null {
  if (!text) {
    return null;
  }
  if (String(contentType || "").includes("text/event-stream")) {
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const payload = dataLines.find((line) => line !== "[DONE]");
    return payload ? (JSON.parse(payload) as JsonRpcResponse) : null;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

export function extractListData(body: JsonValue): JsonValue[] {
  if (Array.isArray(body)) {
    return body;
  }
  const root = jsonRecord(body);
  if (!root) {
    return [];
  }
  if (Array.isArray(root.data)) {
    return root.data;
  }
  if (Array.isArray(root.records)) {
    return root.records;
  }
  const resultBody = jsonRecord(root.result);
  if (resultBody && Array.isArray(resultBody.data)) {
    return resultBody.data;
  }
  return [];
}

export function extractRecordId(record: JsonValue): string | null {
  const root = jsonRecord(record);
  const data = root ? jsonRecord(root.data) : null;
  const candidate = root?.id ?? root?.key ?? root?.record_id ?? data?.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function recordPayload(record: JsonValue): JsonRecord {
  const root = jsonRecord(record);
  const data = root ? jsonRecord(root.data) : null;
  return data ?? root ?? {};
}

function objectKeys(value: JsonValue): string[] {
  const root = jsonRecord(value);
  return root ? Object.keys(root).sort() : [];
}

export function classifyStrictProjection(record: JsonValue, expectedFields: string[]): ClassifyVerdict {
  const payload = recordPayload(record);
  const actual = objectKeys(payload);
  const expected = [...expectedFields].sort();
  if (actual.length === 0) {
    return { status: "skip", detail: "no projected record was available" };
  }
  const unexpected = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    return {
      status: "fail",
      detail: `projected payload keys were ${actual.join(",") || "<none>"}; expected exactly ${expected.join(",")}`,
      extra: { payload },
    };
  }
  return { status: "pass", detail: `projection returned only ${expected.join(",")}` };
}

function extractSearchResults(body: JsonValue): JsonValue[] {
  const root = jsonRecord(body);
  if (!root) {
    return [];
  }
  if (Array.isArray(root.results)) {
    return root.results;
  }
  if (Array.isArray(root.hits)) {
    return root.hits;
  }
  const data = jsonRecord(root.data);
  if (data) {
    if (Array.isArray(data.results)) {
      return data.results;
    }
    if (Array.isArray(data.hits)) {
      return data.hits;
    }
    if (Array.isArray(data.data)) {
      return data.data;
    }
  }
  if (Array.isArray(root.data)) {
    return root.data;
  }
  return [];
}

function sourceIdForHit(hit: JsonValue): JsonValue {
  const root = jsonRecord(hit);
  const source = root ? jsonRecord(root.source) : null;
  return (
    root?.connection_id ?? root?.connector_instance_id ?? source?.connection_id ?? source?.connector_instance_id ?? null
  );
}

export function classifySearchLimitAndSource(body: JsonValue, limit: number): ClassifyVerdict {
  const hits = extractSearchResults(body);
  if (hits.length > limit) {
    return { status: "fail", detail: `returned ${hits.length} hits for limit ${limit}`, extra: { hits } };
  }
  if (hits.length === 0) {
    return { status: "warn", detail: "search returned no hits; limit held but source identity is unproven" };
  }
  const missingSource = hits.filter((hit) => !sourceIdForHit(hit));
  if (missingSource.length > 0) {
    return {
      status: "fail",
      detail: `${missingSource.length} hit(s) lacked connection_id/source identity`,
      extra: { hits },
    };
  }
  const root = jsonRecord(body);
  const data = root ? jsonRecord(root.data) : null;
  const meta = root ? jsonRecord(root.meta) : null;
  const dataMeta = data ? jsonRecord(data.meta) : null;
  const pkgOwner = meta ?? dataMeta;
  const pkg = pkgOwner ? jsonRecord(pkgOwner.package) : null;
  const sourceMix = pkg?.source_mix;
  return {
    status: "pass",
    detail: `returned ${hits.length} hit(s) within limit ${limit} with source identity`,
    ...(Array.isArray(sourceMix) ? { extra: { sourceMix } } : {}),
  };
}

export function classifyPageHandles(body: JsonValue): ClassifyVerdict {
  const outer = jsonRecord(body);
  const data = outer ? jsonRecord(outer.data) : null;
  const root = data ?? outer ?? {};
  const hasMore = root.has_more ?? outer?.has_more;
  const links = outer ? jsonRecord(outer.links) : null;
  const nextCursor = root.next_cursor ?? outer?.next_cursor ?? links?.next ?? null;
  const rootMeta = jsonRecord(root.meta);
  const outerMeta = outer ? jsonRecord(outer.meta) : null;
  const count = rootMeta?.count ?? outerMeta?.count ?? null;
  if (hasMore === true && !nextCursor) {
    return {
      status: "fail",
      detail: "has_more=true but no next cursor/link was visible",
      extra: { body: body as JsonRecord },
    };
  }
  if (!count) {
    return { status: "warn", detail: "page returned but count handle was not visible" };
  }
  return { status: "pass", detail: `page handles visible${nextCursor ? " with cursor" : ""}` };
}

export function extractMcpToolData(rpc: JsonRpcResponse | null): JsonValue {
  const structured = rpc?.result?.structuredContent;
  const structuredRecord = jsonRecord(structured);
  if (structuredRecord && "error" in structuredRecord) {
    return structuredRecord.error;
  }
  if (structuredRecord && "data" in structuredRecord) {
    return structuredRecord.data;
  }
  if (structured !== undefined) {
    return structured;
  }
  const content = jsonArray(rpc?.result?.content);
  const textEntry = content.find((entry) => jsonRecord(entry)?.type === "text");
  const text = jsonRecord(textEntry)?.text;
  if (typeof text !== "string" || !text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractMcpToolStructuredContent(rpc: JsonRpcResponse | null): JsonValue {
  const structured = jsonRecord(rpc?.result?.structuredContent);
  return structured ?? extractMcpToolData(rpc);
}

export function extractMcpToolError(rpc: JsonRpcResponse | null): { code: string; message: string } | null {
  if (rpc?.error) {
    return {
      code: rpc.error.code ? String(rpc.error.code) : "json_rpc_error",
      message: String(rpc.error.message ?? "JSON-RPC error"),
    };
  }
  if (!rpc?.result?.isError) {
    return null;
  }
  const data = extractMcpToolData(rpc);
  const dataRecord = jsonRecord(data);
  if (dataRecord) {
    return {
      code: String(dataRecord.code ?? dataRecord.type ?? "tool_error"),
      message: String(dataRecord.message ?? JSON.stringify(dataRecord)),
    };
  }
  return { code: "tool_error", message: String(data ?? "MCP tool error") };
}

export function bodyErrorCode(body: JsonValue): JsonValue {
  const root = jsonRecord(body);
  const error = root ? jsonRecord(root.error) : null;
  return root?.code ?? root?.type ?? error?.code ?? error?.type ?? null;
}

export function classifyAmbiguousConnection(status: number, body: JsonValue): ClassifyVerdict & { ok: boolean } {
  if (status >= 200 && status < 300) {
    return { ok: true, status: "pass", detail: "request succeeded without connection_id; grant may be single-source" };
  }
  const code = bodyErrorCode(body);
  if (status === 409 && code === "ambiguous_connection") {
    return { ok: true, status: "pass", detail: "returned typed ambiguous_connection" };
  }
  return {
    ok: false,
    status: "fail",
    detail: `expected 2xx or typed ambiguous_connection; got HTTP ${status}${code ? ` ${code}` : ""}`,
  };
}

const BOUNDED_AUTH_ERROR_CODES = new Set([
  "invalid_token",
  "insufficient_scope",
  "unauthorized",
  "invalid_request",
  "invalid_client",
  "authentication_error",
]);

export function classifyExcludedBearer(status: number, body: JsonValue): ClassifyVerdict {
  if (status >= 200 && status < 300) {
    return {
      status: "fail",
      detail: "ordinary read served a non-grant bearer; scoped-grant requirement not enforced",
      extra: { body: body as JsonRecord },
    };
  }
  if (status !== 401 && status !== 403) {
    return { status: "warn", detail: `non-grant bearer rejected with HTTP ${status} (expected bounded 401/403)` };
  }
  const code = bodyErrorCode(body);
  if (code && !BOUNDED_AUTH_ERROR_CODES.has(String(code))) {
    return { status: "warn", detail: `non-grant bearer rejected HTTP ${status} with unexpected code ${code}` };
  }
  return {
    status: "pass",
    detail: `non-grant bearer rejected (HTTP ${status}${code ? ` ${code}` : ""}); reads require the scoped grant`,
  };
}

function extractSchemaRoot(body: JsonValue): JsonRecord | null {
  const root = jsonRecord(body);
  if (root?.object === "schema") {
    return root;
  }
  const data = root ? jsonRecord(root.data) : null;
  if (data?.object === "schema") {
    return data;
  }
  if (root && Array.isArray(root.connectors)) {
    return root;
  }
  if (data && Array.isArray(data.connectors)) {
    return data;
  }
  return null;
}

interface SchemaStreamRow {
  connector: JsonRecord;
  stream: JsonRecord;
}
function schemaStreams(root: JsonRecord | null): SchemaStreamRow[] {
  return jsonArray(root?.connectors).flatMap((connector) => {
    const connectorRecord = jsonRecord(connector);
    const streams = jsonArray(connectorRecord?.streams);
    return streams.map((stream) => ({
      connector: connectorRecord ?? {},
      stream: jsonRecord(stream) ?? {},
    }));
  });
}

function schemaConnectionIds(root: JsonRecord | null): string[] {
  const ids = new Set<string>();
  for (const connector of jsonArray(root?.connectors)) {
    const connectorRecord = jsonRecord(connector);
    addConnectionIds(ids, connectorRecord);
    for (const entry of jsonArray(connectorRecord?.granted_connections)) {
      addConnectionIds(ids, jsonRecord(entry));
    }
    for (const stream of jsonArray(connectorRecord?.streams)) {
      const streamRecord = jsonRecord(stream);
      addConnectionIds(ids, streamRecord);
      for (const entry of jsonArray(streamRecord?.granted_connections)) {
        addConnectionIds(ids, jsonRecord(entry));
      }
    }
  }
  return [...ids];
}

function addConnectionIds(ids: Set<string>, value: JsonRecord | null): void {
  for (const key of ["connection_id", "connector_instance_id"]) {
    const id = value?.[key];
    if (typeof id === "string" && id.length > 0) {
      ids.add(id);
    }
  }
}

export function classifyScopedSchema(
  body: JsonValue,
  streamName: string,
  connectionId: string | undefined
): ClassifyVerdict {
  const root = extractSchemaRoot(body);
  if (!root) {
    return {
      status: "fail",
      detail: "schema body did not contain a schema document",
      extra: { body: body as JsonRecord },
    };
  }
  const rows = schemaStreams(root);
  if (rows.length === 0) {
    return { status: "fail", detail: "scoped schema returned no streams", extra: { body: body as JsonRecord } };
  }
  const wrongStream = rows.find(({ stream }) => stream.name !== streamName);
  if (wrongStream) {
    return {
      status: "fail",
      detail: `scoped schema included unexpected stream ${wrongStream.stream.name ?? "<unknown>"}`,
      extra: { body: body as JsonRecord },
    };
  }
  const ids = schemaConnectionIds(root);
  if (ids.length !== 1 || ids[0] !== connectionId) {
    return {
      status: "fail",
      detail: `scoped schema connection ids were ${ids.join(",") || "<none>"}, expected ${connectionId}`,
      extra: { body: body as JsonRecord },
    };
  }
  return { status: "pass", detail: `schema narrowed to ${streamName} / ${connectionId}` };
}

function schemaConnectorKeys(root: JsonRecord | null): string[] {
  const keys = new Set<string>();
  for (const connector of jsonArray(root?.connectors)) {
    const connectorRecord = jsonRecord(connector);
    addConnectorKey(keys, connectorRecord);
    for (const stream of jsonArray(connectorRecord?.streams)) {
      addConnectorKey(keys, jsonRecord(stream));
    }
  }
  return [...keys];
}

function addConnectorKey(keys: Set<string>, value: JsonRecord | null): void {
  const key = value?.connector_key;
  if (typeof key === "string" && key.length > 0) {
    keys.add(key);
  }
}

export function classifySourceIdentity(body: JsonValue, connectionId: string | undefined): ClassifyVerdict {
  const root = extractSchemaRoot(body);
  if (!root) {
    return {
      status: "fail",
      detail: "schema body did not contain a schema document",
      extra: { body: body as JsonRecord },
    };
  }
  const ids = schemaConnectionIds(root);
  if (ids.length !== 1 || ids[0] !== connectionId) {
    return {
      status: "fail",
      detail: `expected canonical connection_id ${connectionId}; saw ${ids.join(",") || "<none>"}`,
      extra: { body: body as JsonRecord },
    };
  }
  const connectorKeys = schemaConnectorKeys(root);
  if (connectorKeys.length === 0) {
    return {
      status: "warn",
      detail: `connection_id ${connectionId} present; connector_key not surfaced by this transport/view`,
    };
  }
  if (connectorKeys.length > 1) {
    return {
      status: "fail",
      detail: `scoped schema mixed connector_keys ${connectorKeys.join(",")}`,
      extra: { body: body as JsonRecord },
    };
  }
  return { status: "pass", detail: `canonical source identity ${connectionId} / ${connectorKeys[0]}` };
}

export function classifyToolNames(toolNames: string[]) {
  const missingCore = CORE_MCP_TOOLS.filter((name) => !toolNames.includes(name));
  const unexpectedTools = toolNames.filter((name) => !CORE_MCP_TOOLS.includes(name));
  const forbiddenPresent = FORBIDDEN_NORMAL_MCP_TOOLS.filter((name) => toolNames.includes(name));
  return {
    missingCore,
    unexpectedTools,
    forbiddenPresent,
    ok: missingCore.length === 0 && unexpectedTools.length === 0 && forbiddenPresent.length === 0,
    detail: `${toolNames.length} advertised tool(s)`,
  };
}

export function summarizeResults(results: CheckResult[]) {
  const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const entry of results) {
    counts[entry.status as "fail" | "pass" | "skip" | "warn"] += 1;
  }
  return { ok: counts.fail === 0, counts };
}

const PARITY_TRANSPORTS = ["REST", "MCP", "CLI"];

const PARITY_ROW_BY_CHECK: Record<string, string> = {
  "schema.compact": "compact_schema",
  "schema.scoped": "source_scoping",
  "schema.scoped_full": "source_scoping",
  "schema.source_identity": "source_identity",
  "query_records.projection": "projection",
  "fetch.projection": "projection",
  "record_detail.projection": "projection",
  "search.fan_in_limit_source_identity": "search_limit_source",
  "query_records.count": "count_handle",
  "query_records.sort_count": "count_handle",
  "aggregate.count": "aggregate_count",
  "query_records.omit_connection_id": "typed_ambiguity",
  excluded_bearer: "grant_bearer_only",
};

const PARITY_ROW_ORDER = [
  "compact_schema",
  "source_scoping",
  "source_identity",
  "projection",
  "search_limit_source",
  "count_handle",
  "aggregate_count",
  "typed_ambiguity",
  "grant_bearer_only",
];

export function buildParityMatrix(results: CheckResult[]) {
  const cells = new Map<string, string>();
  for (const entry of results) {
    if (!PARITY_TRANSPORTS.includes(entry.surface)) {
      continue;
    }
    const row = PARITY_ROW_BY_CHECK[entry.name];
    if (!row) {
      continue;
    }
    const key = `${row}\0${entry.surface}`;
    const prior = cells.get(key);
    if (prior === "fail") {
      continue;
    }
    cells.set(key, entry.status);
  }

  const rows: { diverged: boolean; row: string; transports: Record<string, string> }[] = [];
  let diverged = false;
  for (const row of PARITY_ROW_ORDER) {
    const transports: Record<string, string> = {};
    let anyPass = false;
    let anyFail = false;
    for (const surface of PARITY_TRANSPORTS) {
      const status = cells.get(`${row}\0${surface}`) ?? "absent";
      transports[surface] = status;
      if (status === "pass") {
        anyPass = true;
      }
      if (status === "fail") {
        anyFail = true;
      }
    }
    const rowDiverged = anyPass && anyFail;
    if (rowDiverged) {
      diverged = true;
    }
    rows.push({ row, transports, diverged: rowDiverged });
  }
  return { rows, diverged, ok: !diverged };
}

export function cliCredentialCacheFile(cacheRoot: string, origin: string): string {
  const host = new URL(normalizeOrigin(origin)).host.replace(NON_HOST_CHARACTERS_PATTERN, "_");
  return join(cacheRoot, "clients", `${host}.json`);
}

async function readBody(resp: Response): Promise<{ json: JsonValue; text: string }> {
  const text = await resp.text();
  let json: JsonValue = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// Delegates to the shared owner-session helper (scripts/lib/owner-session.ts
// — the one place that drives the CSRF-protected /owner/login form).
async function establishOwnerSession(origin: string, ownerPassword: string): Promise<string> {
  return (await establishOwnerSessionCookie({ origin, ownerPassword })) ?? "";
}

async function mintScopedClientToken({
  origin,
  ownerPassword,
  ownerSubject,
  connectorId,
  connectionId,
  stream,
}: {
  connectionId?: string;
  connectorId: string | undefined;
  origin: string;
  ownerPassword: string | undefined;
  ownerSubject: string | undefined;
  stream: string;
}): Promise<string> {
  if (!ownerPassword) {
    throw new Error("--owner-password or PDPP_OWNER_PASSWORD is required when --token is omitted");
  }
  if (!connectorId) {
    throw new Error("--connector-id is required when --token is omitted");
  }

  const sessionCookie = await establishOwnerSession(origin, ownerPassword);
  const redirectUri = "https://client.example/callback";
  const registerResp = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "PDPP read-surface smoke client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
    }),
  });
  if (registerResp.status !== 201) {
    const { text } = await readBody(registerResp);
    throw new Error(`oauth/register failed ${registerResp.status}: ${text}`);
  }
  const client = (await readBody(registerResp)).json as { client_id: string };
  const verifier = crypto.randomBytes(32).toString("base64url");
  const streamGrant: JsonRecord = { name: stream || "*" };
  if (connectionId) {
    streamGrant.connection_id = connectionId;
  }
  const authorizationDetails = [
    {
      type: "https://pdpp.org/data-access",
      source: { kind: "connector", id: connectorId },
      purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
      purpose_description: "PDPP read-surface smoke",
      access_mode: "continuous",
      streams: [streamGrant],
    },
  ];

  const authorizeUrl = new URL(`${origin}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "read-surface-smoke");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, {
    redirect: "manual",
    headers: { Cookie: sessionCookie },
  });
  if (authorizeResp.status !== 302) {
    const { text } = await readBody(authorizeResp);
    throw new Error(`oauth/authorize failed ${authorizeResp.status}: ${text}`);
  }
  const authorizeLocation = authorizeResp.headers.get("location");
  if (!authorizeLocation) {
    throw new Error("oauth/authorize did not return a redirect location");
  }
  const consentUrl = new URL(authorizeLocation, origin);
  const requestUri = consentUrl.searchParams.get("request_uri");
  if (!requestUri) {
    throw new Error("oauth/authorize did not return a consent request_uri");
  }

  const consentPageResp = await fetch(consentUrl, {
    headers: { Accept: "text/html", Cookie: sessionCookie },
    redirect: "manual",
  });
  const consentCsrfCookie = findSetCookiePair(getSetCookieList(consentPageResp), "pdpp_owner_csrf");
  const consentCsrfField = extractCsrfFieldValue(await consentPageResp.text());

  const approveHeaders: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookieParts = [sessionCookie, consentCsrfCookie].filter(Boolean) as string[];
  if (cookieParts.length > 0) {
    approveHeaders.Cookie = cookieParts.join("; ");
  }
  const approveBody: Record<string, string> = { request_uri: requestUri, subject_id: ownerSubject || "owner_local" };
  if (consentCsrfField) {
    approveBody._csrf = consentCsrfField;
  }

  const approveResp = await fetch(`${origin}/consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: approveHeaders,
    body: new URLSearchParams(approveBody).toString(),
  });
  if (approveResp.status !== 302) {
    const { text } = await readBody(approveResp);
    throw new Error(`consent/approve failed ${approveResp.status}: ${text}`);
  }
  const approveLocation = approveResp.headers.get("location");
  if (!approveLocation) {
    throw new Error("consent/approve did not return a redirect location");
  }
  const callback = new URL(approveLocation);
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new Error("consent/approve did not return an authorization code");
  }

  const tokenResp = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  if (tokenResp.status !== 200) {
    const { text } = await readBody(tokenResp);
    throw new Error(`oauth/token failed ${tokenResp.status}: ${text}`);
  }
  const tokenBody = (await readBody(tokenResp)).json as { access_token: string };
  return tokenBody.access_token;
}

export function classifyCliHelp(stdout: string | null | undefined) {
  const text = String(stdout || "");
  const hasCliHelp = PDPP_CLI_PATTERN.test(text);
  const advertisedReadCommands = [
    QUERY_RECORDS_PATTERN,
    SEARCH_WORD_PATTERN,
    AGGREGATE_WORD_PATTERN,
    FETCH_WORD_PATTERN,
  ].filter((pattern) => pattern.test(text));
  return {
    hasCliHelp,
    hasGrantScopedReadCommands: advertisedReadCommands.length > 0,
  };
}

function result(
  status: CheckStatus,
  surface: string,
  name: string,
  detail: string,
  extra: JsonRecord = {}
): CheckResult {
  return { status, surface, name, detail, ...extra };
}

function ok(surface: string, name: string, detail: string, extra?: JsonRecord): CheckResult {
  return result("pass", surface, name, detail, extra);
}

function warn(surface: string, name: string, detail: string, extra?: JsonRecord): CheckResult {
  return result("warn", surface, name, detail, extra);
}

function fail(surface: string, name: string, detail: string, extra?: JsonRecord): CheckResult {
  return result("fail", surface, name, detail, extra);
}

function skip(surface: string, name: string, detail: string, extra?: JsonRecord): CheckResult {
  return result("skip", surface, name, detail, extra);
}

async function fetchText(
  url: string | URL,
  {
    token,
    method = "GET",
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = "application/json",
  }: {
    accept?: string;
    body?: JsonValue;
    method?: string;
    timeoutMs?: number | undefined;
    token?: string | undefined;
  } = {}
): Promise<TextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: accept };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const resp = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: JsonValue = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, contentType: resp.headers.get("content-type"), text, json };
  } finally {
    clearTimeout(timer);
  }
}

function getJson(
  origin: string,
  path: string,
  params: Record<string, JsonValue>,
  opts?: { timeoutMs?: number; token?: string }
): Promise<TextResponse> {
  return fetchText(buildUrl(origin, path, params), opts);
}

async function mcpPost(
  origin: string,
  token: string | undefined,
  message: JsonRecord,
  timeoutMs: number | undefined
): Promise<McpResponse> {
  const resp = await fetchText(`${normalizeOrigin(origin)}/mcp`, {
    token,
    method: "POST",
    body: message,
    timeoutMs,
    accept: "application/json, text/event-stream",
  });
  const rpc = resp.text ? parseMcpResponseText(resp.contentType, resp.text) : null;
  return { ...resp, rpc };
}

async function pushChecked(
  results: CheckResult[],
  surface: string,
  name: string,
  fn: () => CheckResult | Promise<CheckResult>
): Promise<void> {
  try {
    results.push(await fn());
  } catch (error) {
    results.push(fail(surface, name, error instanceof Error ? error.message : String(error)));
  }
}

function require2xx(resp: TextResponse, surface: string, name: string): CheckResult | null {
  if (resp.status >= 200 && resp.status < 300) {
    return null;
  }
  const code = bodyErrorCode(resp.json);
  return fail(surface, name, `HTTP ${resp.status}${code ? ` ${code}` : ""}`, {
    body: (resp.json ?? resp.text) as JsonRecord,
  });
}

function requireMcpOk(resp: McpResponse, name: string): CheckResult | null {
  if (resp.status < 200 || resp.status >= 300) {
    return fail("MCP", name, `HTTP ${resp.status}`, { body: (resp.json ?? resp.text) as JsonRecord });
  }
  const toolError = extractMcpToolError(resp.rpc);
  if (toolError) {
    return fail("MCP", name, `${toolError.code}: ${toolError.message}`);
  }
  return null;
}

interface RestCheckOptions {
  connectionId?: string;
  dateField: string;
  origin: string;
  searchQuery: string;
  since: string;
  stream: string;
  timeoutMs: number;
  token: string;
}

async function runRestChecks({
  origin,
  token,
  connectionId,
  stream,
  searchQuery,
  dateField,
  since,
  timeoutMs,
}: RestCheckOptions) {
  const results: CheckResult[] = [];
  let firstRecordId: string | null = null;

  await pushChecked(results, "REST", "schema", async () => {
    const resp = await getJson(origin, "/v1/schema", {}, { token, timeoutMs });
    const failure = require2xx(resp, "REST", "schema");
    return failure ?? ok("REST", "schema", "schema returned");
  });

  await pushChecked(results, "REST", "schema.compact", async () => {
    const resp = await getJson(origin, "/v1/schema", { view: "compact" }, { token, timeoutMs });
    const failure = require2xx(resp, "REST", "schema.compact");
    if (failure) {
      return failure;
    }
    return jsonRecord(resp.json)?.detail === "compact"
      ? ok("REST", "schema.compact", "compact schema returned")
      : fail("REST", "schema.compact", "schema did not carry detail=compact", { body: resp.json as JsonRecord });
  });

  await pushChecked(results, "REST", "schema.scoped", async () => {
    const resp = await getJson(
      origin,
      "/v1/schema",
      { view: "compact", stream, connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "schema.scoped");
    if (failure) {
      return failure;
    }
    const verdict = classifyScopedSchema(resp.json, stream, connectionId);
    return result(verdict.status, "REST", "schema.scoped", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "REST", "schema.source_identity", async () => {
    const resp = await getJson(
      origin,
      "/v1/schema",
      { view: "compact", stream, connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "schema.source_identity");
    if (failure) {
      return failure;
    }
    const verdict = classifySourceIdentity(resp.json, connectionId);
    return result(verdict.status, "REST", "schema.source_identity", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "REST", "list_streams.scoped", async () => {
    const resp = await getJson(origin, "/v1/streams", { connection_id: connectionId }, { token, timeoutMs });
    const failure = require2xx(resp, "REST", "list_streams.scoped");
    if (failure) {
      return failure;
    }
    const streams = extractListData(resp.json);
    return ok("REST", "list_streams.scoped", `${streams.length} stream(s) returned`);
  });

  await pushChecked(results, "REST", "query_records.basic", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "query_records.basic");
    if (failure) {
      return failure;
    }
    const records = extractListData(resp.json);
    firstRecordId = extractRecordId(records[0]);
    return ok("REST", "query_records.basic", `${records.length} record(s) returned`, { firstRecordId });
  });

  await pushChecked(results, "REST", "query_records.projection", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, fields: ["id"] },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "query_records.projection");
    if (failure) {
      return failure;
    }
    const verdict = classifyStrictProjection(extractListData(resp.json)[0], ["id"]);
    return result(verdict.status, "REST", "query_records.projection", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "REST", "query_records.omit_connection_id", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1 },
      { token, timeoutMs }
    );
    const verdict = classifyAmbiguousConnection(resp.status, resp.json);
    return result(verdict.status, "REST", "query_records.omit_connection_id", verdict.detail);
  });

  await pushChecked(results, "REST", "query_records.sort", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, sort: `-${dateField}` },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "query_records.sort");
    if (!failure) {
      return ok("REST", "query_records.sort", `sort=-${dateField} accepted`);
    }
    if (bodyErrorCode(resp.json) === "unsupported_query") {
      return warn("REST", "query_records.sort", failure.detail);
    }
    return failure;
  });

  await pushChecked(results, "REST", "query_records.count", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, count: "exact" },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "query_records.count");
    if (!failure) {
      const verdict = classifyPageHandles(resp.json);
      return result(
        verdict.status,
        "REST",
        "query_records.count",
        `count=exact accepted; ${verdict.detail}`,
        verdict.extra
      );
    }
    if (bodyErrorCode(resp.json) === "unsupported_query") {
      return warn("REST", "query_records.count", failure.detail);
    }
    return failure;
  });

  await pushChecked(results, "REST", "query_records.filter_object", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records`,
      { limit: 1, connection_id: connectionId, [`filter[${dateField}][gte]`]: since },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "query_records.filter_object");
    return failure
      ? warn("REST", "query_records.filter_object", failure.detail)
      : ok("REST", "query_records.filter_object", "typed bracket filter accepted");
  });

  await pushChecked(results, "REST", "record_detail", async () => {
    if (!firstRecordId) {
      return skip("REST", "record_detail", "no record id returned by basic query");
    }
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(firstRecordId)}`,
      { connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "record_detail");
    return failure ?? ok("REST", "record_detail", `record ${firstRecordId} returned`);
  });

  await pushChecked(results, "REST", "record_detail.projection", async () => {
    if (!firstRecordId) {
      return skip("REST", "record_detail.projection", "no record id returned by basic query");
    }
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(firstRecordId)}`,
      { connection_id: connectionId, fields: ["id"] },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "record_detail.projection");
    if (failure) {
      return failure;
    }
    const verdict = classifyStrictProjection(jsonRecord(resp.json)?.data ?? resp.json, ["id"]);
    return result(verdict.status, "REST", "record_detail.projection", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "REST", "search.lexical", async () => {
    const resp = await getJson(
      origin,
      "/v1/search",
      { q: searchQuery, streams: stream, limit: 1, connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "search.lexical");
    return failure ?? ok("REST", "search.lexical", "lexical search returned");
  });

  await pushChecked(results, "REST", "search.fan_in_limit_source_identity", async () => {
    const limit = 3;
    const resp = await getJson(origin, "/v1/search", { q: searchQuery, streams: stream, limit }, { token, timeoutMs });
    const failure = require2xx(resp, "REST", "search.fan_in_limit_source_identity");
    if (failure) {
      return failure;
    }
    const verdict = classifySearchLimitAndSource(resp.json, limit);
    return result(verdict.status, "REST", "search.fan_in_limit_source_identity", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "REST", "aggregate.count", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/aggregate`,
      { metric: "count", connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "aggregate.count");
    return failure ?? ok("REST", "aggregate.count", "count aggregate returned");
  });

  await pushChecked(results, "REST", "aggregate.group_by_time", async () => {
    const resp = await getJson(
      origin,
      `/v1/streams/${encodeURIComponent(stream)}/aggregate`,
      { metric: "count", group_by_time: dateField, granularity: "day", limit: 7, connection_id: connectionId },
      { token, timeoutMs }
    );
    const failure = require2xx(resp, "REST", "aggregate.group_by_time");
    return failure
      ? warn("REST", "aggregate.group_by_time", failure.detail)
      : ok("REST", "aggregate.group_by_time", `${dateField}/day aggregate returned`);
  });

  await pushChecked(results, "REST", "event_capabilities", async () => {
    const resp = await getJson(origin, "/.well-known/oauth-protected-resource", {}, { timeoutMs });
    const failure = require2xx(resp, "REST", "event_capabilities");
    if (failure) {
      return failure;
    }
    const capabilities = jsonRecord(jsonRecord(resp.json)?.capabilities);
    const clientEventSubscriptions = jsonRecord(capabilities?.client_event_subscriptions);
    const supported = clientEventSubscriptions?.supported;
    return supported === true
      ? ok("REST", "event_capabilities", "client event subscriptions advertised")
      : warn("REST", "event_capabilities", "client event subscriptions not advertised");
  });

  await pushChecked(results, "REST", "list_event_subscriptions", async () => {
    const resp = await getJson(origin, "/v1/event-subscriptions", {}, { token, timeoutMs });
    const failure = require2xx(resp, "REST", "list_event_subscriptions");
    return failure ?? ok("REST", "list_event_subscriptions", "event subscriptions listed");
  });

  await pushChecked(results, "REST", "excluded_bearer", async () => {
    const resp = await getJson(origin, "/v1/schema", {}, { token: NON_GRANT_BEARER, timeoutMs });
    const verdict = classifyExcludedBearer(resp.status, resp.json);
    return result(verdict.status, "REST", "excluded_bearer", verdict.detail, verdict.extra);
  });

  return { results, firstRecordId };
}

interface McpCheckOptions {
  connectionId?: string;
  dateField: string;
  origin: string;
  searchQuery: string;
  since: string;
  stream: string;
  timeoutMs: number;
  token: string;
}

async function runMcpChecks({
  origin,
  token,
  connectionId,
  stream,
  searchQuery,
  dateField,
  since,
  timeoutMs,
}: McpCheckOptions) {
  const results: CheckResult[] = [];
  let id = 1;
  let firstRecordId: string | null = null;
  const call = (name: string, args: JsonRecord) => {
    id += 1;
    return mcpPost(origin, token, mcpToolCallMessage(name, args, id), timeoutMs);
  };

  await pushChecked(results, "MCP", "initialize", async () => {
    id += 1;
    const resp = await mcpPost(origin, token, mcpInitializeMessage(id), timeoutMs);
    if (resp.status >= 200 && resp.status < 300 && !resp.rpc?.error) {
      return ok("MCP", "initialize", "initialized");
    }
    return fail("MCP", "initialize", `HTTP ${resp.status}: ${resp.rpc?.error?.message ?? resp.text}`);
  });

  let toolNames: string[] = [];
  await pushChecked(results, "MCP", "tools.list", async () => {
    id += 1;
    const resp = await mcpPost(origin, token, mcpToolsListMessage(id), timeoutMs);
    if (resp.status < 200 || resp.status >= 300 || resp.rpc?.error) {
      return fail("MCP", "tools.list", `HTTP ${resp.status}: ${resp.rpc?.error?.message ?? resp.text}`);
    }
    const tools = jsonArray(resp.rpc?.result?.tools) as McpTool[];
    toolNames = tools.map((tool) => tool.name).filter((name): name is string => Boolean(name));
    const verdict = classifyToolNames(toolNames);
    if (verdict.missingCore.length > 0) {
      return fail("MCP", "tools.list", `missing core tool(s): ${verdict.missingCore.join(", ")}`);
    }
    if (verdict.forbiddenPresent.length > 0 || verdict.unexpectedTools.length > 0) {
      const extra = [...new Set([...verdict.forbiddenPresent, ...verdict.unexpectedTools])];
      return fail("MCP", "tools.list", `${verdict.detail}; unexpected normal-surface tool(s): ${extra.join(", ")}`);
    }
    const schemaTool = tools.find((tool) => tool.name === "schema");
    const schemaProperties = schemaTool?.inputSchema?.properties;
    if (!schemaProperties?.connection_id) {
      return fail("MCP", "tools.list", "schema tool does not expose connection_id in inputSchema");
    }
    return ok("MCP", "tools.list", `${verdict.detail}; exact normal read surface present`);
  });

  await pushChecked(results, "MCP", "schema", async () => {
    const resp = await call("schema", {});
    const failure = requireMcpOk(resp, "schema");
    return failure ?? ok("MCP", "schema", "schema returned");
  });

  await pushChecked(results, "MCP", "schema.compact", async () => {
    const resp = await call("schema", { detail: "compact" });
    const failure = requireMcpOk(resp, "schema.compact");
    if (failure) {
      return failure;
    }
    const body = jsonRecord(extractMcpToolData(resp.rpc));
    return body?.detail === "compact"
      ? ok("MCP", "schema.compact", "compact schema returned")
      : warn("MCP", "schema.compact", `compact schema detail was ${body?.detail ?? "<unset>"}`);
  });

  await pushChecked(results, "MCP", "schema.scoped_full", async () => {
    const resp = await call("schema", { stream, connection_id: connectionId, detail: "full" });
    const failure = requireMcpOk(resp, "schema.scoped_full");
    if (failure) {
      return failure;
    }
    const bytes = Buffer.byteLength(JSON.stringify(resp.rpc?.result?.structuredContent ?? {}), "utf8");
    if (bytes > SCOPED_FULL_SCHEMA_BYTE_BUDGET) {
      return fail(
        "MCP",
        "schema.scoped_full",
        `scoped full schema exceeded ${SCOPED_FULL_SCHEMA_BYTE_BUDGET} bytes (${bytes}); likely ignored stream/connection scope`
      );
    }
    return ok("MCP", "schema.scoped_full", `scoped full schema stayed bounded (${bytes} bytes)`);
  });

  await pushChecked(results, "MCP", "schema.source_identity", async () => {
    const resp = await call("schema", { stream, connection_id: connectionId, detail: "compact" });
    const failure = requireMcpOk(resp, "schema.source_identity");
    if (failure) {
      return failure;
    }
    const verdict = classifySourceIdentity(extractMcpToolData(resp.rpc), connectionId);
    return result(verdict.status, "MCP", "schema.source_identity", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "MCP", "query_records.basic", async () => {
    const resp = await call("query_records", { stream, limit: 1, connection_id: connectionId });
    const failure = requireMcpOk(resp, "query_records.basic");
    if (failure) {
      return failure;
    }
    const records = extractListData(extractMcpToolData(resp.rpc));
    firstRecordId = extractRecordId(records[0]);
    return ok("MCP", "query_records.basic", `${records.length} record(s) returned`, { firstRecordId });
  });

  await pushChecked(results, "MCP", "query_records.projection", async () => {
    const resp = await call("query_records", { stream, limit: 1, connection_id: connectionId, fields: ["id"] });
    const failure = requireMcpOk(resp, "query_records.projection");
    if (failure) {
      return failure;
    }
    const verdict = classifyStrictProjection(extractListData(extractMcpToolData(resp.rpc))[0], ["id"]);
    return result(verdict.status, "MCP", "query_records.projection", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "MCP", "query_records.omit_connection_id", async () => {
    const resp = await call("query_records", { stream, limit: 1 });
    const toolError = extractMcpToolError(resp.rpc);
    if (!toolError && resp.status >= 200 && resp.status < 300) {
      return ok(
        "MCP",
        "query_records.omit_connection_id",
        "request succeeded without connection_id; grant may be single-source"
      );
    }
    if (toolError?.code === "ambiguous_connection") {
      return ok("MCP", "query_records.omit_connection_id", "returned typed ambiguous_connection");
    }
    return fail(
      "MCP",
      "query_records.omit_connection_id",
      // toolError can still be null here (the first branch above only
      // returns when status is ALSO 2xx) — tsc agrees `toolError?.code` is
      // genuinely string | undefined at this point, unlike Biome's own
      // (non-type-aware) suggestion to drop the fallback.
      // biome-ignore lint/suspicious/noUnnecessaryConditions: verified against tsc; toolError can be null here, see comment above
      `expected success or ambiguous_connection; got ${toolError?.code ?? `HTTP ${resp.status}`}`
    );
  });

  await pushChecked(results, "MCP", "query_records.sort_count", async () => {
    const resp = await call("query_records", {
      stream,
      limit: 1,
      connection_id: connectionId,
      sort: `-${dateField}`,
      count: "exact",
    });
    const failure = requireMcpOk(resp, "query_records.sort_count");
    if (!failure) {
      const verdict = classifyPageHandles(extractMcpToolData(resp.rpc));
      return result(
        verdict.status,
        "MCP",
        "query_records.sort_count",
        `sort=-${dateField} and count=exact accepted; ${verdict.detail}`,
        verdict.extra
      );
    }
    return failure.detail.includes("unsupported_query")
      ? warn("MCP", "query_records.sort_count", failure.detail)
      : failure;
  });

  await pushChecked(results, "MCP", "query_records.filter_object", async () => {
    const resp = await call("query_records", {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: { [dateField]: { gte: since } },
    });
    const failure = requireMcpOk(resp, "query_records.filter_object");
    return failure
      ? warn("MCP", "query_records.filter_object", failure.detail)
      : ok("MCP", "query_records.filter_object", "typed filter object accepted");
  });

  await pushChecked(results, "MCP", "query_records.filter_legacy_literal", async () => {
    const resp = await call("query_records", {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: `filter[${dateField}][gte]=${since}`,
    });
    const toolError = extractMcpToolError(resp.rpc);
    if (toolError) {
      return ok("MCP", "query_records.filter_legacy_literal", `legacy string filter rejected (${toolError.code})`);
    }
    return warn(
      "MCP",
      "query_records.filter_legacy_literal",
      "legacy string filter unexpectedly accepted; MCP filters should be typed objects"
    );
  });

  await pushChecked(results, "MCP", "query_records.filter_legacy_encoded", async () => {
    const resp = await call("query_records", {
      stream,
      limit: 1,
      connection_id: connectionId,
      filter: `filter%5B${dateField}%5D%5Bgte%5D=${encodeURIComponent(since)}`,
    });
    const toolError = extractMcpToolError(resp.rpc);
    if (toolError) {
      return ok("MCP", "query_records.filter_legacy_encoded", `encoded raw filter rejected (${toolError.code})`);
    }
    return warn(
      "MCP",
      "query_records.filter_legacy_encoded",
      "encoded raw filter unexpectedly accepted; MCP filters should be typed objects"
    );
  });

  await pushChecked(results, "MCP", "fetch", async () => {
    if (!firstRecordId) {
      return skip("MCP", "fetch", "no record id returned by basic query");
    }
    const resp = await call("fetch", { id: `${stream}:${firstRecordId}`, connection_id: connectionId });
    const failure = requireMcpOk(resp, "fetch");
    return failure ?? ok("MCP", "fetch", `fetched ${stream}:${firstRecordId}`);
  });

  await pushChecked(results, "MCP", "fetch.projection", async () => {
    if (!firstRecordId) {
      return skip("MCP", "fetch.projection", "no record id returned by basic query");
    }
    const resp = await call("fetch", { id: `${stream}:${firstRecordId}`, connection_id: connectionId, fields: ["id"] });
    const failure = requireMcpOk(resp, "fetch.projection");
    if (failure) {
      return failure;
    }
    const doc = jsonRecord(extractMcpToolData(resp.rpc));
    let projected: JsonValue = null;
    try {
      projected = typeof doc?.text === "string" ? JSON.parse(doc.text) : null;
    } catch {
      projected = null;
    }
    if (!projected) {
      return warn("MCP", "fetch.projection", "fetch returned a document but text was not JSON-projectable");
    }
    const verdict = classifyStrictProjection(jsonRecord(projected)?.data ?? projected, ["id"]);
    return result(verdict.status, "MCP", "fetch.projection", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "MCP", "search.lexical", async () => {
    const resp = await call("search", {
      q: searchQuery,
      streams: [stream],
      limit: 1,
      mode: "lexical",
      connection_id: connectionId,
    });
    const failure = requireMcpOk(resp, "search.lexical");
    return failure ?? ok("MCP", "search.lexical", "lexical search returned");
  });

  await pushChecked(results, "MCP", "search.fan_in_limit_source_identity", async () => {
    const limit = 3;
    const resp = await call("search", { q: searchQuery, streams: [stream], limit, mode: "lexical" });
    const failure = requireMcpOk(resp, "search.fan_in_limit_source_identity");
    if (failure) {
      return failure;
    }
    const verdict = classifySearchLimitAndSource(extractMcpToolStructuredContent(resp.rpc), limit);
    return result(verdict.status, "MCP", "search.fan_in_limit_source_identity", verdict.detail, verdict.extra);
  });

  await pushChecked(results, "MCP", "aggregate.count", async () => {
    const resp = await call("aggregate", { stream, metric: "count", connection_id: connectionId });
    const failure = requireMcpOk(resp, "aggregate.count");
    return failure ?? ok("MCP", "aggregate.count", "count aggregate returned");
  });

  await pushChecked(results, "MCP", "aggregate.group_by_time", async () => {
    const resp = await call("aggregate", {
      stream,
      metric: "count",
      group_by_time: dateField,
      granularity: "day",
      limit: 7,
      connection_id: connectionId,
    });
    const failure = requireMcpOk(resp, "aggregate.group_by_time");
    return failure
      ? warn("MCP", "aggregate.group_by_time", failure.detail)
      : ok("MCP", "aggregate.group_by_time", `${dateField}/day aggregate returned`);
  });

  await pushChecked(results, "MCP", "excluded_bearer", async () => {
    id += 1;
    const resp = await mcpPost(origin, NON_GRANT_BEARER, mcpToolsListMessage(id), timeoutMs);
    if (resp.status >= 200 && resp.status < 300 && !resp.rpc?.error) {
      return fail("MCP", "excluded_bearer", "MCP served a non-grant bearer; scoped-grant requirement not enforced");
    }
    const verdict = classifyExcludedBearer(resp.status, resp.json);
    return result(verdict.status, "MCP", "excluded_bearer", verdict.detail, verdict.extra);
  });

  results.push(
    warn(
      "ChatGPT host",
      "direct_recipient_routing",
      "direct MCP cannot reproduce ChatGPT host resource invalidation; rerun the ChatGPT-host checklist after this passes"
    )
  );
  return { results, toolNames };
}

interface CliCheckOptions {
  connectionId?: string;
  dateField: string;
  origin: string;
  searchQuery: string;
  stream: string;
  timeoutMs: number;
  token: string;
}
interface CliChildResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

async function runCliChecks({
  origin,
  token,
  connectionId,
  stream,
  searchQuery,
  dateField,
  timeoutMs,
}: CliCheckOptions) {
  const results: CheckResult[] = [];
  const { spawnSync } = await import("node:child_process");
  const cliBin = join(process.cwd(), "packages/cli/bin/pdpp.ts");
  let parent: string | null = null;
  let cacheRoot: string | null = null;
  let firstRecordId: string | null = null;

  async function writeCredentialCache(root: string, credentialToken: string): Promise<void> {
    const cacheFile = cliCredentialCacheFile(root, origin);
    await mkdir(join(root, "clients"), { recursive: true, mode: 0o700 });
    await writeFile(
      cacheFile,
      `${JSON.stringify(
        {
          provider_url: normalizeOrigin(origin),
          authorization_server: normalizeOrigin(origin),
          scope: "pdpp:read",
          client: { client_id: "read-surface-smoke" },
          credential: { access_token: credentialToken, token_type: "Bearer" },
          created_at: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
  }

  async function ensureCache(): Promise<string> {
    if (cacheRoot) {
      return cacheRoot;
    }
    parent = await mkdtemp(join(tmpdir(), "pdpp-read-surface-cli-"));
    cacheRoot = join(parent, ".pdpp");
    await writeCredentialCache(cacheRoot, token);
    return cacheRoot;
  }

  function spawnCli(args: string[]): CliChildResult {
    return spawnSync("node", [cliBin, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
  }

  try {
    await pushChecked(results, "CLI", "help", () => {
      const child = spawnCli(["--help"]);
      if (child.status !== 0) {
        return fail("CLI", "help", `pdpp --help exited ${child.status}: ${child.stderr || child.stdout}`);
      }
      const verdict = classifyCliHelp(child.stdout);
      if (!verdict.hasCliHelp) {
        return fail("CLI", "help", "help output did not identify the PDPP CLI");
      }
      return ok("CLI", "help", "pdpp --help returned");
    });

    await pushChecked(results, "CLI", "token_cache", async () => {
      const root = await ensureCache();
      const child = spawnCli(["token", normalizeOrigin(origin), "--cache-root", root]);
      if (child.status !== 0) {
        return fail("CLI", "token_cache", `pdpp token exited ${child.status}: ${child.stderr || child.stdout}`);
      }
      if (child.stdout.trim() !== token) {
        return fail("CLI", "token_cache", "pdpp token did not return the cached bearer");
      }
      return ok("CLI", "token_cache", "stored credential can be read by pdpp token");
    });

    await pushChecked(results, "CLI", "grant_scoped_read_commands", () => {
      const child = spawnCli(["--help"]);
      if (child.status !== 0) {
        return fail("CLI", "grant_scoped_read_commands", `pdpp --help exited ${child.status}`);
      }
      const verdict = classifyCliHelp(child.stdout);
      return verdict.hasGrantScopedReadCommands
        ? ok("CLI", "grant_scoped_read_commands", "grant-scoped read commands are advertised")
        : warn(
            "CLI",
            "grant_scoped_read_commands",
            "current pdpp CLI exposes connect/token but not query_records/search/aggregate/fetch read commands"
          );
    });

    await pushChecked(results, "CLI", "schema", async () => {
      const root = await ensureCache();
      const child = spawnCli(["read", "schema", normalizeOrigin(origin), "--cache-root", root, "--format", "json"]);
      if (child.status !== 0) {
        return fail("CLI", "schema", `pdpp read schema exited ${child.status}: ${child.stderr || child.stdout}`);
      }
      const parsed = JSON.parse(child.stdout);
      return parsed
        ? ok("CLI", "schema", "schema returned through cached grant")
        : fail("CLI", "schema", "empty schema output");
    });

    await pushChecked(results, "CLI", "schema.compact", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "schema",
        normalizeOrigin(origin),
        "--view",
        "compact",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "schema.compact",
          `pdpp read schema compact exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const body = jsonRecord(JSON.parse(child.stdout));
      return body?.detail === "compact"
        ? ok("CLI", "schema.compact", "compact schema returned through cached grant")
        : warn("CLI", "schema.compact", `compact schema detail was ${body?.detail ?? "<unset>"}`);
    });

    await pushChecked(results, "CLI", "schema.scoped", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "schema",
        normalizeOrigin(origin),
        "--view",
        "compact",
        "--stream",
        stream,
        "--connection-id",
        connectionId ?? "",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "schema.scoped",
          `pdpp read schema scoped exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const verdict = classifyScopedSchema(JSON.parse(child.stdout), stream, connectionId);
      return result(verdict.status, "CLI", "schema.scoped", verdict.detail, verdict.extra);
    });

    await pushChecked(results, "CLI", "schema.source_identity", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "schema",
        normalizeOrigin(origin),
        "--view",
        "compact",
        "--stream",
        stream,
        "--connection-id",
        connectionId ?? "",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "schema.source_identity",
          `pdpp read schema scoped exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const verdict = classifySourceIdentity(JSON.parse(child.stdout), connectionId);
      return result(verdict.status, "CLI", "schema.source_identity", verdict.detail, verdict.extra);
    });

    await pushChecked(results, "CLI", "query_records.basic", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "query-records",
        normalizeOrigin(origin),
        stream,
        "--connection-id",
        connectionId ?? "",
        "--limit",
        "1",
        "--sort",
        `-${dateField}`,
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "query_records.basic",
          `pdpp read query-records exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const records = extractListData(JSON.parse(child.stdout));
      firstRecordId = extractRecordId(records[0]);
      return ok("CLI", "query_records.basic", `${records.length} record(s) returned through cached grant`);
    });

    await pushChecked(results, "CLI", "query_records.projection", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "query-records",
        normalizeOrigin(origin),
        stream,
        "--connection-id",
        connectionId ?? "",
        "--limit",
        "1",
        "--fields",
        "id",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "query_records.projection",
          `pdpp read query-records projection exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const verdict = classifyStrictProjection(extractListData(JSON.parse(child.stdout))[0], ["id"]);
      return result(verdict.status, "CLI", "query_records.projection", verdict.detail, verdict.extra);
    });

    await pushChecked(results, "CLI", "query_records.omit_connection_id", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "query-records",
        normalizeOrigin(origin),
        stream,
        "--limit",
        "1",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status === 0) {
        return ok(
          "CLI",
          "query_records.omit_connection_id",
          "request succeeded without connection_id; grant may be single-source"
        );
      }
      const combined = `${child.stderr || ""}\n${child.stdout || ""}`;
      return AMBIGUOUS_OR_CONNECTION_ID_PATTERN.test(combined)
        ? ok("CLI", "query_records.omit_connection_id", "returned typed ambiguity guidance")
        : fail(
            "CLI",
            "query_records.omit_connection_id",
            `expected success or ambiguous_connection; got exit ${child.status}: ${combined.trim()}`
          );
    });

    await pushChecked(results, "CLI", "query_records.count", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "query-records",
        normalizeOrigin(origin),
        stream,
        "--connection-id",
        connectionId ?? "",
        "--limit",
        "1",
        "--count",
        "exact",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "query_records.count",
          `pdpp read query-records count exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const verdict = classifyPageHandles(JSON.parse(child.stdout));
      return result(
        verdict.status,
        "CLI",
        "query_records.count",
        `count=exact accepted; ${verdict.detail}`,
        verdict.extra
      );
    });

    await pushChecked(results, "CLI", "fetch.projection", async () => {
      if (!firstRecordId) {
        return skip("CLI", "fetch.projection", "no record id returned by basic query");
      }
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "fetch",
        normalizeOrigin(origin),
        stream,
        firstRecordId,
        "--connection-id",
        connectionId ?? "",
        "--fields",
        "id",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "fetch.projection",
          `pdpp read fetch projection exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const parsed = JSON.parse(child.stdout);
      const verdict = classifyStrictProjection(jsonRecord(parsed)?.data ?? parsed, ["id"]);
      return result(verdict.status, "CLI", "fetch.projection", verdict.detail, verdict.extra);
    });

    await pushChecked(results, "CLI", "search.fan_in_limit_source_identity", async () => {
      const root = await ensureCache();
      const limit = 3;
      const child = spawnCli([
        "read",
        "search",
        normalizeOrigin(origin),
        searchQuery,
        "--streams",
        stream,
        "--limit",
        String(limit),
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "search.fan_in_limit_source_identity",
          `pdpp read search exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const verdict = classifySearchLimitAndSource(JSON.parse(child.stdout), limit);
      return result(verdict.status, "CLI", "search.fan_in_limit_source_identity", verdict.detail, verdict.extra);
    });

    await pushChecked(results, "CLI", "aggregate.count", async () => {
      const root = await ensureCache();
      const child = spawnCli([
        "read",
        "aggregate",
        normalizeOrigin(origin),
        stream,
        "--metric",
        "count",
        "--connection-id",
        connectionId ?? "",
        "--cache-root",
        root,
        "--format",
        "json",
      ]);
      if (child.status !== 0) {
        return fail(
          "CLI",
          "aggregate.count",
          `pdpp read aggregate exited ${child.status}: ${child.stderr || child.stdout}`
        );
      }
      const parsed = JSON.parse(child.stdout);
      return parsed
        ? ok("CLI", "aggregate.count", "count aggregate returned through cached grant")
        : fail("CLI", "aggregate.count", "empty aggregate output");
    });

    await pushChecked(results, "CLI", "excluded_bearer", async () => {
      let junkParent: string | null = null;
      try {
        junkParent = await mkdtemp(join(tmpdir(), "pdpp-read-surface-cli-junk-"));
        const junkRoot = join(junkParent, ".pdpp");
        await writeCredentialCache(junkRoot, NON_GRANT_BEARER);
        const child = spawnCli([
          "read",
          "schema",
          normalizeOrigin(origin),
          "--cache-root",
          junkRoot,
          "--format",
          "json",
        ]);
        if (child.status === 0) {
          return fail("CLI", "excluded_bearer", "CLI served a non-grant bearer; scoped-grant requirement not enforced");
        }
        return ok(
          "CLI",
          "excluded_bearer",
          `non-grant bearer rejected (exit ${child.status}); reads require the scoped grant`
        );
      } finally {
        if (junkParent) {
          await rm(junkParent, { recursive: true, force: true });
        }
      }
    });
  } finally {
    if (parent) {
      await rm(parent, { recursive: true, force: true });
    }
  }

  return { results };
}

interface ReadSurfaceSmokeOptions {
  connectionId?: string;
  dateField: string;
  origin: string;
  searchQuery: string;
  since: string;
  skipCli: boolean;
  skipMcp: boolean;
  skipRest: boolean;
  stream: string;
  timeoutMs: number;
  token: string;
}

export async function runReadSurfaceSmoke(options: ReadSurfaceSmokeOptions) {
  const all: CheckResult[] = [];
  if (!options.skipRest) {
    const rest = await runRestChecks(options);
    all.push(...rest.results);
  }
  if (!options.skipMcp) {
    const mcp = await runMcpChecks(options);
    all.push(...mcp.results);
  }
  if (!options.skipCli) {
    const cli = await runCliChecks(options);
    all.push(...cli.results);
  }
  const summary = summarizeResults(all);
  const parityMatrix = buildParityMatrix(all);
  const combinedSummary = { ...summary, ok: summary.ok && parityMatrix.ok };
  return { results: all, summary: combinedSummary, parityMatrix };
}

function printTextReport(origin: string, report: Awaited<ReturnType<typeof runReadSurfaceSmoke>>): void {
  process.stdout.write(`PDPP read-surface smoke against ${origin}\n`);
  for (const entry of report.results) {
    const marker = entry.status.toUpperCase().padEnd(4);
    process.stdout.write(`  ${marker} ${entry.surface}.${entry.name}: ${entry.detail}\n`);
  }
  if (report.parityMatrix) {
    process.stdout.write("\nParity matrix (shared read semantics):\n");
    const header = ["row".padEnd(20), ...PARITY_TRANSPORTS.map((transport) => transport.padEnd(7))].join(" ");
    process.stdout.write(`  ${header}\n`);
    for (const { row, transports, diverged } of report.parityMatrix.rows) {
      const cells = PARITY_TRANSPORTS.map((transport) => String(transports[transport]).padEnd(7)).join(" ");
      const flag = diverged ? "  <- DIVERGED" : "";
      process.stdout.write(`  ${row.padEnd(20)} ${cells}${flag}\n`);
    }
    if (report.parityMatrix.diverged) {
      process.stdout.write("  parity FAILED: a shared behavior passed on one adapter and failed on another\n");
    }
  }
  const { counts } = report.summary;
  process.stdout.write(
    `\nSummary: ${counts.pass} pass, ${counts.warn} warn, ${counts.skip} skip, ${counts.fail} fail\n`
  );
}

const USAGE = `Usage: node --import tsx scripts/read-surface-smoke.ts --origin <url> --connection-id <cin> [options]

Options:
  --origin <url>            PDPP composed origin / resource server origin.
  --token <bearer>          Client or MCP package bearer. Defaults to
                            PDPP_READ_SURFACE_TOKEN.
  --owner-password <secret> Owner password used to mint a scoped client token
                            when --token is omitted. Defaults to
                            PDPP_OWNER_PASSWORD.
  --owner-subject <id>      Owner subject for consent approval (default:
                            PDPP_OWNER_SUBJECT_ID or owner_local).
  --connector-id <id>       Connector source id for minted scoped grants when
                            --token is omitted.
  --connection-id <cin>     Connection id to use for scoped read tests.
  --stream <name>           Stream to test (default: messages).
  --search-query <q>        Lexical search probe query (default: test).
  --date-field <field>      Date field for sort/filter/time-bucket probes
                            (default: sent_at).
  --since <iso>             Lower bound for filter probes (default: 1970-01-01).
  --timeout-ms <n>          Per-request timeout (default: 30000).
  --skip-rest               Only run MCP checks.
  --skip-mcp                Only run REST checks.
  --skip-cli                Skip local CLI credential/help checks.
  --json                    Emit machine-readable JSON.
  -h, --help                Show this help.

Exit code 0 means every core REST/MCP check passed. Warnings call out optional
or host-only evidence gaps, including ChatGPT direct-recipient routing and the
current CLI lack of grant-scoped read commands.`;

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!(opts.origin && opts.connectionId)) {
    process.stderr.write(`--origin and --connection-id are required.\n\n${USAGE}\n`);
    process.exit(2);
  }
  const origin = normalizeOrigin(opts.origin);
  let token = opts.token ?? process.env.PDPP_READ_SURFACE_TOKEN;
  if (!token) {
    const ownerPassword = opts.ownerPassword ?? process.env.PDPP_OWNER_PASSWORD;
    const ownerSubject = opts.ownerSubject ?? process.env.PDPP_OWNER_SUBJECT_ID ?? "owner_local";
    if (!(ownerPassword && opts.connectorId)) {
      process.stderr.write(
        `--token/PDPP_READ_SURFACE_TOKEN or (--owner-password/PDPP_OWNER_PASSWORD plus --connector-id) is required.\n\n${USAGE}\n`
      );
      process.exit(2);
    }
    token = await mintScopedClientToken({
      origin,
      ownerPassword,
      ownerSubject,
      connectorId: opts.connectorId,
      connectionId: opts.connectionId,
      stream: opts.stream,
    });
  }
  const options: ReadSurfaceSmokeOptions = {
    ...opts,
    origin,
    token,
  };
  const report = await runReadSurfaceSmoke(options);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ origin: options.origin, ...report }, null, 2)}\n`);
  } else {
    printTextReport(options.origin, report);
  }
  process.exit(report.summary.ok ? 0 : 1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectError, normalizeProviderUrl, readStoredCredential } from "../connect/flow.ts";
import { type ParsedFlags, parseArgs, requirePositional } from "../ref/args.ts";
import type { CommandIo } from "../ref/commands/call.ts";
import { PdppHttpError, PdppUsageError } from "../ref/errors.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../ref/output.ts";

const COMMANDS = new Set(["schema", "streams", "query-records", "fetch", "field-window", "search", "aggregate"]);
const SEARCH_MODE_PATHS: Record<string, string> = {
  semantic: "/v1/search/semantic",
  hybrid: "/v1/search/hybrid",
};

export function readHelp(binName = "pdpp"): string {
  return `Grant-scoped reads (uses pdpp connect/token cache, never owner credentials):
  ${binName} read schema <provider-url> [--view compact] [--stream <name>] [--connection-id <cin>] [--cache-root <dir>] [--format json|table]
  ${binName} read streams <provider-url> [--connection-id <cin>] [--cache-root <dir>] [--format json|table]
  ${binName} read query-records <provider-url> <stream> [--connection-id <cin>] [--limit <n>] [--cursor <cursor>] [--fields a,b] [--sort <spec>] [--count none|estimated|exact] [--filter-json <json>] [--format json|jsonl|table]
  ${binName} read fetch <provider-url> <stream> <record-id> [--connection-id <cin>] [--fields a,b] [--format json|table]
  ${binName} read field-window <provider-url> <stream> <record-id> --field <path> [--connection-id <cin>] [--q <text>] [--offset-chars <n>] [--limit-chars <n>] [--before-chars <n>] [--after-chars <n>] [--format json|table]
  ${binName} read search <provider-url> <query> [--connection-id <cin>] [--streams a,b] [--mode lexical|semantic|hybrid] [--limit <n>] [--format json|jsonl|table]
  ${binName} read aggregate <provider-url> <stream> --metric <metric> [--field <field>] [--connection-id <cin>] [--group-by <field> | --group-by-time <field> --granularity <unit>] [--limit <n>] [--format json|table]`;
}

export async function runRead(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    out.write(`${readHelp()}\n`);
    return 0;
  }

  if (!COMMANDS.has(command)) {
    throw new PdppUsageError(`Unknown read command: ${command}`);
  }

  const { flags, positionals } = parseArgs(rest);
  const providerUrl = requirePositional(positionals, 0, "provider-url");
  let credential: { access_token: string };
  let normalizedProviderUrl: string;
  try {
    const stored = await readStoredCredential(providerUrl, {
      cacheRoot: typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined,
    });
    credential = stored.credential as { access_token: string };
    normalizedProviderUrl = stored.providerUrl;
  } catch (error) {
    if (error instanceof ConnectError) {
      // biome-ignore lint/style/useErrorCause: PdppUsageError's constructor (message, details) has no cause param; the ConnectError's message is folded into the thrown message instead.
      throw new PdppUsageError(error.message);
    }
    throw error;
  }

  const request = buildReadRequest(command, positionals.slice(1), flags, normalizedProviderUrl);
  const body = await fetchReadJson(request, credential.access_token, fetchImpl);
  writeData(projectOutput(body, flags), resolveFormat(flags, "json", "json"), out);
  writeEnvelopeWarnings(body, err);
  return 0;
}

interface ReadRequest {
  method: string;
  url: string;
}

type QueryValue = string | number | boolean | string[] | undefined;
type QueryRecord = Record<string, QueryValue>;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one request builder per read subcommand, dispatched by a flat if-chain on `command`; splitting would scatter each subcommand's query-param mapping across files for no reduction in real complexity.
export function buildReadRequest(
  command: string,
  positionals: string[],
  flags: ParsedFlags,
  providerUrl: string
): ReadRequest {
  const origin = normalizeProviderUrl(providerUrl);
  if (!origin) {
    throw new PdppUsageError(`Invalid provider URL: ${providerUrl}`);
  }

  if (command === "schema") {
    return {
      method: "GET",
      url: buildUrl(origin, "/v1/schema", pickQuery(flags, ["connector-id", "connection-id", "stream", "view"])),
    };
  }

  if (command === "streams") {
    return {
      method: "GET",
      url: buildUrl(origin, "/v1/streams", pickQuery(flags, ["connection-id", "connector-instance-id"])),
    };
  }

  if (command === "query-records") {
    const stream = requirePositional(positionals, 0, "stream");
    const query: QueryRecord = {
      ...pickQuery(flags, [
        "connection-id",
        "connector-instance-id",
        "cursor",
        "limit",
        "order",
        "sort",
        "count",
        "changes-since",
      ]),
      ...csvQuery(flags, "fields"),
      ...jsonFilterQuery(flags),
    };
    return { method: "GET", url: buildUrl(origin, `/v1/streams/${encodeURIComponent(stream)}/records`, query) };
  }

  if (command === "fetch") {
    const stream = requirePositional(positionals, 0, "stream");
    const recordId = requirePositional(positionals, 1, "record-id");
    const query: QueryRecord = {
      ...pickQuery(flags, ["connection-id", "connector-instance-id"]),
      ...csvQuery(flags, "fields"),
    };
    return {
      method: "GET",
      url: buildUrl(origin, `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`, query),
    };
  }

  if (command === "field-window") {
    const stream = requirePositional(positionals, 0, "stream");
    const recordId = requirePositional(positionals, 1, "record-id");
    if (!flags.field) {
      throw new PdppUsageError("Missing required flag: --field");
    }
    const query = pickQuery(flags, [
      "connection-id",
      "field",
      "cursor",
      "offset-chars",
      "limit-chars",
      "q",
      "before-chars",
      "after-chars",
    ]);
    return {
      method: "GET",
      url: buildUrl(
        origin,
        `/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}/field-window`,
        query
      ),
    };
  }

  if (command === "search") {
    const queryText = requirePositional(positionals, 0, "query");
    const mode = flags.mode ? String(flags.mode) : undefined;
    const path = SEARCH_MODE_PATHS[mode ?? ""] ?? "/v1/search";
    const query: QueryRecord = {
      q: queryText,
      ...pickQuery(flags, ["connection-id", "connector-instance-id", "cursor", "limit"]),
      ...csvQuery(flags, "streams"),
    };
    return { method: "GET", url: buildUrl(origin, path, query) };
  }

  if (command === "aggregate") {
    const stream = requirePositional(positionals, 0, "stream");
    if (!flags.metric) {
      throw new PdppUsageError("Missing required flag: --metric");
    }
    if (flags["group-by"] && flags["group-by-time"]) {
      throw new PdppUsageError("Use only one of --group-by or --group-by-time.");
    }
    const query: QueryRecord = pickQuery(flags, [
      "connection-id",
      "connector-instance-id",
      "field",
      "granularity",
      "limit",
      "metric",
      "time-zone",
    ]);
    if (flags["group-by"]) {
      query.group_by = flags["group-by"];
    }
    if (flags["group-by-time"]) {
      query.group_by_time = flags["group-by-time"];
    }
    return { method: "GET", url: buildUrl(origin, `/v1/streams/${encodeURIComponent(stream)}/aggregate`, query) };
  }

  throw new PdppUsageError(`Unsupported read command: ${command}`);
}

interface ReadErrorBody {
  error?: { message?: string };
  error_description?: string;
  message?: string;
}

async function fetchReadJson(request: ReadRequest, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: PdppUsageError's constructor (message, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppUsageError(`Network request failed: ${(error as Error).message}`);
  }

  const text = typeof resp.text === "function" ? await resp.text() : "";
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (resp.status >= 400) {
    const errBody = parsed as ReadErrorBody | null;
    const message =
      errBody?.error_description ||
      errBody?.error?.message ||
      errBody?.message ||
      `HTTP ${resp.status} ${resp.statusText || ""}`.trim();
    throw new PdppHttpError(String(message), resp.status, parsed, {
      request_id: resp.headers?.get?.("x-request-id") ?? null,
    });
  }

  return parsed;
}

function buildUrl(origin: string, path: string, query: QueryRecord = {}): string {
  const url = new URL(path, `${origin}/`);
  for (const [key, value] of Object.entries(query)) {
    appendQuery(url, key, value);
  }
  return url.toString();
}

function appendQuery(url: URL, key: string, value: QueryValue | string): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendQuery(url, key, entry);
    }
    return;
  }
  url.searchParams.append(key, String(value));
}

function pickQuery(flags: ParsedFlags, names: string[]): QueryRecord {
  const query: QueryRecord = {};
  for (const name of names) {
    const value = flags[name];
    if (value === undefined || value === true) {
      continue;
    }
    query[name.replaceAll("-", "_")] = value;
  }
  return query;
}

function csvQuery(flags: ParsedFlags, name: string): QueryRecord {
  const raw = flags[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  return {
    [name]: raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function jsonFilterQuery(flags: ParsedFlags): QueryRecord {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: `ParsedFlags` types every key as `string | boolean`, but at runtime an absent flag reads back as `undefined` (see args.ts's `parseArgs`, which only ever assigns entries it saw); this check is load-bearing against real CLI input, not tautological against the type.
  if (flags.filter !== undefined && flags["filter-json"] !== undefined) {
    throw new PdppUsageError("Use only one of --filter or --filter-json.");
  }
  if (typeof flags.filter === "string") {
    return { filter: flags.filter };
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: `ParsedFlags` types every key as `string | boolean`, but at runtime an absent flag reads back as `undefined`; this check is load-bearing against real CLI input, not tautological against the type.
  if (flags["filter-json"] === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(flags["filter-json"] as string);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: PdppUsageError's constructor (message, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppUsageError(`--filter-json must be valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PdppUsageError("--filter-json must be a JSON object.");
  }
  const query: QueryRecord = {};
  for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        query[`filter[${field}][${op}]`] = opValue as QueryValue;
      }
    } else {
      query[`filter[${field}]`] = value as QueryValue;
    }
  }
  return query;
}

function projectOutput(body: unknown, flags: ParsedFlags): unknown {
  if (!flags.data) {
    return body;
  }
  const typed = body as { data?: unknown; records?: unknown };
  if (body && typeof body === "object" && Array.isArray(typed.data)) {
    return typed.data;
  }
  if (body && typeof body === "object" && Array.isArray(typed.records)) {
    return typed.records;
  }
  return body;
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `pdpp ref call` — a generic owner-authenticated HTTP caller for the long tail
// of owner-only reference routes (dataset reconcile, run cancel, schedule
// pause/resume, and any other /_ref/* or /v1/owner/* route).
//
// It exists so owner lanes stop rediscovering the auth model on every new
// action. The auth mode is inferred from the path prefix and can be overridden:
//
//   /_ref/*      → owner session cookie   (cached, --owner-session, or env)
//   /v1/owner/*  → owner bearer           (--owner-token-stdin or PDPP_OWNER_TOKEN)
//
// Bodies are always sent as application/json, which the reference server treats
// as CSRF-exempt — so there is no `_csrf` handling anywhere. Secrets are never
// printed: only the response body (stdout) and a `METHOD path → status` line
// (stderr) are emitted.
//
// Usage:
//   pdpp ref call <method> <path> [--as-url <url>]
//     [--data <json> | --data-stdin]
//     [--auth cookie|bearer]
//     [--owner-session <cookie>] [--owner-token-stdin]
//     [--cache-root <dir>] [--format json|table]
//     [--status-only]

import { parseArgs, requirePositional } from "../args.ts";
import { buildAuthHeaders, resolveAuthMode } from "../auth.ts";
import { PdppHttpError, PdppUsageError } from "../errors.ts";
import { resolveReferenceUrl } from "../fetch.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.ts";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KNOWN_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

export interface CommandIo {
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WritableStream;
}

interface CallErrorBody {
  error?: { message?: string };
  error_description?: string;
  message?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single owner-authenticated HTTP call assembled linearly (method/path validation, auth headers, body, request, status line, error/response shaping); splitting would scatter one request's lifecycle across helpers for no reduction in real complexity.
export async function runRefCall(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  const { flags, positionals } = parseArgs(argv);
  const method = requirePositional(positionals, 0, "method").toUpperCase();
  if (!KNOWN_METHODS.has(method)) {
    throw new PdppUsageError(`Unsupported method: ${method}. Use one of ${[...KNOWN_METHODS].join(", ")}.`);
  }
  const path = requirePositional(positionals, 1, "path");

  const referenceUrl = resolveReferenceUrl(flags);
  const mode = resolveAuthMode(path, flags.auth);
  const authHeaders = await buildAuthHeaders({ mode, referenceUrl, flags, io });

  const body = await resolveBody(flags, io, method);

  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders };
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = body;
  }

  const url = `${referenceUrl}${path.startsWith("/") ? path : `/${path}`}`;

  let resp: Response;
  try {
    resp = await fetchImpl(url, init);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: PdppUsageError's constructor (message, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppUsageError(`Network request to ${path} failed: ${(e as Error).message}`);
  }

  // Always surface the status line on stderr so machine-readable stdout stays
  // clean. The URL is intentionally the path only — never the cookie/bearer.
  err.write(`${`${method} ${path} → ${resp.status} ${resp.statusText || ""}`.trimEnd()}\n`);

  if (flags["status-only"]) {
    return statusExitCode(resp.status);
  }

  const text = await readBody(resp);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (resp.status >= 400) {
    const errBody = parsed as CallErrorBody | null;
    const message =
      (parsed &&
        typeof parsed === "object" &&
        (errBody?.error_description || errBody?.error?.message || errBody?.message)) ||
      `HTTP ${resp.status} ${resp.statusText || ""}`.trim();
    throw new PdppHttpError(String(message), resp.status, parsed);
  }

  if (parsed !== null && parsed !== "") {
    const format = resolveFormat(flags, "json", "json");
    writeData(parsed, format, out);
    if (parsed && typeof parsed === "object") {
      writeEnvelopeWarnings(parsed, err);
    }
  }
  return 0;
}

async function resolveBody(
  flags: Record<string, string | boolean>,
  io: CommandIo,
  method: string
): Promise<string | undefined> {
  const hasInline = typeof flags.data === "string";
  const hasStdin = Boolean(flags["data-stdin"]);
  if (hasInline && hasStdin) {
    throw new PdppUsageError("Use only one of --data or --data-stdin, not both.");
  }

  let raw: string;
  if (hasInline) {
    raw = flags.data as string;
  } else if (hasStdin) {
    raw = await readAll(io.stdin || process.stdin);
  } else {
    return;
  }

  const trimmed = String(raw).trim();
  if (!trimmed) {
    return;
  }

  // Validate that the body is JSON before sending; the server only parses
  // application/json, and sending malformed JSON would surface as an opaque
  // 400. Re-serialize so we send canonical JSON with the right content-type.
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: PdppUsageError's constructor (message, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppUsageError(`--data must be valid JSON: ${(e as Error).message}`);
  }
  if (!METHODS_WITH_BODY.has(method)) {
    throw new PdppUsageError(`A request body is not valid for ${method}.`);
  }
  return JSON.stringify(value);
}

function statusExitCode(status: number): number {
  if (status >= 200 && status < 400) {
    return 0;
  }
  if (status === 401) {
    return 3;
  }
  if (status === 403) {
    return 4;
  }
  if (status === 404) {
    return 5;
  }
  return 1;
}

async function readBody(resp: Response): Promise<string> {
  if (typeof resp.text === "function") {
    return await resp.text();
  }
  return "";
}

function readAll(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!stream || typeof stream.on !== "function") {
      resolvePromise("");
      return;
    }
    let buf = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
    });
    stream.on("end", () => resolvePromise(buf));
    stream.on("error", rejectPromise);
  });
}

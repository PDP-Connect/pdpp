// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Native Fastify transport.
//
// `createApp()` returns a small factory with the API that the PDPP reference
// handlers are written against (`app.get/post/put/delete/head`, `app.use`,
// `app.set`, `listen`). Internally it builds a Fastify instance and wraps
// each handler so Fastify's `(request, reply)` is presented to PDPP as
// `(req, res, next)`. Handlers stay adapter-neutral; the transport is the
// single place that cares about Fastify specifics.
//
// Supported surface (kept tight on purpose; extend with care):
//   req:  get(name), is(type), accepts(types), body, headers, hostname,
//         method, params, path, protocol, query
//   res:  setHeader, header, set, getHeader, status, send, json
//
// Body parsing:
//   - application/json                — Fastify's JSON parser (empty bodies ⇒ {})
//   - application/x-www-form-urlencoded — @fastify/formbody with qs depth 8
//   - application/x-ndjson             — raw string, parsed by the handler
//   - application/vnd.pdpp.manual-upload — raw stream for staged owner imports
//   - other content types              — raw Buffer for binary upload routes
//
// Query parsing:
//   - qs-backed nested parser so `filter[field][gte]=…` decodes into
//     `{ filter: { field: { gte: … } } }`, matching PDPP Core §8.
//     Spec review still pending — see
//     design-notes/express-5-query-parser-open-question-2026-04-22.md.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import fastifyFormbody from "@fastify/formbody";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pino from "pino";

// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
declare module "fastify" {
  interface FastifyRequest {
    __pdppTraceId?: string;
    accepts?: (types: string | string[]) => string | false;
    get?: (name: string) => string | undefined;
    is?: (types: string | string[]) => string | false;
    path?: string;
  }

  interface FastifyReply {
    locals?: Record<string, unknown>;
  }
}

import { publicManifests, referenceManifests } from "@pdpp/reference-contract";
import {
  applyRequestValidation,
  applyResponseValidation,
  buildResponseContractErrorBody,
  ensureRequestId,
  isRequestValidationEnforced,
  isResponseCanary,
} from "./contract-validation.ts";
import { HOSTED_INGEST_MAX_REQUEST_BYTES } from "./hosted-ingest-limits.ts";

// Header name the reference sets on responses to expose the protocol trace
// ID (handler-set via setReferenceTraceId in server/index.js).
const PDPP_TRACE_ID_HEADER = "PDPP-Reference-Trace-Id";
export const PDPP_MANUAL_UPLOAD_STREAM_CONTENT_TYPE = "application/vnd.pdpp.manual-upload";

// Log field set that every record shares. Path names match the OTel log data
// model where they overlap (`trace_id`, `req_id`) so a later OTLP adapter can
// forward records without renaming.
const REDACT_PATHS = [
  "access_token",
  "refresh_token",
  "device_code",
  "user_code",
  "interaction_response",
  "INTERACTION_RESPONSE",
  "req.headers.authorization",
  "*.access_token",
  "*.refresh_token",
];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface QsParser {
  parse: (value: string, options: { depth: number; arrayLimit: number }) => Record<string, unknown>;
}
interface RouteManifest {
  id: string;
  request?:
    | {
        params?: unknown;
        query?: unknown;
        headers?: unknown;
        body?: { schema?: unknown } | undefined;
      }
    | undefined;
  responses?: Record<string, { schema?: unknown; [field: string]: unknown } | undefined> | undefined;
  summary?: string | undefined;
  tags?: readonly string[] | undefined;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type Next = (error?: Error) => void;
interface ExpressResponse {
  end: (payload?: unknown) => ExpressResponse;
  getHeader: (name: string) => unknown;
  header: (field: string | Record<string, unknown>, value?: unknown) => ExpressResponse;
  headersSent: boolean;
  hijack: () => ExpressResponse;
  json: (payload: unknown) => ExpressResponse;
  locals: Record<string, unknown>;
  readonly raw: FastifyReply["raw"];
  redirect: (statusOrUrl: number | string, maybeUrl?: string) => ExpressResponse;
  removeHeader: (name: string) => ExpressResponse;
  send: (payload?: unknown) => ExpressResponse;
  sendStatus: (code: number) => ExpressResponse;
  set: (field: string | Record<string, unknown>, value?: unknown) => ExpressResponse;
  setHeader: (name: string, value: unknown) => ExpressResponse;
  status: (code: number) => ExpressResponse;
  statusCode: number;
  type: (value: string) => ExpressResponse;
}
// Route modules own their narrower request/response views. The transport
// invokes them dynamically after producing the real Fastify/Express shim;
// `never` keeps registration contravariant without weakening those modules'
// declarations to `any`.
type ExpressHandler = (...args: never[]) => unknown;
type RouteArgument = ExpressHandler | { contract?: string; bodyLimit?: number };
interface RegisteredRoute {
  contractOp: string | null;
  method: HttpMethod;
  url: string;
}
interface RouteMethods {
  delete: (path: string, ...args: RouteArgument[]) => RouteMethods;
  get: (path: string, ...args: RouteArgument[]) => RouteMethods;
  patch: (path: string, ...args: RouteArgument[]) => RouteMethods;
  post: (path: string, ...args: RouteArgument[]) => RouteMethods;
  put: (path: string, ...args: RouteArgument[]) => RouteMethods;
}
interface CreateAppOptions {
  __requestValidationAllowlistForTest?: Iterable<string>;
  logger?: FastifyBaseLogger;
}
function isRouteOptions(value: unknown): value is { contract?: string; bodyLimit?: number } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQsParser(value: unknown): value is QsParser {
  return value !== null && typeof value === "object" && "parse" in value && typeof value.parse === "function";
}

function loadQsParser(): QsParser {
  const loaded: unknown = createRequire(import.meta.url)("qs");
  if (isQsParser(loaded)) {
    return loaded;
  }
  throw new Error("qs must expose parse(value, options)");
}

const qs = loadQsParser();

/**
 * Build the Pino logger this transport hands to Fastify. Callers pass the
 * `quiet` flag from startServer() so test harnesses that want no stdout
 * chatter get `level: 'silent'` regardless of NODE_ENV.
 */
export function buildLogger({ quiet = false }: { quiet?: boolean } = {}) {
  if (quiet) {
    return pino({ level: "silent" });
  }
  const isProd = process.env.NODE_ENV === "production";
  const options: Parameters<typeof pino>[0] = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { censor: "<redacted>", paths: REDACT_PATHS },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (!isProd) {
    options.transport = {
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
      target: "pino-pretty",
    };
  }
  return pino(options);
}

// Index route manifests by operation id so route registration can pick them
// up by name and attach the JSON-Schema directly onto the Fastify route.
const CONTRACT_MANIFESTS = new Map<string, RouteManifest>();
for (const manifest of [...publicManifests, ...referenceManifests]) {
  CONTRACT_MANIFESTS.set(manifest.id, manifest);
}

/**
 * Recursively strip JSON-Schema `$id` keys before compile so common schemas
 * like UriSchema can be referenced by many routes without ajv ambiguous-id
 * collisions. The reference-contract package's own validator does the same.
 */
function stripIds(node: unknown): JsonValue {
  if (node === null || typeof node === "boolean" || typeof node === "number" || typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => stripIds(item));
  }
  if (node && typeof node === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$id") {
        continue;
      }
      out[key] = stripIds(value);
    }
    return out;
  }
  throw new TypeError("Route schema contains a non-JSON value");
}

/**
 * Build the `schema` object Fastify accepts on `fastify.route({schema})` from
 * a contract-package route manifest. Returns `undefined` if the manifest has
 * no schemas worth attaching.
 *
 * We deliberately OMIT the `response` schemas. Fastify otherwise routes
 * responses through `fast-json-stringify`, which strips properties that
 * aren't declared in the schema. The contract package's current response
 * schemas drift from the actual server payload shapes in several places
 * (e.g. `refGetConnector` declares `streams: items string` but the server
 * returns `streams: [{ name, freshness }]`). Attaching those shapes would
 * silently truncate correct runtime responses. Request-side schemas
 * (`params` / `querystring` / `headers` / `body`) stay attached so the
 * contract still lives directly on the Fastify route; the response-schema
 * alignment is tracked as an open design question in
 * `design-notes/reference-contract-response-schema-drift-2026-04-22.md`.
 */
function buildRouteSchema(manifest: RouteManifest): Record<string, JsonValue> | undefined {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!manifest?.request) {
    return;
  }
  const schema: Record<string, JsonValue> = {};
  if (manifest.request?.params) {
    schema.params = stripIds(manifest.request.params);
  }
  if (manifest.request?.query) {
    schema.querystring = stripIds(manifest.request.query);
  }
  if (manifest.request?.headers) {
    schema.headers = stripIds(manifest.request.headers);
  }
  if (manifest.request?.body?.schema) {
    schema.body = stripIds(manifest.request.body.schema);
  }
  if (manifest.summary) {
    schema.summary = manifest.summary;
  }
  if (Array.isArray(manifest.tags) && manifest.tags.length) {
    schema.tags = manifest.tags;
  }
  if (manifest.id) {
    schema.operationId = manifest.id;
  }
  return Object.keys(schema).length ? schema : undefined;
}

/**
 * Build a fresh Fastify instance wired up the way PDPP wants it.
 *
 * The caller supplies a pre-built Pino logger (see `buildLogger`). We pass it
 * as `loggerInstance` rather than letting Fastify build its own, because the
 * server wants test-time `quiet` to mean truly silent.
 *
 * `disableRequestLogging: true` turns off Fastify's built-in request-start and
 * request-completion log lines. We emit our own completion record in an
 * `onResponse` hook so it can carry PDPP's `trace_id` alongside `req_id`.
 */
function buildFastify({ loggerInstance }: { loggerInstance: FastifyBaseLogger }): FastifyInstance {
  const fastify = Fastify({
    bodyLimit: HOSTED_INGEST_MAX_REQUEST_BYTES, // match previous express.text() limit
    disableRequestLogging: true,
    // Fastify auto-registers HEAD shadow routes for every GET. PDPP relies
    // on this so HEAD probes return GET-equivalent status codes (RFC 7231
    // §4.3.2) — without it, an unauthenticated `HEAD /v1/streams` returns
    // 404 while `GET /v1/streams` returns 401, which both confuses tooling
    // and leaks "no such resource" semantics for protected URLs. PDPP does
    // not currently register any explicit `app.head()` routes; if a future
    // route needs custom HEAD semantics, disable this shadow (or scope it
    // off the affected path) before registering the explicit handler —
    // Fastify will otherwise reject it as "Method 'HEAD' already declared."
    exposeHeadRoutes: true,
    // Use an inbound Request-Id header if present, otherwise let Fastify
    // generate one. Matches the existing `ensureRequestId()` behavior.
    genReqId: (req) => {
      const header = req.headers?.["request-id"];
      if (typeof header === "string" && header.trim()) {
        return header.trim();
      }
      return randomUUID();
    },
    // Keep-alive can leave pooled client sockets stale after a server restart
    // on the same port (tests exercise this pattern; `closeServer()` +
    // `startServer()` on the same port). We respond with `Connection: close`
    // on every reply below via an `onSend` hook so clients never pool our
    // sockets. The `keepAliveTimeout` is also set short as belt-and-braces.
    keepAliveTimeout: 1,
    loggerInstance,
    // Router-level options moved out of the top-level constructor in Fastify 5
    // (the deprecated location warns FSTDEP022 and is removed in Fastify 6).
    routerOptions: {
      ignoreTrailingSlash: false,
      // `qs.parse` decodes PDPP's nested bracket shape
      // (filter[field][gte]=..., expand[]=..., expand_limit[rel]=...) per
      // Core §8. Depth bounded to 8 + arrayLimit 64 to close the DoS surface
      // that Express 5's default `simple` parser was tightening.
      querystringParser: (str) => qs.parse(str, { arrayLimit: 64, depth: 8 }),
    },
  });

  // Force `Connection: close` on every response. See the note above the
  // Fastify config block. An `onRequest` hook sets it before handlers run so
  // there's no race with streaming replies.
  fastify.addHook("onRequest", (_request, reply, done) => {
    reply.header("connection", "close");
    done();
  });

  // Fastify rejects a route body that exceeds its local bodyLimit before the
  // Express-shaped adapter runs. Keep this mapping narrowly scoped so the
  // reference source-webhook contract still emits the same typed envelope as
  // handler-owned resource_limit errors; other transport errors retain
  // Fastify's default handling.
  fastify.setErrorHandler((error, request, reply) => {
    const { code, statusCode } = error as { readonly code?: unknown; readonly statusCode?: unknown };
    if (
      request.url.startsWith("/_ref/source-webhooks/") &&
      (code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413)
    ) {
      reply.header("Request-Id", request.id);
      reply.status(413).send({
        error: {
          code: "resource_limit",
          message: "source webhook body exceeds 1 MiB",
          request_id: request.id,
          type: "request_entity_too_large_error",
        },
      });
      return;
    }
    reply.send(error);
  });

  // Emit one structured completion record per request carrying req_id, method,
  // path, statusCode, responseTime, and — when the handler set it via
  // setReferenceTraceId() — trace_id. Kept at `info`; this is the baseline
  // record the spec promises, not a per-status-code shape.
  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  fastify.addHook("onResponse", async (request, reply) => {
    const traceId = reply.getHeader?.(PDPP_TRACE_ID_HEADER) || request.__pdppTraceId;
    request.log.info(
      {
        method: request.method,
        req_id: request.id,
        responseTime: Math.round(reply.elapsedTime ?? 0),
        statusCode: reply.statusCode,
        url: request.url,
        ...(traceId ? { trace_id: traceId } : {}),
      },
      "request completed"
    );
  });

  fastify.addContentTypeParser("application/x-ndjson", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // Large owner import artifacts must not hit the wildcard buffer parser.
  // Route handlers that opt into this exact content type receive the raw
  // readable stream and are responsible for writing it to bounded storage.
  fastify.addContentTypeParser(PDPP_MANUAL_UPLOAD_STREAM_CONTENT_TYPE, (_req, payload, done) => {
    done(null, payload);
  });

  // Binary upload surfaces (currently `POST /v1/blobs`) need exact bytes.
  // The wildcard parser is a fallback: exact parsers above and JSON below
  // still own their content types.
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // Express tolerates empty request bodies on `Content-Type: application/json`
  // (treats `req.body` as `{}`). Fastify's default JSON parser returns
  // FST_ERR_CTP_EMPTY_JSON_BODY. Replace it with a parser that accepts empty
  // payloads so routes like `POST /grants/:id/revoke` (no body, header still
  // JSON) reach their handlers instead of failing at the transport.
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(typeof body === "string" ? body : body.toString()));
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      Object.assign(err, { statusCode: 400 });
      done(err, undefined);
    }
  });

  return fastify;
}

/**
 * Turn a Fastify `(request, reply)` pair into an Express-shaped `(req, res)`
 * pair so existing route handlers keep working unchanged. Returns the shim
 * object. Mutations to `req.query` / `req.body` etc. inside handlers are
 * reflected on the underlying Fastify `request` where it matters.
 */
function expressShim(request: FastifyRequest, reply: FastifyReply): { req: FastifyRequest; res: ExpressResponse } {
  const req = request;

  // Ensure the properties Express handlers rely on are there. Fastify already
  // populates `headers`, `params`, `query`, `body`, `method`, and `url`.
  // `req.path` is just the URL path with any query string stripped.
  if (!Object.hasOwn(req, "path")) {
    Object.defineProperty(req, "path", {
      configurable: true,
      get() {
        const raw = req.raw?.url || req.url || "";
        const q = raw.indexOf("?");
        return q >= 0 ? raw.slice(0, q) : raw;
      },
    });
  }

  // Fastify exposes `request.protocol` and `request.hostname` natively, but
  // only when `trustProxy` is set. We expose simple fallbacks derived from
  // the raw request.
  if (!req.protocol) {
    Object.defineProperty(req, "protocol", {
      configurable: true,
      get() {
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const socket = req.raw.socket;
        const encrypted = "encrypted" in socket && socket.encrypted === true;
        return encrypted ? "https" : "http";
      },
    });
  }
  if (!req.hostname) {
    Object.defineProperty(req, "hostname", {
      configurable: true,
      get() {
        const host = req.headers?.host;
        if (!host) {
          return "";
        }
        const colon = host.indexOf(":");
        return colon >= 0 ? host.slice(0, colon) : host;
      },
    });
  }

  // Express's `req.get(headerName)` is case-insensitive.
  if (typeof req.get !== "function") {
    req.get = (name: string): string | undefined => {
      if (!name) {
        return;
      }
      const header = req.headers?.[String(name).toLowerCase()];
      return typeof header === "string" ? header : undefined;
    };
  }

  // Express's `req.is(type)` returns the matched type string or false.
  if (typeof req.is !== "function") {
    req.is = (types: string | string[]) => matchedContentType(req.headers["content-type"], types);
  }

  // Minimal `req.accepts(types)` returning the best match from the Accept
  // header. Handlers in PDPP only care about `req.accepts(['html', 'json'])`.
  if (typeof req.accepts !== "function") {
    req.accepts = (types: string | string[]) => acceptedType(req.headers.accept, types);
  }

  // Express-compatible `res` that proxies onto Fastify's `reply`.
  const res: ExpressResponse = {
    end(payload?: unknown) {
      res.headersSent = true;
      if (payload === undefined) {
        reply.send();
      } else {
        reply.send(payload);
      }
      return res;
    },
    getHeader(name: string) {
      return reply.getHeader(name);
    },
    // Express exposes `res.header(field, value)` and `res.set(field, value)` as
    // aliases of `setHeader`, with an object form that sets multiple headers in
    // one call. Several PDPP handlers (and the streaming routes' WWW-Authenticate
    // emission for 401s) chain `.status(...).header(...)`, which only works if
    // both methods return `this`. Without these aliases the chain crashes with
    // `res.status(...).header is not a function` and Fastify converts the throw
    // into a 500 — masking the intended 401 envelope.
    header(field: string | Record<string, unknown>, value?: unknown) {
      if (field && typeof field === "object") {
        for (const [k, v] of Object.entries(field)) {
          reply.header(k, v);
        }
      } else {
        reply.header(field, value);
      }
      return res;
    },
    headersSent: false,
    hijack() {
      if (typeof reply.hijack === "function") {
        reply.hijack();
      }
      res.headersSent = true;
      return res;
    },
    json(payload: unknown) {
      res.headersSent = true;
      reply.header("content-type", reply.getHeader?.("content-type") || "application/json; charset=utf-8");
      reply.send(payload);
      return res;
    },
    locals: reply.locals || {},
    // Streaming/SSE escape hatch: handlers that need to write directly to the
    // raw socket call `res.hijack()` first, then write to `res.raw`. The
    // Fastify reply lifecycle is suspended so the handler is responsible for
    // ending the response itself.
    get raw() {
      return reply.raw;
    },
    redirect(statusOrUrl: number | string, maybeUrl?: string) {
      const statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 302;
      const location = typeof statusOrUrl === "number" ? maybeUrl : statusOrUrl;
      res.headersSent = true;
      reply.code(statusCode);
      reply.header("location", location ?? "");
      reply.send();
      return res;
    },
    removeHeader(name: string) {
      reply.removeHeader(name);
      return res;
    },
    send(payload?: unknown) {
      res.headersSent = true;
      // Express.send() auto-detects content type: strings → text/html,
      // objects → JSON, Buffers → application/octet-stream (keep existing
      // header if set). Fastify's reply.send() already handles Buffer and
      // object serialization; strings go as text.
      if (payload === undefined || payload === null) {
        reply.send();
      } else if (typeof payload === "string") {
        if (!reply.getHeader?.("content-type")) {
          reply.header("content-type", "text/html; charset=utf-8");
        }
        reply.send(payload);
      } else if (Buffer.isBuffer(payload)) {
        if (!reply.getHeader?.("content-type")) {
          reply.header("content-type", "application/octet-stream");
        }
        reply.send(payload);
      } else {
        reply.send(payload);
      }
      return res;
    },
    sendStatus(code: number) {
      res.statusCode = code;
      reply.code(code).send();
      return res;
    },
    set(field: string | Record<string, unknown>, value?: unknown) {
      return res.header(field, value);
    },
    setHeader(name: string, value: unknown) {
      reply.header(name, value);
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      reply.code(code);
      return res;
    },
    statusCode: 200,
    type(value: string) {
      reply.type(value);
      return res;
    },
  };

  return { req, res };
}

// Express's `req.is(type)` returns the matched type string or false.
function matchedContentType(
  contentTypeHeader: string | string[] | undefined,
  types: string | string[]
): string | false {
  const ct = (String(contentTypeHeader || "").split(";")[0] ?? "").trim().toLowerCase();
  if (!ct) {
    return false;
  }
  const candidates = Array.isArray(types) ? types : [types];
  for (const candidate of candidates) {
    if (matchesMediaType(ct, String(candidate).toLowerCase())) {
      return candidate;
    }
  }
  return false;
}

// Minimal `req.accepts(types)` returning the best match from the Accept
// header. Handlers in PDPP only care about `req.accepts(['html', 'json'])`.
function acceptedType(acceptHeader: string | string[] | undefined, types: string | string[]): string | false {
  const accept = String(acceptHeader || "").toLowerCase();
  const candidates = Array.isArray(types) ? types : [types];
  if (!accept || accept === "*/*") {
    return candidates[0] ?? false;
  }
  for (const candidate of candidates) {
    const short = String(candidate).toLowerCase();
    const long = short.includes("/") ? short : `application/${short}`;
    if (accept.includes(short) || accept.includes(long)) {
      return candidate;
    }
  }
  return false;
}

function matchesMediaType(ct: string, pattern: string): boolean {
  if (pattern === "*/*") {
    return true;
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return ct.startsWith(prefix);
  }
  if (!pattern.includes("/")) {
    // Express accepts shorthand like 'json' → any */json match.
    return ct.endsWith(`/${pattern}`) || ct.includes(`+${pattern}`);
  }
  return ct === pattern;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}

function invokeHandler(handler: ExpressHandler, req: FastifyRequest, res: ExpressResponse, next: Next): unknown {
  return Reflect.apply(handler, undefined, [req, res, next]);
}

/**
 * Fastify converts its URL pattern syntax to its own format. Express uses
 * `/foo/:bar` — Fastify supports the same `:param` syntax natively, so no
 * path transformation is needed.
 */
function normalizePath(path: string): string {
  return path;
}

/**
 * Run an ordered list of Express-style `(req, res, next)` middleware until
 * one calls `next(err)`, one responds, or the chain completes.
 */
function runMiddlewareChain(
  middleware: readonly ExpressHandler[],
  req: FastifyRequest,
  res: ExpressResponse
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let i = 0;
    function next(err?: Error) {
      if (err) {
        reject(err);
        return;
      }
      if (res.headersSent) {
        resolve(true);
        return;
      }
      if (i >= middleware.length) {
        resolve(false);
        return;
      }
      // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
      const fn = middleware[i++];
      if (!fn) {
        resolve(false);
        return;
      }
      try {
        const result = invokeHandler(fn, req, res, next);
        if (isPromiseLike(result)) {
          result.then(() => {
            if (res.headersSent) {
              resolve(true);
            }
            // Otherwise rely on the explicit next() call.
          }, reject);
        }
      } catch (err2) {
        reject(err2);
      }
    }
    next();
  });
}

/**
 * Wrap a list of Express-style middleware + a final handler into a Fastify
 * route handler.
 */
function wrapHandler(middleware: readonly ExpressHandler[], handler: ExpressHandler) {
  return async function fastifyRouteHandler(request: FastifyRequest, reply: FastifyReply) {
    const { req, res } = expressShim(request, reply);
    if (middleware.length) {
      const responded = await runMiddlewareChain(middleware, req, res);
      if (responded || res.headersSent) {
        return reply;
      }
    }
    // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
    const result = invokeHandler(handler, req, res, () => {});
    if (isPromiseLike(result)) {
      await result;
    }
    return reply;
  };
}

/**
 * Variant of `wrapHandler` for routes enrolled in the response-validation
 * canary allowlist. Intercepts the response's JSON-emission methods just
 * before bytes are sent so the payload can be validated against the
 * declared contract WITHOUT serializing through Fastify's response-schema
 * pipeline (which would coerce or strip fields).
 *
 * Behavior:
 *   - Only intercepts `res.json(payload)`. Other emission paths (`send`
 *     with a string/Buffer, redirects, 204, hijacked streams, SSE) pass
 *     through unchanged so non-allowlisted response shapes are not
 *     mutated.
 *   - On validation failure, replaces the outgoing payload with a PDPP
 *     `internal_contract_error` envelope at HTTP 500 and logs the
 *     validator errors under the request id.
 *   - On validation success (or when the manifest has no schema for the
 *     selected status), emits the handler's original payload unchanged.
 */
function wrapHandlerWithResponseCanary(
  middleware: readonly ExpressHandler[],
  handler: ExpressHandler,
  manifest: RouteManifest
) {
  return async function fastifyCanaryRouteHandler(request: FastifyRequest, reply: FastifyReply) {
    const { req, res } = expressShim(request, reply);
    if (middleware.length) {
      const responded = await runMiddlewareChain(middleware, req, res);
      if (responded || res.headersSent) {
        return reply;
      }
    }

    // Patch `res.json` so canary operations validate just before sending.
    // Canary operations are stable JSON metadata/discovery routes whose
    // handlers always go through `res.json(envelope)`. Non-JSON paths
    // (`res.send(string)`, `res.send(Buffer)`, `res.redirect`,
    // `res.sendStatus`, `res.hijack` for streams/SSE) skip this
    // interception entirely.
    const originalJson = res.json.bind(res);
    res.json = (payload: unknown) => {
      const status = res.statusCode || 200;
      const result = applyResponseValidation({
        operationId: manifest.id,
        payload,
        status,
      });
      if (result.ok) {
        return originalJson(payload);
      }
      const requestId = ensureRequestId(res);
      const body = buildResponseContractErrorBody({
        operationId: manifest.id,
        requestId,
      });
      request.log?.error?.(
        {
          operation_id: manifest.id,
          req_id: request.id,
          status,
          validator_errors: result.errors,
        },
        "response payload violated declared route contract"
      );
      res.status(500);
      return originalJson(body);
    };

    // biome-ignore lint/suspicious/noEmptyBlockStatements: The empty handler intentionally absorbs this best-effort cleanup failure.
    const result = invokeHandler(handler, req, res, () => {});
    if (isPromiseLike(result)) {
      await result;
    }
    return reply;
  };
}

/**
 * Split a route's variadic `args` into its handler/middleware functions and
 * the options carried by a leading plain-object entry, e.g.
 *   app.post('/foo', { contract: 'fooOp' }, middleware, handler)
 *
 * The subtle contract lives here: any non-function entry that looks like a
 * plain options object is consumed for its `contract` / `bodyLimit` keys and
 * everything else is interpreted as a middleware/handler function. Returns the
 * collected functions plus the sniffed options; the empty-handler check and
 * handler/middleware split stay at the call site.
 */
function parseRouteArgs(args: readonly RouteArgument[]): {
  fns: ExpressHandler[];
  bodyLimit: number | null;
  contractOpId: string | null;
} {
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  let bodyLimit = null;
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  let contractOpId = null;
  const fns: ExpressHandler[] = [];
  for (const entry of args) {
    if (typeof entry === "function") {
      fns.push(entry);
      continue;
    }
    if (isRouteOptions(entry)) {
      if (typeof entry.contract === "string") {
        contractOpId = entry.contract;
      }
      const requestedBodyLimit = entry.bodyLimit;
      if (typeof requestedBodyLimit === "number" && Number.isInteger(requestedBodyLimit) && requestedBodyLimit > 0) {
        bodyLimit = requestedBodyLimit;
      }
    }
  }
  return { bodyLimit, contractOpId, fns };
}

/**
 * Resolve the contract manifest for a route's operation id, failing fast at
 * registration time so drift between server/index.js and
 * `@pdpp/reference-contract` is observable at startup rather than at the first
 * request. Returns `null` when the route declared no operation id and throws
 * on an unknown id.
 */
function resolveManifest(method: HttpMethod, path: string, contractOpId: string | null): RouteManifest | null {
  if (!contractOpId) {
    return null;
  }
  const manifest = CONTRACT_MANIFESTS.get(contractOpId);
  if (!manifest) {
    throw new Error(`Unknown reference-contract operation id for ${method} ${path}: ${contractOpId}`);
  }
  return manifest;
}

function requestValidationManifest(manifest: RouteManifest): {
  id: string;
  responses?: { "400"?: { schema?: { $id?: string } } };
} {
  const schema = manifest.responses?.["400"]?.schema;
  if (schema && typeof schema === "object" && "$id" in schema && typeof schema.$id === "string") {
    return { id: manifest.id, responses: { "400": { schema: { $id: schema.$id } } } };
  }
  return { id: manifest.id };
}

/**
 * Assemble the full ordered middleware chain for a route:
 *   [...globalMiddleware, ...routeMiddleware, transportValidation?]
 *
 * When the route's operation id is on the request-validation allowlist,
 * transport-level validation runs AFTER user-supplied middleware (auth,
 * owner-session, device-credential checks) and BEFORE the route handler. This
 * preserves auth ordering: unauthenticated callers see the auth error envelope
 * rather than a contract-shape error. Routes NOT on the allowlist see no
 * transport-level validation, which preserves the rich handler-owned
 * diagnostics on shape rejection.
 */
function buildRouteMiddleware({
  globalMiddleware,
  middleware,
  manifest,
  enforceRequestValidation,
}: {
  globalMiddleware: readonly ExpressHandler[];
  middleware: readonly ExpressHandler[];
  manifest: RouteManifest | null;
  enforceRequestValidation: (operationId: string) => boolean;
}): ExpressHandler[] {
  if (!(manifest && enforceRequestValidation(manifest.id))) {
    return [...globalMiddleware, ...middleware];
  }
  const manifestRef = manifest;
  const validate = (req: FastifyRequest, res: ExpressResponse, next: Next) => {
    const responded = applyRequestValidation({
      manifest: requestValidationManifest(manifestRef),
      req,
      res,
    });
    if (responded) {
      return;
    }
    next();
  };
  return [...globalMiddleware, ...middleware, validate];
}

/**
 * Build the Fastify route-definition object: the wrapped handler (with the
 * response canary when the manifest opts in), the optional bodyLimit, and the
 * contract-package JSON-Schema attachment.
 *
 * The schema is informative metadata for tests, OpenAPI emission, and
 * introspection; runtime request validation happens (when enabled for this op
 * id) in the middleware chain through `@pdpp/reference-contract`. Fastify's own
 * validator is disabled so it cannot transform or strip payloads. Response
 * schemas are deliberately omitted — see `buildRouteSchema`.
 */
function buildRouteOptions({
  method,
  path,
  handler,
  bodyLimit,
  manifest,
  contractOpId,
  combinedMiddleware,
}: {
  method: HttpMethod;
  path: string;
  handler: ExpressHandler;
  bodyLimit: number | null;
  manifest: RouteManifest | null;
  contractOpId: string | null;
  combinedMiddleware: readonly ExpressHandler[];
}): Parameters<FastifyInstance["route"]>[0] {
  const wrappedHandler =
    manifest && isResponseCanary(manifest.id)
      ? wrapHandlerWithResponseCanary(combinedMiddleware, handler, manifest)
      : wrapHandler(combinedMiddleware, handler);

  const routeOptions: Parameters<FastifyInstance["route"]>[0] = {
    handler: wrappedHandler,
    method,
    url: normalizePath(path),
  };
  if (bodyLimit) {
    routeOptions.bodyLimit = bodyLimit;
  }
  if (manifest) {
    const schema = buildRouteSchema(manifest);
    if (schema) {
      routeOptions.schema = schema;
      routeOptions.validatorCompiler = () => () => true;
      routeOptions.config = { pdppContractOp: contractOpId };
    }
  }
  return routeOptions;
}

/**
 * Express-shaped `app` object backed by Fastify. Not a drop-in for every
 * Express API — only what PDPP uses. See the header comment for the
 * exact surface.
 *
 * Options:
 *   logger
 *     Pre-built Pino logger; otherwise built from `buildLogger()`.
 *
 *   __requestValidationAllowlistForTest
 *     Test-only injection. When present (must be a Set or array of
 *     operation ids), this app instance treats those op ids as
 *     request-validation-enforced INSTEAD OF reading the shared
 *     `REQUEST_VALIDATION_ALLOWLIST` from `contract-validation.ts`.
 *     Production callers MUST NOT pass this; the live reference server
 *     constructs createApp() without it, so the shared (currently
 *     empty) allowlist remains the single production source of truth.
 *     The leading double-underscore + `ForTest` suffix is the explicit
 *     opt-in signal so a reviewer can grep for production misuse. See
 *     `reference-implementation/test/route-contract-validation.test.js`
 *     for the only intended caller.
 */
export function createApp({ logger, __requestValidationAllowlistForTest }: CreateAppOptions = {}) {
  const loggerInstance = logger ?? buildLogger();
  const fastify = buildFastify({ loggerInstance });
  const settings = new Map<string, unknown>();
  const globalMiddleware: ExpressHandler[] = [];
  let formbodyRegistered = false;

  // Resolve the per-app request-validation enforcement predicate. In
  // production this is the module-level set from contract-validation.ts
  // (`isRequestValidationEnforced`). In tests, callers may inject an
  // override that turns enforcement on for a synthetic route bound to a
  // real manifest, so the transport's "request rejected before handler"
  // path is exercised without ever shipping that enforcement live.
  let enforceRequestValidation: (operationId: string) => boolean;
  if (__requestValidationAllowlistForTest) {
    const overrideSet = new Set(__requestValidationAllowlistForTest);
    enforceRequestValidation = (operationId) => overrideSet.has(operationId);
  } else {
    enforceRequestValidation = isRequestValidationEnforced;
  }

  // Track every registered route so tests and introspection tools can query
  // which routes came with a contract-package binding. Fastify's
  // `findRoute()` doesn't expose `config`, so we maintain this list at
  // registration time.
  const registeredRoutes: RegisteredRoute[] = [];

  async function ensureFormbody() {
    if (formbodyRegistered) {
      return;
    }
    await fastify.register(fastifyFormbody, {
      bodyLimit: 100 * 1024 * 1024,
      parser: (str) => qs.parse(str, { arrayLimit: 64, depth: 8 }),
    });
    formbodyRegistered = true;
  }

  // ─── method helpers ──────────────────────────────────────────────────────

  function registerRoute(method: HttpMethod, path: string, args: RouteArgument[]): void {
    const { fns, bodyLimit, contractOpId } = parseRouteArgs(args);
    if (!fns.length) {
      throw new Error(`No handler for ${method} ${path}`);
    }
    const handler = fns.at(-1);
    if (!handler) {
      throw new Error(`No handler for ${method} ${path}`);
    }
    const middleware = fns.slice(0, -1);

    const manifest = resolveManifest(method, path, contractOpId);
    const combinedMiddleware = buildRouteMiddleware({
      enforceRequestValidation,
      globalMiddleware,
      manifest,
      middleware,
    });
    const routeOptions = buildRouteOptions({
      bodyLimit,
      combinedMiddleware,
      contractOpId,
      handler,
      manifest,
      method,
      path,
    });

    fastify.route(routeOptions);
    registeredRoutes.push({
      contractOp: contractOpId,
      method,
      url: normalizePath(path),
    });
  }

  function get(path: string, ...args: RouteArgument[]) {
    registerRoute("GET", path, args);
    return app;
  }
  function post(path: string, ...args: RouteArgument[]) {
    registerRoute("POST", path, args);
    return app;
  }
  function put(path: string, ...args: RouteArgument[]) {
    registerRoute("PUT", path, args);
    return app;
  }
  function patch(path: string, ...args: RouteArgument[]) {
    registerRoute("PATCH", path, args);
    return app;
  }
  function del(path: string, ...args: RouteArgument[]) {
    registerRoute("DELETE", path, args);
    return app;
  }
  function head(path: string, ...args: RouteArgument[]) {
    registerRoute("HEAD", path, args);
    return app;
  }
  function options(path: string, ...args: RouteArgument[]) {
    registerRoute("OPTIONS", path, args);
    return app;
  }

  // ─── app.use(middleware) ────────────────────────────────────────────────

  function use(fnOrPath: ExpressHandler | string) {
    // Express supports app.use(path, fn) too, but PDPP only uses the bare
    // app.use(fn) form. Throw if that changes so we notice.
    if (typeof fnOrPath === "string") {
      throw new Error("createApp().use(path, fn) is not supported — use route-level middleware");
    }
    if (typeof fnOrPath !== "function") {
      throw new Error("createApp().use expects a function");
    }
    globalMiddleware.push(fnOrPath);
    return app;
  }

  // ─── app.set / app.get (settings) ────────────────────────────────────────

  function set(name: string, value: unknown) {
    settings.set(name, value);
    // `app.set('query parser', ...)` — Fastify's parser is baked into the
    // instance above. We only accept the 'extended' preset to document that
    // the native nested parsing is on; any other value would be silently
    // ignored in Express too, so we accept-and-ignore here.
    return app;
  }

  function getSetting(name: string): unknown {
    return settings.get(name);
  }

  function appGet(path: string, ...args: RouteArgument[]): RouteMethods;
  function appGet(name: string): unknown;
  function appGet(pathOrName: string, ...rest: RouteArgument[]): RouteMethods | unknown {
    if (rest.length === 0 && !pathOrName.startsWith("/")) {
      return getSetting(pathOrName);
    }
    return get(pathOrName, ...rest);
  }

  // ─── listen helper ───────────────────────────────────────────────────────

  async function listen(
    port: number,
    hostOrCb?: string | ((error?: Error) => void),
    maybeCb?: (error?: Error) => void
  ) {
    const host = typeof hostOrCb === "string" ? hostOrCb : "0.0.0.0";
    // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
    const cb = typeof maybeCb === "function" ? maybeCb : typeof hostOrCb === "function" ? hostOrCb : null;
    await ensureFormbody();
    await fastify.ready();
    try {
      await fastify.listen({ host, port });
      if (cb) {
        cb();
      }
    } catch (err) {
      const callbackError = err instanceof Error ? err : new Error(String(err));
      if (cb) {
        cb(callbackError);
      } else {
        throw callbackError;
      }
    }
    // Attach the Fastify instance to the raw http.Server so tests that want
    // to introspect routes (e.g. via `fastify.printRoutes()`) can reach it
    // through the returned server object without going through the app
    // closure. Also expose the transport-level route registry so the W6
    // transport-coverage test can assert every contract manifest has its
    // binding declared at registration time.
    Object.assign(fastify.server, {
      __pdppFastify: fastify,
      __pdppRegisteredRoutes: [...registeredRoutes],
    });
    // Return the underlying Node http.Server so tests that call
    // `.closeAllConnections()` / `.close(cb)` keep working.
    return fastify.server;
  }

  const app = {
    delete: del,

    // Escape hatch — tests and runtime adapters may need the raw Fastify
    // instance or its underlying http.Server.
    fastify,
    // Route methods
    get: appGet,

    // Introspection: returns the list of `{method, url, contractOp}`
    // registrations. Used by the W6 transport-coverage test to assert that
    // every @pdpp/reference-contract manifest is attached to a real route.
    getRegisteredRoutes() {
      return [...registeredRoutes];
    },
    head,
    listen,
    options,
    patch,
    post,
    put,
    set,
    use,
  };

  return app;
}

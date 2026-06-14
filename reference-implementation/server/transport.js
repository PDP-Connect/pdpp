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

import Fastify from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import pino from 'pino';
import qs from 'qs';

import { publicManifests, referenceManifests } from '@pdpp/reference-contract';
import {
  applyRequestValidation,
  applyResponseValidation,
  buildResponseContractErrorBody,
  ensureRequestId,
  isRequestValidationEnforced,
  isResponseCanary,
} from './contract-validation.js';

// Header name the reference sets on responses to expose the protocol trace
// ID (handler-set via setReferenceTraceId in server/index.js).
const PDPP_TRACE_ID_HEADER = 'PDPP-Reference-Trace-Id';
export const PDPP_MANUAL_UPLOAD_STREAM_CONTENT_TYPE = 'application/vnd.pdpp.manual-upload';

// Log field set that every record shares. Path names match the OTel log data
// model where they overlap (`trace_id`, `req_id`) so a later OTLP adapter can
// forward records without renaming.
const REDACT_PATHS = [
  'access_token',
  'refresh_token',
  'device_code',
  'user_code',
  'interaction_response',
  'INTERACTION_RESPONSE',
  'req.headers.authorization',
  '*.access_token',
  '*.refresh_token',
];

/**
 * Build the Pino logger this transport hands to Fastify. Callers pass the
 * `quiet` flag from startServer() so test harnesses that want no stdout
 * chatter get `level: 'silent'` regardless of NODE_ENV.
 */
export function buildLogger({ quiet = false } = {}) {
  if (quiet) {
    return pino({ level: 'silent' });
  }
  const isProd = process.env.NODE_ENV === 'production';
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '<redacted>' },
  };
  if (!isProd) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    };
  }
  return pino(options);
}

// Index route manifests by operation id so route registration can pick them
// up by name and attach the JSON-Schema directly onto the Fastify route.
const CONTRACT_MANIFESTS = new Map();
for (const manifest of [...publicManifests, ...referenceManifests]) {
  CONTRACT_MANIFESTS.set(manifest.id, manifest);
}

/**
 * Recursively strip JSON-Schema `$id` keys before compile so common schemas
 * like UriSchema can be referenced by many routes without ajv ambiguous-id
 * collisions. The reference-contract package's own validator does the same.
 */
function stripIds(node) {
  if (Array.isArray(node)) return node.map((item) => stripIds(item));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$id') continue;
      out[key] = stripIds(value);
    }
    return out;
  }
  return node;
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
function buildRouteSchema(manifest) {
  if (!manifest?.request) return undefined;
  const schema = {};
  if (manifest.request?.params) schema.params = stripIds(manifest.request.params);
  if (manifest.request?.query) schema.querystring = stripIds(manifest.request.query);
  if (manifest.request?.headers) schema.headers = stripIds(manifest.request.headers);
  if (manifest.request?.body?.schema) schema.body = stripIds(manifest.request.body.schema);
  if (manifest.summary) schema.summary = manifest.summary;
  if (Array.isArray(manifest.tags) && manifest.tags.length) schema.tags = manifest.tags;
  if (manifest.id) schema.operationId = manifest.id;
  return Object.keys(schema).length ? schema : undefined;
}

const PASSTHROUGH_CONTENT_TYPES = ['application/x-ndjson', 'text/plain'];

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
function buildFastify({ loggerInstance }) {
  const fastify = Fastify({
    loggerInstance,
    disableRequestLogging: true,
    // Keep-alive can leave pooled client sockets stale after a server restart
    // on the same port (tests exercise this pattern; `closeServer()` +
    // `startServer()` on the same port). We respond with `Connection: close`
    // on every reply below via an `onSend` hook so clients never pool our
    // sockets. The `keepAliveTimeout` is also set short as belt-and-braces.
    keepAliveTimeout: 1,
    bodyLimit: 200 * 1024 * 1024, // match previous express.text() limit
    // Use an inbound Request-Id header if present, otherwise let Fastify
    // generate one. Matches the existing `ensureRequestId()` behavior.
    genReqId: (req) => {
      const header = req.headers?.['request-id'];
      if (typeof header === 'string' && header.trim()) return header.trim();
      return undefined; // Fastify generates one
    },
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
    // Router-level options moved out of the top-level constructor in Fastify 5
    // (the deprecated location warns FSTDEP022 and is removed in Fastify 6).
    routerOptions: {
      ignoreTrailingSlash: false,
      // `qs.parse` decodes PDPP's nested bracket shape
      // (filter[field][gte]=..., expand[]=..., expand_limit[rel]=...) per
      // Core §8. Depth bounded to 8 + arrayLimit 64 to close the DoS surface
      // that Express 5's default `simple` parser was tightening.
      querystringParser: (str) => qs.parse(str, { depth: 8, arrayLimit: 64 }),
    },
  });

  // Force `Connection: close` on every response. See the note above the
  // Fastify config block. An `onRequest` hook sets it before handlers run so
  // there's no race with streaming replies.
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('connection', 'close');
    done();
  });

  // Emit one structured completion record per request carrying req_id, method,
  // path, statusCode, responseTime, and — when the handler set it via
  // setReferenceTraceId() — trace_id. Kept at `info`; this is the baseline
  // record the spec promises, not a per-status-code shape.
  fastify.addHook('onResponse', async (request, reply) => {
    const traceId = reply.getHeader?.(PDPP_TRACE_ID_HEADER) || request.__pdppTraceId;
    request.log.info(
      {
        req_id: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: Math.round(reply.elapsedTime ?? 0),
        ...(traceId ? { trace_id: traceId } : {}),
      },
      'request completed',
    );
  });

  // application/x-ndjson + text/plain come in as raw strings. Handlers that
  // care read `req.body` and parse line-by-line themselves (runtime ingest).
  for (const type of PASSTHROUGH_CONTENT_TYPES) {
    fastify.addContentTypeParser(type, { parseAs: 'string' }, (req, body, done) => {
      done(null, body);
    });
  }

  // Large owner import artifacts must not hit the wildcard buffer parser.
  // Route handlers that opt into this exact content type receive the raw
  // readable stream and are responsible for writing it to bounded storage.
  fastify.addContentTypeParser(PDPP_MANUAL_UPLOAD_STREAM_CONTENT_TYPE, (req, payload, done) => {
    done(null, payload);
  });

  // Binary upload surfaces (currently `POST /v1/blobs`) need exact bytes.
  // The wildcard parser is a fallback: exact parsers above and JSON below
  // still own their content types.
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  // Express tolerates empty request bodies on `Content-Type: application/json`
  // (treats `req.body` as `{}`). Fastify's default JSON parser returns
  // FST_ERR_CTP_EMPTY_JSON_BODY. Replace it with a parser that accepts empty
  // payloads so routes like `POST /grants/:id/revoke` (no body, header still
  // JSON) reach their handlers instead of failing at the transport.
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      if (!body) { done(null, {}); return; }
      try { done(null, JSON.parse(body)); }
      catch (err) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  return fastify;
}

/**
 * Turn a Fastify `(request, reply)` pair into an Express-shaped `(req, res)`
 * pair so existing route handlers keep working unchanged. Returns the shim
 * object. Mutations to `req.query` / `req.body` etc. inside handlers are
 * reflected on the underlying Fastify `request` where it matters.
 */
function expressShim(request, reply) {
  const req = request;

  // Ensure the properties Express handlers rely on are there. Fastify already
  // populates `headers`, `params`, `query`, `body`, `method`, and `url`.
  // `req.path` is just the URL path with any query string stripped.
  if (!Object.prototype.hasOwnProperty.call(req, 'path')) {
    Object.defineProperty(req, 'path', {
      get() {
        const raw = req.raw?.url || req.url || '';
        const q = raw.indexOf('?');
        return q >= 0 ? raw.slice(0, q) : raw;
      },
      configurable: true,
    });
  }

  // Fastify exposes `request.protocol` and `request.hostname` natively, but
  // only when `trustProxy` is set. We expose simple fallbacks derived from
  // the raw request.
  if (!req.protocol) {
    Object.defineProperty(req, 'protocol', {
      get() {
        const encrypted = req.raw?.socket?.encrypted;
        return encrypted ? 'https' : 'http';
      },
      configurable: true,
    });
  }
  if (!req.hostname) {
    Object.defineProperty(req, 'hostname', {
      get() {
        const host = req.headers?.host;
        if (!host) return '';
        const colon = host.indexOf(':');
        return colon >= 0 ? host.slice(0, colon) : host;
      },
      configurable: true,
    });
  }

  // Express's `req.get(headerName)` is case-insensitive.
  if (typeof req.get !== 'function') {
    req.get = (name) => {
      if (!name) return undefined;
      return req.headers?.[String(name).toLowerCase()];
    };
  }

  // Express's `req.is(type)` returns the matched type string or false.
  if (typeof req.is !== 'function') {
    req.is = (types) => {
      const ct = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!ct) return false;
      const candidates = Array.isArray(types) ? types : [types];
      for (const candidate of candidates) {
        if (matchesMediaType(ct, String(candidate).toLowerCase())) return candidate;
      }
      return false;
    };
  }

  // Minimal `req.accepts(types)` returning the best match from the Accept
  // header. Handlers in PDPP only care about `req.accepts(['html', 'json'])`.
  if (typeof req.accepts !== 'function') {
    req.accepts = (types) => {
      const accept = String(req.headers?.accept || '').toLowerCase();
      const candidates = Array.isArray(types) ? types : [types];
      if (!accept || accept === '*/*') return candidates[0] || false;
      for (const candidate of candidates) {
        const short = String(candidate).toLowerCase();
        const long = short.includes('/') ? short : `application/${short}`;
        if (accept.includes(short) || accept.includes(long)) return candidate;
      }
      return false;
    };
  }

  // Express-compatible `res` that proxies onto Fastify's `reply`.
  const res = {
    headersSent: false,
    statusCode: 200,
    locals: reply.locals || {},
    setHeader(name, value) { reply.header(name, value); return res; },
    // Express exposes `res.header(field, value)` and `res.set(field, value)` as
    // aliases of `setHeader`, with an object form that sets multiple headers in
    // one call. Several PDPP handlers (and the streaming routes' WWW-Authenticate
    // emission for 401s) chain `.status(...).header(...)`, which only works if
    // both methods return `this`. Without these aliases the chain crashes with
    // `res.status(...).header is not a function` and Fastify converts the throw
    // into a 500 — masking the intended 401 envelope.
    header(field, value) {
      if (field && typeof field === 'object') {
        for (const [k, v] of Object.entries(field)) reply.header(k, v);
      } else {
        reply.header(field, value);
      }
      return res;
    },
    set(field, value) { return res.header(field, value); },
    getHeader(name) { return reply.getHeader ? reply.getHeader(name) : reply.raw?.getHeader?.(name); },
    removeHeader(name) { if (reply.removeHeader) reply.removeHeader(name); return res; },
    status(code) { res.statusCode = code; reply.code(code); return res; },
    sendStatus(code) { res.statusCode = code; reply.code(code).send(); return res; },
    type(value) { reply.type(value); return res; },
    redirect(statusOrUrl, maybeUrl) {
      const statusCode = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      const location = typeof statusOrUrl === 'number' ? maybeUrl : statusOrUrl;
      res.headersSent = true;
      reply.code(statusCode);
      reply.header('location', location);
      reply.send();
      return res;
    },
    json(payload) {
      res.headersSent = true;
      reply.header('content-type', reply.getHeader?.('content-type') || 'application/json; charset=utf-8');
      reply.send(payload);
      return res;
    },
    send(payload) {
      res.headersSent = true;
      // Express.send() auto-detects content type: strings → text/html,
      // objects → JSON, Buffers → application/octet-stream (keep existing
      // header if set). Fastify's reply.send() already handles Buffer and
      // object serialization; strings go as text.
      if (payload === undefined || payload === null) {
        reply.send();
      } else if (typeof payload === 'string') {
        if (!reply.getHeader?.('content-type')) {
          reply.header('content-type', 'text/html; charset=utf-8');
        }
        reply.send(payload);
      } else if (Buffer.isBuffer(payload)) {
        if (!reply.getHeader?.('content-type')) {
          reply.header('content-type', 'application/octet-stream');
        }
        reply.send(payload);
      } else {
        reply.send(payload);
      }
      return res;
    },
    end(payload) {
      res.headersSent = true;
      if (payload !== undefined) reply.send(payload);
      else reply.send();
      return res;
    },
    // Streaming/SSE escape hatch: handlers that need to write directly to the
    // raw socket call `res.hijack()` first, then write to `res.raw`. The
    // Fastify reply lifecycle is suspended so the handler is responsible for
    // ending the response itself.
    get raw() { return reply.raw; },
    hijack() {
      if (typeof reply.hijack === 'function') {
        reply.hijack();
      }
      res.headersSent = true;
      return res;
    },
  };

  return { req, res };
}

function matchesMediaType(ct, pattern) {
  if (pattern === '*/*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return ct.startsWith(prefix);
  }
  if (!pattern.includes('/')) {
    // Express accepts shorthand like 'json' → any */json match.
    return ct.endsWith(`/${pattern}`) || ct.includes(`+${pattern}`);
  }
  return ct === pattern;
}

/**
 * Fastify converts its URL pattern syntax to its own format. Express uses
 * `/foo/:bar` — Fastify supports the same `:param` syntax natively, so no
 * path transformation is needed.
 */
function normalizePath(path) {
  return path;
}

/**
 * Run an ordered list of Express-style `(req, res, next)` middleware until
 * one calls `next(err)`, one responds, or the chain completes.
 */
function runMiddlewareChain(middleware, req, res) {
  return new Promise((resolve, reject) => {
    let i = 0;
    function next(err) {
      if (err) { reject(err); return; }
      if (res.headersSent) { resolve(true); return; }
      if (i >= middleware.length) { resolve(false); return; }
      const fn = middleware[i++];
      try {
        const result = fn(req, res, next);
        if (result && typeof result.then === 'function') {
          result.then(() => {
            if (res.headersSent) resolve(true);
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
function wrapHandler(middleware, handler) {
  return async function fastifyRouteHandler(request, reply) {
    const { req, res } = expressShim(request, reply);
    if (middleware.length) {
      const responded = await runMiddlewareChain(middleware, req, res);
      if (responded || res.headersSent) return reply;
    }
    const result = handler(req, res, () => {});
    if (result && typeof result.then === 'function') {
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
function wrapHandlerWithResponseCanary(middleware, handler, manifest) {
  return async function fastifyCanaryRouteHandler(request, reply) {
    const { req, res } = expressShim(request, reply);
    if (middleware.length) {
      const responded = await runMiddlewareChain(middleware, req, res);
      if (responded || res.headersSent) return reply;
    }

    // Patch `res.json` so canary operations validate just before sending.
    // Canary operations are stable JSON metadata/discovery routes whose
    // handlers always go through `res.json(envelope)`. Non-JSON paths
    // (`res.send(string)`, `res.send(Buffer)`, `res.redirect`,
    // `res.sendStatus`, `res.hijack` for streams/SSE) skip this
    // interception entirely.
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const status = res.statusCode || 200;
      const result = applyResponseValidation({
        operationId: manifest.id,
        status,
        payload,
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
          req_id: request.id,
          operation_id: manifest.id,
          status,
          validator_errors: result.errors,
        },
        'response payload violated declared route contract',
      );
      res.status(500);
      return originalJson(body);
    };

    const result = handler(req, res, () => {});
    if (result && typeof result.then === 'function') {
      await result;
    }
    return reply;
  };
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
 *     `REQUEST_VALIDATION_ALLOWLIST` from `contract-validation.js`.
 *     Production callers MUST NOT pass this; the live reference server
 *     constructs createApp() without it, so the shared (currently
 *     empty) allowlist remains the single production source of truth.
 *     The leading double-underscore + `ForTest` suffix is the explicit
 *     opt-in signal so a reviewer can grep for production misuse. See
 *     `reference-implementation/test/route-contract-validation.test.js`
 *     for the only intended caller.
 */
export function createApp({ logger, __requestValidationAllowlistForTest } = {}) {
  const loggerInstance = logger ?? buildLogger();
  const fastify = buildFastify({ loggerInstance });
  const settings = new Map();
  const globalMiddleware = [];
  let formbodyRegistered = false;

  // Resolve the per-app request-validation enforcement predicate. In
  // production this is the module-level set from contract-validation.js
  // (`isRequestValidationEnforced`). In tests, callers may inject an
  // override that turns enforcement on for a synthetic route bound to a
  // real manifest, so the transport's "request rejected before handler"
  // path is exercised without ever shipping that enforcement live.
  let enforceRequestValidation;
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
  const registeredRoutes = [];

  async function ensureFormbody() {
    if (formbodyRegistered) return;
    await fastify.register(fastifyFormbody, {
      bodyLimit: 100 * 1024 * 1024,
      parser: (str) => qs.parse(str, { depth: 8, arrayLimit: 64 }),
    });
    formbodyRegistered = true;
  }

  // ─── method helpers ──────────────────────────────────────────────────────

  function registerRoute(method, path, args) {
    // An args list may include a leading options object carrying a contract
    // operation id, e.g.
    //   app.post('/foo', { contract: 'fooOp' }, middleware, handler)
    // Any non-function entry that looks like a plain options object is
    // consumed here; everything else is interpreted as middleware/handler.
    let bodyLimit = null;
    let contractOpId = null;
    const fns = [];
    for (const entry of args) {
      if (typeof entry === 'function') { fns.push(entry); continue; }
      if (entry && typeof entry === 'object') {
        if (typeof entry.contract === 'string') {
          contractOpId = entry.contract;
        }
        if (Number.isInteger(entry.bodyLimit) && entry.bodyLimit > 0) {
          bodyLimit = entry.bodyLimit;
        }
        continue;
      }
    }
    if (!fns.length) throw new Error(`No handler for ${method} ${path}`);
    const handler = fns[fns.length - 1];
    const middleware = fns.slice(0, -1);

    // Resolve the contract manifest first so an unknown operation id
    // fails fast at registration time (before the route is added to
    // Fastify). This keeps drift between server/index.js and
    // @pdpp/reference-contract observable at startup rather than at
    // the first request to the route.
    let manifest = null;
    if (contractOpId) {
      manifest = CONTRACT_MANIFESTS.get(contractOpId);
      if (!manifest) {
        throw new Error(
          `Unknown reference-contract operation id for ${method} ${path}: ${contractOpId}`,
        );
      }
    }

    // Build the route middleware chain. When the route's operation id
    // is on the request-validation allowlist, transport-level
    // validation runs AFTER user-supplied middleware (auth, owner-
    // session, device-credential checks) and BEFORE the route handler.
    // This preserves auth ordering: unauthenticated callers see the
    // auth error envelope rather than a contract-shape error. Routes
    // NOT on the allowlist see no transport-level validation, which
    // preserves the rich handler-owned diagnostics on shape rejection.
    const routeMiddleware = [...middleware];
    if (manifest && enforceRequestValidation(manifest.id)) {
      const manifestRef = manifest;
      routeMiddleware.push((req, res, next) => {
        const responded = applyRequestValidation({
          manifest: manifestRef,
          req,
          res,
        });
        if (responded) return;
        next();
      });
    }
    const combinedMiddleware = [...globalMiddleware, ...routeMiddleware];

    const wrappedHandler =
      manifest && isResponseCanary(manifest.id)
        ? wrapHandlerWithResponseCanary(combinedMiddleware, handler, manifest)
        : wrapHandler(combinedMiddleware, handler);

    const routeOptions = {
      method,
      url: normalizePath(path),
      handler: wrappedHandler,
    };
    if (bodyLimit) {
      routeOptions.bodyLimit = bodyLimit;
    }

    // Attach the contract-package JSON-Schema directly to the Fastify
    // route definition. The schema is informative metadata for tests,
    // OpenAPI emission, and introspection; runtime request validation
    // happens (when enabled for this op id) in the middleware chain
    // above through `@pdpp/reference-contract`. Fastify's own validator
    // is disabled so it cannot transform or strip payloads. Response
    // schemas are deliberately omitted — see `buildRouteSchema`.
    if (manifest) {
      const schema = buildRouteSchema(manifest);
      if (schema) {
        routeOptions.schema = schema;
        routeOptions.validatorCompiler = () => () => true;
        routeOptions.config = { pdppContractOp: contractOpId };
      }
    }

    fastify.route(routeOptions);
    registeredRoutes.push({
      method,
      url: normalizePath(path),
      contractOp: contractOpId,
    });
  }

  function get(path, ...args) { registerRoute('GET', path, args); return app; }
  function post(path, ...args) { registerRoute('POST', path, args); return app; }
  function put(path, ...args) { registerRoute('PUT', path, args); return app; }
  function patch(path, ...args) { registerRoute('PATCH', path, args); return app; }
  function del(path, ...args) { registerRoute('DELETE', path, args); return app; }
  function head(path, ...args) { registerRoute('HEAD', path, args); return app; }
  function options(path, ...args) { registerRoute('OPTIONS', path, args); return app; }

  // ─── app.use(middleware) ────────────────────────────────────────────────

  function use(fnOrPath, maybeFn) {
    // Express supports app.use(path, fn) too, but PDPP only uses the bare
    // app.use(fn) form. Throw if that changes so we notice.
    if (typeof fnOrPath === 'string') {
      throw new Error('createApp().use(path, fn) is not supported — use route-level middleware');
    }
    if (typeof fnOrPath !== 'function') {
      throw new Error('createApp().use expects a function');
    }
    globalMiddleware.push(fnOrPath);
    return app;
  }

  // ─── app.set / app.get (settings) ────────────────────────────────────────

  function set(name, value) {
    settings.set(name, value);
    // `app.set('query parser', ...)` — Fastify's parser is baked into the
    // instance above. We only accept the 'extended' preset to document that
    // the native nested parsing is on; any other value would be silently
    // ignored in Express too, so we accept-and-ignore here.
    return app;
  }

  function getSetting(name) { return settings.get(name); }

  // ─── listen helper ───────────────────────────────────────────────────────

  async function listen(port, hostOrCb, maybeCb) {
    const host = typeof hostOrCb === 'string' ? hostOrCb : '0.0.0.0';
    const cb = typeof maybeCb === 'function'
      ? maybeCb
      : (typeof hostOrCb === 'function' ? hostOrCb : null);
    await ensureFormbody();
    await fastify.ready();
    try {
      await fastify.listen({ port, host });
      if (cb) cb();
    } catch (err) {
      if (cb) cb(err); else throw err;
    }
    // Attach the Fastify instance to the raw http.Server so tests that want
    // to introspect routes (e.g. via `fastify.printRoutes()`) can reach it
    // through the returned server object without going through the app
    // closure. Also expose the transport-level route registry so the W6
    // transport-coverage test can assert every contract manifest has its
    // binding declared at registration time.
    fastify.server.__pdppFastify = fastify;
    fastify.server.__pdppRegisteredRoutes = [...registeredRoutes];
    // Return the underlying Node http.Server so tests that call
    // `.closeAllConnections()` / `.close(cb)` keep working.
    return fastify.server;
  }

  const app = {
    // Route methods
    get(pathOrName, ...rest) {
      // Express `app.get(name)` reads a setting. Keep that behavior only when
      // called with a single non-function argument.
      if (rest.length === 0 && typeof pathOrName === 'string' && !pathOrName.startsWith('/')) {
        return getSetting(pathOrName);
      }
      return get(pathOrName, ...rest);
    },
    post, put, patch, delete: del, head, options,
    use, set,

    // Escape hatch — tests and runtime adapters may need the raw Fastify
    // instance or its underlying http.Server.
    fastify,
    listen,

    // Introspection: returns the list of `{method, url, contractOp}`
    // registrations. Used by the W6 transport-coverage test to assert that
    // every @pdpp/reference-contract manifest is attached to a real route.
    getRegisteredRoutes() {
      return [...registeredRoutes];
    },
  };

  return app;
}

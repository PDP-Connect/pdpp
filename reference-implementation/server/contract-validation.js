// Route-contract validation adapter for the reference HTTP transport.
//
// Spec: openspec/changes/wire-route-contract-validation/specs/
//   reference-implementation-architecture/spec.md
//
// Responsibilities:
//   - Maintain two explicit allowlists keyed on `@pdpp/reference-contract`
//     operation ids:
//       * `REQUEST_VALIDATION_ALLOWLIST` — routes whose handler does not
//         emit richer wire-shape diagnostics on rejection, so the
//         transport's structured `invalid_request` envelope is the
//         load-bearing observable. Empty in this tranche.
//       * `RESPONSE_CANARY_OPERATIONS` — stable JSON metadata/discovery
//         routes whose response schema is known to be exact.
//   - Run request validation when the route's operation id is in the
//     request allowlist, AFTER auth/owner middleware and BEFORE the
//     route handler mutates state or returns data.
//   - Run response validation when the operation id is in the canary
//     allowlist, inspecting the outgoing payload without Fastify
//     serialization, coercion, or field stripping.
//   - Map validation failures to PDPP / OAuth error envelopes (picked
//     from the route manifest's declared 400 response schema) so
//     callers see one error shape per surface.
//
// This module is framework-agnostic at its core. The transport
// (server/transport.js) decides where and when to call it; operation
// modules stay free of any reference-contract or transport imports.

import { randomBytes } from 'node:crypto';

import { validateRequest, validateResponse } from '@pdpp/reference-contract';

// Routes enrolled for transport-level request validation. Membership in
// this set means: the handler does not own richer wire-shape
// diagnostics on rejection, so the contract validator's structured
// `invalid_request` envelope is the load-bearing observable. The
// allowlist starts empty in this tranche — every existing annotated
// route has at least one handler-emitted code/message/param hint or
// spine event we want to preserve. Expansion is per-route follow-up
// after each handler is proven shape-only or after equivalent
// diagnostics are emitted from the validation boundary.
//
// See design.md decision 3 in openspec/changes/wire-route-contract-validation/.
const REQUEST_VALIDATION_ALLOWLIST = new Set([
  // Add ids here only when the handler does not own richer wire-shape
  // diagnostics on rejection.
]);

// Routes enrolled for response-schema validation. Start with stable
// metadata/discovery surfaces where the response schema is known to be
// exact. Expanding this set is per-route follow-up after individual
// schemas are proven to match handler payloads — see
// design-notes/reference-contract-response-schema-drift-2026-04-22.md.
const RESPONSE_CANARY_OPERATIONS = new Set([
  'getRsDiscoveryIndex',
  'getAsDiscoveryIndex',
]);

export function isRequestValidationEnforced(operationId) {
  return REQUEST_VALIDATION_ALLOWLIST.has(operationId);
}

export function isResponseCanary(operationId) {
  return RESPONSE_CANARY_OPERATIONS.has(operationId);
}

export function listRequestValidationAllowlist() {
  return [...REQUEST_VALIDATION_ALLOWLIST];
}

export function listResponseCanaryOperations() {
  return [...RESPONSE_CANARY_OPERATIONS];
}

// Inspect the manifest's declared 400 response to decide which error
// envelope a malformed request should receive. Manifests that declare
// `pdpp/common/OAuthError` at 400 are OAuth-shaped (DCR, token, PAR,
// device authorization); everything else uses the PDPP envelope.
// Falling back to PDPP is the safer default — it carries the
// structured `code` callers already rely on.
function pickRequestErrorEnvelope(manifest) {
  const response400 = manifest?.responses?.['400'];
  const schemaId = response400?.schema?.$id;
  if (schemaId === 'pdpp/common/OAuthError') {
    return 'oauth';
  }
  return 'pdpp';
}

function ensureRequestId(res) {
  // Mirrors server/index.js's ensureRequestId(). Held locally so this
  // module stays decoupled from server/index.js (which would otherwise
  // create an import cycle: index.js → transport.js → here → index.js).
  const existing = res.getHeader?.('Request-Id');
  if (typeof existing === 'string' && existing.trim()) {
    return existing.trim();
  }
  const generated = `req_${randomBytes(8).toString('hex')}`;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Request-Id', generated);
  }
  return generated;
}

function summarizeFailure(failure) {
  // AJV emits one error per failing keyword. For the user-facing
  // message we surface the first failure's path/message — enough to
  // identify the offending field without leaking schema internals.
  const first = failure.errors?.[0];
  const where = first?.where ?? 'request';
  const instancePath = first?.instancePath ?? '';
  const message = first?.message ?? 'request did not match contract';
  const target = instancePath ? `${where}${instancePath}` : where;
  return { where, target, message };
}

function paramHintFromFailure(failure) {
  // PDPP's error envelope optionally carries `param`. For request
  // validation we map the AJV path onto the originating property when
  // the path points to a top-level property — e.g. `/client_id` in
  // `body` becomes `param: 'client_id'`. Sub-paths fall back to the
  // request part identifier (`body`, `query`, …).
  const first = failure.errors?.[0];
  if (!first) return null;
  const instancePath = first.instancePath || '';
  if (instancePath.startsWith('/') && instancePath.indexOf('/', 1) === -1) {
    return instancePath.slice(1) || null;
  }
  // AJV's `additionalProperties` failure puts the offending name in
  // `params.additionalProperty` rather than the instance path.
  const additional = first.params && /** @type {Record<string, unknown>} */ (first.params).additionalProperty;
  if (typeof additional === 'string' && additional) {
    return additional;
  }
  // Fall back to the request part identifier (body/query/params/headers).
  return first.where ?? null;
}

function pdppErrorBody({ status, code, message, param, requestId }) {
  const type = (() => {
    if (status === 400) return 'invalid_request_error';
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    return 'api_error';
  })();
  const error = { type, code, message };
  if (param) error.param = param;
  error.request_id = requestId;
  return { error };
}

function oauthErrorBody({ code, description, requestId }) {
  return {
    error: code,
    error_description: description,
    request_id: requestId,
  };
}

/**
 * Run request validation for a single contract route.
 *
 * Only invoked by the transport when the manifest's operation id is in
 * the request-validation allowlist. Returns `true` when a response has
 * been sent (caller must short-circuit), `false` when the request
 * passed validation.
 *
 * @param {object} args
 * @param {object} args.manifest - Route manifest from @pdpp/reference-contract.
 * @param {object} args.req      - Express-shaped request from the transport shim.
 * @param {object} args.res      - Express-shaped response from the transport shim.
 * @returns {boolean}
 */
export function applyRequestValidation({ manifest, req, res }) {
  const operationId = manifest.id;
  const result = validateRequest(operationId, {
    params: req.params,
    query: req.query,
    body: req.body,
    headers: req.headers,
  });
  if (result.ok) {
    return false;
  }
  const { target, message } = summarizeFailure(result);
  const param = paramHintFromFailure(result);
  const requestId = ensureRequestId(res);
  const envelope = pickRequestErrorEnvelope(manifest);
  if (envelope === 'oauth') {
    const body = oauthErrorBody({
      code: 'invalid_request',
      description: `${target}: ${message}`,
      requestId,
    });
    res.status(400).json(body);
    return true;
  }
  const body = pdppErrorBody({
    status: 400,
    code: 'invalid_request',
    message: `${target}: ${message}`,
    param,
    requestId,
  });
  res.status(400).json(body);
  return true;
}

/**
 * Validate a JSON response body for a canary-allowlisted route.
 *
 * Returns `{ ok: true, validated }` when the payload conforms (or when
 * the route / status is intentionally skipped). Returns
 * `{ ok: false, errors }` when the handler tried to send a payload
 * that violates its declared contract; the caller is responsible for
 * fail-closing with a server-side contract error.
 *
 * This function NEVER mutates the payload.
 */
export function applyResponseValidation({ operationId, status, payload }) {
  if (!RESPONSE_CANARY_OPERATIONS.has(operationId)) {
    return { ok: true, validated: false };
  }
  const result = validateResponse(operationId, { status, body: payload });
  if (result.ok) {
    return { ok: true, validated: !result.skipped };
  }
  return { ok: false, errors: result.errors };
}

/**
 * Build a PDPP-shaped server-side error envelope for a canary response
 * that violated its contract. Status is 500 with code
 * `internal_contract_error`. Validator errors are intentionally NOT
 * placed in the wire envelope — response-schema mismatches are
 * operator-facing debug signal, not protocol output. Callers log the
 * validator errors alongside the request id.
 */
export function buildResponseContractErrorBody({ operationId, requestId }) {
  return pdppErrorBody({
    status: 500,
    code: 'internal_contract_error',
    message: `Response for operation '${operationId}' violated its declared contract.`,
    param: null,
    requestId,
  });
}

export { ensureRequestId };

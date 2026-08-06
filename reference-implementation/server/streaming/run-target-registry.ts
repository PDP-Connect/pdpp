// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-target registry (reference-internal).
 *
 * Holds an ephemeral, in-memory map from `(runId, interactionId)` to a
 * streaming target plus the device-exporter authority that registered it.
 * Legacy CDP targets resolve to a page-target WebSocket URL string; Neko
 * targets resolve to a normalized descriptor. Consumed by the streaming
 * companion factory's resolver when a viewer attaches to a specific
 * run-interaction streaming session.
 *
 * Key shape: composite `(runId, interactionId)`. Each manual_action
 * interaction has its own page identity (the page the human should see and
 * control); the registry never collapses two interactions of the same run
 * into a single "latest page" cell. See:
 *   openspec/changes/add-run-interaction-streaming-companion/design-notes/
 *   advisor-recommendation-streaming-page-target-resolution.md  (= tmp/answer.md)
 *
 * This is reference-runtime orchestration plumbing, NOT a PDPP wire
 * surface. It MUST NOT introduce manifest fields, capability vocabulary,
 * or Collection Profile conformance terms. The endpoints registered by
 * `attachRoutes` live under
 * `/admin/runs/:runId/interactions/:interactionId/streaming-target` to
 * make the admin/internal framing visible.
 *
 * Security shape (all enforced here, not by callers):
 *  - CDP `wsUrl` MUST parse as ws:/wss: and remain loopback
 *    (`127.0.0.1`/`localhost`). Neko `base_url` MUST parse as http:/https:
 *    and remain either loopback, the private Compose service host `neko`, or
 *    an explicitly approved managed n.eko surface descriptor.
 *  - Full target URLs and auth metadata are never logged, never echoed back
 *    in responses, and never included in error messages. Logs may carry
 *    `runId`, `interactionId`, `backend`, `host`, `port`.
 *  - DELETE requires the same `deviceId` that registered the record.
 *    A different device-exporter cannot unregister another device's
 *    target.
 *  - Nonces are scoped per-run (not per-interaction): a single nonce
 *    minted at run spawn time authenticates registrations for the run.
 *    Interaction exactness for managed n.eko descriptors is enforced by
 *    descriptor metadata (`interaction_id`) checked against the route key.
 *    The synthetic deviceId on the nonce path is `nonce:<runId>` so the
 *    same nonce-issued authority is consistent across the run's interactions.
 *  - Records expire after a short TTL (default 1h) and are evicted by
 *    explicit DELETE, lazy on-access sweep, periodic timer, and
 *    process exit.
 *
 * PUT semantics (idempotency rule):
 *  - Same-value re-PUT for an existing `(runId, interactionId)` succeeds
 *    silently (no log). Same-device, same-target is a routine retry.
 *  - Different-value PUT for an existing key REPLACES the prior value
 *    AND logs a `run_target_replaced` warning. The page identity has
 *    changed (e.g. the connector navigated to a popup); the registry
 *    accepts the new value rather than failing closed. The diagnostic
 *    counter lets us see whether replacement is rare-and-intentional or
 *    a sign of churn.
 *  - A different deviceId trying to PUT over an existing key is still
 *    rejected with 409 — that is a different-authority conflict and is
 *    not what idempotent re-PUT means.
 */

import { createHash, timingSafeEqual } from "node:crypto";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

type TargetBackend = "cdp" | "neko";
type RegistryAction = "registered" | "reaffirmed" | "replaced";
type RegistryLogLevel = "debug" | "error" | "info" | "warn";
type RecordFields = Record<string, unknown>;

interface NekoDescriptor extends JsonObject {
  auth?: JsonObject;
  backend: "neko";
  base_url: string;
  browser_session_id?: string;
  cdp_http_url?: string;
  interaction_id?: string;
  lease_id?: string;
  profile_key?: string;
  start_url?: string;
  surface_id?: string;
  window_settle_endpoint?: string;
}

interface NormalizedTarget {
  backend: TargetBackend;
  comparisonKey: string;
  descriptor: JsonObject;
  host: string;
  port: string;
  resolverValue: NekoDescriptor | string;
}

interface RegistryRecord {
  backend: TargetBackend;
  baseUrl?: string;
  comparisonKey: string;
  descriptor: JsonObject;
  deviceId: string;
  expiry: number;
  interactionId: string;
  pageTitle?: string;
  pageUrl?: string;
  reason?: string;
  registeredAt: string;
  runId: string;
  wsUrl?: string;
}

export interface TargetRegistrationInput extends RecordFields {
  auth?: unknown;
  backend?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
  cdp_http_url?: unknown;
  cdpHttpUrl?: unknown;
  descriptor?: unknown;
  deviceId?: unknown;
  interactionId?: unknown;
  pageTitle?: unknown;
  pageUrl?: unknown;
  reason?: unknown;
  runId?: unknown;
  start_url?: unknown;
  startUrl?: unknown;
  ws_url?: unknown;
  wsUrl?: unknown;
}

type IdentifiedTargetRegistrationInput = TargetRegistrationInput & {
  interactionId: string;
  runId: string;
};

interface RunInteractionKey {
  interactionId?: unknown;
  runId?: unknown;
}

interface RegisteredTargetKey extends RunInteractionKey {
  deviceId?: unknown;
}

interface NonceKey {
  nonce?: unknown;
  runId?: unknown;
}

interface PresentedNonceKey {
  presentedToken?: unknown;
  runId?: unknown;
}

interface DeviceExporterAuthority {
  deviceId: string;
}

interface RegistryRequest {
  body?: unknown;
  deviceExporter?: DeviceExporterAuthority;
  headers?: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
}

interface RegistryReply {
  json: (body: JsonObject) => RegistryReply;
  status: (status: number) => RegistryReply;
}

type Next = (error?: unknown) => void;
type RegistryRouteHandler = (req: RegistryRequest, res: RegistryReply, next: Next) => unknown;

interface RegistryRouteApp {
  delete: (path: string, ...handlers: RegistryRouteHandler[]) => void;
  post: (path: string, ...handlers: RegistryRouteHandler[]) => void;
  put: (path: string, ...handlers: RegistryRouteHandler[]) => void;
}

type DeviceExporterAuth = RegistryRouteHandler;
type RegistryLogger = Partial<Record<RegistryLogLevel, (entry: JsonObject) => void>>;

interface NekoApprovalContext {
  cdpHost: string | null;
  cdpPort: string | null;
  host: string;
  interactionId: string;
  port: string;
  runId: string;
}

type NekoDescriptorApproval = (descriptor: NekoDescriptor, context: NekoApprovalContext) => boolean;

interface RegistryState {
  isNekoDescriptorApproved: NekoDescriptorApproval | null;
  logger: RegistryLogger | null;
  nonceHashes: Map<string, string>;
  now: () => number;
  records: Map<string, RegistryRecord>;
  ttlMs: number;
}

interface RegistryRouteHandlers {
  log: (level: RegistryLogLevel, message: string, data?: JsonObject) => void;
  register: (input: TargetRegistrationInput) => RegistrationResult;
  unregister: (input: RegisteredTargetKey) => boolean;
  verifyNonce: (input: PresentedNonceKey) => boolean;
}

interface RegistrationResult {
  action: RegistryAction;
  expiry: number;
  interactionId: string;
  runId: string;
}

interface CreateRunTargetRegistryOptions {
  isNekoDescriptorApproved?: NekoDescriptorApproval | null;
  logger?: RegistryLogger | null;
  now?: () => number;
  sweepIntervalMs?: number;
  ttlMs?: number;
}

export interface RunTargetRegistry {
  _internal: {
    nonceHashes: Map<string, string>;
    records: Map<string, RegistryRecord>;
    ttlMs: number;
  };
  attachRoutes: (app: unknown, requireDeviceExporterAuth: unknown) => void;
  clearNonce: (input: RunInteractionKey) => void;
  evictExpired: () => void;
  forceUnregister: (input: RunInteractionKey) => boolean;
  get: (input: RunInteractionKey) => NekoDescriptor | string | null;
  getByRun: (runId: unknown) => RegistryRecord[];
  register: (input: TargetRegistrationInput) => RegistrationResult;
  registerNonce: (input: NonceKey) => void;
  shutdown: () => void;
  unregister: (input: RegisteredTargetKey) => boolean;
  verifyNonce: (input: PresentedNonceKey) => boolean;
}

interface NekoHttpUrlField {
  inputName: string;
  missingMessage: string;
  outputName: "baseUrl" | "cdpHttpUrl";
  trailingSlash: "add" | "remove";
}

interface NekoOptionalDescriptorField {
  inputNames?: string[];
  key: Exclude<keyof NekoDescriptor, number>;
  sourceNames: string[];
}

interface RouteStringField {
  camelCase: string | null;
  key: "pageTitle" | "pageUrl" | "reason" | "startUrl" | "wsUrl";
  snakeCase: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const NEKO_PRIVATE_HOSTS = new Set([...LOOPBACK_HOSTS, "neko"]);
const WS_PROTOCOLS = new Set(["ws:", "wss:"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const BEARER_TOKEN_PATTERN = /^Bearer\s+(.+)$/i;
const NEKO_HTTP_URL_FIELDS: Record<"base" | "cdp", NekoHttpUrlField> = {
  base: {
    inputName: "base_url",
    missingMessage: "base_url is required",
    outputName: "baseUrl",
    trailingSlash: "remove",
  },
  cdp: {
    inputName: "cdp_http_url",
    missingMessage: "cdp_http_url must be a non-empty URL when provided",
    outputName: "cdpHttpUrl",
    trailingSlash: "add",
  },
};
const NEKO_OPTIONAL_DESCRIPTOR_FIELDS: NekoOptionalDescriptorField[] = [
  { inputNames: ["start_url", "startUrl"], key: "start_url", sourceNames: ["start_url", "startUrl"] },
  { key: "browser_session_id", sourceNames: ["browser_session_id", "browserSessionId"] },
  { key: "lease_id", sourceNames: ["lease_id", "leaseId"] },
  { key: "profile_key", sourceNames: ["profile_key", "profileKey"] },
  { key: "surface_id", sourceNames: ["surface_id", "surfaceId"] },
  { key: "window_settle_endpoint", sourceNames: ["window_settle_endpoint", "windowSettleEndpoint"] },
];
const ROUTE_STRING_FIELDS: RouteStringField[] = [
  { camelCase: "wsUrl", key: "wsUrl", snakeCase: "ws_url" },
  { camelCase: "pageUrl", key: "pageUrl", snakeCase: "page_url" },
  { camelCase: "pageTitle", key: "pageTitle", snakeCase: "page_title" },
  { camelCase: "startUrl", key: "startUrl", snakeCase: "start_url" },
  { camelCase: null, key: "reason", snakeCase: "reason" },
];

/** Encode a `(runId, interactionId)` pair into the internal Map key. */
function compositeKey(runId: string, interactionId: string): string {
  return `${runId}::${interactionId}`;
}

/**
 * Hash a registration nonce before storing it. Nonces are bearer secrets
 * — we never keep the raw value in memory after issuance, so a heap dump
 * or process introspection cannot reveal the credential a child still
 * holds. SHA-256 hex (64 chars) is sufficient: nonces are random 32-byte
 * tokens, so collisions are not a concern, and a fast hash is fine
 * because we are not defending against an offline brute force — the
 * raw nonce only exists in env memory of two short-lived processes.
 */
function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Constant-time compare of two equal-length hex strings. We hash the
 * presented token and compare against the stored hash so a timing
 * channel cannot leak information about the stored hash itself.
 */
function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  if (typeof aHex !== "string" || typeof bHex !== "string") {
    return false;
  }
  if (aHex.length !== bHex.length) {
    return false;
  }
  const a = Buffer.from(aHex, "utf8");
  const b = Buffer.from(bHex, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

class RunTargetError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "RunTargetError";
    this.code = code;
    this.status = status;
  }
}

function pdppErrorBody(code: string, message: string): JsonObject {
  // Replicates the envelope shape used by `pdppError` in `server/index.js`.
  // We do not import that helper because it lives in a 5887-line module and
  // also wires up resource-metadata / request-id behavior that the admin
  // routes do not need. Status-code → error-type is intentionally narrow:
  // the admin endpoint only ever returns 400, 401, 403, 404, 409, 500.
  let type = "invalid_request_error";
  if (code === "authentication_error") {
    type = "authentication_error";
  } else if (code === "permission_error") {
    type = "permission_error";
  }
  return { error: { code, message, type } };
}

function sendError(res: RegistryReply, status: number, code: string, message: string): RegistryReply {
  return res.status(status).json(pdppErrorBody(code, message));
}

function firstStringField(object: RecordFields, fieldNames: string[]): string | undefined {
  let value: string | undefined;
  for (const fieldName of fieldNames) {
    if (typeof object[fieldName] === "string") {
      value = object[fieldName];
      break;
    }
  }
  return value;
}

function firstNonNullField(object: RecordFields, fieldNames: string[]): unknown {
  let value: unknown;
  for (const fieldName of fieldNames) {
    if (object[fieldName] !== undefined && object[fieldName] !== null) {
      value = object[fieldName];
      break;
    }
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseUrlOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseRequiredUrl(value: unknown, fieldName: string, missingMessage: string): URL {
  if (!isNonEmptyString(value)) {
    throw new RunTargetError("run_target_invalid_url", missingMessage);
  }
  const parsed = parseUrlOrNull(value);
  if (!parsed) {
    throw new RunTargetError("run_target_invalid_url", `${fieldName} is not a valid URL`);
  }
  return parsed;
}

function defaultPort(parsed: URL): string {
  return parsed.port || (parsed.protocol === "https:" || parsed.protocol === "wss:" ? "443" : "80");
}

function normalizeTrailingSlash(href: string, trailingSlash: "add" | "remove"): string {
  if (trailingSlash === "remove") {
    return href.endsWith("/") ? href.slice(0, -1) : href;
  }
  return href.endsWith("/") ? href : `${href}/`;
}

/**
 * Validates a candidate wsUrl. Returns `{ host, port }` on success;
 * throws `RunTargetError('run_target_invalid_url' | 'run_target_non_loopback')`
 * on rejection. Never includes the full URL or path in thrown messages.
 */
function validateWsUrl(wsUrl: unknown): { host: string; port: string } {
  const parsed = parseRequiredUrl(wsUrl, "wsUrl", "wsUrl is required");
  if (!WS_PROTOCOLS.has(parsed.protocol)) {
    throw new RunTargetError("run_target_invalid_url", `wsUrl scheme must be ws: or wss:, got ${parsed.protocol}`);
  }
  // Strip IPv6 brackets when present so the comparison is consistent.
  const host = parsed.hostname;
  // Accept loopback OR the private Compose service host `neko`. The neko
  // host is reachable only on the private docker-compose network and is
  // fronted by cdp-proxy.py inside the neko container — it carries the
  // same trust boundary as loopback, just across a sibling-container
  // private network. This permits the remote-CDP connector flow (the
  // chatgpt connector via PDPP_CHATGPT_REMOTE_CDP_URL) to register page
  // handoffs that point at neko's Chromium. base_url already permits
  // this host for the same reason; the asymmetry was an oversight.
  if (!NEKO_PRIVATE_HOSTS.has(host)) {
    throw new RunTargetError("run_target_non_loopback", "wsUrl host must be 127.0.0.1, localhost, or neko");
  }
  return { host, port: defaultPort(parsed) };
}

function validateNekoHttpUrl(
  url: unknown,
  field: NekoHttpUrlField
): { baseUrl?: string; cdpHttpUrl?: string; host: string; port: string } {
  const parsed = parseRequiredUrl(url, field.inputName, field.missingMessage);
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new RunTargetError(
      "run_target_invalid_url",
      `${field.inputName} scheme must be http: or https:, got ${parsed.protocol}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new RunTargetError("run_target_invalid_url", `${field.inputName} must not include credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new RunTargetError("run_target_invalid_url", `${field.inputName} must not include query or fragment`);
  }
  return {
    [field.outputName]: normalizeTrailingSlash(parsed.href, field.trailingSlash),
    host: parsed.hostname,
    port: defaultPort(parsed),
  };
}

/**
 * Coerce an optional metadata field to a trimmed string or undefined.
 * The metadata fields (`pageUrl`, `pageTitle`, `reason`) are forward-
 * compatible diagnostic context — accepted, stored, and surfaced via
 * `getByRun()` for debug, but not consulted by the resolver.
 */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isJsonScalar(value: unknown): value is JsonPrimitive {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeJsonObject(value: RecordFields, fieldName: string): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeJsonMetadata(value[key], fieldName);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

function normalizeJsonArray(values: unknown[], fieldName: string): JsonValue[] {
  const normalizedItems: JsonValue[] = [];
  for (const item of values) {
    normalizedItems.push(normalizeJsonMetadata(item, fieldName) ?? null);
  }
  return normalizedItems;
}

function normalizeJsonMetadata(value: unknown, fieldName = "auth"): JsonValue | undefined {
  if (isJsonScalar(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    // JSON serialization preserves an undefined array slot as null. Keep
    // the registry's former JSON-clone behavior while rejecting values the
    // JSON boundary cannot faithfully represent.
    return normalizeJsonArray(value, fieldName);
  }
  const object = recordOrUndefined(value);
  if (object) {
    return normalizeJsonObject(object, fieldName);
  }
  if (value === undefined) {
    return;
  }
  throw new RunTargetError("run_target_invalid_auth", `${fieldName} must contain JSON-compatible values`);
}

function normalizeAuthMetadata(auth: unknown): JsonObject | undefined {
  if (auth === undefined || auth === null) {
    return;
  }
  const object = recordOrUndefined(auth);
  if (!object) {
    throw new RunTargetError("run_target_invalid_auth", "auth must be an object");
  }
  return normalizeJsonObject(object, "auth");
}

function cloneJson<T extends JsonValue>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function registrationAction(existing: RegistryRecord | undefined, target: NormalizedTarget): RegistryAction {
  if (!existing) {
    return "registered";
  }
  return existing.comparisonKey === target.comparisonKey ? "reaffirmed" : "replaced";
}

function targetRecordFields(target: NormalizedTarget): Pick<RegistryRecord, "baseUrl" | "wsUrl"> {
  if (target.backend === "cdp" && typeof target.resolverValue === "string") {
    return { wsUrl: target.resolverValue };
  }
  if (target.backend === "neko" && typeof target.descriptor.base_url === "string") {
    return { baseUrl: target.descriptor.base_url };
  }
  return {};
}

function buildRecord({
  runId,
  interactionId,
  target,
  deviceId,
  pageUrl,
  pageTitle,
  reason,
  registeredAt,
  ttlMs,
}: TargetRegistrationInput & {
  deviceId: string;
  interactionId: string;
  registeredAt: number;
  runId: string;
  target: NormalizedTarget;
  ttlMs: number;
}): RegistryRecord {
  const normalizedPageUrl = optionalString(pageUrl);
  const normalizedPageTitle = optionalString(pageTitle);
  const normalizedReason = optionalString(reason);
  return {
    backend: target.backend,
    interactionId,
    runId,
    ...targetRecordFields(target),
    comparisonKey: target.comparisonKey,
    descriptor: cloneJson(target.descriptor) ?? {},
    ...(normalizedPageUrl === undefined ? {} : { pageUrl: normalizedPageUrl }),
    ...(normalizedPageTitle === undefined ? {} : { pageTitle: normalizedPageTitle }),
    ...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
    deviceId,
    expiry: registeredAt + ttlMs,
    registeredAt: new Date(registeredAt).toISOString(),
  };
}

function recordOrUndefined(value: unknown): RecordFields | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordFields) : undefined;
}

function routeBody(req: RegistryRequest): RecordFields {
  return recordOrUndefined(req.body) ?? {};
}

function selectRouteDescriptor(body: RecordFields): RecordFields | undefined {
  const target = recordOrUndefined(body.target);
  if (target) {
    return target;
  }
  return recordOrUndefined(body.descriptor);
}

function selectRouteStringFields(
  body: RecordFields
): Pick<TargetRegistrationInput, "pageTitle" | "pageUrl" | "reason" | "startUrl" | "wsUrl"> {
  const fields: Pick<TargetRegistrationInput, "pageTitle" | "pageUrl" | "reason" | "startUrl" | "wsUrl"> = {};
  for (const field of ROUTE_STRING_FIELDS) {
    const snakeCaseValue = body[field.snakeCase];
    if (typeof snakeCaseValue === "string") {
      fields[field.key] = snakeCaseValue;
      continue;
    }
    if (field.camelCase !== null) {
      fields[field.key] = body[field.camelCase];
    }
  }
  return fields;
}

function registrationInputFromRoute(
  req: RegistryRequest,
  runId: string,
  interactionId: string,
  deviceId: string
): TargetRegistrationInput {
  const body = routeBody(req);
  const { wsUrl, pageUrl, pageTitle, startUrl, reason } = selectRouteStringFields(body);
  return {
    auth: body.auth,
    backend: body.backend,
    base_url: body.base_url,
    baseUrl: body.baseUrl,
    cdp_http_url: body.cdp_http_url,
    cdpHttpUrl: body.cdpHttpUrl,
    descriptor: selectRouteDescriptor(body),
    deviceId,
    interactionId,
    pageTitle,
    pageUrl,
    reason,
    runId,
    start_url: body.start_url,
    startUrl,
    ws_url: body.ws_url,
    wsUrl,
  };
}

function supportsRouteRegistration(app: unknown): app is RegistryRouteApp {
  return (
    typeof app === "object" &&
    app !== null &&
    "put" in app &&
    typeof app.put === "function" &&
    "post" in app &&
    typeof app.post === "function" &&
    "delete" in app &&
    typeof app.delete === "function"
  );
}

function normalizeOptionalDescriptorFields(
  descriptor: NekoDescriptor,
  source: RecordFields,
  input: TargetRegistrationInput
): void {
  for (const { key, sourceNames, inputNames = [] } of NEKO_OPTIONAL_DESCRIPTOR_FIELDS) {
    const value = firstNonNullField(source, sourceNames) ?? firstNonNullField(input, inputNames);
    const normalized = optionalString(value);
    if (normalized !== undefined) {
      descriptor[key] = normalized;
    }
  }
}

function assertNekoDescriptorApproved(
  descriptor: NekoDescriptor,
  { host, port, cdpHost, cdpPort, runId, interactionId }: NekoApprovalContext,
  isNekoDescriptorApproved: NekoDescriptorApproval | null
): void {
  if (NEKO_PRIVATE_HOSTS.has(host) && (cdpHost === null || NEKO_PRIVATE_HOSTS.has(cdpHost))) {
    return;
  }
  if (
    typeof isNekoDescriptorApproved === "function" &&
    isNekoDescriptorApproved(descriptor, { cdpHost, cdpPort, host, interactionId, port, runId }) === true
  ) {
    return;
  }
  throw new RunTargetError(
    "run_target_non_loopback",
    "base_url host must be 127.0.0.1, localhost, neko, or an approved managed n.eko surface"
  );
}

function normalizedTarget(
  backend: TargetBackend,
  descriptor: JsonObject,
  resolverValue: NekoDescriptor | string,
  host: string,
  port: string
): NormalizedTarget {
  return { backend, comparisonKey: JSON.stringify(descriptor), descriptor, host, port, resolverValue };
}

function normalizeCdpTarget(input: TargetRegistrationInput, source: RecordFields): NormalizedTarget {
  const wsUrl = firstStringField(source, ["ws_url", "wsUrl"]) ?? input.wsUrl;
  const { host, port } = validateWsUrl(wsUrl);
  if (!isNonEmptyString(wsUrl)) {
    throw new RunTargetError("run_target_invalid_url", "wsUrl is required");
  }
  return normalizedTarget("cdp", { backend: "cdp", ws_url: wsUrl }, wsUrl, host, port);
}

function hasCdpHttpUrl(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normalizedDescriptorInteractionId(source: RecordFields, input: TargetRegistrationInput): string | undefined {
  if (source === input) {
    return optionalString(source.interaction_id);
  }
  return optionalString(firstNonNullField(source, ["interaction_id", "interactionId"]));
}

function assertTargetRegistrationIdentity(
  input: TargetRegistrationInput
): asserts input is IdentifiedTargetRegistrationInput {
  if (!(isNonEmptyString(input.runId) && isNonEmptyString(input.interactionId))) {
    throw new RunTargetError("run_target_invalid_url", "runId and interactionId are required");
  }
}

function addNekoCdpHttpUrl(
  descriptor: NekoDescriptor,
  source: RecordFields,
  input: TargetRegistrationInput
): { cdpHost: string | null; cdpPort: string | null } {
  const rawUrl =
    firstNonNullField(source, ["cdp_http_url", "cdpHttpUrl"]) ??
    firstNonNullField(input, ["cdp_http_url", "cdpHttpUrl"]);
  if (!hasCdpHttpUrl(rawUrl)) {
    return { cdpHost: null, cdpPort: null };
  }
  const normalized = validateNekoHttpUrl(rawUrl, NEKO_HTTP_URL_FIELDS.cdp);
  if (!normalized.cdpHttpUrl) {
    throw new RunTargetError("run_target_invalid_url", "cdp_http_url must be a non-empty URL when provided");
  }
  descriptor.cdp_http_url = normalized.cdpHttpUrl;
  return { cdpHost: normalized.host, cdpPort: normalized.port };
}

function isManagedNekoSettleEndpoint(candidate: URL, expected: URL): boolean {
  return (
    HTTP_PROTOCOLS.has(candidate.protocol) &&
    !candidate.username &&
    !candidate.password &&
    !candidate.search &&
    !candidate.hash &&
    candidate.origin === expected.origin &&
    candidate.pathname === expected.pathname
  );
}

function assertManagedNekoSettleEndpoint(descriptor: NekoDescriptor): void {
  if (!(descriptor.surface_id && descriptor.window_settle_endpoint)) {
    return;
  }
  const authorityUrl = new URL(descriptor.cdp_http_url || descriptor.base_url);
  const expected = new URL("/pdpp/window-settle", authorityUrl);
  const candidate = parseUrlOrNull(descriptor.window_settle_endpoint);
  if (!candidate) {
    throw new RunTargetError(
      "run_target_invalid_window_settle_endpoint",
      "window_settle_endpoint must be a valid URL for the managed surface"
    );
  }
  if (!isManagedNekoSettleEndpoint(candidate, expected)) {
    throw new RunTargetError(
      "run_target_window_settle_origin_mismatch",
      "window_settle_endpoint must be the managed surface's own settle endpoint"
    );
  }
  descriptor.window_settle_endpoint = expected.href;
}

function normalizeNekoTarget(
  input: TargetRegistrationInput,
  source: RecordFields,
  isNekoDescriptorApproved: NekoDescriptorApproval | null
): NormalizedTarget {
  assertTargetRegistrationIdentity(input);
  const baseUrl = firstStringField(source, ["base_url", "baseUrl"]) ?? input.baseUrl;
  const { baseUrl: normalizedBaseUrl, host, port } = validateNekoHttpUrl(baseUrl, NEKO_HTTP_URL_FIELDS.base);
  if (!normalizedBaseUrl) {
    throw new RunTargetError("run_target_invalid_url", "base_url is required");
  }
  const descriptor: NekoDescriptor = { backend: "neko", base_url: normalizedBaseUrl };
  const { cdpHost, cdpPort } = addNekoCdpHttpUrl(descriptor, source, input);
  normalizeOptionalDescriptorFields(descriptor, source, input);
  assertManagedNekoSettleEndpoint(descriptor);
  const descriptorInteractionId = normalizedDescriptorInteractionId(source, input);
  if (descriptorInteractionId !== undefined) {
    descriptor.interaction_id = descriptorInteractionId;
  }
  const auth = normalizeAuthMetadata(firstNonNullField(source, ["auth"]) ?? input.auth);
  if (auth !== undefined) {
    descriptor.auth = auth;
  }
  assertNekoDescriptorApproved(
    descriptor,
    { cdpHost, cdpPort, host, interactionId: input.interactionId, port, runId: input.runId },
    isNekoDescriptorApproved
  );
  return normalizedTarget("neko", descriptor, descriptor, host, port);
}

function normalizeTargetDescriptor(
  input: TargetRegistrationInput,
  { isNekoDescriptorApproved }: Pick<RegistryState, "isNekoDescriptorApproved">
): NormalizedTarget {
  const source = recordOrUndefined(input.descriptor) ?? input;
  const backend = optionalString(source.backend) || "cdp";
  if (backend === "cdp") {
    return normalizeCdpTarget(input, source);
  }
  if (backend === "neko") {
    return normalizeNekoTarget(input, source, isNekoDescriptorApproved);
  }
  throw new RunTargetError("run_target_invalid_backend", "streaming target backend must be cdp or neko");
}

function logRegistry(state: RegistryState, level: RegistryLogLevel, msg: string, data?: JsonObject): void {
  if (!state.logger || typeof state.logger[level] !== "function") {
    return;
  }
  try {
    state.logger[level]?.({ msg, ...(data ?? {}) });
  } catch {
    /* logger errors must not break the registration path */
  }
}

function evictRegistryRecord(state: RegistryState, key: string, record: RegistryRecord): void {
  state.records.delete(key);
  logRegistry(state, "info", "run_target_evicted_expired", {
    interactionId: record.interactionId,
    runId: record.runId,
  });
}

function evictIfRegistryRecordExpired(
  state: RegistryState,
  key: string,
  record: RegistryRecord,
  time: number
): boolean {
  if (record.expiry > time) {
    return false;
  }
  evictRegistryRecord(state, key, record);
  return true;
}

function evictExpiredRegistryRecords(state: RegistryState): void {
  const time = state.now();
  for (const [key, record] of state.records) {
    evictIfRegistryRecordExpired(state, key, record, time);
  }
}

function logRegistryRegistration(
  state: RegistryState,
  action: RegistryAction,
  record: RegistryRecord,
  target: NormalizedTarget
): void {
  if (action === "reaffirmed") {
    return;
  }
  logRegistry(state, action === "replaced" ? "warn" : "info", `run_target_${action}`, {
    backend: target.backend,
    deviceId: record.deviceId,
    host: target.host,
    interactionId: record.interactionId,
    port: target.port,
    runId: record.runId,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  });
}

function registerRegistryTarget(state: RegistryState, input: TargetRegistrationInput): RegistrationResult {
  const { runId, interactionId, deviceId } = input;
  if (!isNonEmptyString(runId)) {
    throw new RunTargetError("run_target_invalid_url", "runId is required");
  }
  if (!isNonEmptyString(interactionId)) {
    throw new RunTargetError("run_target_invalid_url", "interactionId is required");
  }
  if (!isNonEmptyString(deviceId)) {
    throw new RunTargetError("run_target_invalid_url", "deviceId is required");
  }
  const target = normalizeTargetDescriptor(input, state);
  evictExpiredRegistryRecords(state);

  const key = compositeKey(runId, interactionId);
  const existing = state.records.get(key);
  if (existing && existing.deviceId !== deviceId) {
    throw new RunTargetError(
      "run_target_already_registered_other_device",
      "Another device has already registered a streaming target for this run interaction",
      409
    );
  }

  const registeredAt = state.now();
  const action = registrationAction(existing, target);
  const record = buildRecord({ ...input, deviceId, interactionId, registeredAt, runId, target, ttlMs: state.ttlMs });
  state.records.set(key, record);
  logRegistryRegistration(state, action, record, target);
  return { action, expiry: record.expiry, interactionId, runId };
}

function unregisterRegistryTarget(
  state: RegistryState,
  { runId, interactionId, deviceId }: RegisteredTargetKey
): boolean {
  if (!(isNonEmptyString(runId) && isNonEmptyString(interactionId))) {
    return false;
  }
  const key = compositeKey(runId, interactionId);
  const record = state.records.get(key);
  if (!record || record.deviceId !== deviceId) {
    return false;
  }
  state.records.delete(key);
  logRegistry(state, "info", "run_target_unregistered", { deviceId, interactionId, runId });
  return true;
}

function forceUnregisterRegistryTarget(state: RegistryState, { runId, interactionId }: RunInteractionKey): boolean {
  if (!(isNonEmptyString(runId) && isNonEmptyString(interactionId))) {
    return false;
  }
  const key = compositeKey(runId, interactionId);
  if (!state.records.has(key)) {
    return false;
  }
  state.records.delete(key);
  logRegistry(state, "info", "run_target_force_unregistered", { interactionId, runId });
  return true;
}

function activeRegistryRecord(state: RegistryState, key: string): RegistryRecord | null {
  const record = state.records.get(key);
  if (!record || evictIfRegistryRecordExpired(state, key, record, state.now())) {
    return null;
  }
  return record;
}

function getRegistryTarget(
  state: RegistryState,
  { runId, interactionId }: RunInteractionKey
): NekoDescriptor | string | null {
  if (!(isNonEmptyString(runId) && isNonEmptyString(interactionId))) {
    return null;
  }
  const record = activeRegistryRecord(state, compositeKey(runId, interactionId));
  if (!record) {
    return null;
  }
  return record.backend === "neko" ? (cloneJson(record.descriptor) as NekoDescriptor) : (record.wsUrl ?? null);
}

function getRegistryTargetsByRun(state: RegistryState, runId: unknown): RegistryRecord[] {
  if (!isNonEmptyString(runId)) {
    return [];
  }
  const time = state.now();
  const records: RegistryRecord[] = [];
  for (const [key, record] of state.records) {
    if (record.runId === runId && !evictIfRegistryRecordExpired(state, key, record, time)) {
      records.push(record);
    }
  }
  return records;
}

function registerRegistryNonce(state: RegistryState, { runId, nonce }: NonceKey): void {
  if (!isNonEmptyString(runId)) {
    throw new RunTargetError("run_target_invalid_url", "runId is required");
  }
  if (!isNonEmptyString(nonce)) {
    throw new RunTargetError("run_target_invalid_url", "nonce is required");
  }
  state.nonceHashes.set(runId, hashNonce(nonce));
}

function verifyRegistryNonce(state: RegistryState, { runId, presentedToken }: PresentedNonceKey): boolean {
  if (!(isNonEmptyString(runId) && isNonEmptyString(presentedToken))) {
    return false;
  }
  const stored = state.nonceHashes.get(runId);
  return stored ? constantTimeHexEqual(stored, hashNonce(presentedToken)) : false;
}

function clearRegistryNonce(state: RegistryState, { runId }: RunInteractionKey): void {
  if (isNonEmptyString(runId)) {
    state.nonceHashes.delete(runId);
    // A run nonce is the connector's authority to mutate these records. Once
    // the controller clears that authority at terminalization, no
    // interaction target from the run may remain controllable. The per-
    // interaction DELETE remains the normal completion path; this sweep is
    // the crash/timeout safety net.
    for (const [key, record] of state.records) {
      if (record.runId === runId) {
        state.records.delete(key);
      }
    }
  }
}

function extractBearerToken(req: RegistryRequest): string | null {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = BEARER_TOKEN_PATTERN.exec(header.trim());
  const token = match?.[1];
  return token ? token.trim() : null;
}

function routeParameters(req: RegistryRequest): { interactionId: string; runId: string } {
  const { interactionId, runId } = req.params;
  if (!(runId && interactionId)) {
    throw new RunTargetError("run_target_invalid_url", "run and interaction identifiers are required");
  }
  return {
    interactionId: decodeURIComponent(interactionId),
    runId: decodeURIComponent(runId),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

function sendUnexpectedRouteError(
  res: RegistryReply,
  err: unknown,
  log: RegistryRouteHandlers["log"],
  event: string,
  message: string
): RegistryReply {
  log("warn", event, { error: errorMessage(err) });
  return sendError(res, 500, "server_error", message);
}

function handleRegisterRoute(
  req: RegistryRequest,
  res: RegistryReply,
  { register, log }: Pick<RegistryRouteHandlers, "log" | "register">
): RegistryReply {
  try {
    const { runId, interactionId } = routeParameters(req);
    const deviceId = req.deviceExporter?.deviceId;
    if (!isNonEmptyString(deviceId)) {
      return sendError(
        res,
        403,
        "permission_error",
        "Device exporter authority is required to register a run streaming target"
      );
    }
    const { expiry, action } = register(registrationInputFromRoute(req, runId, interactionId, deviceId));
    return res.status(200).json({
      action,
      expiry,
      interaction_id: interactionId,
      object: "run_streaming_target",
      run_id: runId,
    });
  } catch (err) {
    if (err instanceof RunTargetError) {
      return sendError(res, err.status, err.code, err.message);
    }
    return sendUnexpectedRouteError(
      res,
      err,
      log,
      "run_target_register_failed",
      "Failed to register run streaming target"
    );
  }
}

function handleUnregisterRoute(
  req: RegistryRequest,
  res: RegistryReply,
  { unregister, log }: Pick<RegistryRouteHandlers, "log" | "unregister">
): RegistryReply {
  try {
    const { runId, interactionId } = routeParameters(req);
    const deviceId = req.deviceExporter?.deviceId;
    if (!isNonEmptyString(deviceId)) {
      return sendError(
        res,
        403,
        "permission_error",
        "Device exporter authority is required to unregister a run streaming target"
      );
    }
    if (!unregister({ deviceId, interactionId, runId })) {
      return sendError(
        res,
        404,
        "not_found",
        "No streaming target is registered for this run interaction by this device"
      );
    }
    return res.status(200).json({
      interaction_id: interactionId,
      object: "run_streaming_target_deleted",
      run_id: runId,
    });
  } catch (err) {
    return sendUnexpectedRouteError(
      res,
      err,
      log,
      "run_target_unregister_failed",
      "Failed to unregister run streaming target"
    );
  }
}

function requireRunTargetAuth(
  req: RegistryRequest,
  res: RegistryReply,
  next: Next,
  {
    verifyNonce,
    requireDeviceExporterAuth,
  }: { requireDeviceExporterAuth: DeviceExporterAuth; verifyNonce: RegistryRouteHandlers["verifyNonce"] }
): unknown {
  const presentedToken = extractBearerToken(req);
  const runId = req.params.runId ? decodeURIComponent(req.params.runId) : "";
  if (presentedToken && runId && verifyNonce({ presentedToken, runId })) {
    req.deviceExporter = { deviceId: `nonce:${runId}` };
    return next();
  }
  return requireDeviceExporterAuth(req, res, next);
}

function attachRegistryRoutes(app: unknown, requireDeviceExporterAuth: unknown, handlers: RegistryRouteHandlers): void {
  if (!supportsRouteRegistration(app)) {
    throw new Error("attachRoutes: app must support .put(), .post(), and .delete()");
  }
  if (typeof requireDeviceExporterAuth !== "function") {
    throw new Error("attachRoutes: requireDeviceExporterAuth middleware is required");
  }
  const deviceExporterAuth: DeviceExporterAuth = (req, res, next) => requireDeviceExporterAuth(req, res, next);
  const resourcePath = "/admin/runs/:runId/interactions/:interactionId/streaming-target";
  const requireAuth: RegistryRouteHandler = (req, res, next) =>
    requireRunTargetAuth(req, res, next, {
      requireDeviceExporterAuth: deviceExporterAuth,
      verifyNonce: handlers.verifyNonce,
    });
  const register: RegistryRouteHandler = (req, res) => handleRegisterRoute(req, res, handlers);
  const unregister: RegistryRouteHandler = (req, res) => handleUnregisterRoute(req, res, handlers);
  app.put(resourcePath, requireAuth, register);
  app.post(resourcePath, requireAuth, register);
  app.delete(resourcePath, requireAuth, unregister);
}

/**
 * Create a run-target registry.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.ttlMs=DEFAULT_TTL_MS]   Record TTL in ms.
 * @param {Function} [opts.now]                    Clock for tests.
 * @param {object}   [opts.logger]                 Pino-style logger.
 * @param {number}   [opts.sweepIntervalMs]        Periodic sweep interval.
 *                                                  Pass 0 to disable.
 * @param {Function} [opts.isNekoDescriptorApproved] Approval hook for managed
 *                                                  dynamic n.eko descriptors.
 */
export function createRunTargetRegistry({
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = null,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  isNekoDescriptorApproved = null,
}: CreateRunTargetRegistryOptions = {}): RunTargetRegistry {
  const state: RegistryState = {
    isNekoDescriptorApproved,
    logger,
    nonceHashes: new Map<string, string>(),
    now,
    records: new Map<string, RegistryRecord>(),
    ttlMs,
  };
  const register = (input: TargetRegistrationInput) => registerRegistryTarget(state, input);
  const unregister = (input: RegisteredTargetKey) => unregisterRegistryTarget(state, input);
  const forceUnregister = (input: RunInteractionKey) => forceUnregisterRegistryTarget(state, input);
  const get = (input: RunInteractionKey) => getRegistryTarget(state, input);
  const getByRun = (runId: unknown) => getRegistryTargetsByRun(state, runId);
  const registerNonce = (input: NonceKey) => registerRegistryNonce(state, input);
  const verifyNonce = (input: PresentedNonceKey) => verifyRegistryNonce(state, input);
  const clearNonce = (input: RunInteractionKey) => clearRegistryNonce(state, input);
  const evictExpired = () => evictExpiredRegistryRecords(state);
  const log = (level: RegistryLogLevel, msg: string, data?: JsonObject) => logRegistry(state, level, msg, data);
  const attachRoutes = (app: unknown, requireDeviceExporterAuth: unknown) =>
    attachRegistryRoutes(app, requireDeviceExporterAuth, { log, register, unregister, verifyNonce });

  let sweepTimer: NodeJS.Timeout | null = null;
  if (Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0) {
    sweepTimer = setInterval(evictExpired, sweepIntervalMs);
    if (typeof sweepTimer.unref === "function") {
      sweepTimer.unref();
    }
  }

  function shutdown(): void {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    state.records.clear();
    state.nonceHashes.clear();
  }

  return {
    _internal: {
      nonceHashes: state.nonceHashes,
      records: state.records,
      ttlMs,
    },
    attachRoutes,
    clearNonce,
    evictExpired,
    forceUnregister,
    get,
    getByRun,
    register,
    registerNonce,
    shutdown,
    unregister,
    verifyNonce,
  };
}

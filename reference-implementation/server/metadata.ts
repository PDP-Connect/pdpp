// Pure builders for the AS / RS metadata documents that the reference
// implementation publishes. These functions take in the runtime-derived
// fields (resolved URLs, capability flags, supported types, etc.) and
// produce the plain JSON shapes that PDPP discovery expects.
//
// They have no I/O, no Express coupling, and no global state — every
// dependency is injected. That keeps them trivially testable and lets
// the same builders drive both the live HTTP responses and the static
// fixtures used in conformance tests.

import { isIP } from "node:net";

// Lightweight Express-like accessors. We don't import express types
// directly here because the helper is also called from Fastify and
// from tests that fabricate a tiny shim — the structural duck type
// avoids dragging the express type tree into a metadata module.
export interface ResolvePublicUrlRequest {
  get(name: string): string | undefined;
  protocol: string;
}

// Hoisted to module scope: Biome's `useTopLevelRegex` rule (and the
// matching V8 perf characteristic) prefers the literal compiled once.
const TRAILING_SLASH_RE = /\/+$/;
const HEADER_LIST_SEPARATOR_RE = /\s*,\s*/;
const TRUSTED_HOST_SEPARATOR_RE = /[\s,]+/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BRACKETED_HOST_RE = /^\[(.*)\]$/;
const DECIMAL_PORT_RE = /^\d+$/;

export type MetadataTrustedHosts = string | readonly string[] | null | undefined;

interface TrustedMetadataRequestOriginOptions {
  forceHostDerived?: boolean;
}

interface HostAndPort {
  hostname: string;
  port: string | null;
}

interface TrustedHostPattern extends HostAndPort {
  wildcard: boolean;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH_RE, "");
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(HEADER_LIST_SEPARATOR_RE, 1)[0]?.trim() || undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(BRACKETED_HOST_RE, "$1");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.startsWith("127.")
  );
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (isLoopbackHost(normalized) || normalized.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split(".").map((part) => Number(part));
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }

  if (ipVersion === 6) {
    return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }

  return false;
}

export function isLocalOrPrivateRequestOrigin(req: ResolvePublicUrlRequest): boolean {
  const requestOrigin = parseUrl(resolveRequestPublicUrl(req));
  return !!requestOrigin?.hostname && isPrivateNetworkHost(requestOrigin.hostname);
}

function hostFromOrigin(value: string): string | null {
  return parseUrl(value)?.hostname ?? null;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function splitBareHostAndPort(value: string): HostAndPort | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("[")) {
    const closeBracket = normalized.indexOf("]");
    if (closeBracket === -1) {
      return null;
    }
    const hostname = normalizeHostname(normalized.slice(1, closeBracket));
    const suffix = normalized.slice(closeBracket + 1);
    if (!suffix) {
      return { hostname, port: null };
    }
    const port = suffix.startsWith(":") ? suffix.slice(1) : "";
    return hostname && DECIMAL_PORT_RE.test(port) ? { hostname, port } : null;
  }

  const lastColon = normalized.lastIndexOf(":");
  const hasSingleColon = lastColon !== -1 && normalized.indexOf(":") === lastColon;
  if (hasSingleColon) {
    const port = normalized.slice(lastColon + 1);
    if (DECIMAL_PORT_RE.test(port)) {
      return { hostname: normalizeHostname(normalized.slice(0, lastColon)), port };
    }
  }

  return { hostname: normalizeHostname(normalized), port: null };
}

function parseTrustedHostPattern(entry: string): TrustedHostPattern | null {
  const value = stripTrailingSlash(entry.trim());
  if (!value) {
    return null;
  }

  if (URL_SCHEME_RE.test(value)) {
    const parsed = parseUrl(value);
    return parsed?.hostname
      ? { hostname: normalizeHostname(parsed.hostname), port: parsed.port || null, wildcard: false }
      : null;
  }

  const wildcard = value.startsWith("*.");
  const bare = splitBareHostAndPort(wildcard ? value.slice(2) : value);
  if (!bare?.hostname || bare.hostname.includes("*")) {
    return null;
  }
  return { ...bare, wildcard };
}

function trustedHostEntries(trustedHosts: MetadataTrustedHosts): string[] {
  if (!trustedHosts) {
    return [];
  }
  const values = Array.isArray(trustedHosts) ? trustedHosts : [trustedHosts];
  return values
    .flatMap((value) => String(value).split(TRUSTED_HOST_SEPARATOR_RE))
    .map((value) => value.trim())
    .filter(Boolean);
}

function matchesTrustedHost(pattern: TrustedHostPattern, request: HostAndPort): boolean {
  if (pattern.port && pattern.port !== request.port) {
    return false;
  }
  if (pattern.wildcard) {
    return request.hostname.endsWith(`.${pattern.hostname}`) && request.hostname !== pattern.hostname;
  }
  return request.hostname === pattern.hostname;
}

function trustedHostsInclude(request: HostAndPort, trustedHosts: MetadataTrustedHosts): boolean {
  return trustedHostEntries(trustedHosts).some((entry) => {
    const pattern = parseTrustedHostPattern(entry);
    return pattern ? matchesTrustedHost(pattern, request) : false;
  });
}

function forwardedPublicOrigin(req: ResolvePublicUrlRequest): string | null {
  const forwardedHost = firstHeaderValue(req.get("x-forwarded-host"));
  if (!forwardedHost) {
    return null;
  }
  const forwardedProto = firstHeaderValue(req.get("x-forwarded-proto")) ?? req.protocol;
  return stripTrailingSlash(`${forwardedProto}://${forwardedHost}`);
}

export function resolveRequestPublicUrl(req: ResolvePublicUrlRequest): string {
  const host = firstHeaderValue(req.get("x-forwarded-host")) ?? req.get("host") ?? "";
  const protocol = firstHeaderValue(req.get("x-forwarded-proto")) ?? req.protocol;
  return stripTrailingSlash(`${protocol}://${host}`);
}

export function resolvePublicUrl(req: ResolvePublicUrlRequest, explicitUrl?: string | null): string {
  const forwardedOrigin = forwardedPublicOrigin(req);
  if (explicitUrl) {
    const parsedExplicit = parseUrl(explicitUrl);
    if (forwardedOrigin && parsedExplicit && isLoopbackHost(parsedExplicit.hostname)) {
      return forwardedOrigin;
    }
    const requestOrigin = resolveRequestPublicUrl(req);
    const requestHostname = hostFromOrigin(requestOrigin);
    if (
      parsedExplicit &&
      requestHostname &&
      isLoopbackHost(parsedExplicit.hostname) &&
      !isLoopbackHost(requestHostname)
    ) {
      return requestOrigin;
    }
    return stripTrailingSlash(explicitUrl);
  }
  return resolveRequestPublicUrl(req);
}

export function protectedResourceMetadataUrlForResource(resource: string): string {
  const parsed = new URL(resource);
  const resourcePath = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}/.well-known/oauth-protected-resource${resourcePath}${parsed.search}`;
}

export function shouldUseDirectRequestOrigin(req: ResolvePublicUrlRequest, explicitUrl?: string | null): boolean {
  if (!explicitUrl || forwardedPublicOrigin(req)) {
    return false;
  }
  const parsedExplicit = parseUrl(explicitUrl);
  const requestHostname = hostFromOrigin(resolveRequestPublicUrl(req));
  return !!(
    parsedExplicit &&
    requestHostname &&
    isLoopbackHost(parsedExplicit.hostname) &&
    !isLoopbackHost(requestHostname)
  );
}

function explicitUrlUsesRequestOrigin(req: ResolvePublicUrlRequest, explicitUrl?: string | null): boolean {
  if (!explicitUrl) {
    return true;
  }

  const parsedExplicit = parseUrl(explicitUrl);
  if (!parsedExplicit) {
    return false;
  }

  if (forwardedPublicOrigin(req) && isLoopbackHost(parsedExplicit.hostname)) {
    return true;
  }

  const requestHostname = hostFromOrigin(resolveRequestPublicUrl(req));
  return !!(requestHostname && isLoopbackHost(parsedExplicit.hostname) && !isLoopbackHost(requestHostname));
}

export function isTrustedMetadataRequestOrigin(
  req: ResolvePublicUrlRequest,
  explicitUrl?: string | null,
  trustedHosts?: MetadataTrustedHosts,
  options: TrustedMetadataRequestOriginOptions = {}
): boolean {
  if (!(options.forceHostDerived || explicitUrlUsesRequestOrigin(req, explicitUrl))) {
    return true;
  }

  const requestOrigin = parseUrl(resolveRequestPublicUrl(req));
  if (!requestOrigin?.hostname) {
    return false;
  }

  const request = { hostname: normalizeHostname(requestOrigin.hostname), port: requestOrigin.port || null };
  return isPrivateNetworkHost(request.hostname) || trustedHostsInclude(request, trustedHosts);
}

export function resolveSiblingPublicUrl(req: ResolvePublicUrlRequest, explicitUrl?: string | null): string | null {
  if (!explicitUrl) {
    return null;
  }
  const forwardedOrigin = forwardedPublicOrigin(req);
  const parsedExplicit = parseUrl(explicitUrl);
  if (!parsedExplicit) {
    return stripTrailingSlash(explicitUrl);
  }
  if (forwardedOrigin && isLoopbackHost(parsedExplicit.hostname)) {
    return forwardedOrigin;
  }

  const requestOrigin = resolveRequestPublicUrl(req);
  const parsedRequest = parseUrl(requestOrigin);
  if (parsedRequest && isLoopbackHost(parsedExplicit.hostname) && !isLoopbackHost(parsedRequest.hostname)) {
    parsedRequest.port = parsedExplicit.port;
    return stripTrailingSlash(parsedRequest.toString());
  }

  return stripTrailingSlash(explicitUrl);
}

// JSON-shape of the OAuth `protected_resource_metadata` document plus
// PDPP-specific extensions (pdpp_*). The fields are emitted only when
// supplied; capabilities are emitted only when non-empty. The structural
// types here are intentionally permissive: the reference-contract
// schemas are the authoritative source of truth for what's accepted on
// the wire — this builder just shapes the output the same way the
// schemas demand.
// Discovery-hint shape published as `pdpp_discovery_hints` inside the
// protected-resource metadata document. The block is generated from the
// same runtime state that drives capability advertisement so it cannot
// drift from live behavior. See:
//   openspec/changes/polish-reference-api-discovery-seams/specs/reference-implementation-architecture/spec.md
export interface ProtectedResourceDiscoveryHints {
  aggregate: {
    endpoint_template: string;
  };
  blob_indirection: "data.blob_ref.fetch_url";
  changes_since_bootstrap: "beginning";
  connectors_endpoint: string;
  hybrid_pagination_supported?: boolean;
  owner_polyfill_requires_source_kind_connector?: boolean;
  query_base: string;
  schema_endpoint: string;
  search?: {
    endpoint: string;
    filter_requires_single_stream: boolean;
    scope_param: "streams[]";
  };
  streams_endpoint_template: string;
}

export interface ProtectedResourceAgentDiscovery {
  advisory: true;
  cli?: {
    bin_name: string;
    connect_command: string;
    install_command: string;
    no_owner_token: boolean;
    no_owner_token_policy: string;
    package: string;
    package_specifier: string;
    run_command: string;
    version_policy: string;
  };
  llms_full_txt: string;
  llms_txt: string;
  mcp?: {
    endpoint: string;
    no_owner_token: true;
    transport: "streamable_http";
  };
  recommended_flow: "pdpp connect";
  skill: string;
  skill_catalog: string;
  skill_name: "pdpp-data-access";
}

// Advisory trusted-owner-agent onboarding block carried inside the
// protected-resource metadata document and the RS cold-start root pointer.
// Non-normative reference metadata: it names the owner-level REST automation
// profile and the surfaces a trusted local owner agent needs to onboard and
// keep an incremental local view. The host only emits it when owner-agent
// onboarding is safely configured (a resolved public/browser origin); it is
// never advertised from a direct ephemeral test server. Every URL is derived
// from the caller-visible trusted public origin, so a forwarded-origin caller
// either sees a block scoped to the trusted host or no block at all — never an
// untrusted host. See:
//   openspec/changes/add-trusted-owner-agent-onboarding/specs/reference-implementation-architecture/spec.md
export interface ProtectedResourceOwnerAgentOnboarding {
  advisory: true;
  authorization_server: string;
  // Pointer to the bearer-authed owner-agent control entrypoint and the
  // action families it currently supports vs. defers to owner mediation. A
  // trusted local agent reads this before guessing at control routes. See
  // openspec/changes/add-owner-agent-control-surface.
  control_surface: OwnerAgentControlSurface;
  device_authorization_endpoint: string;
  event_subscriptions_endpoint?: string;
  introspection_endpoint: string;
  mcp_owner_bearer_rejected: true;
  owner_approval_url: string;
  pdpp_token_kind: "owner";
  profile: "trusted_owner_agent";
  query_base: string;
  registration_endpoint?: string;
  resource: string;
  revocation_path_template: string;
  schema_endpoint: string;
  streams_endpoint: string;
  token_endpoint: string;
  warning: string;
}

// Owner-agent control surface catalog. This is the single source of truth for
// which owner-agent REST control actions the running reference implementation
// supports, where their routes live, and which action families remain
// owner-mediated or unsupported in this build. Both the advisory
// `pdpp_owner_agent_onboarding.control_surface` discovery hint and the
// bearer-authed `GET /v1/owner/control` capability document are projected from
// this builder so a trusted agent cannot read a supported claim from one
// surface and a different claim from the other.
//
// Honesty rule (full-context-refresh "Treat gaps as first-class outputs"):
// an action family is only ever listed `supported` when this build actually
// serves it over the owner-agent bearer surface. Everything else is named
// explicitly — never silently omitted — with `status` set to
// `owner_mediated` (the operation exists but requires a browser owner session
// or owner-mediated provider step today) or `unsupported` (no route in this
// build). See:
//   openspec/changes/add-owner-agent-control-surface/specs/
//     reference-owner-agent-control-surface/spec.md
//   openspec/changes/add-owner-agent-control-surface/specs/
//     reference-agent-access-workflow/spec.md
//     (#"Owner-agent onboarding metadata SHALL describe control-plane scope")

export type OwnerAgentControlActionStatus = "supported" | "owner_mediated" | "unsupported";

export interface OwnerAgentControlAction {
  // Stable action-family key an agent can branch on without parsing prose.
  family: string;
  // HTTP method + absolute URL when `status` is `supported`; null otherwise so
  // an agent does not probe a 404 for an action this build does not serve.
  method: string | null;
  // One-line, secret-free explanation. For non-supported families this names
  // where the action lives today (owner session / dashboard) or why it is
  // unsupported.
  reason: string;
  status: OwnerAgentControlActionStatus;
  url: string | null;
}

export interface OwnerAgentControlSurface {
  actions: readonly OwnerAgentControlAction[];
  // Absolute URL of the capability document route itself.
  entrypoint: string;
  mcp_owner_bearer_rejected: true;
  object: "owner_agent_control_surface";
  // Reference-only control vocabulary; not promoted to PDPP Core.
  scope: "reference_implementation";
}

export interface OwnerAgentControlSurfaceInput {
  // Already-trusted, forwarded-origin-safe RS public base (no trailing slash
  // required; this builder normalizes). Every URL is derived from it so the
  // catalog can never name an untrusted host.
  resource: string;
}

// Single source of truth for the owner-agent control action catalog. Each
// descriptor declares the family's stable status/method/reason and how its URL
// is derived from the trusted RS base. `scope` says whether the family is a
// surface-level action (`surface`, e.g. discovery and listing) or operates on a
// single configured connection (`instance`). Both the control capability
// document (`buildOwnerAgentControlSurface`) and the per-connection
// `supported_actions` projection (`buildOwnerConnectionSupportedActions`) are
// projected from this one table, so the two surfaces can never disagree about
// what this build supports for a connection.
//
// `urlTemplate` receives the trusted RS base and is only invoked for `supported`
// families; non-supported families always project `method: null, url: null` so
// an agent never probes a 404. For an instance-scoped supported family the
// template carries a literal `{connection_id}` placeholder in the surface
// catalog; the per-connection projection substitutes the concrete id.
interface OwnerAgentControlActionDescriptor {
  family: string;
  method: string | null;
  reason: string;
  // "surface" — a control-plane entrypoint not bound to one connection.
  // "instance" — operates on a single configured connection (`connection_id`).
  scope: "surface" | "instance";
  status: OwnerAgentControlActionStatus;
  urlTemplate: ((rs: string) => string) | null;
}

const OWNER_AGENT_CONTROL_ACTION_CATALOG: readonly OwnerAgentControlActionDescriptor[] = [
  {
    family: "discover_control_capabilities",
    scope: "surface",
    status: "supported",
    method: "GET",
    urlTemplate: (rs) => `${rs}/v1/owner/control`,
    reason: "Read this owner-agent control capability document.",
  },
  {
    family: "list_connector_templates",
    scope: "surface",
    status: "supported",
    method: "GET",
    urlTemplate: (rs) => `${rs}/v1/owner/connector-templates`,
    reason:
      "List available connector templates with connector_id, modality, connection-intent status, and related configured connection summaries.",
  },
  {
    family: "list_connections",
    scope: "surface",
    status: "supported",
    method: "GET",
    urlTemplate: (rs) => `${rs}/v1/owner/connections`,
    reason:
      "List configured connection instances with connection_id, connector identity, display_name, and label status.",
  },
  // Supported in this build: a trusted owner agent POSTs a typed connection
  // intent. The route returns a real owner-mediated next step
  // (`enroll_local_collector`) for proven local-collector connectors and a
  // typed `unsupported` with a named-gap reason for browser-bound,
  // API/network-only, and unknown connectors. It never marks a connection
  // active and never bypasses a provider step.
  {
    family: "initiate_connection",
    scope: "surface",
    status: "supported",
    method: "POST",
    urlTemplate: (rs) => `${rs}/v1/owner/connections/intents`,
    reason:
      "Initiate a new connection as a typed, auditable, owner-mediated intent. Body: { connector_id, display_name? }. Returns next_step.kind = enroll_local_collector for proven local-collector connectors, or unsupported (with a reason naming the missing primitive) for browser-bound and API/network-only connectors. No connection is marked active by the intent.",
  },
  {
    family: "rename_connection",
    scope: "instance",
    status: "supported",
    method: "PATCH",
    // Templated path: the surface catalog carries the literal `{connection_id}`
    // placeholder; the per-connection projection substitutes the concrete id.
    urlTemplate: (rs) => `${rs}/v1/owner/connections/{connection_id}`,
    reason:
      "Set a connection's owner-meaningful display_name by connection_id. Body: { display_name }. Use a connection_id from list_connections.",
  },
  {
    family: "run_connection",
    scope: "instance",
    status: "owner_mediated",
    method: null,
    urlTemplate: null,
    reason:
      "Run-now is available on the browser owner-session surface; it is not yet exposed to owner-agent bearers in this build.",
  },
  // Supported in this build: a trusted owner agent pauses, resumes, or deletes a
  // connection's schedule by connection_id. The representative URL is the pause
  // route; the resume sibling lives at the same path with `/resume` instead of
  // `/pause`, and DELETE on the parent `/schedule` path removes the schedule
  // config (named in the reason so an agent discovers all three without a second
  // probe). Connector-only addressing of these routes auto-selects a single
  // active connection or returns a typed `ambiguous_connection`. Schedule
  // create/replace remains on the browser owner-session surface.
  {
    family: "manage_schedule",
    scope: "instance",
    status: "supported",
    method: "POST",
    // Templated path: the surface catalog carries the literal `{connection_id}`
    // placeholder; the per-connection projection substitutes the concrete id.
    urlTemplate: (rs) => `${rs}/v1/owner/connections/{connection_id}/schedule/pause`,
    reason:
      "Pause, resume, or delete a connection's schedule by connection_id. POST this URL to pause; POST the sibling `/v1/owner/connections/{connection_id}/schedule/resume` to resume; DELETE `/v1/owner/connections/{connection_id}/schedule` to delete the schedule config (204 on delete, typed 404 when none existed). Use a connection_id from list_connections. Schedule create/replace remains owner-session only.",
  },
  {
    family: "inspect_diagnostics",
    scope: "instance",
    status: "unsupported",
    method: null,
    urlTemplate: null,
    reason:
      "Per-connection diagnostics is not implemented as an owner-agent control route in this build. Device-exporter diagnostics remain on the browser owner-session surface.",
  },
  {
    family: "delete_connection",
    scope: "instance",
    status: "unsupported",
    method: null,
    urlTemplate: null,
    reason: "Connection delete is not implemented as an owner-agent control route in this build.",
  },
  {
    family: "revoke_connection",
    scope: "instance",
    status: "unsupported",
    method: null,
    urlTemplate: null,
    reason:
      "Connection credential revoke is not implemented as an owner-agent control route in this build. Device-exporter revoke remains on the browser owner-session surface.",
  },
];

// Projects one catalog descriptor to a concrete `OwnerAgentControlAction`.
// `supported` families resolve their URL from the trusted RS base; every other
// family projects `method: null, url: null` regardless of any template so the
// catalog never advertises a route this build does not serve.
function projectControlAction(descriptor: OwnerAgentControlActionDescriptor, rs: string): OwnerAgentControlAction {
  const isSupported = descriptor.status === "supported";
  return {
    family: descriptor.family,
    status: descriptor.status,
    method: isSupported ? descriptor.method : null,
    url: isSupported && descriptor.urlTemplate ? descriptor.urlTemplate(rs) : null,
    reason: descriptor.reason,
  };
}

export function buildOwnerAgentControlSurface({ resource }: OwnerAgentControlSurfaceInput): OwnerAgentControlSurface {
  const rs = stripTrailingSlash(resource);
  const entrypoint = `${rs}/v1/owner/control`;
  const actions: OwnerAgentControlAction[] = OWNER_AGENT_CONTROL_ACTION_CATALOG.map((descriptor) =>
    projectControlAction(descriptor, rs)
  );
  return {
    object: "owner_agent_control_surface",
    entrypoint,
    scope: "reference_implementation",
    mcp_owner_bearer_rejected: true,
    actions,
  };
}

export interface OwnerConnectionSupportedActionsInput {
  // Concrete `connection_id` (== `connector_instance_id`) the actions target.
  connectionId: string;
  // Already-trusted, forwarded-origin-safe RS public base. Same trust contract
  // as `buildOwnerAgentControlSurface`.
  resource: string;
}

// Projects the instance-scoped subset of the control catalog for one configured
// connection. Surface-level families (discovery, list, initiate) are excluded
// because they are not bound to a single connection. For a `supported`
// instance-scoped family the literal `{connection_id}` placeholder is replaced
// with the concrete id so an agent gets a directly-callable URL; non-supported
// families keep `method: null, url: null`.
//
// This is the per-connection `supported_actions` array attached to every
// `owner_connection` row. It is projected from the SAME catalog the control
// document reads, so a connection can never advertise a supported action the
// control document calls unsupported (or vice versa).
export function buildOwnerConnectionSupportedActions({
  connectionId,
  resource,
}: OwnerConnectionSupportedActionsInput): OwnerAgentControlAction[] {
  const rs = stripTrailingSlash(resource);
  const encodedId = encodeURIComponent(connectionId);
  return OWNER_AGENT_CONTROL_ACTION_CATALOG.filter((descriptor) => descriptor.scope === "instance").map(
    (descriptor) => {
      const action = projectControlAction(descriptor, rs);
      // Resolve the `{connection_id}` placeholder to the concrete (URL-encoded)
      // id for supported instance actions so the agent can call it directly.
      if (action.url) {
        action.url = action.url.replace("{connection_id}", encodedId);
      }
      return action;
    }
  );
}

export interface ProtectedResourceMetadataInput {
  agentDiscovery?: ProtectedResourceAgentDiscovery | null;
  authorizationServers: readonly string[];
  capabilities?: Record<string, unknown> | null;
  discoveryHints?: ProtectedResourceDiscoveryHints | null;
  ownerAgentOnboarding?: ProtectedResourceOwnerAgentOnboarding | null;
  providerConnectVersion: string;
  queryBase: string;
  resource: string;
  resourceName: string;
  selfExportSupported: boolean;
  tokenKindsSupported: readonly string[];
}

export interface ProtectedResourceMetadata {
  authorization_servers: readonly string[];
  bearer_methods_supported: readonly string[];
  capabilities?: Record<string, unknown>;
  pdpp_agent_discovery?: ProtectedResourceAgentDiscovery;
  pdpp_core_query_base: string;
  pdpp_discovery_hints?: ProtectedResourceDiscoveryHints;
  pdpp_owner_agent_onboarding?: ProtectedResourceOwnerAgentOnboarding;
  pdpp_provider_connect_version: string;
  pdpp_self_export_supported: boolean;
  pdpp_token_kinds_supported: readonly string[];
  resource: string;
  resource_name: string;
}

export function buildProtectedResourceMetadata({
  resource,
  resourceName,
  authorizationServers,
  queryBase,
  providerConnectVersion,
  selfExportSupported,
  tokenKindsSupported,
  agentDiscovery,
  ownerAgentOnboarding,
  capabilities,
  discoveryHints,
}: ProtectedResourceMetadataInput): ProtectedResourceMetadata {
  const metadata: ProtectedResourceMetadata = {
    resource,
    resource_name: resourceName,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"],
    pdpp_provider_connect_version: providerConnectVersion,
    pdpp_self_export_supported: selfExportSupported,
    pdpp_token_kinds_supported: tokenKindsSupported,
    pdpp_core_query_base: queryBase,
  };
  if (discoveryHints) {
    metadata.pdpp_discovery_hints = discoveryHints;
  }
  if (agentDiscovery) {
    metadata.pdpp_agent_discovery = agentDiscovery;
  }
  if (ownerAgentOnboarding) {
    metadata.pdpp_owner_agent_onboarding = ownerAgentOnboarding;
  }
  if (capabilities && typeof capabilities === "object" && Object.keys(capabilities).length > 0) {
    metadata.capabilities = capabilities;
  }
  return metadata;
}

// Builds the lexical-retrieval extension advertisement carried inside
// the resource-server metadata document. See:
//   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
//
// When `supported` is false the function returns { supported: false }
// so callers can still publish an explicit non-support signal without
// rebuilding the shape. When `supported` is true all six required keys
// are emitted.
export interface LexicalRetrievalCapabilityInput {
  crossStream?: boolean;
  defaultLimit?: number;
  endpoint?: string;
  maxLimit?: number;
  score?: LexicalRetrievalScoreCapability | null;
  snippets?: boolean;
  supported?: boolean;
}

export interface LexicalRetrievalScoreCapability {
  kind: "bm25";
  order: "lower_is_better";
  supported: true;
  value_semantics: "implementation_relative";
}

export type LexicalRetrievalCapability =
  | { supported: false }
  | {
      supported: true;
      endpoint: string;
      cursor_supported: true;
      count_supported: false;
      cross_stream: boolean;
      snippets: boolean;
      default_limit: number;
      max_limit: number;
      score?: LexicalRetrievalScoreCapability;
    };

export function buildLexicalRetrievalCapability({
  supported = true,
  endpoint = "/v1/search",
  crossStream = true,
  snippets = true,
  defaultLimit = 25,
  maxLimit = 100,
  score = {
    supported: true,
    kind: "bm25",
    order: "lower_is_better",
    value_semantics: "implementation_relative",
  },
}: LexicalRetrievalCapabilityInput = {}): LexicalRetrievalCapability {
  if (!supported) {
    return { supported: false };
  }
  const capability: LexicalRetrievalCapability = {
    supported: true,
    endpoint,
    // Per canonicalize-public-read-contract task 4.3, pagination and count
    // support are advertised explicitly on every search capability:
    //   - lexical supports opaque-cursor pagination over a persisted
    //     snapshot (cursor_supported: true);
    //   - lexical does NOT compute counts today (count_supported: false).
    // Strict request validation already rejects `count=...` on /v1/search;
    // the negative advertisement makes that decision discoverable to
    // clients and MCP/CLI consumers without trial-and-error.
    cursor_supported: true,
    count_supported: false,
    cross_stream: crossStream,
    snippets,
    default_limit: defaultLimit,
    max_limit: maxLimit,
  };
  if (score) {
    capability.score = score;
  }
  return capability;
}

// Builds the semantic-retrieval extension advertisement carried inside the
// resource-server metadata document. Truthfulness rules are enforced by the
// route handler too: callers should omit the capability entirely unless a
// real backend and persistent index are actually available.
export interface SemanticRetrievalCapabilityInput {
  crossStream?: boolean;
  defaultLimit?: number;
  dimensions?: number | null;
  distanceMetric?: string | null;
  dtype?: string | null;
  endpoint?: string;
  indexState?: "built" | "building" | "stale" | null;
  languageBias?: { primary: string; note?: string } | null;
  maxLimit?: number;
  model?: string | null;
  profileId?: string | null;
  score?: SemanticRetrievalScoreCapability | null;
  snippets?: boolean;
}

export interface SemanticRetrievalScoreCapability {
  comparable_with: {
    backend_identity: string;
    dimensions: number;
    distance_metric: string;
    dtype?: string;
    model: string;
    profile_id?: string;
  };
  kind: "semantic_distance";
  order: "lower_is_better";
  supported: true;
  value_semantics: "distance";
}

export interface SemanticRetrievalCapability {
  count_supported: false;
  cross_stream: boolean;
  // Pagination/count metadata per canonicalize-public-read-contract task 4.3.
  // Semantic search uses opaque-cursor pagination over a persisted snapshot
  // (cursor_supported: true). The runtime does NOT compute counts on
  // semantic responses; clients should not request `count=`.
  cursor_supported: true;
  default_limit: number;
  dimensions: number;
  distance_metric: string;
  endpoint: string;
  index_state: "built" | "building" | "stale";
  language_bias?: { primary: string; note?: string };
  lexical_blending: false;
  max_limit: number;
  model: string;
  query_input: "text";
  score?: SemanticRetrievalScoreCapability;
  snippets: boolean;
  stability: "experimental";
  supported: true;
}

export function buildSemanticRetrievalCapability({
  endpoint = "/v1/search/semantic",
  crossStream = true,
  snippets = true,
  defaultLimit = 25,
  maxLimit = 100,
  model = null,
  dimensions = null,
  distanceMetric = null,
  indexState = null,
  languageBias = null,
  profileId = null,
  dtype = null,
  score,
}: SemanticRetrievalCapabilityInput = {}): SemanticRetrievalCapability | null {
  if (!(model && dimensions && distanceMetric && indexState)) {
    return null;
  }

  const comparableWith = {
    backend_identity: [
      profileId ? `profile=${profileId}` : null,
      `model=${model}`,
      dtype ? `dtype=${dtype}` : null,
      `dimensions=${dimensions}`,
      `metric=${distanceMetric}`,
    ]
      .filter(Boolean)
      .join(";"),
    model,
    dimensions,
    distance_metric: distanceMetric,
    ...(profileId ? { profile_id: profileId } : {}),
    ...(dtype ? { dtype } : {}),
  };

  const capability: SemanticRetrievalCapability = {
    supported: true,
    stability: "experimental",
    endpoint,
    cursor_supported: true,
    count_supported: false,
    cross_stream: crossStream,
    query_input: "text",
    snippets,
    lexical_blending: false,
    model,
    dimensions,
    distance_metric: distanceMetric,
    default_limit: defaultLimit,
    max_limit: maxLimit,
    index_state: indexState,
  };

  if (score !== null) {
    capability.score = score ?? {
      supported: true,
      kind: "semantic_distance",
      order: "lower_is_better",
      value_semantics: "distance",
      comparable_with: comparableWith,
    };
  }

  if (languageBias) {
    capability.language_bias = languageBias;
  }

  return capability;
}

// Builds the hybrid-retrieval extension advertisement carried inside the
// resource-server metadata document. See:
//   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
//
// Truthfulness rule: callers must only publish this capability when BOTH
// lexical and semantic retrieval are actually reachable on this server, so
// composition under the same grant is honest. This builder returns null
// when the caller cannot assert that — callers should then omit the key.
export interface HybridRetrievalCapabilityInput {
  crossStream?: boolean;
  cursorSupported?: boolean;
  defaultLimit?: number;
  endpoint?: string;
  lexicalAvailable?: boolean;
  maxLimit?: number;
  semanticAvailable?: boolean;
  supported?: boolean;
}

export interface HybridRetrievalCapability {
  // canonicalize-public-read-contract task 4.3: hybrid composes lexical +
  // semantic snapshots and does NOT compute counts (count_supported: false).
  count_supported: false;
  cross_stream: boolean;
  cursor_supported: boolean;
  default_limit: number;
  endpoint: string;
  max_limit: number;
  sources: readonly ["lexical", "semantic"];
  stability: "experimental";
  supported: true;
}

export function buildHybridRetrievalCapability({
  supported = true,
  endpoint = "/v1/search/hybrid",
  crossStream = true,
  defaultLimit = 25,
  maxLimit = 100,
  cursorSupported = false,
  lexicalAvailable = true,
  semanticAvailable = true,
}: HybridRetrievalCapabilityInput = {}): HybridRetrievalCapability | { supported: false } | null {
  if (!supported) {
    return { supported: false };
  }
  // Hybrid retrieval only makes sense when BOTH underlying surfaces are
  // advertised. Callers must gate on that; we defend here too.
  if (!(lexicalAvailable && semanticAvailable)) {
    return null;
  }
  return {
    supported: true,
    stability: "experimental",
    endpoint,
    cross_stream: crossStream,
    default_limit: defaultLimit,
    max_limit: maxLimit,
    cursor_supported: cursorSupported,
    count_supported: false,
    sources: ["lexical", "semantic"] as const,
  };
}

// Builds the `client_event_subscriptions` capability advertisement
// carried inside the resource-server metadata document. This is a
// reference-implementation extension, NOT a Core PDPP capability —
// other PDPP implementations are free to expose a different surface
// until a Core change promotes one. The advertisement documents the
// route, signing scheme, delivery semantics, supported event types,
// and any client-visible limits so callers do not need out-of-band
// docs to use the feature.
//
// Spec:
//   openspec/changes/add-client-event-subscriptions/specs/
//   reference-implementation-architecture/spec.md
export interface ClientEventSubscriptionsCapabilityInput {
  endpoint?: string;
  supported?: boolean;
}

export interface ClientEventSubscriptionsCapability {
  authority_kinds_supported: readonly ["client_grant", "trusted_owner_agent"];
  // Reject non-HTTPS callbacks except for development loopback.
  callback_url: {
    https_required: true;
    localhost_exception: true;
  };
  delivery: {
    at_least_once: true;
    after_commit: true;
    coalescing: false;
    retry_schedule_seconds: readonly [30, 120, 600, 3600, 21600, 86400];
    max_attempts: 6;
    dead_letter_state: "disabled_failure";
    response_window_seconds: 10;
  };
  endpoint: string;
  // CloudEvents 1.0 structured-mode JSON body. PDPP profile version is
  // carried in the `pdppversion` CloudEvents extension attribute so the
  // envelope stays interoperable with the CloudEvents 1.x ecosystem.
  //
  // CloudEvents context-attribute names must be lowercase alphanumeric
  // (CloudEvents §extension-context-attributes), so PDPP fields that would
  // contain an underscore live inside `data` rather than at the top level.
  // `subscription_id` is the canonical example: it travels as
  // `data.subscription_id` and is also recoverable from the standard `source`
  // URL. `occurredAt` is emitted as the standard `time` attribute.
  envelope: {
    format: "cloudevents+json";
    content_type: "application/cloudevents+json; charset=utf-8";
    specversion: "1.0";
    pdppversion: "1";
    fields: readonly ["specversion", "pdppversion", "id", "type", "source", "time", "data"];
    subscription_id_location: "data.subscription_id";
    no_record_bodies: true;
  };
  event_types: readonly [
    "pdpp.subscription.verify",
    "pdpp.subscription.test",
    "pdpp.records.changed",
    "pdpp.grant.revoked",
  ];
  hint_cursor: {
    cursor_field: "data.changes_since";
    read_endpoint_template: "/v1/streams/{stream}/records?changes_since={cursor}";
  };
  limits: {
    callback_url_max_bytes: 2048;
    response_snippet_capture_bytes: 512;
  };
  // Subscriptions are reference-only. Cross-implementation
  // standardization is future work.
  scope: "reference_implementation";
  // Standard Webhooks (https://www.standardwebhooks.com) compatible
  // signing. Off-the-shelf Standard Webhooks libraries can verify
  // deliveries against the secret returned at subscription create.
  signing: {
    profile: "standard-webhooks";
    algorithm: "HMAC-SHA256";
    id_header: "webhook-id";
    timestamp_header: "webhook-timestamp";
    signature_header: "webhook-signature";
    signed_payload: "{webhook-id}.{webhook-timestamp}.{body}";
    signature_encoding: "v1,<base64>";
    secret_prefix: "whsec_";
    secret_payload_encoding: "base64";
  };
  stability: "reference_extension";
  supported: true;
  transport: "https_webhook";
  verification: {
    handshake: "post_with_challenge_echo";
    challenge_event_type: "pdpp.subscription.verify";
  };
}

export function buildClientEventSubscriptionsCapability({
  supported = true,
  endpoint = "/v1/event-subscriptions",
}: ClientEventSubscriptionsCapabilityInput = {}): ClientEventSubscriptionsCapability | { supported: false } {
  if (!supported) {
    return { supported: false };
  }
  return {
    supported: true,
    stability: "reference_extension",
    endpoint,
    authority_kinds_supported: ["client_grant", "trusted_owner_agent"] as const,
    scope: "reference_implementation",
    transport: "https_webhook",
    envelope: {
      format: "cloudevents+json",
      content_type: "application/cloudevents+json; charset=utf-8",
      specversion: "1.0",
      pdppversion: "1",
      fields: ["specversion", "pdppversion", "id", "type", "source", "time", "data"] as const,
      subscription_id_location: "data.subscription_id",
      no_record_bodies: true,
    },
    event_types: [
      "pdpp.subscription.verify",
      "pdpp.subscription.test",
      "pdpp.records.changed",
      "pdpp.grant.revoked",
    ] as const,
    signing: {
      profile: "standard-webhooks",
      algorithm: "HMAC-SHA256",
      id_header: "webhook-id",
      timestamp_header: "webhook-timestamp",
      signature_header: "webhook-signature",
      signed_payload: "{webhook-id}.{webhook-timestamp}.{body}",
      signature_encoding: "v1,<base64>",
      secret_prefix: "whsec_",
      secret_payload_encoding: "base64",
    },
    delivery: {
      at_least_once: true,
      after_commit: true,
      coalescing: false,
      retry_schedule_seconds: [30, 120, 600, 3600, 21_600, 86_400] as const,
      max_attempts: 6,
      dead_letter_state: "disabled_failure",
      response_window_seconds: 10,
    },
    verification: {
      handshake: "post_with_challenge_echo",
      challenge_event_type: "pdpp.subscription.verify",
    },
    hint_cursor: {
      cursor_field: "data.changes_since",
      read_endpoint_template: "/v1/streams/{stream}/records?changes_since={cursor}",
    },
    callback_url: {
      https_required: true,
      localhost_exception: true,
    },
    limits: {
      callback_url_max_bytes: 2048,
      response_snippet_capture_bytes: 512,
    },
  };
}

// Authorization-server metadata is the OAuth 2.0 / PDPP discovery
// document. Optional fields are emitted only when supplied (or
// non-empty for arrays); this matches the schema's
// `additionalProperties: false` expectations and keeps the published
// document free of `null` / `undefined` keys.
export interface AuthorizationServerMetadataInput {
  agentConnectEndpoint?: string | null;
  authorizationDetailsTypesSupported?: readonly string[] | null;
  authorizationEndpoint?: string | null;
  codeChallengeMethodsSupported?: readonly string[] | null;
  deviceAuthorizationEndpoint?: string | null;
  grantTypesSupported?: readonly string[] | null;
  introspectionEndpoint: string;
  issuer: string;
  preRegisteredPublicClients?: readonly AuthorizationServerPublicClient[] | null;
  providerConnectCapabilities: Record<string, unknown>;
  pushedAuthorizationRequestEndpoint?: string | null;
  registrationEndpoint?: string | null;
  registrationModesSupported?: readonly string[] | null;
  responseTypesSupported?: readonly string[] | null;
  tokenEndpoint?: string | null;
  tokenEndpointAuthMethodsSupported?: readonly string[] | null;
}

export interface AuthorizationServerPublicClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly token_endpoint_auth_method: string;
}

export interface AuthorizationServerMetadata {
  agent_connect_endpoint?: string;
  authorization_endpoint?: string;
  code_challenge_methods_supported?: readonly string[];
  device_authorization_endpoint?: string;
  grant_types_supported?: readonly string[];
  introspection_endpoint: string;
  issuer: string;
  pdpp_authorization_details_types_supported?: readonly string[];
  pdpp_pre_registered_public_clients?: readonly AuthorizationServerPublicClient[];
  pdpp_provider_connect_capabilities: Record<string, unknown>;
  pdpp_registration_modes_supported?: readonly string[];
  pushed_authorization_request_endpoint?: string;
  registration_endpoint?: string;
  response_types_supported?: readonly string[];
  token_endpoint?: string;
  token_endpoint_auth_methods_supported?: readonly string[];
}

export function buildAuthorizationServerMetadata({
  issuer,
  introspectionEndpoint,
  pushedAuthorizationRequestEndpoint,
  registrationEndpoint,
  providerConnectCapabilities,
  preRegisteredPublicClients,
  registrationModesSupported,
  authorizationDetailsTypesSupported,
  authorizationEndpoint,
  codeChallengeMethodsSupported,
  tokenEndpoint,
  tokenEndpointAuthMethodsSupported,
  deviceAuthorizationEndpoint,
  agentConnectEndpoint,
  grantTypesSupported,
  responseTypesSupported,
}: AuthorizationServerMetadataInput): AuthorizationServerMetadata {
  const metadata: AuthorizationServerMetadata = {
    issuer,
    introspection_endpoint: introspectionEndpoint,
    pdpp_provider_connect_capabilities: providerConnectCapabilities,
  };

  if (pushedAuthorizationRequestEndpoint) {
    metadata.pushed_authorization_request_endpoint = pushedAuthorizationRequestEndpoint;
  }

  if (registrationEndpoint) {
    metadata.registration_endpoint = registrationEndpoint;
  }

  if (registrationModesSupported?.length) {
    metadata.pdpp_registration_modes_supported = registrationModesSupported;
  }

  if (preRegisteredPublicClients?.length) {
    metadata.pdpp_pre_registered_public_clients = preRegisteredPublicClients;
  }

  if (authorizationDetailsTypesSupported?.length) {
    metadata.pdpp_authorization_details_types_supported = authorizationDetailsTypesSupported;
  }

  if (authorizationEndpoint) {
    metadata.authorization_endpoint = authorizationEndpoint;
  }
  if (responseTypesSupported?.length) {
    metadata.response_types_supported = responseTypesSupported;
  }
  if (codeChallengeMethodsSupported?.length) {
    metadata.code_challenge_methods_supported = codeChallengeMethodsSupported;
  }
  if (tokenEndpoint) {
    metadata.token_endpoint = tokenEndpoint;
  }
  if (tokenEndpointAuthMethodsSupported?.length) {
    metadata.token_endpoint_auth_methods_supported = tokenEndpointAuthMethodsSupported;
  }
  if (deviceAuthorizationEndpoint) {
    metadata.device_authorization_endpoint = deviceAuthorizationEndpoint;
  }
  if (agentConnectEndpoint) {
    metadata.agent_connect_endpoint = agentConnectEndpoint;
  }
  if (grantTypesSupported?.length) {
    metadata.grant_types_supported = grantTypesSupported;
  }

  return metadata;
}

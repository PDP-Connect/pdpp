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
  recommended_flow: "pdpp connect";
  skill: string;
  skill_catalog: string;
  skill_name: "pdpp-data-access";
}

export interface ProtectedResourceMetadataInput {
  agentDiscovery?: ProtectedResourceAgentDiscovery | null;
  authorizationServers: readonly string[];
  capabilities?: Record<string, unknown> | null;
  discoveryHints?: ProtectedResourceDiscoveryHints | null;
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
  cross_stream: boolean;
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
    sources: ["lexical", "semantic"] as const,
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
  deviceAuthorizationEndpoint?: string | null;
  grantTypesSupported?: readonly string[] | null;
  introspectionEndpoint: string;
  issuer: string;
  providerConnectCapabilities: Record<string, unknown>;
  pushedAuthorizationRequestEndpoint?: string | null;
  registrationEndpoint?: string | null;
  registrationModesSupported?: readonly string[] | null;
  tokenEndpoint?: string | null;
  tokenEndpointAuthMethodsSupported?: readonly string[] | null;
}

export interface AuthorizationServerMetadata {
  agent_connect_endpoint?: string;
  device_authorization_endpoint?: string;
  grant_types_supported?: readonly string[];
  introspection_endpoint: string;
  issuer: string;
  pdpp_authorization_details_types_supported?: readonly string[];
  pdpp_provider_connect_capabilities: Record<string, unknown>;
  pdpp_registration_modes_supported?: readonly string[];
  pushed_authorization_request_endpoint?: string;
  registration_endpoint?: string;
  token_endpoint?: string;
  token_endpoint_auth_methods_supported?: readonly string[];
}

export function buildAuthorizationServerMetadata({
  issuer,
  introspectionEndpoint,
  pushedAuthorizationRequestEndpoint,
  registrationEndpoint,
  providerConnectCapabilities,
  registrationModesSupported,
  authorizationDetailsTypesSupported,
  tokenEndpoint,
  tokenEndpointAuthMethodsSupported,
  deviceAuthorizationEndpoint,
  agentConnectEndpoint,
  grantTypesSupported,
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

  if (authorizationDetailsTypesSupported?.length) {
    metadata.pdpp_authorization_details_types_supported = authorizationDetailsTypesSupported;
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

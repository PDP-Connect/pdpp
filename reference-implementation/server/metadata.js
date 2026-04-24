export function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

export function resolvePublicUrl(req, explicitUrl) {
  if (explicitUrl) {
    return stripTrailingSlash(explicitUrl);
  }
  return stripTrailingSlash(`${req.protocol}://${req.get('host')}`);
}

export function buildProtectedResourceMetadata({
  resource,
  resourceName,
  authorizationServers,
  queryBase,
  providerConnectVersion,
  selfExportSupported,
  tokenKindsSupported,
  capabilities,
}) {
  const metadata = {
    resource,
    resource_name: resourceName,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
    pdpp_provider_connect_version: providerConnectVersion,
    pdpp_self_export_supported: selfExportSupported,
    pdpp_token_kinds_supported: tokenKindsSupported,
    pdpp_core_query_base: queryBase,
  };
  if (capabilities && typeof capabilities === 'object' && Object.keys(capabilities).length > 0) {
    metadata.capabilities = capabilities;
  }
  return metadata;
}

// Builds the lexical-retrieval extension advertisement carried inside the
// resource-server metadata document. See:
//   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
//
// When `supported` is false the function returns { supported: false } so
// callers can still publish an explicit non-support signal without rebuilding
// the shape. When `supported` is true all six required keys are emitted.
export function buildLexicalRetrievalCapability({
  supported = true,
  endpoint = '/v1/search',
  crossStream = true,
  snippets = true,
  defaultLimit = 25,
  maxLimit = 100,
} = {}) {
  if (!supported) {
    return { supported: false };
  }
  return {
    supported: true,
    endpoint,
    cross_stream: crossStream,
    snippets,
    default_limit: defaultLimit,
    max_limit: maxLimit,
  };
}

/**
 * Build the capabilities.semantic_retrieval advertisement for the RS metadata
 * document. Truthfulness rules (enforced by the route's caller, not just by
 * this helper):
 *
 *   - Return null (⇒ advertisement omitted) unless a real embedding backend
 *     AND a real vector index are configured. An "empty" advertisement would
 *     be a lie.
 *   - `stability` is hardcoded to `"experimental"`. There is no operator flag
 *     that can publish `"stable"` in v1.
 *   - `query_input` is hardcoded to `"text"`. No raw vectors, no client
 *     embeddings on the public surface.
 *   - `lexical_blending` is hardcoded to `false`. Every result emits
 *     retrieval_mode: "semantic" in v1.
 *   - `model`, `dimensions`, `distance_metric` come from the live backend,
 *     not from configuration defaults.
 *   - `index_state` is read from a live state probe at request time; it
 *     reports "stale" honestly when the backend identity diverges from the
 *     persisted semantic_search_meta fingerprints.
 *
 * Spec: openspec/changes/add-semantic-retrieval-experimental-extension/
 *       specs/semantic-retrieval/spec.md
 */
export function buildSemanticRetrievalCapability({
  endpoint = '/v1/search/semantic',
  crossStream = true,
  snippets = true,
  defaultLimit = 25,
  maxLimit = 100,
  model,
  dimensions,
  distanceMetric,
  indexState,
  languageBias = null,
} = {}) {
  // Load-bearing truthfulness check: if any backend-sourced fact is missing,
  // refuse to publish the advertisement. Callers should treat a null return
  // as "omit the capability block entirely".
  if (!model || !dimensions || !distanceMetric || !indexState) {
    return null;
  }
  const advertisement = {
    supported: true,
    stability: 'experimental',
    endpoint,
    cross_stream: crossStream,
    query_input: 'text',
    snippets,
    lexical_blending: false,
    model,
    dimensions,
    distance_metric: distanceMetric,
    default_limit: defaultLimit,
    max_limit: maxLimit,
    index_state: indexState,
  };
  if (languageBias) {
    advertisement.language_bias = languageBias;
  }
  return advertisement;
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
  grantTypesSupported,
}) {
  const metadata = {
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
  if (grantTypesSupported?.length) {
    metadata.grant_types_supported = grantTypesSupported;
  }

  return metadata;
}

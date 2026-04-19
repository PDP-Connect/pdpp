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
}) {
  return {
    resource,
    resource_name: resourceName,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
    pdpp_provider_connect_version: providerConnectVersion,
    pdpp_self_export_supported: selfExportSupported,
    pdpp_token_kinds_supported: tokenKindsSupported,
    pdpp_core_query_base: queryBase,
  };
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

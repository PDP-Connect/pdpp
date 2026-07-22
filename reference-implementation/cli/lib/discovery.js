// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolveRsUrl } from './common.js';
import { PdppCliError } from './errors.js';
import { fetchJson } from './fetch.js';

export async function discoverProvider(flags) {
  const rsUrl = normalizeUrl(resolveRsUrl(flags));
  const expectedAsUrl = flags['as-url'] ? normalizeUrl(flags['as-url']) : null;
  const { body: resourceMetadata } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
  const advertisedAuthorizationServers = (resourceMetadata.authorization_servers || []).map(normalizeUrl);

  if (resourceMetadata.resource && normalizeUrl(resourceMetadata.resource) !== rsUrl) {
    throw new PdppCliError(`Protected-resource metadata resource mismatch: expected ${rsUrl}, got ${resourceMetadata.resource}`);
  }

  const authorizationServer = expectedAsUrl || advertisedAuthorizationServers[0];
  if (!authorizationServer) {
    throw new PdppCliError('Protected-resource metadata did not advertise an authorization server');
  }

  const { body: authorizationServerMetadata } = await fetchJson(`${authorizationServer}/.well-known/oauth-authorization-server`);
  if (authorizationServerMetadata.issuer && normalizeUrl(authorizationServerMetadata.issuer) !== authorizationServer) {
    throw new PdppCliError(
      `Authorization-server metadata issuer mismatch: expected ${authorizationServer}, got ${authorizationServerMetadata.issuer}`
    );
  }

  return {
    rsUrl,
    authorizationServer,
    advertisedAuthorizationServers,
    authorizationServerAdvertised: advertisedAuthorizationServers.includes(authorizationServer),
    resourceMetadata,
    authorizationServerMetadata,
  };
}

function normalizeUrl(value) {
  return String(value).replace(/\/+$/, '');
}

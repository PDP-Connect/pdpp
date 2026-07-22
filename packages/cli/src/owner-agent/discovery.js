// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Discovery for the trusted owner-agent onboarding profile.
//
// A trusted local owner agent (e.g. Daisy) starts from an entrypoint URL and
// must learn, without route guessing, where to:
//   - initiate browser-mediated owner approval (device authorization),
//   - poll for the issued owner-agent credential (token endpoint),
//   - introspect the credential, and
//   - revoke it (RFC 7592 client delete).
//
// Two discovery sources are honored, in priority order:
//   1. The advisory `pdpp_owner_agent_onboarding` block, when the deployment
//      advertises it in protected-resource metadata or the `GET /` root pointer.
//      This is the explicit, owner-level profile described in the
//      add-trusted-owner-agent-onboarding OpenSpec change.
//   2. A fallback to the existing RFC 8628 device-authorization shape advertised
//      in authorization-server metadata (`device_authorization_endpoint`,
//      `token_endpoint`, `introspection_endpoint`, `registration_endpoint`).
//      This lets the CLI work against the current reference server before the
//      advisory block is emitted server-side.
//
// This module does NOT emit server metadata. It only consumes it.

import { OwnerAgentError } from "./errors.js";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

export function normalizeEntrypointUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    if (parsed.pathname === "/") {
      parsed.pathname = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Resolve the owner-agent onboarding endpoints starting from an entrypoint URL.
 *
 * @param {string} entrypointUrl
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<OwnerAgentOnboardingProfile>}
 */
export async function discoverOwnerAgentProfile(entrypointUrl, options = {}) {
  const resource = normalizeEntrypointUrl(entrypointUrl);
  if (!resource) {
    throw new OwnerAgentError("invalid_entrypoint", `Invalid entrypoint URL: ${entrypointUrl}`, 64);
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new OwnerAgentError("fetch_unavailable", "This Node runtime does not provide fetch().");
  }

  const resourceMetadata = await getJson(
    fetchFn,
    new URL(PROTECTED_RESOURCE_METADATA_PATH, resource).toString(),
    "metadata_failure"
  );

  // The root pointer (GET /) may also carry the advisory block. We only fetch
  // it if protected-resource metadata did not already surface onboarding info.
  let onboarding = readOnboardingBlock(resourceMetadata);
  if (!onboarding) {
    const rootMetadata = await getJsonOptional(fetchFn, resource);
    onboarding = rootMetadata ? readOnboardingBlock(rootMetadata) : null;
  }

  const authorizationServerUrl = selectAuthorizationServer(resourceMetadata, resource);
  const authorizationMetadata = authorizationServerUrl
    ? await getJsonOptional(fetchFn, new URL(AUTHORIZATION_SERVER_METADATA_PATH, authorizationServerUrl).toString())
    : null;

  const profile = buildProfile({
    authorizationMetadata,
    authorizationServerUrl,
    onboarding,
    resource,
  });

  if (!(profile.deviceAuthorizationEndpoint && profile.tokenEndpoint)) {
    throw new OwnerAgentError(
      "onboarding_unavailable",
      "This deployment does not advertise a trusted owner-agent onboarding flow. " +
        "Expected a pdpp_owner_agent_onboarding block or an RFC 8628 device_authorization_endpoint + token_endpoint."
    );
  }

  return profile;
}

function readOnboardingBlock(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const block = metadata.pdpp_owner_agent_onboarding ?? metadata.pdpp_agent_discovery?.owner_agent_onboarding ?? null;
  return block && typeof block === "object" ? block : null;
}

function buildProfile({ resource, authorizationServerUrl, onboarding, authorizationMetadata }) {
  const issuer = normalizeEntrypointUrl(
    onboarding?.authorization_server ?? authorizationMetadata?.issuer ?? authorizationServerUrl ?? resource
  );
  const base = issuer ?? resource;

  const deviceAuthorizationEndpoint = resolveEndpoint(
    onboarding?.device_authorization_endpoint ?? authorizationMetadata?.device_authorization_endpoint,
    base
  );
  const tokenEndpoint = resolveEndpoint(onboarding?.token_endpoint ?? authorizationMetadata?.token_endpoint, base);
  const introspectionEndpoint = resolveEndpoint(
    onboarding?.introspection_endpoint ?? authorizationMetadata?.introspection_endpoint,
    base
  );
  const registrationEndpoint = resolveEndpoint(
    onboarding?.registration_endpoint ?? authorizationMetadata?.registration_endpoint,
    base
  );
  const approvalUrl = resolveEndpoint(onboarding?.owner_approval_url ?? onboarding?.approval_url, base);
  const schemaEndpoint = resolveEndpoint(onboarding?.schema_endpoint, resource);
  const schemaCompactEndpoint = resolveEndpoint(
    onboarding?.schema_compact_endpoint ?? (schemaEndpoint ? `${schemaEndpoint}?view=compact` : null),
    resource
  );
  const streamsEndpoint = resolveEndpoint(onboarding?.streams_endpoint, resource);
  const revocationPathTemplate =
    typeof onboarding?.revocation_path_template === "string" ? onboarding.revocation_path_template : null;

  return {
    advisory: Boolean(onboarding),
    approvalUrl,
    authorizationServer: issuer,
    deviceAuthorizationEndpoint,
    introspectionEndpoint,
    mcpRejectsOwnerBearer: onboarding?.mcp_owner_bearer_rejected ?? onboarding?.mcp_rejects_owner_bearer ?? true,
    profile: onboarding?.profile ?? "trusted_owner_agent",
    registrationEndpoint,
    resource,
    revocationPathTemplate,
    schemaCompactEndpoint,
    schemaEndpoint,
    streamsEndpoint,
    tokenEndpoint,
  };
}

function selectAuthorizationServer(resourceMetadata, resource) {
  const servers = resourceMetadata?.authorization_servers;
  const selected = Array.isArray(servers) ? servers[0] : resourceMetadata?.authorization_server;
  return normalizeEntrypointUrl(selected ?? resource);
}

function resolveEndpoint(value, base) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value, base ? `${base}/` : undefined).toString();
  } catch {
    return null;
  }
}

async function getJson(fetchFn, url, errorCode) {
  let response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: ${error.message}.`);
  }
  if (!response.ok) {
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  return response.json();
}

async function getJsonOptional(fetchFn, url) {
  let response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @typedef {object} OwnerAgentOnboardingProfile
 * @property {string} profile
 * @property {boolean} advisory  true when discovered from an advisory block
 * @property {string} resource
 * @property {string|null} authorizationServer
 * @property {string|null} deviceAuthorizationEndpoint
 * @property {string|null} tokenEndpoint
 * @property {string|null} introspectionEndpoint
 * @property {string|null} registrationEndpoint
 * @property {string|null} revocationPathTemplate
 * @property {string|null} approvalUrl
 * @property {string|null} schemaEndpoint
 * @property {string|null} schemaCompactEndpoint
 * @property {string|null} streamsEndpoint
 * @property {boolean} mcpRejectsOwnerBearer
 */

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

import { OwnerAgentError } from "./errors.ts";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

type FetchFn = typeof fetch;

const TRAILING_SLASHES_RE = /\/+$/;
const TRAILING_SLASH_RE = /\/$/;

export function normalizeEntrypointUrl(value: string | undefined | null): string | null {
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
    parsed.pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(TRAILING_SLASHES_RE, "") : parsed.pathname;
    if (parsed.pathname === "/") {
      parsed.pathname = "";
    }
    return parsed.toString().replace(TRAILING_SLASH_RE, "");
  } catch {
    return null;
  }
}

interface OwnerAgentOnboardingBlock {
  approval_url?: string;
  authorization_server?: string;
  device_authorization_endpoint?: string;
  introspection_endpoint?: string;
  mcp_owner_bearer_rejected?: boolean;
  mcp_rejects_owner_bearer?: boolean;
  owner_approval_url?: string;
  profile?: string;
  registration_endpoint?: string;
  revocation_path_template?: string;
  schema_compact_endpoint?: string;
  schema_endpoint?: string;
  streams_endpoint?: string;
  token_endpoint?: string;
}

interface ProtectedResourceMetadata {
  authorization_server?: string;
  authorization_servers?: string[];
  pdpp_agent_discovery?: { owner_agent_onboarding?: OwnerAgentOnboardingBlock };
  pdpp_owner_agent_onboarding?: OwnerAgentOnboardingBlock;
}

interface AuthorizationServerMetadata {
  device_authorization_endpoint?: string;
  introspection_endpoint?: string;
  issuer?: string;
  registration_endpoint?: string;
  token_endpoint?: string;
}

export interface OwnerAgentOnboardingProfile {
  advisory: boolean;
  approvalUrl: string | null;
  authorizationServer: string | null;
  deviceAuthorizationEndpoint: string | null;
  introspectionEndpoint: string | null;
  mcpRejectsOwnerBearer: boolean;
  profile: string;
  registrationEndpoint: string | null;
  resource: string;
  revocationPathTemplate: string | null;
  schemaCompactEndpoint: string | null;
  schemaEndpoint: string | null;
  streamsEndpoint: string | null;
  tokenEndpoint: string | null;
}

export interface DiscoverOwnerAgentProfileOptions {
  fetch?: FetchFn;
}

/**
 * Resolve the owner-agent onboarding endpoints starting from an entrypoint URL.
 */
export async function discoverOwnerAgentProfile(
  entrypointUrl: string,
  options: DiscoverOwnerAgentProfileOptions = {}
): Promise<OwnerAgentOnboardingProfile> {
  const resource = normalizeEntrypointUrl(entrypointUrl);
  if (!resource) {
    throw new OwnerAgentError("invalid_entrypoint", `Invalid entrypoint URL: ${entrypointUrl}`, 64);
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new OwnerAgentError("fetch_unavailable", "This Node runtime does not provide fetch().");
  }

  const resourceMetadata = await getJson<ProtectedResourceMetadata>(
    fetchFn,
    new URL(PROTECTED_RESOURCE_METADATA_PATH, resource).toString(),
    "metadata_failure"
  );

  // The root pointer (GET /) may also carry the advisory block. We only fetch
  // it if protected-resource metadata did not already surface onboarding info.
  let onboarding = readOnboardingBlock(resourceMetadata);
  if (!onboarding) {
    const rootMetadata = await getJsonOptional<ProtectedResourceMetadata>(fetchFn, resource);
    onboarding = rootMetadata ? readOnboardingBlock(rootMetadata) : null;
  }

  const authorizationServerUrl = selectAuthorizationServer(resourceMetadata, resource);
  const authorizationMetadata = authorizationServerUrl
    ? await getJsonOptional<AuthorizationServerMetadata>(
        fetchFn,
        new URL(AUTHORIZATION_SERVER_METADATA_PATH, authorizationServerUrl).toString()
      )
    : null;

  const profile = buildProfile({
    resource,
    authorizationServerUrl,
    onboarding,
    authorizationMetadata,
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

function readOnboardingBlock(metadata: ProtectedResourceMetadata | null): OwnerAgentOnboardingBlock | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const block = metadata.pdpp_owner_agent_onboarding ?? metadata.pdpp_agent_discovery?.owner_agent_onboarding ?? null;
  return block && typeof block === "object" ? block : null;
}

interface BuildProfileArgs {
  authorizationMetadata: AuthorizationServerMetadata | null;
  authorizationServerUrl: string | null;
  onboarding: OwnerAgentOnboardingBlock | null;
  resource: string;
}

function buildProfile({
  resource,
  authorizationServerUrl,
  onboarding,
  authorizationMetadata,
}: BuildProfileArgs): OwnerAgentOnboardingProfile {
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
    profile: onboarding?.profile ?? "trusted_owner_agent",
    advisory: Boolean(onboarding),
    resource,
    authorizationServer: issuer,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    introspectionEndpoint,
    registrationEndpoint,
    revocationPathTemplate,
    approvalUrl,
    schemaEndpoint,
    schemaCompactEndpoint,
    streamsEndpoint,
    mcpRejectsOwnerBearer: onboarding?.mcp_owner_bearer_rejected ?? onboarding?.mcp_rejects_owner_bearer ?? true,
  };
}

function selectAuthorizationServer(
  resourceMetadata: ProtectedResourceMetadata | null,
  resource: string
): string | null {
  const servers = resourceMetadata?.authorization_servers;
  const selected = Array.isArray(servers) ? servers[0] : resourceMetadata?.authorization_server;
  return normalizeEntrypointUrl(selected ?? resource);
}

function resolveEndpoint(value: string | null | undefined, base: string | null): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value, base ? `${base}/` : undefined).toString();
  } catch {
    return null;
  }
}

async function getJson<T>(fetchFn: FetchFn, url: string, errorCode: string): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: ${(error as Error).message}.`);
  }
  if (!response.ok) {
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function getJsonOptional<T>(fetchFn: FetchFn, url: string): Promise<T | null> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

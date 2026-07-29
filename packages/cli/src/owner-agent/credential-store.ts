// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Local credential target for the trusted owner-agent profile.
//
// Owner-agent credentials are owner-level local automation. They are written to
// a local file with restrictive permissions and are NEVER printed to stdout,
// stderr, logs, or dashboard status tables.
//
// Target resolution:
//   - An explicit `--credential-file <path>` always wins. Daisy's first
//     supported target is `~/applications/daisy/.pi/agent/pdpp-owner-agent.json`;
//     the operator passes it explicitly.
//   - Otherwise a safe default under the user home is used:
//     `~/.pdpp/owner-agents/<host>.json`. This is intentionally rooted in the
//     home directory, not a project-local `.pdpp/`, so an owner-level bearer is
//     never accidentally committed alongside project files.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_OWNER_AGENT_DIR = join(".pdpp", "owner-agents");

export interface ResolveCredentialFileArgs {
  credentialFile?: string | undefined;
  home?: string | undefined;
  resource: string;
}

/**
 * Resolve the absolute credential-file path for an owner-agent credential.
 */
export function resolveCredentialFile({ credentialFile, resource, home }: ResolveCredentialFileArgs): string {
  const base = home ?? homedir();
  if (credentialFile) {
    const expanded = expandHome(credentialFile, base);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  const host = hostSlug(resource);
  return join(base, DEFAULT_OWNER_AGENT_DIR, `${host}.json`);
}

/**
 * Write owner-agent credential material to the target file with 0600 perms.
 * Returns the absolute path written. The bearer is stored on disk only; it is
 * the caller's responsibility never to print it.
 */
export async function writeOwnerAgentCredential(targetPath: string, payload: unknown): Promise<string> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort tighten on the directory we own; ignore EPERM on shared parents.
  await chmod(dir, 0o700).catch(() => {
    /* best-effort; ignore EPERM on shared parents */
  });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  // writeFile honors the mode only on creation; enforce 0600 if the file
  // pre-existed with looser perms.
  await chmod(targetPath, 0o600).catch(() => {
    /* best-effort; enforce 0600 if the file pre-existed with looser perms */
  });
  return targetPath;
}

export interface BuildCredentialRecordArgs {
  authorizationServer?: string | null;
  clientId?: string | null;
  createdAt: string;
  credential: {
    access_token: string;
    token_type?: string;
    expires_at?: string | null;
    scope?: string | null;
    registration_client_uri?: string | null;
  };
  introspectionEndpoint?: string | null;
  registrationClientUri?: string | null;
  registrationEndpoint?: string | null;
  resource: string;
  schemaCompactEndpoint?: string | null;
  schemaEndpoint?: string | null;
  streamsEndpoint?: string | null;
}

export interface OwnerAgentCredentialRecordOnDisk {
  access_token: string;
  authorization_server: string | null;
  client_id: string | null;
  created_at: string;
  credential: {
    access_token: string;
    token_type: string;
    expires_at: string | null;
    scope: string | null;
  };
  expires_at: string | null;
  introspection_endpoint: string | null;
  pdpp_token_kind: "owner";
  profile: "trusted_owner_agent";
  registration_client_uri: string | null;
  registration_endpoint: string | null;
  resource: string;
  schema_compact_endpoint: string | null;
  schema_endpoint: string | null;
  scope: string | null;
  streams_endpoint: string | null;
  token_type: string;
}

/**
 * Build the on-disk credential record. Includes the bearer (for the agent to
 * use) plus non-secret metadata for status/introspection/revocation.
 */
export function buildCredentialRecord({
  resource,
  authorizationServer,
  credential,
  clientId,
  introspectionEndpoint,
  registrationEndpoint,
  registrationClientUri,
  schemaCompactEndpoint,
  schemaEndpoint,
  streamsEndpoint,
  createdAt,
}: BuildCredentialRecordArgs): OwnerAgentCredentialRecordOnDisk {
  const tokenType = credential.token_type ?? "Bearer";
  const expiresAt = credential.expires_at ?? null;
  const scope = credential.scope ?? null;
  return {
    profile: "trusted_owner_agent",
    pdpp_token_kind: "owner",
    resource,
    authorization_server: authorizationServer ?? null,
    client_id: clientId ?? null,
    introspection_endpoint: introspectionEndpoint ?? null,
    schema_endpoint: schemaEndpoint ?? null,
    schema_compact_endpoint: schemaCompactEndpoint ?? null,
    streams_endpoint: streamsEndpoint ?? null,
    // RFC 7592 client-delete revocation handle, when the credential was bound
    // to a dynamically registered client. The reference implementation gates
    // DELETE with an owner session, not a registration access token.
    registration_client_uri: registrationClientUri ?? credential.registration_client_uri ?? null,
    registration_endpoint: registrationEndpoint ?? null,
    access_token: credential.access_token,
    token_type: tokenType,
    expires_at: expiresAt,
    scope,
    // Backward-compatible nested credential block for callers that adopted the
    // first CLI preview. Daisy and the owner-agent runbook read the top-level
    // access_token.
    credential: {
      access_token: credential.access_token,
      token_type: tokenType,
      expires_at: expiresAt,
      scope,
    },
    created_at: createdAt,
  };
}

function expandHome(p: string, base: string): string {
  if (p === "~") {
    return base;
  }
  if (p.startsWith("~/")) {
    return join(base, p.slice(2));
  }
  return p;
}

function hostSlug(resource: string): string {
  try {
    return new URL(resource).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  } catch {
    return "owner-agent";
  }
}

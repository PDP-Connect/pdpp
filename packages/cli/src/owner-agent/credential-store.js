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

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_OWNER_AGENT_DIR = join('.pdpp', 'owner-agents');

/**
 * Resolve the absolute credential-file path for an owner-agent credential.
 *
 * @param {object} args
 * @param {string} [args.credentialFile]  explicit target (e.g. Daisy's path)
 * @param {string} args.resource          normalized resource origin
 * @param {string} [args.home]            home dir override (tests)
 * @returns {string} absolute path
 */
export function resolveCredentialFile({ credentialFile, resource, home } = {}) {
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
 *
 * @param {string} targetPath  absolute path
 * @param {object} payload     credential record (must include access_token)
 * @returns {Promise<string>}
 */
export async function writeOwnerAgentCredential(targetPath, payload) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort tighten on the directory we own; ignore EPERM on shared parents.
  await chmod(dir, 0o700).catch(() => {});
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  // writeFile honors the mode only on creation; enforce 0600 if the file
  // pre-existed with looser perms.
  await chmod(targetPath, 0o600).catch(() => {});
  return targetPath;
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
  createdAt,
}) {
  return {
    profile: 'trusted-owner-agent',
    pdpp_token_kind: 'owner',
    resource,
    authorization_server: authorizationServer ?? null,
    client_id: clientId ?? null,
    introspection_endpoint: introspectionEndpoint ?? null,
    // RFC 7592 client-delete revocation handle, when the credential was bound
    // to a dynamically registered client.
    registration_client_uri: credential.registration_client_uri ?? null,
    registration_access_token: credential.registration_access_token ?? null,
    registration_endpoint: registrationEndpoint ?? null,
    credential: {
      access_token: credential.access_token,
      token_type: credential.token_type ?? 'Bearer',
      expires_at: credential.expires_at ?? null,
      scope: credential.scope ?? null,
    },
    created_at: createdAt,
  };
}

function expandHome(p, base) {
  if (p === '~') return base;
  if (p.startsWith('~/')) return join(base, p.slice(2));
  return p;
}

function hostSlug(resource) {
  try {
    return new URL(resource).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  } catch {
    return 'owner-agent';
  }
}

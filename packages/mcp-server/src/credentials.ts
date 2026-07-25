// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readStoredCredential } from "@pdpp/cli";

export class CredentialError extends Error {
  code: string;
  exitCode: number;

  constructor(code: string, message: string, exitCode = 78, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface ScopedCredential {
  accessToken: string;
  cacheFile: string;
  grantId: string | null;
  providerUrl: string;
  scope: string | null;
  tokenType: string;
}

interface LoadScopedCredentialOptions {
  cacheRoot?: string;
}

// exactOptionalPropertyTypes forbids `{ cacheRoot: undefined }`: readStoredCredential's
// options type declares `cacheRoot?: string`, not `cacheRoot?: string | undefined`, so
// the key must be omitted entirely when absent rather than forwarded as an explicit
// `undefined` value. Exported as its own pure function so absent-vs-present forwarding
// is directly testable without mocking the `@pdpp/cli` import.
export function readStoredCredentialOptionsFor(options: LoadScopedCredentialOptions): { cacheRoot?: string } {
  const readStoredCredentialOptions: { cacheRoot?: string } = {};
  if (options.cacheRoot !== undefined) {
    readStoredCredentialOptions.cacheRoot = options.cacheRoot;
  }
  return readStoredCredentialOptions;
}

// The stored credential's decoded JSON shape, narrowed to the fields this
// adapter reads. `@pdpp/cli` (readStoredCredential) has no published type
// declarations, so this interface is authored here rather than imported.
interface StoredCredential {
  access_token?: string;
  grant_id?: string;
  kind?: string;
  pdpp_token_kind?: string;
  role?: string;
  scope?: string;
  token_kind?: string;
  token_type?: string;
}

interface StoredCredentialPayload {
  grant_id?: string;
  scope?: string;
}

interface StoredCredentialResult {
  cacheFile: string;
  credential: StoredCredential;
  payload?: StoredCredentialPayload;
  providerUrl: string;
}

type CliConnectError = Error & { code?: string };

/**
 * Load a scoped PDPP client credential from the `pdpp connect` cache.
 *
 * Owner credentials are refused by default; the adapter uses a grant-scoped bearer
 * token for PDPP reads and event-subscription management. The env-derived
 * `PDPP_OWNER_TOKEN` is never consulted.
 */
export async function loadScopedCredential(
  providerUrl: string,
  options: LoadScopedCredentialOptions = {}
): Promise<ScopedCredential> {
  if (!providerUrl) {
    throw new CredentialError(
      "no_provider_url",
      "Provider URL required. Pass --provider-url <url> or set PDPP_PROVIDER_URL.",
      64
    );
  }

  let result: StoredCredentialResult;
  try {
    result = (await readStoredCredential(
      providerUrl,
      readStoredCredentialOptionsFor(options)
    )) as StoredCredentialResult;
  } catch (error) {
    const cliError = error as CliConnectError;
    // cause IS threaded on every throw below, as the 4th positional arg into
    // CredentialError's (code, message, exitCode, options) constructor ->
    // super(message, options); the useErrorCause rule only recognizes
    // `{ cause }` as a direct `new Error(...)` argument, not through a custom
    // subclass's constructor signature, hence the per-throw suppressions.
    if (cliError.code === "not_connected") {
      // biome-ignore lint/style/useErrorCause: see note above the if-chain.
      throw new CredentialError(
        "not_connected",
        `No scoped PDPP credential cached for ${providerUrl}. Run \`pdpp connect ${providerUrl}\` and try again.`,
        78,
        { cause: error }
      );
    }
    if (cliError.code === "credential_expired") {
      // biome-ignore lint/style/useErrorCause: see cause note above.
      throw new CredentialError(
        "credential_expired",
        `Cached PDPP credential for ${providerUrl} is expired. Run \`pdpp connect ${providerUrl}\` again.`,
        78,
        { cause: error }
      );
    }
    if (cliError.code === "credential_invalid") {
      // biome-ignore lint/style/useErrorCause: see cause note above.
      throw new CredentialError(
        "credential_invalid",
        `Cached PDPP credential for ${providerUrl} is malformed; re-run \`pdpp connect ${providerUrl}\`.`,
        78,
        { cause: error }
      );
    }
    if (cliError.code === "invalid_provider_url") {
      // biome-ignore lint/style/useErrorCause: see cause note above.
      throw new CredentialError("invalid_provider_url", cliError.message, 64, { cause: error });
    }
    throw error;
  }

  const { credential } = result;
  if (!credential.access_token) {
    throw new CredentialError(
      "credential_invalid",
      `Cached PDPP credential for ${providerUrl} is missing an access token.`,
      78
    );
  }

  if (isOwnerKind(credential)) {
    throw new CredentialError(
      "owner_token_refused",
      `Cached credential for ${providerUrl} is an owner token; owner credentials are refused by the MCP adapter.`,
      77
    );
  }

  return {
    providerUrl: result.providerUrl,
    cacheFile: result.cacheFile,
    accessToken: credential.access_token,
    tokenType: credential.token_type ?? "Bearer",
    scope: credential.scope ?? result.payload?.scope ?? null,
    grantId: credential.grant_id ?? result.payload?.grant_id ?? null,
  };
}

function isOwnerKind(credential: StoredCredential): boolean {
  if (!credential || typeof credential !== "object") {
    return false;
  }
  // The PDPP audit doc names `pdpp_token_kind=owner` as the owner-distinguishing claim
  // on cached credentials. Treat any kind/role-shaped owner signal as a refusal trigger.
  const flagged = [credential.pdpp_token_kind, credential.token_kind, credential.kind, credential.role];
  return flagged.some((value) => typeof value === "string" && value.toLowerCase() === "owner");
}

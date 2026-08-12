// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { basicIntrospectionAuthorization } from "../../server/introspection-http.ts";
import type { CliFlags } from "../lib/args.ts";
import { parseArgs } from "../lib/args.ts";
import { resolveAsUrl } from "../lib/common.ts";
import type { AuthorizationServerMetadata, ProtectedResourceMetadata } from "../lib/discovery.ts";
import { discoverProvider } from "../lib/discovery.ts";
import { PdppCliError, PdppHttpError, PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

// The three auth endpoints a CLI flow needs, resolved either directly from
// --as-url (always present, since they are template-literal-built from a
// known-good AS base URL) or discovered from --rs-url's AS metadata
// document (each optional, since RFC 8414 endpoints are themselves
// optional-if-unsupported; resolveAuthSurface's `require*` flags gate which
// ones a given caller actually needs before returning).
interface AuthSurface {
  deviceAuthorizationEndpoint?: string | undefined;
  introspectionEndpoint?: string | undefined;
  issuer: string | true;
  tokenEndpoint?: string | undefined;
}

interface AuthSurfaceRequirements {
  requireDeviceAuthorizationEndpoint?: boolean;
  requireIntrospectionEndpoint?: boolean;
  requireSelfExportCapabilities?: boolean;
  requireTokenEndpoint?: boolean;
}

// The RFC 8628 device-authorization response body.
interface DeviceAuthorizationResponse {
  device_code?: string;
  interval?: number;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
}

async function runAuthIntrospect(flags: CliFlags): Promise<void> {
  const token = flags.token || process.env.PDPP_OWNER_TOKEN || process.env.PDPP_CLIENT_TOKEN;
  if (!token || token === true) {
    throw new PdppUsageError("Missing required flag: --token");
  }

  const introspectionCredentials = resolveIntrospectionCallerCredentials();
  const authSurface = await resolveAuthSurface(flags, {
    requireIntrospectionEndpoint: true,
  });

  const { body } = await fetchJson(`${authSurface.introspectionEndpoint}`, {
    body: JSON.stringify({ token }),
    headers: {
      Authorization: basicIntrospectionAuthorization(introspectionCredentials),
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  writeData(body, resolveFormat(flags, "json", "json"));
}

function resolveIntrospectionCallerCredentials(): { clientId: string; clientSecret: string } {
  // Introspection credentials authenticate the CLI as a confidential resource
  // server caller. Keep the secret out of argv, shell history, and process
  // listings by accepting it through the environment only.
  const clientId = process.env.PDPP_RS_INTROSPECTION_CLIENT_ID;
  const clientSecret = process.env.PDPP_RS_INTROSPECTION_CLIENT_SECRET;
  if (!(clientId && clientSecret)) {
    throw new PdppUsageError(
      "Missing introspection caller credentials: set PDPP_RS_INTROSPECTION_CLIENT_ID and PDPP_RS_INTROSPECTION_CLIENT_SECRET"
    );
  }
  return { clientId, clientSecret };
}

// One device-flow token-endpoint poll attempt: returns true when a token
// was obtained and written (caller should stop polling), false to keep
// polling (authorization_pending), or throws to abort the flow. Extracted
// from runAuthLogin's poll loop only to keep both functions' cognitive
// complexity in budget — behavior is unchanged.
async function pollAuthLoginToken(
  authSurface: AuthSurface,
  clientId: string,
  device: DeviceAuthorizationResponse,
  flags: CliFlags,
  bumpInterval: () => void
): Promise<boolean> {
  try {
    const { body, headers } = await fetchJson(`${authSurface.tokenEndpoint}`, {
      body: new URLSearchParams({
        client_id: clientId,
        device_code: device.device_code || "",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return true;
  } catch (error) {
    if (!(error instanceof PdppHttpError)) {
      throw error;
    }

    const errorBody =
      error.body && typeof error.body === "object"
        ? (error.body as { error?: string; error_description?: string })
        : null;
    const oauthCode = errorBody?.error;
    if (oauthCode === "authorization_pending") {
      return false;
    }
    if (oauthCode === "slow_down") {
      bumpInterval();
      return false;
    }
    // PdppCliError carries context via `details` (already forwarded here
    // as `error.details`, see errors.ts), not the native cause chain.
    // biome-ignore lint/style/useErrorCause: see comment above
    throw new PdppCliError(errorBody?.error_description || error.message, error.exitCode, error.details);
  }
}

async function runAuthLogin(flags: CliFlags): Promise<void> {
  const authSurface = await resolveAuthSurface(flags, {
    requireDeviceAuthorizationEndpoint: true,
    requireSelfExportCapabilities: true,
    requireTokenEndpoint: true,
  });
  const clientId = String(flags["client-id"] || "pdpp-cli");
  const timeoutSeconds = Math.max(Number.parseInt(String(flags["timeout-seconds"] || "300"), 10) || 300, 1);

  const { body: deviceBody } = await fetchJson(`${authSurface.deviceAuthorizationEndpoint}`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = (deviceBody ?? {}) as DeviceAuthorizationResponse;

  process.stderr.write(`Verification URI: ${device.verification_uri_complete || device.verification_uri}\n`);
  process.stderr.write(`User code: ${device.user_code}\n`);

  let intervalMs = Math.max((device.interval || 5) * 1000, 1000);
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    // Deliberate device-flow poll loop: each iteration must wait before
    // re-checking the token endpoint, so the awaits are inherently
    // sequential, not parallelizable.
    // biome-ignore lint/performance/noAwaitInLoops: see comment above
    await sleep(intervalMs);
    const obtained = await pollAuthLoginToken(authSurface, clientId, device, flags, () => {
      intervalMs += 5000;
    });
    if (obtained) {
      return;
    }
  }

  throw new PdppCliError("Timed out waiting for owner approval");
}

// Async to keep a uniform Promise<void> signature across index.ts's
// COMMANDS dispatch table; each branch returns another handler's promise
// directly (no local await needed).
// biome-ignore lint/suspicious/useAwait: see comment above
export async function runAuth(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags } = parseArgs(rest);

  if (subcommand === "introspect") {
    return runAuthIntrospect(flags);
  }

  if (subcommand === "login") {
    return runAuthLogin(flags);
  }

  throw new PdppUsageError(
    "Usage: pdpp auth <introspect|login> ...\n" +
      "  introspect --token <token> [--as-url <url> | --rs-url <url>] [--format json|table]\n" +
      "  login [--client-id <id>] [--as-url <url> | --rs-url <url>] [--timeout-seconds <n>] [--format json]"
  );
}

// Verifies the discovered AS/RS advertises the PDPP self-export capability
// set runAuthLogin requires — extracted from resolveAuthSurface only to keep
// its own cognitive complexity in budget; behavior (which checks run, in
// which order, with which messages) is unchanged.
function requireSelfExportCapabilities(
  resourceMetadata: ProtectedResourceMetadata,
  metadata: AuthorizationServerMetadata
): void {
  if (resourceMetadata.pdpp_self_export_supported !== true) {
    throw new PdppCliError("Protected-resource metadata does not advertise pdpp_self_export_supported=true");
  }
  if (
    !(
      Array.isArray(resourceMetadata.pdpp_token_kinds_supported) &&
      resourceMetadata.pdpp_token_kinds_supported.includes("owner")
    )
  ) {
    throw new PdppCliError("Protected-resource metadata does not advertise owner token support");
  }
  const capabilities = Array.isArray(metadata.pdpp_provider_connect_capabilities)
    ? metadata.pdpp_provider_connect_capabilities
    : [];
  for (const capability of ["owner_self_export", "cli_device_connect"]) {
    if (!capabilities.includes(capability)) {
      throw new PdppCliError(
        `Authorization-server metadata does not advertise required PDPP capability: ${capability}`
      );
    }
  }
}

// Verifies the discovered surface advertises every endpoint a given caller
// declared required — extracted from resolveAuthSurface for the same reason
// as requireSelfExportCapabilities above.
function requireDiscoveredEndpoints(surface: AuthSurface, requirements: AuthSurfaceRequirements): void {
  if (requirements.requireIntrospectionEndpoint && !surface.introspectionEndpoint) {
    throw new PdppCliError("Authorization-server metadata did not advertise an introspection endpoint");
  }
  if (requirements.requireTokenEndpoint && !surface.tokenEndpoint) {
    throw new PdppCliError("Authorization-server metadata did not advertise a token endpoint");
  }
  if (requirements.requireDeviceAuthorizationEndpoint && !surface.deviceAuthorizationEndpoint) {
    throw new PdppCliError("Authorization-server metadata did not advertise a device-authorization endpoint");
  }
}

function authSurfaceFromAsUrl(asUrl: string | true): AuthSurface {
  return {
    deviceAuthorizationEndpoint: `${asUrl}/oauth/device_authorization`,
    introspectionEndpoint: `${asUrl}/introspect`,
    issuer: asUrl,
    tokenEndpoint: `${asUrl}/oauth/token`,
  };
}

async function resolveAuthSurface(flags: CliFlags, requirements: AuthSurfaceRequirements = {}): Promise<AuthSurface> {
  if (flags["as-url"]) {
    return authSurfaceFromAsUrl(resolveAsUrl(flags));
  }

  if (flags["rs-url"]) {
    const discovered = await discoverProvider(flags);
    const { authorizationServerMetadata: metadata, resourceMetadata } = discovered;
    const surface: AuthSurface = {
      deviceAuthorizationEndpoint: metadata.device_authorization_endpoint,
      introspectionEndpoint: metadata.introspection_endpoint,
      issuer: discovered.authorizationServer,
      tokenEndpoint: metadata.token_endpoint,
    };

    if (requirements.requireSelfExportCapabilities) {
      requireSelfExportCapabilities(resourceMetadata, metadata);
    }

    requireDiscoveredEndpoints(surface, requirements);

    return surface;
  }

  return authSurfaceFromAsUrl(resolveAsUrl(flags));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

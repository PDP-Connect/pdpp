// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference-only static-secret credential probe seam.
 *
 * The owner-journey flow design (B1) introduces ONE new primitive for the
 * static-secret setup moment: a synchronous validation step (Zapier's test
 * step) that checks a pasted provider secret against the provider before the
 * reference stores it, and echoes back a non-secret account identity on
 * success.
 *
 * Where this lives is a deliberate boundary call (flow design "Where validation
 * lives — decision"): the Collection Profile has NO `VALIDATE`/`PREFLIGHT`
 * message and SHALL NOT gain one for this — reference needs must not leak into
 * protocol semantics until they earn it. So this is an OPTIONAL, reference-only
 * connector hook, not a Collection Profile message and not PDPP Core. It is also
 * intentionally NOT re-exported from the runner barrel (`src/runner/index.ts`):
 * the publishable local-collector slice never probes provider credentials.
 *
 * Promotion trigger (flow design): if three or more connectors implement the
 * hook and a second implementation wants it, consider promoting a probe scope
 * into the Collection Profile — not before.
 *
 * Construction notes:
 *   - This module is pure orchestration + a static registry. The actual network
 *     calls are INJECTED as a transport, mirroring the wider injectable-seam
 *     pattern (`static-secret-injection.ts`, `static-secret-run-credentials.js`).
 *     That keeps the module free of any native/network dependency at import
 *     time and lets tests pass deterministic doubles — no live provider calls in
 *     tests, ever.
 *   - The contract is `probeCredential(secret, context) -> { identity, detail }
 *     | typed error`. A typed `CredentialProbeError` carries a provider-named,
 *     owner-causal `code`/`message` (never a raw provider error code, never the
 *     secret).
 *   - A connector ABSENT from the registry has no synchronous probe; the setup
 *     flow degrades gracefully to the first-sync path (flow design: "Connectors
 *     without the hook degrade gracefully").
 */

import type { StaticSecretCredentialKind } from "./static-secret-injection.ts";

/** A connector advertises one of these validation modes for its setup. */
export type CredentialValidationMode = "synchronous" | "first_sync";

/**
 * Non-secret context handed to a probe. `setupFields` are the connector's
 * declared non-secret setup fields (e.g. Gmail's `account_email`); they were
 * captured at draft creation and are required by some probes (IMAP LOGIN needs
 * the address). The probe never receives — and never returns — the secret in
 * any echoed value.
 */
export interface CredentialProbeContext {
  readonly connectorInstanceId?: string | null;
  readonly setupFields?: Readonly<Record<string, string>> | null;
}

/**
 * The non-secret result of a successful probe.
 *   - `identity`: the owner-facing account identity to echo ("Connected as
 *     {identity}") and to derive the connection label from. Non-secret.
 *   - `detail`: an optional short non-secret note (e.g. plan, account type).
 */
export interface CredentialProbeIdentity {
  readonly detail?: string | null;
  readonly identity: string;
}

/**
 * Typed probe failure. `code` is a stable, owner-causal reason string (e.g.
 * `gmail_credential_rejected`, `github_credential_rejected`,
 * `github_credential_insufficient_scope`); `message` is owner-voiced and names
 * the provider and artifact. Neither carries the secret or a raw provider error
 * body. `retryable` distinguishes a transient reach-the-provider failure (the
 * owner can retry) from a definite rejection (the owner must fix the
 * credential).
 */
export class CredentialProbeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "CredentialProbeError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Transport injected into a probe. Each connector's probe declares the transport
 * shape it needs (see `GmailProbeTransport` / `GithubProbeTransport`). Tests pass
 * deterministic doubles; production wiring passes a real network implementation.
 */
export type CredentialProbeTransport = Record<string, unknown>;

/**
 * One connector's probe. Given the secret, non-secret context, and an injected
 * transport, it resolves a non-secret identity or throws a
 * `CredentialProbeError`. A probe MUST NOT log, return, or embed the secret.
 */
export type ConnectorCredentialProbe = (args: {
  readonly context: CredentialProbeContext;
  readonly secret: string;
  readonly transport: CredentialProbeTransport;
}) => Promise<CredentialProbeIdentity>;

export interface ConnectorCredentialProbeDescriptor {
  readonly credentialKind: StaticSecretCredentialKind;
  readonly probe: ConnectorCredentialProbe;
}

// ─── Gmail probe ─────────────────────────────────────────────────────────

/**
 * Gmail probes by opening one IMAP session and authenticating. A successful
 * LOGIN proves the app password is valid for the mailbox; the mailbox address is
 * the identity. The transport is the single async LOGIN attempt so the live
 * implementation (imapflow) stays out of this module and out of tests.
 */
export interface GmailProbeTransport {
  /**
   * Attempt an IMAP LOGIN. Resolves when authentication succeeds; rejects with
   * any error when it does not (the orchestration maps that to a typed,
   * owner-voiced rejection). Implementations MUST close the session.
   */
  imapLogin(args: { address: string; password: string }): Promise<void>;
}

function gmailAddressFromContext(context: CredentialProbeContext): string | null {
  const fields = context.setupFields;
  if (!fields) {
    return null;
  }
  const value = fields.account_email ?? fields.gmail_address ?? fields.email;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const gmailProbe: ConnectorCredentialProbe = async ({ context, secret, transport }) => {
  const address = gmailAddressFromContext(context);
  if (!address) {
    throw new CredentialProbeError(
      "gmail_address_missing",
      "Enter the Gmail address for this mailbox so the app password can be checked."
    );
  }
  const imapTransport = transport as Partial<GmailProbeTransport>;
  if (typeof imapTransport.imapLogin !== "function") {
    throw new CredentialProbeError(
      "gmail_probe_transport_missing",
      "Gmail validation is unavailable on this instance right now. Try again, or skip validation and start the first sync."
    );
  }
  try {
    await imapTransport.imapLogin({ address, password: secret });
  } catch {
    // imapflow surfaces a bad app password as an authentication failure. The
    // owner-causal reading is "Google rejected this app password" — never the
    // raw IMAP error, never the secret.
    throw new CredentialProbeError(
      "gmail_credential_rejected",
      "Google rejected this app password for that mailbox. Check the Gmail address and create a fresh app password, then try again."
    );
  }
  return { identity: address, detail: null };
};

// ─── GitHub probe ────────────────────────────────────────────────────────

/**
 * GitHub probes with `GET /user` using the PAT. A 200 proves the token is valid
 * and yields the login (the identity); a 401 means the token is rejected. The
 * transport is the single authenticated GET so the live `fetch` stays injectable
 * and tests never hit github.com.
 */
export interface GithubProbeResponse {
  readonly login?: string | null;
  readonly status: number;
}

export interface GithubProbeTransport {
  /** Perform an authenticated `GET /user`. Returns status + parsed login. */
  getUser(args: { token: string }): Promise<GithubProbeResponse>;
}

const githubProbe: ConnectorCredentialProbe = async ({ secret, transport }) => {
  const ghTransport = transport as Partial<GithubProbeTransport>;
  if (typeof ghTransport.getUser !== "function") {
    throw new CredentialProbeError(
      "github_probe_transport_missing",
      "GitHub validation is unavailable on this instance right now. Try again, or skip validation and start the first sync."
    );
  }
  let response: GithubProbeResponse;
  try {
    response = await ghTransport.getUser({ token: secret });
  } catch {
    throw new CredentialProbeError(
      "github_unreachable",
      "Could not reach GitHub to check this token. Try again in a moment.",
      { retryable: true }
    );
  }
  if (response.status === 401) {
    throw new CredentialProbeError(
      "github_credential_rejected",
      "GitHub rejected this token — it may be expired or revoked. Create a new token and try again."
    );
  }
  if (response.status === 403) {
    throw new CredentialProbeError(
      "github_credential_insufficient",
      "GitHub accepted this token but refused the account check — the token may be missing the required scope. Create a token with read access to your profile."
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CredentialProbeError(
      "github_unreachable",
      "GitHub returned an unexpected response while checking this token. Try again in a moment.",
      { retryable: true }
    );
  }
  const login = typeof response.login === "string" && response.login.trim().length > 0 ? response.login.trim() : null;
  if (!login) {
    throw new CredentialProbeError(
      "github_identity_unavailable",
      "GitHub accepted this token but did not return an account login. Try a token tied to a user account."
    );
  }
  return { identity: login, detail: null };
};

// ─── Registry ──────────────────────────────────────────────────────────────

/**
 * Connectors with a synchronous credential probe. A connector here advertises
 * `validation: "synchronous"`; one absent advertises `"first_sync"`. The keys
 * are canonical connector keys (post-registry-prefix strip), matching
 * `STATIC_SECRET_CONNECTOR_REGISTRY`.
 */
export const CREDENTIAL_PROBE_REGISTRY: Readonly<Record<string, ConnectorCredentialProbeDescriptor>> = Object.freeze({
  gmail: Object.freeze({ credentialKind: "app_password" as const, probe: gmailProbe }),
  github: Object.freeze({ credentialKind: "personal_access_token" as const, probe: githubProbe }),
});

/** True when the connector advertises a synchronous credential probe. */
export function hasCredentialProbe(connectorKey: string | null | undefined): boolean {
  return typeof connectorKey === "string" && Object.hasOwn(CREDENTIAL_PROBE_REGISTRY, connectorKey);
}

/**
 * The validation mode a static-secret connector advertises. Connectors with a
 * registered probe validate `synchronous`ly at credential capture; the rest
 * validate at `first_sync`. This is the single source the setup planner,
 * descriptor route, owner-agent intent, and CLI projection all read.
 */
export function credentialValidationMode(connectorKey: string | null | undefined): CredentialValidationMode {
  return hasCredentialProbe(connectorKey) ? "synchronous" : "first_sync";
}

/**
 * Run a connector's synchronous credential probe.
 *
 * Returns a non-secret identity on success. Throws `CredentialProbeError` when
 * the credential is rejected (or the provider is unreachable). Throws a
 * `no_credential_probe` `CredentialProbeError` when the connector has no probe —
 * callers should check `hasCredentialProbe` first and take the first-sync path
 * rather than treating absence as a validation failure.
 *
 * The `transport` is injected by the caller; in production it is the live
 * network implementation, in tests a deterministic double.
 */
export async function probeCredential(args: {
  readonly connectorKey: string;
  readonly context?: CredentialProbeContext;
  readonly secret: string;
  readonly transport: CredentialProbeTransport;
}): Promise<CredentialProbeIdentity> {
  const descriptor = CREDENTIAL_PROBE_REGISTRY[args.connectorKey];
  if (!descriptor) {
    throw new CredentialProbeError(
      "no_credential_probe",
      `Connector '${args.connectorKey}' has no synchronous credential probe.`
    );
  }
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    throw new CredentialProbeError("probe_secret_invalid", "A non-empty provider secret is required to validate.");
  }
  return await descriptor.probe({
    context: args.context ?? {},
    secret: args.secret,
    transport: args.transport,
  });
}

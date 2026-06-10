/**
 * Live transports for the static-secret credential probe.
 *
 * `credential-probe.ts` is pure orchestration with an INJECTED transport. This
 * module supplies the REAL transport — the single bounded network request each
 * connector's probe needs — and lives here, in the connector package, because
 * the provider dependency lives here: imapflow (a Gmail/IMAP dep) is not, and
 * should not be, reachable from the reference server's own dependency tree, and
 * the GitHub probe reuses the same `fetch`/auth shape the GitHub connector uses.
 *
 * The reference server imports `createLiveCredentialProbeTransport` only at the
 * point of use (the owner-session capture route). Tests inject deterministic
 * doubles directly and never import this module, so no live provider call is
 * ever made under test.
 *
 * This module is reference-only: it is NOT re-exported from the runner barrel
 * (`src/runner/index.ts`), so the publishable local-collector slice never
 * carries it. Each transport performs exactly ONE bounded request and never
 * logs the secret.
 */

import type { CredentialProbeTransport, GithubProbeResponse } from "./credential-probe.ts";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_USER_AGENT = "pdpp-credential-probe/0.1";
const PROBE_TIMEOUT_MS = 10_000;

async function gmailImapLogin(args: { address: string; password: string }): Promise<void> {
  // Lazy import so imapflow is only loaded when a Gmail credential is actually
  // probed, never at module load.
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: args.address, pass: args.password },
    logger: false,
    // Bound the probe; a hung connect must not stall the owner's submit.
    socketTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout: PROBE_TIMEOUT_MS,
    connectionTimeout: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } finally {
    // Best-effort cleanup; a logout failure must not mask the connect result.
    await client.logout().catch(() => {
      /* ignore: the probe's verdict is the connect outcome, not logout */
    });
  }
}

async function githubGetUser(args: { token: string }): Promise<GithubProbeResponse> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${args.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": GITHUB_USER_AGENT,
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  let login: string | null = null;
  if (res.status >= 200 && res.status < 300) {
    const body = (await res.json().catch(() => null)) as { login?: unknown } | null;
    login = typeof body?.login === "string" ? body.login : null;
  }
  return { status: res.status, login };
}

/**
 * Build the live transport for one connector's probe. Returns an empty object
 * for connectors with no probe; the caller checks `hasCredentialProbe` first.
 */
export function createLiveCredentialProbeTransport(connectorKey: string): CredentialProbeTransport {
  if (connectorKey === "gmail") {
    return { imapLogin: gmailImapLogin };
  }
  if (connectorKey === "github") {
    return { getUser: githubGetUser };
  }
  return {};
}

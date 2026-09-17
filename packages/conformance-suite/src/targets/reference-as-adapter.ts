// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// An adapter for the PDP-Connect reference implementation's real AS + RS.
//
// This is the adapter that makes the grant-enforcement oracles executable. The
// HTTP adapter can only reuse grants an operator minted by hand, so every case
// needing a *specific* grant shape — a narrowed field projection, a stream held
// out, a grant to revoke mid-run — reports `skip` against it. Those are the
// cases that decide whether enforcement is real, so skipping them leaves the
// most important half of the suite unexercised.
//
// The reference AS exposes the whole consent journey over HTTP, so the adapter
// can drive it: register a client (RFC 7591), stage a selection request (PAR),
// approve it as the owner, and receive a grant plus a bound access token. That
// is the real protocol path, not a test seam bolted onto the side.
//
// Everything here is still black-box. The adapter speaks HTTP to the AS and
// hands the suite a token; the cases then speak HTTP to the RS. No server
// internals are imported and no in-process handle is held, so a different
// implementation exposing the same endpoints is testable through this adapter
// unchanged.

import type { GrantRequest, IssuedGrant, SeededStream, TargetAdapter, TargetCapabilities } from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";

export interface ReferenceAsConfig {
  /** Authorization server base URL, e.g. "http://127.0.0.1:4401". */
  readonly asUrl: string;
  readonly capabilities: TargetCapabilities;
  /** RFC 7591 initial access token the AS requires for client registration. */
  readonly dcrInitialAccessToken: string;
  /** A second subject, so cross-subject isolation (RS-12) is demonstrable. */
  readonly foreignSubjectId?: string;
  /** Credentials an RS uses at the introspection endpoint (RFC 7662 §2.1). */
  readonly introspectionCredentials?: { readonly clientId: string; readonly clientSecret: string };
  /** Query parameters this deployment requires on owner-token reads. */
  readonly ownerReadParams?: Readonly<Record<string, string>>;
  readonly roles: readonly Role[];
  /** Resource server base URL, e.g. "http://127.0.0.1:4402". */
  readonly rsUrl: string;
  /** Source the seeded streams belong to. */
  readonly source: { readonly kind: "connector" | "provider_native"; readonly id: string };
  readonly streams: readonly SeededStream[];
  /** Subject the owner token and grants are scoped to. */
  readonly subjectId: string;
  readonly targetId: string;
  readonly targetVersion: string;
}

/** The device-authorization client the reference AS pre-registers for owners. */
const OWNER_BOOTSTRAP_CLIENT_ID = "cli_longview";

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
}

/**
 * Obtain an owner token through the RFC 8628 device-code flow the reference AS
 * implements. Core leaves owner-token acquisition out of scope, so this is
 * deployment-specific by design and lives in the adapter rather than a case.
 */
async function mintOwnerToken(asUrl: string, subjectId: string): Promise<string | null> {
  const deviceResponse = await postForm(`${asUrl}/oauth/device_authorization`, {
    client_id: OWNER_BOOTSTRAP_CLIENT_ID,
  });
  if (!deviceResponse.ok) {
    return null;
  }
  const device = (await deviceResponse.json()) as { device_code?: string; user_code?: string };
  if (!(device.device_code && device.user_code)) {
    return null;
  }
  const approval = await postForm(`${asUrl}/device/approve`, {
    subject_id: subjectId,
    user_code: device.user_code,
  });
  if (!approval.ok) {
    return null;
  }
  const tokenResponse = await postForm(`${asUrl}/oauth/token`, {
    client_id: OWNER_BOOTSTRAP_CLIENT_ID,
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (!tokenResponse.ok) {
    return null;
  }
  const token = (await tokenResponse.json()) as { access_token?: string };
  return token.access_token ?? null;
}

export class ReferenceAsAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion: string;
  readonly roles: readonly Role[];
  readonly capabilities: TargetCapabilities;
  private readonly config: ReferenceAsConfig;
  private clientId: string | null = null;

  constructor(config: ReferenceAsConfig) {
    this.config = config;
    this.targetId = config.targetId;
    this.targetVersion = config.targetVersion;
    this.roles = config.roles;
    this.capabilities = config.capabilities;
  }

  /** Cases query the resource server; the AS is reached only by this adapter. */
  get baseUrl(): string {
    return this.config.rsUrl;
  }

  get ownerReadParams(): Readonly<Record<string, string>> | undefined {
    return this.config.ownerReadParams;
  }

  get authorizationServerUrl(): string {
    return this.config.asUrl;
  }

  get introspectionCredentials(): { readonly clientId: string; readonly clientSecret: string } | undefined {
    return this.config.introspectionCredentials;
  }

  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    // Register once per run. A fresh client each run keeps grants from earlier
    // runs from being reused, which would let a stale grant satisfy a case that
    // should have failed to obtain one.
    const response = await postJson(
      `${this.config.asUrl}/oauth/register`,
      {
        client_name: "pdpp-conformance-suite",
        redirect_uris: ["http://127.0.0.1/conformance-callback"],
      },
      this.config.dcrInitialAccessToken
    );
    if (!response.ok) {
      throw new Error(
        `Client registration failed against ${this.config.asUrl}/oauth/register (${response.status}): ${await response.text()}`
      );
    }
    const registered = (await response.json()) as { client_id?: string };
    if (!registered.client_id) {
      throw new Error("Client registration returned no client_id.");
    }
    this.clientId = registered.client_id;
    return { streams: this.config.streams };
  }

  async teardown(): Promise<void> {
    // The suite did not create this server and does not tear it down.
    await Promise.resolve();
  }

  /**
   * Drive the real consent journey to obtain a grant of the requested shape.
   *
   * PAR stages the selection request, the owner approves it, and the AS returns
   * the resolved grant with a bound token. Returning null when any step refuses
   * is deliberate: the case then reports `skip`, and a grant the AS declined to
   * issue never becomes a silent pass.
   */
  async issueGrant(wanted: GrantRequest): Promise<IssuedGrant | null> {
    if (!this.clientId) {
      return null;
    }
    const [stream] = wanted.streams;
    if (!stream) {
      return null;
    }

    const parResponse = await postJson(`${this.config.asUrl}/oauth/par`, {
      client_id: this.clientId,
      client_display: { name: "pdpp-conformance-suite" },
      authorization_details: [
        {
          type: "https://pdpp.dev/data-access",
          source: { id: this.config.source.id, kind: this.config.source.kind },
          purpose_code: "https://pdpp.dev/purpose/personal_analytics",
          access_mode: wanted.accessMode ?? "continuous",
          streams: wanted.streams.map((s) => ({
            name: s.name,
            // Only pin fields when the case asked to narrow the projection;
            // otherwise let the AS resolve the full declared set, which is what
            // Section 9 item 4 requires it to do.
            ...(s.fields.length > 0 ? { fields: [...s.fields] } : {}),
          })),
        },
      ],
    });
    if (!parResponse.ok) {
      return null;
    }
    const par = (await parResponse.json()) as { request_uri?: string };
    if (!par.request_uri) {
      return null;
    }

    // Review binds the exact reviewed facts to a revision; the AS rejects an
    // approval that does not carry it (Section 9 item 15).
    const reviewResponse = await postJson(`${this.config.asUrl}/consent/review`, {
      request_uri: par.request_uri,
      subject_id: this.config.subjectId,
    });
    if (!reviewResponse.ok) {
      return null;
    }
    const reviewed = (await reviewResponse.json()) as {
      approval_review_revision?: string;
      revision?: string;
    };
    const revision = reviewed.approval_review_revision ?? reviewed.revision;

    // Approval carries only the reviewed revision, never the selection choices
    // again: Section 9 item 15 binds the decision to the reviewed artifact, and
    // the AS rejects an approval that tries to restate it (including a repeated
    // subject_id, which the review step already fixed).
    const approveResponse = await postJson(`${this.config.asUrl}/consent/approve`, {
      request_uri: par.request_uri,
      ...(revision ? { approval_review_revision: revision } : {}),
    });
    if (!approveResponse.ok) {
      return null;
    }
    const approval = (await approveResponse.json()) as {
      token?: string;
      grant_id?: string;
      grant?: { streams?: { name?: string; fields?: string[] }[] };
    };
    if (!(approval.token && approval.grant_id)) {
      return null;
    }

    // Report the fields the AS actually resolved, not the ones requested. A case
    // checking for projection leakage must compare against what was granted, or
    // it would measure its own request and never detect over-granting.
    const resolved = approval.grant?.streams ?? [];
    return {
      grantId: approval.grant_id,
      accessToken: approval.token,
      streams: wanted.streams.map((s) => {
        const got = resolved.find((r) => r.name === s.name);
        return { name: s.name, fields: got?.fields ? [...got.fields] : [...s.fields] };
      }),
    };
  }

  async revokeGrant(grantId: string): Promise<void> {
    const ownerToken = await mintOwnerToken(this.config.asUrl, this.config.subjectId);
    await fetch(`${this.config.asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: "POST",
      ...(ownerToken ? { headers: { Authorization: `Bearer ${ownerToken}` } } : {}),
    });
  }

  async ownerToken(): Promise<string | null> {
    return await mintOwnerToken(this.config.asUrl, this.config.subjectId);
  }

  async foreignSubjectOwnerToken(): Promise<string | null> {
    if (!this.config.foreignSubjectId) {
      return null;
    }
    return await mintOwnerToken(this.config.asUrl, this.config.foreignSubjectId);
  }
}

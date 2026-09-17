// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// An adapter for the Vana Personal Server's composed PDPP AS + RS.
//
// A second real target with a DIFFERENT authorization shape, which is the point:
// the reference implementation stages a selection request with RFC 9126 PAR and
// approves it at a consent endpoint, while this server opens an authorization
// session, reviews it by digest, approves it, and returns a redirect carrying an
// OAuth authorization code that the client exchanges with PKCE.
//
// Core does not pin either shape. Section 6 defines the selection request and
// Section 7 the resolved grant; how a deployment gets from one to the other is
// its own business. So both are conformant ways to reach the same place, and a
// suite that could only drive one of them would be testing a deployment style
// rather than the protocol. The two adapters existing side by side is the
// evidence that the case bodies are genuinely implementation-independent: they
// receive a token and a resolved grant, and never learn which journey produced
// them.

import type {
  GrantRequest,
  IssuedGrant,
  SeededStream,
  StagedApproval,
  TargetAdapter,
  TargetCapabilities,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";

export interface VanaPsConfig {
  /** Single base URL: this deployment co-locates the AS and RS. */
  readonly baseUrl: string;
  readonly capabilities: TargetCapabilities;
  /** Client the server has pre-registered, with an exactly-matching redirect URI. */
  readonly clientId: string;
  readonly introspectionCredentials?: { readonly clientId: string; readonly clientSecret: string };
  /** Owner credential the server accepts at /pdpp/v1/owner/token. */
  readonly ownerBootstrapToken: string;
  readonly ownerReadParams?: Readonly<Record<string, string>>;
  readonly purposeCode?: string;
  readonly redirectUri: string;
  readonly roles: readonly Role[];
  /** Source the seeded streams belong to. */
  readonly sourceId: string;
  readonly streams: readonly SeededStream[];
  readonly targetId: string;
  readonly targetVersion: string;
}

/**
 * PKCE verifier/challenge pair.
 *
 * Fixed rather than random so a failed run can be replayed exactly. These are
 * test credentials for a local target and authorize nothing beyond it.
 */
const PKCE_VERIFIER = "pdpp-conformance-verifier-0000000000000000000000000000";

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

export class VanaPsAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion: string;
  readonly baseUrl: string;
  readonly roles: readonly Role[];
  readonly capabilities: TargetCapabilities;
  private readonly config: VanaPsConfig;

  constructor(config: VanaPsConfig) {
    this.config = config;
    this.targetId = config.targetId;
    this.targetVersion = config.targetVersion;
    this.baseUrl = config.baseUrl;
    this.roles = config.roles;
    this.capabilities = config.capabilities;
  }

  get ownerReadParams(): Readonly<Record<string, string>> | undefined {
    return this.config.ownerReadParams;
  }

  /** Co-located AS and RS, so the authorization server is the same origin. */
  get authorizationServerUrl(): string {
    return this.config.baseUrl;
  }

  get introspectionCredentials(): { readonly clientId: string; readonly clientSecret: string } | undefined {
    return this.config.introspectionCredentials;
  }

  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    const probe = await fetch(`${this.config.baseUrl}/.well-known/oauth-protected-resource`).catch((error: unknown) => {
      throw new Error(
        `Target ${this.targetId} is not reachable at ${this.config.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }. Start the Personal Server before running the suite.`,
        { cause: error }
      );
    });
    if (probe.status === 0) {
      throw new Error(`Target ${this.targetId} did not answer an HTTP probe.`);
    }
    return { streams: this.config.streams };
  }

  async teardown(): Promise<void> {
    // The suite did not create this server and does not tear it down.
    await Promise.resolve();
  }

  /** Mint an owner token. How the owner authenticates is out of Core's scope. */
  async ownerToken(): Promise<string | null> {
    const response = await fetch(`${this.config.baseUrl}/pdpp/v1/owner/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.ownerBootstrapToken}` },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  }

  /**
   * Drive this server's authorization journey to a grant-bound token:
   * authorize (owner-authenticated) → review → approve → code → PKCE exchange.
   *
   * Returns null at any refusal so the case reports `skip` with the reason,
   * rather than a grant the server declined becoming a silent pass.
   */
  /**
   * Open an authorization session and review it, stopping short of approval, so
   * the approval-binding and replay cases can drive the final step themselves.
   */
  async stageApproval(wanted: GrantRequest): Promise<StagedApproval | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    const ownerAuth = { authorization: `Bearer ${owner}` };

    const authorized = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize`, {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify(await this.authorizeBody(wanted)),
    });
    if (authorized.status !== 201) {
      return null;
    }
    const { session_id: sessionId } = (await authorized.json()) as { session_id?: string };
    if (!sessionId) {
      return null;
    }

    const reviewed = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize/${encodeURIComponent(sessionId)}/review`, {
      headers: ownerAuth,
    });
    const review = reviewed.ok ? ((await reviewed.json()) as { review?: { review_digest?: string } }) : undefined;

    const approve = async (revision?: string): Promise<IssuedGrant | null> => {
      const response = await fetch(
        `${this.config.baseUrl}/pdpp/v1/authorize/${encodeURIComponent(sessionId)}/approve`,
        {
          method: "POST",
          headers: { ...ownerAuth, "content-type": "application/json" },
          body: JSON.stringify(revision ? { review_digest: revision } : {}),
        }
      );
      if (!response.ok) {
        return null;
      }
      const approval = (await response.json()) as {
        redirect_uri?: string;
        grant_id?: string;
        grant?: { streams?: { name?: string; fields?: string[] }[] };
      };
      if (!(approval.redirect_uri && approval.grant_id)) {
        return null;
      }
      const token = await this.exchangeCode(approval.redirect_uri);
      if (!token) {
        return null;
      }
      const resolved = approval.grant?.streams ?? [];
      return {
        grantId: approval.grant_id,
        accessToken: token,
        streams: wanted.streams.map((s) => {
          const got = resolved.find((r) => r.name === s.name);
          return { name: s.name, fields: got?.fields ? [...got.fields] : [...s.fields] };
        }),
      };
    };

    const digest = review?.review?.review_digest;
    return { handle: sessionId, ...(digest ? { reviewRevision: digest } : {}), approve };
  }

  /** The RFC 9396 selection request this server expects, for both entry points. */
  private async authorizeBody(wanted: GrantRequest): Promise<Record<string, unknown>> {
    return {
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_challenge: await s256Challenge(PKCE_VERIFIER),
      code_challenge_method: "S256",
      client_display: { name: "pdpp-conformance-suite" },
      authorization_details: [
        {
          type: "https://pdpp.dev/data-access",
          source: { id: this.config.sourceId },
          purpose_code: this.config.purposeCode ?? "https://pdpp.dev/purpose/personal_analytics",
          access_mode: wanted.accessMode ?? "continuous",
          streams: wanted.streams.map((s) => ({
            name: s.name,
            ...(s.fields.length > 0 ? { fields: [...s.fields] } : {}),
            ...(wanted.timeConstraint
              ? {
                  time_range: {
                    ...(wanted.timeConstraint.from ? { since: wanted.timeConstraint.from } : {}),
                    ...(wanted.timeConstraint.to ? { until: wanted.timeConstraint.to } : {}),
                  },
                }
              : {}),
          })),
        },
      ],
    };
  }

  /** Redeem the authorization code the approval redirect carries, with PKCE. */
  private async exchangeCode(redirectUri: string): Promise<string | null> {
    const code = new URL(redirectUri).searchParams.get("code");
    if (!code) {
      return null;
    }
    const response = await fetch(`${this.config.baseUrl}/pdpp/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code_verifier: PKCE_VERIFIER,
      }).toString(),
    });
    if (!response.ok) {
      return null;
    }
    const token = (await response.json()) as { access_token?: string };
    return token.access_token ?? null;
  }

  /**
   * The whole journey, for cases that just need a grant: stage, then approve
   * with the revision the server issued. Built on stageApproval so there is one
   * implementation of the flow rather than two that can drift apart.
   */
  async issueGrant(wanted: GrantRequest): Promise<IssuedGrant | null> {
    const staged = await this.stageApproval(wanted);
    if (!staged) {
      return null;
    }
    return await staged.approve(staged.reviewRevision);
  }

  async revokeGrant(grantId: string): Promise<void> {
    const owner = await this.ownerToken();
    // Form-encoded, not JSON. This server splits its bodies deliberately: the
    // consent endpoints take JSON while /token, /introspect and /revoke take
    // form encoding, matching the OAuth endpoints they mirror. Sending JSON here
    // returns 400 "grant_id is required", the revoke never lands, and the
    // revocation oracle then reports a target that enforces revocation correctly
    // as failing to — which is exactly what this adapter got wrong first time.
    await fetch(`${this.config.baseUrl}/pdpp/v1/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(owner ? { authorization: `Bearer ${owner}` } : {}),
      },
      body: new URLSearchParams({ grant_id: grantId }).toString(),
    });
  }

  /**
   * Absent by design rather than by omission: this deployment binds one owner to
   * the server, so there is no second subject to prove isolation against. RS-12
   * reports `skip` naming that, which is honest — the requirement is untested
   * here, not satisfied.
   */
  async foreignSubjectOwnerToken(): Promise<string | null> {
    return null;
  }
}

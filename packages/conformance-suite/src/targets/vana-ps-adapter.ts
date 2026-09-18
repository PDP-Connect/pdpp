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
  RefreshableGrant,
  SeededStream,
  SelectionOutcome,
  SelectionRequest,
  StagedApproval,
  TargetAdapter,
  TargetCapabilities,
} from "../harness/adapter.ts";
import { type PdppResponse, request } from "../harness/http.ts";
import type { Role } from "../requirements/catalog.ts";

export interface VanaPsConfig {
  /** Single base URL: this deployment co-locates the AS and RS. */
  readonly baseUrl: string;
  readonly capabilities: TargetCapabilities;
  /** Client the server has pre-registered, with an exactly-matching redirect URI. */
  readonly clientId: string;
  /**
   * A SECOND, dedicated client the server has pre-registered with an
   * operator-configured `grantLifetimeSeconds`, for AS-8's expired-grant
   * oracle (`expiredGrantToken`).
   *
   * Deliberately a distinct client from `clientId`, never the same one with a
   * flag: `expiredGrantToken` must not shrink the lifetime of grants the
   * other cases issue to `clientId`, and a short deployment-wide default
   * would silently break the pagination/refresh cases that expect an
   * ordinary, non-expiring grant to still be usable partway through a run.
   * Absent means this deployment has no such client configured, and AS-8's
   * expiry case reports `skip` naming this hook rather than fabricating one.
   */
  readonly expiryFixture?: {
    readonly clientId: string;
    /** Must match a redirect URI this deployment pre-registered for `clientId` above. */
    readonly redirectUri: string;
    /** The lifetime the deployment's config bound to this client, in seconds. */
    readonly grantLifetimeSeconds: number;
    /**
     * A subset of fields the pre-expiry read's record for `streams[0]` must
     * match, e.g. `{ id: "artist_1", name: "Artist 1" }`. Required so the
     * positive control proves the token reads the seeded record rather than
     * merely getting a 200 with an empty or unrelated body.
     */
    readonly expectedRecord: Readonly<Record<string, unknown>>;
  };
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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
  /**
   * Headers from the most recent successful token-endpoint redemption, for
   * clause 10.2-4.
   *
   * A field rather than a changed `exchangeCode` return type because several
   * call sites need only the token, and widening all of them to carry headers
   * they ignore would be noise. Set immediately before the token is returned,
   * so a grant and its header map are always from the same exchange.
   */
  private lastTokenResponseHeaders: Record<string, string> | null = null;

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

  /**
   * The Vana test deployment exposes owner-authenticated token inspection.
   * Its introspect method uses the same token authority as the co-located RS.
   * This does not establish separated-RS authentication support. A missing
   * owner credential returns null; HTTP failures remain observable responses.
   */
  async coLocatedIntrospect(accessToken: string): Promise<PdppResponse | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    return await request(this.config.baseUrl, "/pdpp/v1/introspect", {
      method: "POST",
      token: owner,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
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
  async stageApproval(
    wanted: GrantRequest,
    client: { readonly clientId: string; readonly redirectUri: string } = {
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
    }
  ): Promise<StagedApproval | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    const ownerAuth = { authorization: `Bearer ${owner}` };

    const authorized = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize`, {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify(await this.authorizeBody(wanted, client)),
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
    // Kept WHOLE, not narrowed to the digest. The server's own review body is
    // the final approval artifact clauses 7.2-2 and 6.3-2 are about, and
    // reshaping it here would mean the cases inspect this adapter's summary
    // rather than what the Personal Server actually publishes.
    const review = reviewed.ok ? ((await reviewed.json()) as { review?: Record<string, unknown> }) : undefined;

    let lastError: { status: number; errorCode?: string } | null = null;
    // Retained only inside this closure so no case body can see or reuse the
    // code directly — `replayLastCode` is the sole way to act on it again.
    let lastRedeemedCode: string | null = null;

    const approve = async (revision?: string, explicitAiTrainingConsent?: boolean): Promise<IssuedGrant | null> => {
      const body: Record<string, unknown> = revision ? { review_digest: revision } : {};
      if (explicitAiTrainingConsent !== undefined) {
        body.explicit_ai_training_consent = explicitAiTrainingConsent;
      }
      const response = await fetch(
        `${this.config.baseUrl}/pdpp/v1/authorize/${encodeURIComponent(sessionId)}/approve`,
        {
          method: "POST",
          headers: { ...ownerAuth, "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => undefined);
        const errorCode = (errorBody as { error?: unknown } | undefined)?.error;
        lastError = {
          status: response.status,
          ...(typeof errorCode === "string" ? { errorCode } : {}),
        };
        return null;
      }
      lastError = null;
      const approval = (await response.json()) as {
        redirect_uri?: string;
        grant_id?: string;
        grant?: { streams?: { name?: string; fields?: string[] }[] };
      };
      if (!(approval.redirect_uri && approval.grant_id)) {
        return null;
      }
      lastRedeemedCode = new URL(approval.redirect_uri).searchParams.get("code");
      const token = await this.exchangeCode(approval.redirect_uri, client);
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
        // Only when the approval response actually carried a grant body. This
        // target's /approve returns `{ redirect_uri, grant_id }`, so in practice
        // this is absent and AS-3's schema case skips for missing evidence.
        ...(approval.grant === undefined ? {} : { rawGrant: approval.grant }),
        // The headers of the exchange that produced THIS token (clause 10.2-4).
        ...(this.lastTokenResponseHeaders === null ? {} : { tokenResponseHeaders: this.lastTokenResponseHeaders }),
      };
    };

    /**
     * Redeem the SAME code from the most recent `approve`, with the SAME PKCE
     * verifier, a second time at the token endpoint. AS-19's replay oracle
     * (Section 9 AS item 19).
     */
    const replayLastCode = async (): Promise<{ status: number; errorCode?: string; accessToken?: string } | null> => {
      if (!lastRedeemedCode) {
        return null;
      }
      let response: Response;
      try {
        response = await fetch(`${this.config.baseUrl}/pdpp/v1/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: lastRedeemedCode,
            client_id: client.clientId,
            redirect_uri: client.redirectUri,
            code_verifier: PKCE_VERIFIER,
          }).toString(),
        });
      } catch {
        return null;
      }
      const responseBody: unknown = await response.json().catch(() => undefined);
      if (response.ok) {
        const accessToken = (responseBody as { access_token?: unknown } | undefined)?.access_token;
        return { status: response.status, ...(typeof accessToken === "string" ? { accessToken } : {}) };
      }
      const errorCode = (responseBody as { error?: unknown } | undefined)?.error;
      return { status: response.status, ...(typeof errorCode === "string" ? { errorCode } : {}) };
    };

    const reviewBody = review?.review;
    const digest = typeof reviewBody?.review_digest === "string" ? reviewBody.review_digest : undefined;
    return {
      handle: sessionId,
      ...(digest ? { reviewRevision: digest } : {}),
      // The server's review body verbatim, when it published one. A target that
      // returns no review body offers no artifact, and the cases report `skip`
      // rather than the suite reconstructing one from its own request.
      ...(reviewBody === undefined ? {} : { approvalArtifact: async () => reviewBody }),
      approve,
      lastApproveError: () => lastError,
      replayLastCode,
    };
  }

  /**
   * Submit a selection request and report what the AS answered, without
   * approving it. Used by the selection-time validation cases, which are about
   * refusals a successful grant can never demonstrate.
   */
  async submitSelection(wanted: SelectionRequest): Promise<SelectionOutcome | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    const detail: Record<string, unknown> = {
      type: "https://pdpp.dev/data-access",
      source: { id: this.config.sourceId },
      purpose_code: wanted.purposeCode ?? this.config.purposeCode ?? "https://pdpp.dev/purpose/personal_analytics",
      access_mode: "continuous",
    };
    if (wanted.streams) {
      detail.streams = wanted.streams.map((s) => ({
        name: s.name,
        // An absent `fields` is the request-time convenience AS-4 must expand,
        // so it has to reach the server absent rather than as an empty array.
        ...(s.fields ? { fields: [...s.fields] } : {}),
      }));
    }
    if (wanted.selectionPreset !== undefined) {
      detail.selection_preset = wanted.selectionPreset;
    }

    const response = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner}`,
        "content-type": "application/json",
        ...(wanted.pdppVersion ? { "PDPP-Version": wanted.pdppVersion } : {}),
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code_challenge: await s256Challenge(PKCE_VERIFIER),
        code_challenge_method: "S256",
        client_display: { name: "pdpp-conformance-suite" },
        authorization_details: [detail],
      }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const errorCode = (body as { error?: unknown } | undefined)?.error;
    return {
      status: response.status,
      ...(typeof errorCode === "string" ? { errorCode } : {}),
      body,
    };
  }

  /**
   * Read the resolved grant the server bound to a staged request, so AS-4 can
   * check that request-time conveniences were expanded before issuance.
   */
  async reviewedStreams(handle: string): Promise<readonly { name: string; fields: readonly string[] }[] | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    const response = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize/${encodeURIComponent(handle)}/review`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      review?: { data?: { streams?: { name?: string; fields?: string[]; instance_ids?: string[] }[] } };
    };
    const streams = body.review?.data?.streams;
    if (!streams) {
      return null;
    }
    return streams.map((s) => ({ name: s.name ?? "", fields: [...(s.fields ?? [])] }));
  }

  /** Issue a grant carrying a refresh token, for the rotation/reuse oracle. */
  async issueRefreshableGrant(wanted: GrantRequest): Promise<RefreshableGrant | null> {
    const staged = await this.stageApproval(wanted);
    if (!staged?.reviewRevision) {
      return null;
    }
    const approved = await this.approveForTokens(staged.handle, staged.reviewRevision);
    return approved;
  }

  /** The RFC 9396 selection request this server expects, for both entry points. */
  private async authorizeBody(
    wanted: GrantRequest,
    client: { readonly clientId: string; readonly redirectUri: string } = {
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
    }
  ): Promise<Record<string, unknown>> {
    return {
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: await s256Challenge(PKCE_VERIFIER),
      code_challenge_method: "S256",
      client_display: { name: "pdpp-conformance-suite" },
      authorization_details: [
        {
          type: "https://pdpp.dev/data-access",
          source: { id: this.config.sourceId },
          purpose_code: wanted.purposeCode ?? this.config.purposeCode ?? "https://pdpp.dev/purpose/personal_analytics",
          access_mode: wanted.accessMode ?? "continuous",
          // Sent only when the case asked for retention terms, so no existing
          // request shape changes. Clause 7.2-2 requires the approval artifact
          // to STATE retention, and a server can only state what was requested
          // — it is a requested term, not one the AS invents.
          ...(wanted.retention
            ? {
                retention: {
                  max_duration: wanted.retention.maxDuration,
                  on_expiry: wanted.retention.onExpiry,
                },
              }
            : {}),
          // Core Section 6 places `client_claims` inside each
          // authorization_details entry. Sent only when the case supplied any,
          // so no existing request shape changes. If this deployment ignores
          // them, the 6.3-2 case sees no bound claims in the review body and
          // reports `skip` (the clause is conditional on claims being
          // rendered) rather than failing the server for a capability Core
          // does not require it to have.
          ...(wanted.clientClaims?.commitments?.length
            ? { client_claims: { commitments: [...wanted.clientClaims.commitments] } }
            : {}),
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
  private async exchangeCode(
    redirectUri: string,
    client: { readonly clientId: string; readonly redirectUri: string } = {
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
    }
  ): Promise<string | null> {
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
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code_verifier: PKCE_VERIFIER,
      }).toString(),
    });
    if (!response.ok) {
      return null;
    }
    const token = (await response.json()) as { access_token?: string };
    if (token.access_token) {
      // Recorded only for a response that actually carried a token: clause
      // 10.2-4 binds "every successful token response that contains an access
      // token or refresh token", so headers from a tokenless response would be
      // evidence about a different obligation.
      this.lastTokenResponseHeaders = Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v]));
    }
    return token.access_token ?? null;
  }

  /**
   * Approve a staged request and redeem its code, keeping the refresh token.
   *
   * `exchangeCode` deliberately returns only the access token, because that is
   * all every other case should see. The rotation oracle needs the family, so it
   * redeems here instead of widening the common path.
   */
  private async approveForTokens(handle: string, revision: string): Promise<RefreshableGrant | null> {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    const approved = await fetch(`${this.config.baseUrl}/pdpp/v1/authorize/${encodeURIComponent(handle)}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: JSON.stringify({ review_digest: revision }),
    });
    if (!approved.ok) {
      return null;
    }
    const { redirect_uri: redirectUri } = (await approved.json()) as { redirect_uri?: string };
    const code = redirectUri ? new URL(redirectUri).searchParams.get("code") : null;
    if (!code) {
      return null;
    }
    return await this.redeem(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code_verifier: PKCE_VERIFIER,
      })
    );
  }

  /** One token-endpoint redemption, shaped as a refreshable family member. */
  private async redeem(form: URLSearchParams): Promise<RefreshableGrant | null> {
    const response = await fetch(`${this.config.baseUrl}/pdpp/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { access_token?: string; refresh_token?: string };
    if (!(body.access_token && body.refresh_token)) {
      return null;
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      refresh: (token: string) =>
        this.redeem(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: this.config.clientId,
          })
        ),
    };
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
    return await staged.approve(staged.reviewRevision, wanted.explicitAiTrainingConsent);
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

  /**
   * A token bound to a grant that has genuinely expired under this
   * deployment's own operator policy — never a fabricated token, a shortened
   * global default, or a different issuer.
   *
   * Drives the real authorize → review → approve → PKCE-redeem journey for
   * `expiryFixture.clientId`, the SAME journey every other case uses, just
   * against the dedicated short-lived client. Before returning, it proves the
   * SAME token reads the expected seeded record (the positive control AS-8's
   * case needs to isolate expiry as the cause of the later refusal, mirroring
   * the revocation case's before/after pair), then sleeps past the
   * deployment-configured lifetime and returns that SAME token unchanged.
   *
   * Returns null only when the fixture is not configured. For configured fixtures, the
   * positive control is a hard precondition: a denied, malformed, empty, or
   * mismatched pre-expiry read throws, so a broken fixture surfaces as AS-8
   * `fail` rather than a silent `skip` that would look identical to "no
   * expiry support configured".
   */
  async expiredGrantToken(): Promise<string | null> {
    const fixture = this.config.expiryFixture;
    const [stream] = this.config.streams;
    if (!fixture) return null;
    if (!stream || !fixture.expectedRecord?.id) {
      throw new Error("Configured expiry fixture requires a seeded stream and expected record ID.");
    }

    const staged = await this.stageApproval(
      { streams: [{ name: stream.name, fields: [...stream.fields] }] },
      { clientId: fixture.clientId, redirectUri: fixture.redirectUri }
    );
    if (!staged) {
      throw new Error("Configured expiry fixture could not establish authorization.");
    }
    const grant = await staged.approve(staged.reviewRevision);
    if (!grant) {
      throw new Error("Configured expiry fixture could not obtain a grant token.");
    }

    const before = await fetch(`${this.config.baseUrl}/v1/streams/${encodeURIComponent(stream.name)}/records`, {
      headers: { authorization: `Bearer ${grant.accessToken}` },
    });
    if (before.status !== 200) {
      throw new Error(
        `expiryFixture is configured but the pre-expiry read of stream "${stream.name}" returned ${before.status}, not 200. The positive control this oracle needs (proof the token worked before expiry) did not hold.`
      );
    }
    const body = (await before.json().catch(() => undefined)) as { data?: unknown } | undefined;
    const records = Array.isArray(body?.data) ? (body.data as { id?: unknown; data?: Record<string, unknown> }[]) : [];
    const expected = Object.entries(fixture.expectedRecord);
    // The RS record envelope (`toRecordJson`) carries the record key as the
    // top-level `id` and every other seeded field nested under `data` — the
    // same shape every other stream-reading case in this suite reads
    // (resource-server.ts, query-surface.ts). expectedRecord's keys are
    // matched against whichever level actually carries them.
    const matched = records.find((record) =>
      expected.every(([key, value]) => (key === "id" ? record.id === value : record.data?.[key] === value))
    );
    if (!matched) {
      throw new Error(
        `expiryFixture is configured but the pre-expiry read of stream "${stream.name}" did not contain a record matching expectedRecord. Got ${records.length} record(s). The positive control this oracle needs (proof the token reads the seeded record before expiry) did not hold.`
      );
    }

    await sleep((fixture.grantLifetimeSeconds + 2) * 1000);

    return grant.accessToken;
  }
}

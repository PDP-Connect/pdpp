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

import { createHash, randomBytes } from "node:crypto";
import {
  type BlobFixture,
  type DeclarationOutcome,
  describeRefusedStep,
  type GrantRequest,
  type IssuedGrant,
  type MultiInstanceFixture,
  PreconditionFailed,
  type SeededStream,
  type SelectionOutcome,
  type SelectionRequest,
  type SourceDeclarationStream,
  type SourceDeclarationSubmission,
  type StagedApproval,
  type TargetAdapter,
  type TargetCapabilities,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";

export interface ReferenceAsConfig {
  /** Authorization server base URL, e.g. "http://127.0.0.1:4401". */
  readonly asUrl: string;
  readonly capabilities: TargetCapabilities;
  /**
   * The `changes_since` value that opens a fresh sync session. The reference
   * implementation requires `beginning` and treats an empty value as absent.
   */
  readonly changesSinceBootstrap?: string;
  /** RFC 7591 initial access token the AS requires for client registration. */
  readonly dcrInitialAccessToken: string;
  /** A second subject, so cross-subject isolation (RS-12) is demonstrable. */
  readonly foreignSubjectId?: string;
  /**
   * Record ids the foreign subject's own store holds, per stream. The seeding
   * seeds only `subjectId`, so each listed stream is empty for the foreign
   * subject; an unlisted stream is unknown.
   */
  readonly foreignSubjectRecordIds?: Readonly<Record<string, readonly string[]>>;
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

/**
 * One HTTP step of an arrangement. A refusal or an unreachable server throws
 * `PreconditionFailed` naming the step, status and body excerpt: the runner
 * reports the case as `skip`, so a step that did not happen can never be read
 * as a verdict on the target.
 */
async function step(name: string, send: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    throw new PreconditionFailed(
      `${name} could not reach the target: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      }
    );
  }
  if (!response.ok) {
    throw new PreconditionFailed(await describeRefusedStep(name, response));
  }
  return response;
}

async function stepJson<T>(name: string, send: () => Promise<Response>): Promise<T> {
  const response = await step(name, send);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new PreconditionFailed(`${name} answered ${response.status} with a body that is not JSON`, { cause: error });
  }
}

function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
}

/** A stream's field selection: by view name, else by explicit fields, else left to the AS. */
function selectionTerms(s: GrantRequest["streams"][number]): { view?: string; fields?: string[] } {
  if (s.view) {
    return { view: s.view };
  }
  return s.fields.length > 0 ? { fields: [...s.fields] } : {};
}

/**
 * Request fields the reference AS's PAR path has no standard slot for. Refusing
 * them is the honest answer: issuing a plain grant instead would let the case
 * judge a grant that is not the one it asked for.
 */
function unsupportedRequestFields(wanted: GrantRequest): string[] {
  return wanted.explicitAiTrainingConsent === undefined ? [] : ["explicitAiTrainingConsent"];
}

const CALLBACK_URI = "http://127.0.0.1/conformance-callback";
/** Subject the reference AS assigns to an owner action taken without a session. */
const FANIN_OWNER_SUBJECT = "owner_local";
const DATA_ACCESS_TYPE = "https://pdpp.dev/data-access";

/** Parse a response body as JSON, or return null when it is not JSON. */
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function lowerCaseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * The machine-readable error code of a JSON error body, when it carries one.
 * The token endpoint answers the RFC 6749 shape (`error` is the code); the PAR
 * and consent routes answer Core's envelope (`error.code`).
 */
function errorCodeOf(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error;
  if (typeof error === "string") {
    return error;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A request that is plain enough to repeat down the OAuth route without changing its meaning. */
function isPlainRequest(wanted: GrantRequest): boolean {
  return (
    wanted.accessMode === undefined &&
    wanted.clientClaims === undefined &&
    wanted.purposeCode === undefined &&
    wanted.retention === undefined &&
    wanted.timeConstraint === undefined &&
    wanted.explicitAiTrainingConsent === undefined &&
    wanted.streams.every((s) => s.view === undefined)
  );
}

/** A staged OAuth authorization request: the pending consent and the PKCE secret that will redeem its code. */
interface OAuthStaged {
  readonly clientId: string;
  readonly requestUri: string;
  readonly verifier: string;
}

interface ApprovalRefusal {
  readonly errorCode?: string;
  readonly status: number;
}

export class ReferenceAsAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion: string;
  readonly roles: readonly Role[];
  readonly capabilities: TargetCapabilities;
  private readonly config: ReferenceAsConfig;
  private clientId: string | null = null;
  /** One device-flow client per subject: the AS binds a dynamic client to its first owner subject. */
  private readonly ownerClients = new Map<string, Promise<string>>();
  /** Streams each staged request resolved to, keyed by the handle `stageApproval` returned. */
  private readonly reviewedByHandle = new Map<string, unknown[]>();
  /** The approval each JSON-route grant came from, so a consumed grant can be approved a second time. */
  private readonly approvalsByGrant = new Map<string, { requestUri: string; revision: string | undefined }>();
  private ownerBearer: Promise<string> | null = null;
  private blobFixtureOnce: Promise<BlobFixture> | null = null;
  private multiInstanceOnce: Promise<MultiInstanceFixture> | null = null;

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

  get changesSinceBootstrap(): string | undefined {
    return this.config.changesSinceBootstrap;
  }

  /** RFC 7591 registration with the initial access token; returns the new client_id. */
  private async registerClient(name: string): Promise<string> {
    const registered = await stepJson<{ client_id?: string }>(`client registration (${name})`, () =>
      postJson(
        `${this.config.asUrl}/oauth/register`,
        { client_name: name, redirect_uris: ["http://127.0.0.1/conformance-callback"] },
        this.config.dcrInitialAccessToken
      )
    );
    if (!registered.client_id) {
      throw new PreconditionFailed(`client registration (${name}) returned no client_id`);
    }
    return registered.client_id;
  }

  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    // Register once per run. A fresh client each run keeps grants from earlier
    // runs from being reused, which would let a stale grant satisfy a case that
    // should have failed to obtain one.
    try {
      this.clientId = await this.registerClient("pdpp-conformance-suite");
    } catch (error) {
      throw new Error(
        `Client registration failed against ${this.config.asUrl}/oauth/register: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    return { streams: this.config.streams };
  }

  async teardown(): Promise<void> {
    // The suite did not create this server and does not tear it down.
    await Promise.resolve();
  }

  /**
   * Obtain an owner token through the RFC 8628 device-code flow the reference
   * AS implements. Core leaves owner-token acquisition out of scope, so this is
   * deployment-specific by design and lives in the adapter rather than a case.
   *
   * The device-flow client is not pre-registered: the AS only knows clients
   * registered with the initial access token, so one is registered lazily per
   * subject and reused for every token this run mints for that subject.
   */
  private async mintOwnerToken(subjectId: string): Promise<string> {
    let pending = this.ownerClients.get(subjectId);
    if (!pending) {
      pending = this.registerClient(`pdpp-conformance-owner-${subjectId}`);
      this.ownerClients.set(subjectId, pending);
    }
    let clientId: string;
    try {
      clientId = await pending;
    } catch (error) {
      // Do not cache a failed registration: the next call retries it.
      this.ownerClients.delete(subjectId);
      throw error;
    }
    const device = await stepJson<{ device_code?: string; user_code?: string }>("owner device authorization", () =>
      postForm(`${this.config.asUrl}/oauth/device_authorization`, { client_id: clientId })
    );
    if (!(device.device_code && device.user_code)) {
      throw new PreconditionFailed("owner device authorization returned no device_code/user_code");
    }
    const userCode = device.user_code;
    await step("owner device approval", () =>
      postForm(`${this.config.asUrl}/device/approve`, { subject_id: subjectId, user_code: userCode })
    );
    const deviceCode = device.device_code;
    const token = await stepJson<{ access_token?: string }>("owner token redemption", () =>
      postForm(`${this.config.asUrl}/oauth/token`, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
    );
    if (!token.access_token) {
      throw new PreconditionFailed("owner token redemption returned no access_token");
    }
    return token.access_token;
  }

  /** The RFC 9396 `authorization_details` entry for a grant request. */
  private authorizationDetail(wanted: GrantRequest): Record<string, unknown> {
    return {
      type: DATA_ACCESS_TYPE,
      source: { id: this.config.source.id, kind: this.config.source.kind },
      purpose_code: wanted.purposeCode ?? "https://pdpp.dev/purpose/personal_analytics",
      access_mode: wanted.accessMode ?? "continuous",
      ...(wanted.retention
        ? { retention: { max_duration: wanted.retention.maxDuration, on_expiry: wanted.retention.onExpiry } }
        : {}),
      ...(wanted.clientClaims ? { client_claims: wanted.clientClaims } : {}),
      streams: wanted.streams.map((s, index) => ({
        name: s.name,
        // Only pin fields when the case asked to narrow the projection;
        // otherwise let the AS resolve the full declared set, which is what
        // Section 9 item 4 requires it to do. A view is requested by name
        // instead of fields (they are mutually exclusive).
        ...selectionTerms(s),
        // The AS resolves the window against the stream's consent_time_field
        // (Core Section 5); the request carries only the bounds.
        ...(index === 0 && wanted.timeConstraint
          ? {
              time_range: {
                ...(wanted.timeConstraint.from ? { since: wanted.timeConstraint.from } : {}),
                ...(wanted.timeConstraint.to ? { until: wanted.timeConstraint.to } : {}),
              },
            }
          : {}),
      })),
    };
  }

  /**
   * Submit a selection request (PAR) and report the AS's answer without
   * approving it. The AS classifies refusals itself; this method only carries
   * the request and reads back the status and OAuth error code.
   */
  async submitSelection(request: SelectionRequest): Promise<SelectionOutcome | null> {
    if (!this.clientId) {
      throw new PreconditionFailed("submitSelection called before setup() registered a client");
    }
    const detail: Record<string, unknown> = {
      type: DATA_ACCESS_TYPE,
      source: { id: this.config.source.id, kind: this.config.source.kind },
      purpose_code: request.purposeCode ?? "https://pdpp.dev/purpose/personal_analytics",
      access_mode: "continuous",
      ...(request.selectionPreset === undefined ? {} : { selection_preset: request.selectionPreset }),
      ...(request.streams === undefined
        ? {}
        : {
            streams: request.streams.map((s) => ({
              name: s.name,
              ...(s.fields === undefined ? {} : { fields: [...s.fields] }),
              ...(s.view === undefined ? {} : { view: s.view }),
              ...(request.timeRange ? { time_range: { ...request.timeRange } } : {}),
            })),
          }),
    };
    let response: Response;
    try {
      response = await fetch(`${this.config.asUrl}/oauth/par`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(request.pdppVersion === undefined ? {} : { "PDPP-Version": request.pdppVersion }),
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_display: { name: "pdpp-conformance-suite" },
          authorization_details: [detail],
        }),
      });
    } catch (error) {
      throw new PreconditionFailed(
        `selection request could not reach the target: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    const text = await response.text();
    const body = parseJson(text);
    const errorCode = errorCodeOf(body);
    return { status: response.status, body: text, ...(errorCode === undefined ? {} : { errorCode }) };
  }

  /**
   * Start an OAuth authorization-code request (RFC 6749 with PKCE) for a grant
   * request. Returns the pending consent, or the AS's refusal. A transport
   * failure is a `PreconditionFailed`, never a refusal.
   */
  private async startOAuthRequest(wanted: GrantRequest): Promise<OAuthStaged | ApprovalRefusal> {
    if (!this.clientId) {
      throw new PreconditionFailed("an OAuth request was started before setup() registered a client");
    }
    const { clientId } = this;
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CALLBACK_URI,
      response_type: "code",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: randomBytes(8).toString("hex"),
      authorization_details: JSON.stringify([this.authorizationDetail(wanted)]),
    });
    let response: Response;
    try {
      response = await fetch(`${this.config.asUrl}/oauth/authorize?${query}`, { redirect: "manual" });
    } catch (error) {
      throw new PreconditionFailed(
        `OAuth authorization request could not reach the target: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    const location = response.headers.get("location");
    const requestUri = location ? new URL(location, this.config.asUrl).searchParams.get("request_uri") : null;
    if (response.status === 302 && requestUri) {
      return { clientId, requestUri, verifier };
    }
    const errorCode = errorCodeOf(parseJson(await response.text()));
    if (response.status >= 400 && response.status < 500) {
      return { status: response.status, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    throw new PreconditionFailed(`OAuth authorization request answered ${response.status} with no pending consent`);
  }

  /** Finalize the owner's review of a pending consent; the body is the AS's own review artifact. */
  private async reviewPending(
    requestUri: string,
    aiTrainingConsented?: boolean,
    subjectId: string = this.config.subjectId
  ): Promise<{ readonly body: Record<string, unknown>; readonly revision: string | undefined } | ApprovalRefusal> {
    const response = await postJson(`${this.config.asUrl}/consent/review`, {
      request_uri: requestUri,
      subject_id: subjectId,
      ...(aiTrainingConsented === undefined ? {} : { ai_training_consented: aiTrainingConsented }),
    });
    const body = parseJson(await response.text());
    if (!(response.ok && body)) {
      const errorCode = errorCodeOf(body);
      return { status: response.status, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    const revision = body.approval_review_revision;
    return { body, revision: typeof revision === "string" ? revision : undefined };
  }

  /** Redeem an authorization code at the token endpoint, keeping the whole response. */
  private async redeemCode(
    staged: OAuthStaged,
    code: string
  ): Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown> | null;
  }> {
    const response = await postForm(`${this.config.asUrl}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: staged.clientId,
      code,
      redirect_uri: CALLBACK_URI,
      code_verifier: staged.verifier,
    });
    return {
      status: response.status,
      headers: lowerCaseHeaders(response),
      body: parseJson(await response.text()),
    };
  }

  /**
   * Approve a pending consent and redeem the resulting code. Returns the grant
   * with the token endpoint's own response, plus the code for a later replay.
   */
  private async approveAndRedeem(
    staged: OAuthStaged,
    revision: string | undefined
  ): Promise<{ readonly code: string; readonly grant: IssuedGrant } | ApprovalRefusal> {
    const response = await postJson(`${this.config.asUrl}/consent/approve`, {
      request_uri: staged.requestUri,
      ...(revision ? { approval_review_revision: revision } : {}),
    });
    const location = response.headers.get("location");
    const code = location ? new URL(location, this.config.asUrl).searchParams.get("code") : null;
    if (response.status !== 302 || !code) {
      const errorCode = errorCodeOf(parseJson(await response.text()));
      return { status: response.status, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    const redeemed = await this.redeemCode(staged, code);
    const accessToken = redeemed.body?.access_token;
    const grantId = redeemed.body?.grant_id;
    if (redeemed.status !== 200 || typeof accessToken !== "string" || typeof grantId !== "string") {
      const errorCode = errorCodeOf(redeemed.body);
      return { status: redeemed.status, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    const details = Array.isArray(redeemed.body?.authorization_details) ? redeemed.body.authorization_details : [];
    const resolved = (details as { streams?: { name?: string; fields?: string[] }[] }[]).flatMap(
      (d) => d.streams ?? []
    );
    return {
      code,
      grant: {
        grantId,
        accessToken,
        streams: resolved.flatMap((r) => (r.name ? [{ name: r.name, fields: [...(r.fields ?? [])] }] : [])),
        tokenResponseBody: redeemed.body,
        tokenResponseHeaders: redeemed.headers,
      },
    };
  }

  /**
   * Stage an authorization request short of approval. The artifact is the AS's
   * own review response, unreshaped. Returns null when the AS refuses the
   * request itself.
   */
  async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
    const started = await this.startOAuthRequest(request);
    if ("status" in started) {
      return null;
    }
    // A review the AS refuses (the ai_training purpose needs explicit consent
    // while the review is finalized) leaves the request pending but unreviewed:
    // there is no artifact or revision yet, and approving without consent
    // reports the AS's own refusal.
    const firstReview = await this.reviewPending(started.requestUri);
    const reviewed = "status" in firstReview ? null : firstReview;
    const initialRefusal: ApprovalRefusal | null = "status" in firstReview ? firstReview : null;
    const resolvedStreams = (reviewed?.body.approval_review as { resolved_streams?: unknown } | undefined)
      ?.resolved_streams;
    this.reviewedByHandle.set(started.requestUri, Array.isArray(resolvedStreams) ? resolvedStreams : []);

    let lastCode: string | null = null;
    let lastRefusal: ApprovalRefusal | null = initialRefusal;
    const base = {
      handle: started.requestUri,
      ...(reviewed ? { approvalArtifact: () => Promise.resolve(reviewed.body) } : {}),
      approve: async (revision?: string, explicitAiTrainingConsent?: boolean) => {
        // `ai_training_consented` is accepted only while the review is
        // finalized, so a consent given at approval time is carried by
        // re-reviewing; the revision it produces replaces the staged one.
        let useRevision = revision;
        if (initialRefusal && explicitAiTrainingConsent === undefined) {
          lastRefusal = initialRefusal;
          return null;
        }
        if (explicitAiTrainingConsent !== undefined) {
          const rereviewed = await this.reviewPending(started.requestUri, explicitAiTrainingConsent);
          if ("status" in rereviewed) {
            lastRefusal = rereviewed;
            return null;
          }
          if (revision === undefined || revision === reviewed?.revision) {
            useRevision = rereviewed.revision;
          }
        }
        const outcome = await this.approveAndRedeem(started, useRevision);
        if ("status" in outcome) {
          lastRefusal = outcome;
          return null;
        }
        lastRefusal = null;
        lastCode = outcome.code;
        return outcome.grant;
      },
      lastApproveError: () => lastRefusal,
      replayLastCode: async () => {
        if (lastCode === null) {
          return null;
        }
        const replayed = await this.redeemCode(started, lastCode);
        const errorCode = errorCodeOf(replayed.body);
        const accessToken = replayed.body?.access_token;
        return {
          status: replayed.status,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(typeof accessToken === "string" ? { accessToken } : {}),
        };
      },
    };
    return reviewed?.revision === undefined ? base : { ...base, reviewRevision: reviewed.revision };
  }

  /** The streams and fields the AS resolved for a staged request, from its own review. */
  reviewedStreams(handle: string): Promise<readonly { name: string; fields: readonly string[] }[] | null> {
    const resolved = this.reviewedByHandle.get(handle);
    if (!resolved) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      (resolved as { name?: unknown; fields?: unknown }[]).flatMap((s) =>
        typeof s.name === "string"
          ? [{ name: s.name, fields: Array.isArray(s.fields) ? (s.fields as string[]) : [] }]
          : []
      )
    );
  }

  /**
   * Drive the real consent journey to obtain a grant of the requested shape.
   *
   * PAR stages the selection request, the owner approves it, and the AS returns
   * the resolved grant with a bound token. Every refusal, and every requested
   * term the journey cannot carry or the AS did not resolve, throws
   * `PreconditionFailed`: the case then reports `skip` naming the step, and a
   * grant of a different shape never becomes a silent pass or fail.
   */
  async issueGrant(wanted: GrantRequest): Promise<IssuedGrant | null> {
    if (!this.clientId) {
      throw new PreconditionFailed("issueGrant called before setup() registered a client");
    }
    const { clientId } = this;
    const [stream] = wanted.streams;
    if (!stream) {
      return null;
    }
    const unsupported = unsupportedRequestFields(wanted);
    if (unsupported.length > 0) {
      throw new PreconditionFailed(
        `this adapter cannot request ${unsupported.join(", ")} through PAR, so the grant would not have the shape the case asked for`
      );
    }

    const par = await stepJson<{ request_uri?: string }>("PAR (stage selection request)", () =>
      postJson(`${this.config.asUrl}/oauth/par`, {
        client_id: clientId,
        client_display: { name: "pdpp-conformance-suite" },
        authorization_details: [this.authorizationDetail(wanted)],
      })
    );
    if (!par.request_uri) {
      throw new PreconditionFailed("PAR (stage selection request) returned no request_uri");
    }
    const requestUri = par.request_uri;

    // Review binds the exact reviewed facts to a revision; the AS rejects an
    // approval that does not carry it (Section 9 item 15).
    const reviewed = await stepJson<{ approval_review_revision?: string; revision?: string }>("consent review", () =>
      postJson(`${this.config.asUrl}/consent/review`, { request_uri: requestUri, subject_id: this.config.subjectId })
    );
    const revision = reviewed.approval_review_revision ?? reviewed.revision;

    // Approval carries only the reviewed revision, never the selection choices
    // again: Section 9 item 15 binds the decision to the reviewed artifact, and
    // the AS rejects an approval that tries to restate it (including a repeated
    // subject_id, which the review step already fixed).
    const approval = await stepJson<{
      token?: string;
      grant_id?: string;
      grant?: { streams?: { name?: string; fields?: string[]; time_constraint?: unknown }[] };
    }>("consent approval", () =>
      postJson(`${this.config.asUrl}/consent/approve`, {
        request_uri: requestUri,
        ...(revision ? { approval_review_revision: revision } : {}),
      })
    );
    if (!(approval.token && approval.grant_id)) {
      throw new PreconditionFailed("consent approval returned no token/grant_id");
    }
    this.approvalsByGrant.set(approval.grant_id, { requestUri, revision });

    // Report the fields the AS actually resolved, not the ones requested. A case
    // checking for projection leakage must compare against what was granted, or
    // it would measure its own request and never detect over-granting.
    const resolved = approval.grant?.streams ?? [];
    if (wanted.timeConstraint && !resolved.some((r) => r.name === stream.name && r.time_constraint)) {
      // Never hand back an unconstrained grant for a time-bound request: the case
      // would read the records the constraint was meant to hide as an RS defect.
      throw new PreconditionFailed(
        `consent approval resolved the grant for "${stream.name}" without the requested time_constraint, so frozen-window enforcement cannot be isolated`
      );
    }
    return {
      grantId: approval.grant_id,
      accessToken: approval.token,
      streams: wanted.streams.map((s) => {
        const got = resolved.find((r) => r.name === s.name);
        return { name: s.name, fields: got?.fields ? [...got.fields] : [...s.fields] };
      }),
      // Passed through only when the approval response carried a grant body.
      ...(approval.grant === undefined ? {} : { rawGrant: approval.grant }),
      ...(isPlainRequest(wanted) ? await this.tokenEndpointObservation(wanted) : {}),
    };
  }

  /**
   * What the token endpoint returned for a request of this shape.
   *
   * The consent-approval route that carries the grant artifact (`rawGrant`)
   * hands back the token itself, so it never touches the token endpoint. The
   * authorization-code route is the one that does. A single grant cannot take
   * both routes, so this repeats the SAME request down the code route and
   * reports that route's token response. It is evidence about the token
   * endpoint's behavior for this request shape, not about this grant's own
   * token; the grant it creates is discarded. Any step that does not complete
   * yields nothing, and the cases then `skip` rather than judge.
   */
  private async tokenEndpointObservation(
    wanted: GrantRequest
  ): Promise<{ tokenResponseBody?: unknown; tokenResponseHeaders?: Record<string, string> }> {
    try {
      const started = await this.startOAuthRequest(wanted);
      if ("status" in started) {
        return {};
      }
      const reviewed = await this.reviewPending(started.requestUri);
      if ("status" in reviewed) {
        return {};
      }
      const approved = await this.approveAndRedeem(started, reviewed.revision);
      if ("status" in approved) {
        return {};
      }
      return {
        ...(approved.grant.tokenResponseBody === undefined
          ? {}
          : { tokenResponseBody: approved.grant.tokenResponseBody }),
        ...(approved.grant.tokenResponseHeaders === undefined
          ? {}
          : { tokenResponseHeaders: { ...approved.grant.tokenResponseHeaders } }),
      };
    } catch {
      return {};
    }
  }

  /** One owner bearer for the run's data arrangement (writes and blob staging). */
  private async arrangementToken(): Promise<string> {
    this.ownerBearer ??= this.mintOwnerToken(this.config.subjectId);
    try {
      return await this.ownerBearer;
    } catch (error) {
      this.ownerBearer = null;
      throw error;
    }
  }

  private connectorQuery(extra: Record<string, string> = {}): string {
    return new URLSearchParams({ connector_id: this.config.source.id, ...extra }).toString();
  }

  /** Upsert one record through the owner ingest route. */
  private async ingestRecord(stream: string, key: string, data: Record<string, unknown>): Promise<void> {
    const token = await this.arrangementToken();
    const line = JSON.stringify({ type: "RECORD", stream, key, data, emitted_at: new Date().toISOString() });
    const result = await stepJson<{ records_accepted?: number }>(`ingest of ${stream}/${key}`, () =>
      fetch(`${this.config.rsUrl}/v1/ingest/${encodeURIComponent(stream)}?${this.connectorQuery()}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson", Authorization: `Bearer ${token}` },
        body: line,
      })
    );
    if (result.records_accepted !== 1) {
      throw new PreconditionFailed(`ingest of ${stream}/${key} accepted ${result.records_accepted ?? 0} records`);
    }
  }

  /**
   * Change one field of one record: read the record with the owner token, then
   * upsert it with that field replaced. Returns false when the target will not
   * take the write, so the dependent cases `skip`.
   */
  async writeRecordField(stream: string, recordId: string, field: string, value: unknown): Promise<boolean> {
    try {
      const token = await this.arrangementToken();
      const current = await stepJson<{ data?: Record<string, unknown> }>(`read of ${stream}/${recordId}`, () =>
        fetch(
          `${this.config.rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}?${this.connectorQuery()}`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
      );
      if (!current.data) {
        return false;
      }
      await this.ingestRecord(stream, recordId, { ...current.data, [field]: value });
      return true;
    } catch (error) {
      if (error instanceof PreconditionFailed) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Store deterministic bytes through the owner routes. The shared blob is
   * first referenced by a private record, then by a permitted record: a reader
   * must authorize through any permitted reference, not only the first one.
   * A separate private-only blob remains the denial control.
   */
  blobFixture(): Promise<BlobFixture> {
    this.blobFixtureOnce ??= this.stageBlobFixture().catch((error: unknown) => {
      this.blobFixtureOnce = null;
      throw error;
    });
    return this.blobFixtureOnce;
  }

  private async stageBlob(stream: string, recordKey: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    const token = await this.arrangementToken();
    const uploaded = await stepJson<{ blob_id?: string; mime_type?: string; sha256?: string; size_bytes?: number }>(
      `blob upload for ${stream}/${recordKey}`,
      () =>
        fetch(
          `${this.config.rsUrl}/v1/blobs?${this.connectorQuery({ stream, record_key: recordKey, json_path: "/blob_ref", mime_type: mimeType })}`,
          {
            method: "POST",
            headers: { "Content-Type": mimeType, Authorization: `Bearer ${token}` },
            body: Buffer.from(bytes),
          }
        )
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedBlobId = `blob_sha256_${sha256}`;
    if (uploaded.blob_id !== expectedBlobId) {
      throw new PreconditionFailed(`blob upload for ${stream}/${recordKey} did not return its content-addressed id`);
    }
    await this.ingestRecord(stream, recordKey, {
      id: recordKey,
      name: recordKey,
      updated_at: "2026-03-01T00:00:00Z",
      blob_ref: {
        blob_id: uploaded.blob_id,
        mime_type: mimeType,
        size_bytes: bytes.length,
        sha256,
      },
    });
    return uploaded.blob_id;
  }

  private async stageBlobFixture(): Promise<BlobFixture> {
    const mimeType = "application/octet-stream";
    const bytes = Buffer.from("PDPP conformance shared persisted blob\n".repeat(64));
    await this.stageBlob("conformance_private_attachments", "att_shared_private", bytes, mimeType);
    const blobId = await this.stageBlob("conformance_attachments", "att_1", bytes, mimeType);
    const outOfGrantBlobId = await this.stageBlob(
      "conformance_private_attachments",
      "att_private_1",
      Buffer.from("PDPP conformance private-only persisted blob\n".repeat(32)),
      mimeType
    );
    return {
      blobId,
      outOfGrantBlobId,
      sharedBlob: { blobId, mimeType, rawBytes: new Uint8Array(bytes) },
      mimeType,
      rawBytes: new Uint8Array(bytes),
      grantRequest: { streams: [{ name: "conformance_attachments", fields: ["id", "name", "blob_ref"] }] },
    };
  }

  /**
   * Approve the pending consent a consumed single_use grant came from, a second
   * time. Null is the conformant answer (the AS refused); a grant is returned
   * only if the AS issued one. A transport failure or a 5xx throws instead, so
   * a broken run is never read as a refusal.
   */
  async reissueAgainstConsumedGrant(grantId: string): Promise<IssuedGrant | null> {
    const approval = this.approvalsByGrant.get(grantId);
    if (!approval) {
      throw new PreconditionFailed(
        `grant ${grantId} was not issued by this adapter, so its consent cannot be repeated`
      );
    }
    let response: Response;
    try {
      response = await postJson(`${this.config.asUrl}/consent/approve`, {
        request_uri: approval.requestUri,
        ...(approval.revision ? { approval_review_revision: approval.revision } : {}),
      });
    } catch (error) {
      throw new PreconditionFailed(
        `repeating the approval could not reach the target: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    if (response.status >= 500) {
      throw new PreconditionFailed(await describeRefusedStep(`repeated approval of grant ${grantId}`, response));
    }
    const body = parseJson(await response.text());
    if (response.ok && typeof body?.token === "string" && typeof body.grant_id === "string") {
      return { grantId: body.grant_id, accessToken: body.token, streams: [] };
    }
    return null;
  }

  /**
   * Arrange one grant over two connections of one connector.
   *
   * The reference AS lets the owner open several draft connections for a
   * connector whose declaration carries static-secret setup metadata. The boot
   * script registers such a connector (`conformance-fanin`); this hook opens two
   * drafts, ingests records into each, and asks for one grant whose stream lists
   * both instance handles.
   */
  issueMultiInstanceGrant(): Promise<MultiInstanceFixture> {
    this.multiInstanceOnce ??= this.arrangeMultiInstance().catch((error: unknown) => {
      this.multiInstanceOnce = null;
      throw error;
    });
    return this.multiInstanceOnce;
  }

  private async arrangeMultiInstance(): Promise<MultiInstanceFixture> {
    const connectorId = "conformance-fanin";
    const stream = "conformance_items";
    // A draft connection opened without an owner session belongs to the
    // deployment's open-owner subject, so the whole arrangement runs as it.
    const token = await this.mintOwnerToken(FANIN_OWNER_SUBJECT);
    const first = await this.openDraft(connectorId, token);
    const second = await this.openDraft(connectorId, token);
    const instanceIds = [first, second];
    const seeded = await Promise.all(
      instanceIds.map((instanceId, index) => this.seedFanInInstance(connectorId, stream, instanceId, index, token))
    );
    const grant = await this.approveFanInGrant(connectorId, stream, instanceIds);
    return { stream, cursorField: "seen_at", instanceIds, records: seeded.flat(), grant };
  }

  private async openDraft(connectorId: string, token: string): Promise<string> {
    const draft = await stepJson<{ connector_instance_id?: string }>("draft connection", () =>
      postJson(`${this.config.asUrl}/_ref/connectors/${connectorId}/draft-connection`, {}, token)
    );
    if (!draft.connector_instance_id) {
      throw new PreconditionFailed("draft connection returned no connector_instance_id");
    }
    return draft.connector_instance_id;
  }

  /**
   * Ingest 70 records into one instance. Instance 0 steps its cursor by 2
   * minutes and instance 1 by 3, so values interleave and coincide every sixth
   * minute. Every ninth record has no cursor value: null on instance 0, absent
   * on instance 1.
   */
  private async seedFanInInstance(
    connectorId: string,
    stream: string,
    instanceId: string,
    index: number,
    token: string
  ): Promise<{ id: string; instanceId: string; cursor: string | null }[]> {
    const base = Date.parse("2026-03-01T00:00:00Z");
    const records: { id: string; instanceId: string; cursor: string | null }[] = [];
    const lines: string[] = [];
    for (let n = 0; n < 70; n += 1) {
      const id = `${index === 0 ? "a" : "b"}${String(n).padStart(3, "0")}`;
      const cursor = n % 9 === 4 ? null : new Date(base + n * (2 + index) * 60_000).toISOString().replace(".000Z", "Z");
      records.push({ id, instanceId, cursor });
      const data: Record<string, unknown> = { id, name: id };
      if (cursor !== null) {
        data.seen_at = cursor;
      } else if (index === 0) {
        data.seen_at = null;
      }
      lines.push(JSON.stringify({ type: "RECORD", stream, key: id, data, emitted_at: new Date(base).toISOString() }));
    }
    const ingested = await stepJson<{ records_accepted?: number }>(`ingest into ${instanceId}`, () =>
      fetch(
        `${this.config.rsUrl}/v1/ingest/${stream}?${new URLSearchParams({ connector_id: connectorId, connector_instance_id: instanceId })}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson", Authorization: `Bearer ${token}` },
          body: lines.join("\n"),
        }
      )
    );
    if (ingested.records_accepted !== lines.length) {
      throw new PreconditionFailed(
        `ingest into ${instanceId} accepted ${ingested.records_accepted ?? 0} of ${lines.length}`
      );
    }
    return records;
  }

  /** PAR, review and approve one grant whose stream lists every instance handle. */
  private async approveFanInGrant(connectorId: string, stream: string, instanceIds: string[]): Promise<IssuedGrant> {
    const { clientId } = this;
    if (!clientId) {
      throw new PreconditionFailed("issueMultiInstanceGrant called before setup() registered a client");
    }
    const par = await stepJson<{ request_uri?: string }>("PAR (fan-in selection request)", () =>
      postJson(`${this.config.asUrl}/oauth/par`, {
        client_id: clientId,
        client_display: { name: "pdpp-conformance-suite" },
        authorization_details: [
          {
            type: DATA_ACCESS_TYPE,
            source: { id: `https://registry.pdpp.dev/connectors/${connectorId}`, kind: "connector" },
            purpose_code: "https://pdpp.dev/purpose/personal_analytics",
            access_mode: "continuous",
            streams: [{ name: stream, instance_ids: instanceIds }],
          },
        ],
      })
    );
    if (!par.request_uri) {
      throw new PreconditionFailed("PAR (fan-in selection request) returned no request_uri");
    }
    const requestUri = par.request_uri;
    const reviewed = await this.reviewPending(requestUri, undefined, FANIN_OWNER_SUBJECT);
    if ("status" in reviewed) {
      throw new PreconditionFailed(
        `fan-in consent review was refused: HTTP ${reviewed.status} ${reviewed.errorCode ?? ""}`
      );
    }
    const approval = await stepJson<{
      token?: string;
      grant_id?: string;
      grant?: { streams?: { name?: string; fields?: string[]; instance_ids?: string[] }[] };
    }>("fan-in consent approval", () =>
      postJson(`${this.config.asUrl}/consent/approve`, {
        request_uri: requestUri,
        ...(reviewed.revision ? { approval_review_revision: reviewed.revision } : {}),
      })
    );
    if (!(approval.token && approval.grant_id)) {
      throw new PreconditionFailed("fan-in consent approval returned no token/grant_id");
    }
    const granted = approval.grant?.streams?.find((s) => s.name === stream);
    if (!instanceIds.every((id) => granted?.instance_ids?.includes(id))) {
      throw new PreconditionFailed(
        `the grant does not list both instance handles (it lists ${JSON.stringify(granted?.instance_ids ?? [])}), so fan-in cannot be isolated`
      );
    }
    return {
      grantId: approval.grant_id,
      accessToken: approval.token,
      streams: [{ name: stream, fields: [...(granted?.fields ?? [])] }],
    };
  }

  /**
   * Offer a source declaration by registering it as a connector manifest
   * (`POST /connectors`), which is the reference AS's only onboarding route.
   * Registration creates no grant and approves nothing.
   *
   * What the manifest language cannot express is not simulated: a
   * `provider_native` source (the manifest has no source kind) and per-field
   * blob `mime_type` values (the manifest declares no media type) return null,
   * so the cases that need them report `skip` naming this hook.
   */
  async submitDeclaration(declaration: SourceDeclarationSubmission): Promise<DeclarationOutcome | null> {
    if (declaration.source.kind !== "connector") {
      return null;
    }
    const connectorKey = declaration.source.id.split("/").filter(Boolean).at(-1) ?? "conformance";
    const manifest = {
      protocol_version: "0.1.0",
      connector_id: connectorKey,
      connector_key: connectorKey,
      manifest_uri: declaration.source.id,
      version: declaration.declarationVersion,
      display_name: connectorKey,
      runtime_requirements: { bindings: { network: { required: true } } },
      capabilities: { human_interaction: ["credentials"] },
      streams: declaration.streams.map((stream) => this.manifestStream(stream)),
      ...(declaration.selectionPresets
        ? {
            profiles: declaration.selectionPresets.map((preset) => ({
              id: preset.name,
              label: preset.name,
              streams: preset.streams.map((name) => ({ name })),
            })),
          }
        : {}),
    };
    let response: Response;
    try {
      response = await postJson(`${this.config.asUrl}/connectors`, manifest);
    } catch (error) {
      throw new PreconditionFailed(
        `declaration could not reach the target: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
    const text = await response.text();
    const errorCode = errorCodeOf(parseJson(text));
    // A 5xx that names a declaration defect is still the AS's decision about the
    // document; one with no structured code is a broken run, not a refusal.
    if (response.status >= 500 && errorCode === undefined) {
      throw new PreconditionFailed(`declaration registration answered ${response.status}: ${text.slice(0, 200)}`);
    }
    // Read back what the AS holds after the call, refused or not: a refused
    // equivocation must leave the earlier content in place (clause 5.8-4).
    const retained = await this.retainedDeclaration(connectorKey);
    return {
      accepted: response.ok,
      status: response.status,
      body: text,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(retained === null ? {} : { retainedContent: retained }),
    };
  }

  /** A declaration stream as a manifest stream: the offered schema, else string fields. */
  private manifestStream(stream: SourceDeclarationStream): Record<string, unknown> {
    const timestamps = new Set([stream.cursorField, stream.consentTimeField]);
    const schema = stream.schema ?? {
      type: "object",
      properties: Object.fromEntries(
        stream.fields.map((f) => [f, timestamps.has(f) ? { type: "string", format: "date-time" } : { type: "string" }])
      ),
      required: stream.primaryKey ? [...stream.primaryKey] : [],
    };
    return {
      name: stream.name,
      description: stream.name,
      semantics: "mutable_state",
      schema,
      primary_key: stream.primaryKey ? [...stream.primaryKey] : ["id"],
      ...(stream.cursorField === undefined ? {} : { cursor_field: stream.cursorField }),
      ...(stream.consentTimeField === undefined ? {} : { consent_time_field: stream.consentTimeField }),
      selection: { fields: true, resources: true },
      coverage_strategy: "full_inventory",
      freshness_strategy: "manual_as_of",
      incremental: true,
    };
  }

  /** The streams and fields the AS now holds for a connector, read back from its detail route. */
  private async retainedDeclaration(connectorKey: string): Promise<SourceDeclarationStream[] | null> {
    try {
      const response = await fetch(`${this.config.asUrl}/connectors/${encodeURIComponent(connectorKey)}`);
      const body = parseJson(await response.text());
      const streams = (body?.streams ?? (body?.manifest as { streams?: unknown } | undefined)?.streams) as
        | { name?: string; schema?: { properties?: Record<string, unknown> } }[]
        | undefined;
      if (!(response.ok && Array.isArray(streams))) {
        return null;
      }
      return streams.flatMap((s) =>
        typeof s.name === "string" ? [{ name: s.name, fields: Object.keys(s.schema?.properties ?? {}) }] : []
      );
    } catch {
      return null;
    }
  }

  /**
   * Revoke with an owner bearer (the route accepts the owner, or the client
   * whose grant it is). A refused revoke throws, so the revocation cases skip
   * instead of judging a grant that was never revoked.
   */
  async revokeGrant(grantId: string): Promise<void> {
    const ownerToken = await this.mintOwnerToken(this.config.subjectId);
    await step(`revoke grant ${grantId}`, () =>
      fetch(`${this.config.asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    );
  }

  async ownerToken(): Promise<string | null> {
    return await this.mintOwnerToken(this.config.subjectId);
  }

  foreignSubjectRecordIds(stream: string): Promise<readonly string[] | null> {
    return Promise.resolve(this.config.foreignSubjectRecordIds?.[stream] ?? null);
  }

  async foreignSubjectOwnerToken(): Promise<string | null> {
    if (!this.config.foreignSubjectId) {
      return null;
    }
    return await this.mintOwnerToken(this.config.foreignSubjectId);
  }
}

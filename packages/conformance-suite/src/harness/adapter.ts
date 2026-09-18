// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The target adapter contract: the ONLY seam between the suite and an
// implementation under test.
//
// Everything the suite knows about a target comes through this interface. The
// test bodies speak HTTP against `baseUrl` and nothing else — no import of a
// reference server, no in-process handle, no privileged back door. That is what
// makes a result portable: the same suite run against a different vendor's
// resource server exercises the same code path, and a target that passes cannot
// have passed by virtue of being the reference implementation.
//
// The adapter's job is the two things a black-box HTTP client genuinely cannot
// do for itself: obtain credentials (the spec deliberately leaves owner-token
// acquisition out of scope — Core Section 8 "Authentication"), and provision
// known data to assert against (a grant-enforcement test against an empty store
// passes vacuously). Both are deployment-specific by design, so they are
// parameters rather than assumptions.

import type { ReviewEvidence } from "../report/review-evidence.ts";
import type { Role } from "../requirements/catalog.ts";
import type { PdppResponse } from "./http.ts";

/**
 * A stream the target has provisioned for the run, with the facts the suite
 * needs to build valid and invalid requests against it.
 */
export interface SeededStream {
  /**
   * The field `time_range` is evaluated against, when the stream declares one.
   *
   * Core Section 5: "Streams that cannot define a stable `consent_time_field`
   * simply omit it. The absence of `consent_time_field` is the normative signal
   * that the stream does not support time-range filtering." So ABSENCE here is
   * load-bearing rather than merely unknown — it is what makes clauses 5.2-4
   * and 6.8-2 observable, since both are about refusing `time_range` on a
   * stream that declares no such field. A suite with no time-range-incapable
   * stream cannot construct that negative at all.
   *
   * Distinct from `cursorField`: Core requires the two to be declared
   * separately because one governs sync order and the other governs which
   * records fall inside the consented window.
   */
  readonly consentTimeField?: string;
  /** Cursor field used for stable sort, if the stream declares one. */
  readonly cursorField?: string;
  /**
   * The current query/view/relationship capabilities this stream's own
   * retained declaration advertises, independent of any grant.
   *
   * This is what RS-14 checks an owner-token metadata read against. It MUST
   * come from the adapter's own record of what it declared/seeded — never by
   * calling the metadata endpoint under test and treating the response as its
   * own oracle. Absent means the adapter declares no such capability for this
   * stream, in which case RS-14 can only check schema completeness.
   */
  readonly expectedOwnerMetadata?: {
    readonly query?: Readonly<Record<string, unknown>>;
    readonly relationships?: readonly unknown[];
    /** Declared item type for array-typed fields (JSON Schema `items.type`), a nested constraint distinct from flat field type. */
    readonly schemaFieldItemTypes?: Readonly<Record<string, string>>;
    /** Per-field JSON Schema type, for detecting a corrupted (not just missing) schema. */
    readonly schemaFieldTypes?: Readonly<Record<string, string>>;
    /** Fields the schema's `required` array must name (Core Section 5), independent of field presence. */
    readonly schemaRequired?: readonly string[];
    readonly views?: readonly unknown[];
  };
  /** Field names present in the declared schema. */
  readonly fields: readonly string[];
  readonly name: string;
  /** Primary key field names, per Core Section 4. */
  readonly primaryKey: readonly string[];
  /** Number of records the adapter seeded into this stream. */
  readonly recordCount: number;
  /** Core Section 4 stream semantics. Gates the `changes_since` requirements. */
  readonly semantics: "append_only" | "mutable_state";
}

/**
 * Capabilities the target declares. These decide `unsupported` vs `fail`: a
 * target that does not implement an optional capability is not non-conformant,
 * but it also cannot claim coverage of the requirements gated on it.
 *
 * Declarations are the target's own claim. The suite verifies the ones it can
 * (a target declaring `selfExport` that then rejects owner reads fails RS-13)
 * rather than taking every declaration on trust.
 */
export interface TargetCapabilities {
  /** Blob storage and the blob endpoint are implemented. */
  readonly blobs: boolean;
  /** `changes_since` incremental sync is implemented (RS-7, RS-8). */
  readonly incrementalSync: boolean;
  /** Owner tokens are issued, enabling owner-scope and self-export coverage. */
  readonly ownerTokens: boolean;
  /** Refresh tokens are issued (AS-20). */
  readonly refreshTokens: boolean;
  /** Owner tokens may read records without a client grant (RS-13). */
  readonly selfExport: boolean;
  /** AS and RS are separate services communicating over RFC 7662. */
  readonly separatedDeployment: boolean;
  /** `single_use` grants are supported (AS-10). */
  readonly singleUseGrants: boolean;
  /** Named views are supported at issuance (AS-12, AS-13). */
  readonly views: boolean;
}

/**
 * A grant the adapter arranged, plus the access token bound to it.
 *
 * The suite asks for grants by shape (below) and receives the token to use.
 * It does not mint tokens itself and does not require any particular token
 * format: Core Section 8 makes token format opaque to the RS, so it is opaque
 * to the suite too.
 */
export interface IssuedGrant {
  readonly accessToken: string;
  readonly grantId: string;
  /**
   * The issued grant artifact exactly as the target's approval response carried
   * it, unparsed and unreshaped.
   *
   * Absent when the target's approval surface returns no grant body. AS-3 needs
   * the whole Section 7 grant to validate its field tables, and the adapter must
   * not manufacture one: a synthesized body would echo the suite's own request
   * and the case would measure itself. `unknown` (not a typed grant) because the
   * case under test is precisely whether the artifact has the right shape.
   */
  readonly rawGrant?: unknown;
  /**
   * Streams and the exact fields frozen into the grant.
   *
   * Adapters that cannot read the issued grant back fall back to the requested
   * shape here, so this field is NOT evidence of what the target resolved. Use
   * `rawGrant` for that.
   */
  readonly streams: readonly {
    readonly name: string;
    readonly fields: readonly string[];
  }[];
  /**
   * The token endpoint's response BODY for this grant, unparsed and unreshaped.
   *
   * For RFC 9396 Section 7: "the AS MUST return the `authorization_details` as
   * granted in the token response" when the request carried them. Core adopts
   * the RFC 9396 envelope by normative reference (Section 2, "Related
   * standards") and describes both the selection request and the introspection
   * response — but never restates this token-response obligation, so no Core
   * clause covers it and it is tracked on the case rather than in the matrix.
   *
   * `unknown` rather than a typed body BECAUSE the case under test is whether
   * the body has the right shape; typing it would let the adapter's reshaping
   * supply the field the case is looking for. Absent when the adapter obtains
   * tokens by a route with no HTTP token endpoint, which reports the case
   * `skip` naming this hook.
   */
  readonly tokenResponseBody?: unknown;
  /**
   * The response headers the TOKEN ENDPOINT returned alongside this token,
   * lower-cased, exactly as received.
   *
   * Clause 10.2-4: "Every successful OAuth token response that contains an
   * access token or refresh token MUST include `Cache-Control: no-store` and
   * `Pragma: no-cache` before the response is serialized." Those headers are the
   * whole of the obligation, and they are discarded by every adapter that parses
   * a token out of a body and returns the string — which is why the clause sat
   * untested while the suite obtained tokens constantly.
   *
   * It must be the headers of the TOKEN response specifically, not of some later
   * request: the requirement is about what a caching intermediary may retain of
   * the credential-bearing response. An adapter that mints tokens by a route
   * with no HTTP token endpoint (an in-process target, a device-code shortcut)
   * omits this, and the case reports `skip` naming the hook rather than reading
   * an absent header map as an absent header.
   */
  readonly tokenResponseHeaders?: Readonly<Record<string, string>>;
}

/**
 * An authorization request staged but not yet approved, with the handles needed
 * to attempt approval — correctly, twice, or with a stale revision.
 */
export interface StagedApproval {
  /**
   * The final approval artifact the server would bind this approval to, exactly
   * as it publishes it — unparsed and unreshaped.
   *
   * Core Section 7.2 requires that artifact to carry the exact resolved
   * `instance_ids`, stream names, fields, resources, temporal field, `since`,
   * `until`, purpose, retention, client identity and grant expiry (clause
   * 7.2-2), and, when `client_claims` were rendered, the normalized claims with
   * client attribution (clause 6.3-2). None of that is visible from a finished
   * grant: by then the artifact either carried the right facts or the grant is
   * wrong, and both look the same from outside.
   *
   * `unknown` rather than a typed artifact BECAUSE the case under test is
   * whether the artifact has the right shape. Typing it here would let the
   * adapter's own reshaping supply the fields the case is meant to find, and
   * the case would then be measuring the adapter. Absent when the server
   * publishes no separable artifact, which reports the cases `skip`.
   */
  readonly approvalArtifact?: () => Promise<unknown>;
  /**
   * Approve this staged request. Returns the grant, or null if refused.
   *
   * `explicitAiTrainingConsent` is separate from the review revision because
   * AS-14 needs to approve the identical staged request twice — once with the
   * flag, once without — and a revision is consumed by its first use.
   */
  readonly approve: (revision?: string, explicitAiTrainingConsent?: boolean) => Promise<IssuedGrant | null>;
  /** Opaque handle for the pending request (a session id, request_uri, ...). */
  readonly handle: string;
  /**
   * The status and machine-readable error code from the most recent `approve`
   * call that returned null, when the refusal was a structured denial rather
   * than a transport failure (network error, non-JSON body, no error code).
   *
   * AS-14's negative control needs to tell "the server refused issuance
   * because consent was missing" apart from "the request never reached the
   * server intelligibly" — both look like `approve` returning null, and only
   * this distinguishes them.
   */
  readonly lastApproveError?: () => { readonly status: number; readonly errorCode?: string } | null;
  /**
   * Replay the token-endpoint redemption of the authorization code from the
   * most recent successful `approve`, with the same PKCE verifier, so AS-19
   * can observe what the token endpoint does on a genuine second redemption
   * rather than on a second approval of the staged request (a different step:
   * Section 9 AS item 19 governs code consumption at the token endpoint, not
   * approval idempotency).
   *
   * The code itself is never exposed outside the adapter — this method is the
   * only way to act on it a second time. Returns null if no code has been
   * redeemed yet (`approve` was never called or never succeeded), or on a
   * transport failure the case cannot distinguish from a real refusal;
   * `errorCode`/`status` on a non-null result carry the classification a real
   * refusal needs.
   */
  readonly replayLastCode?: () => Promise<{
    readonly status: number;
    readonly errorCode?: string;
    readonly accessToken?: string;
  } | null>;
  /**
   * The revision or digest the server bound the reviewed facts to, if it
   * publishes one. Absent when the server has no such concept.
   */
  readonly reviewRevision?: string;
}

/**
 * The outcome of submitting a selection request, without approving it.
 *
 * Section 9 AS items 2, 5 and 6 are about what the AS REFUSES at selection time,
 * which a successful grant cannot show: an accepted request proves nothing about
 * what an unacceptable one would have done. The adapter reports the status and
 * the machine-readable error code so a case can assert the classification rather
 * than merely that "something failed" — a server that rejects everything with
 * 500 would otherwise pass a naive refusal oracle.
 */
export interface SelectionOutcome {
  /** Raw body, for report evidence. */
  readonly body?: unknown;
  /** The RFC 9396 / OAuth error code, when the response carried one. */
  readonly errorCode?: string;
  readonly status: number;
}

/**
 * A source declaration offered to the AS's onboarding surface.
 *
 * Deliberately only the fields Core Section 5's trust rules turn on. A fuller
 * declaration type would invite cases to assert on content the clauses do not
 * govern, and the point here is the acceptance decision, not schema validation.
 */
export interface SourceDeclarationSubmission {
  /**
   * The authority binding the AS onboarded this declaration under, when the
   * caller wants to name one the AS never accepted (clause 5.8-1). Absent means
   * the adapter's own accepted authority.
   */
  readonly authority?: string;
  /** Opaque, non-empty revision id. Core assigns it NO ordering meaning. */
  readonly declarationVersion: string;
  /**
   * Selection presets this declaration defines (Core Section 6 "Selection
   * presets"), for clause 6.9-1.
   *
   * Carried on the DECLARATION rather than on a request because that is where
   * the obligation sits: "Each selection preset MUST NOT contain the same
   * stream name more than once. Duplicate stream names make the declaration
   * invalid. They are not deferred to grant issuance." So the AS must refuse
   * the document, and a case that sent a duplicate-bearing REQUEST would be
   * testing a different rule (6.8-3) against a different surface.
   *
   * Absent means the declaration defines none, which is the ordinary case and
   * the shape every existing declaration-trust case submits.
   */
  readonly selectionPresets?: readonly { readonly name: string; readonly streams: readonly string[] }[];
  readonly source: { readonly kind: "connector" | "provider_native"; readonly id: string };
  /**
   * The declaration's parsed content, as whatever shape the target onboards.
   *
   * Clause 5.8-4 is about DIFFERENT content under one accepted key, so the
   * cases submit the same key twice with this differing, and the target must
   * refuse the second.
   *
   * `fields` stays the minimal shape the trust clauses (5.8-*) turn on. The
   * optional members below are the declaration-VALIDITY surface — the clauses
   * that ask whether the document is internally coherent, not whether its
   * authority is accepted. They are optional because a trust case must be able
   * to submit a declaration that carries none of them and still be judged on
   * authority alone; a required member would make every existing case assert
   * on content its clause does not govern.
   */
  readonly streams: readonly SourceDeclarationStream[];
}

/**
 * One stream of an offered declaration.
 *
 * The optional members are exactly the fields Core's declaration-validity
 * clauses reference, and no more:
 *
 * - `schema` / `primaryKey` / `cursorField` — clause 5.2-2, "`primary_key` and
 *   `cursor_field` MUST reference fields declared here".
 * - `consentTimeField` — clause 5.2-3, "MUST reference a field declared in the
 *   schema", and clause 5.4-1, which requires it to be declared separately from
 *   `cursor_field` even when it names the same field.
 * - `blobFields` — clause 4.8-1, "`mime_type` MUST be a valid IANA media type".
 *
 * `schema` is carried as the embedded JSON Schema object rather than a field
 * name list because clause 5.2-5 is about the schema DOCUMENT: its `$schema`
 * dialect, whether it meta-validates, and whether its `$ref`/`$dynamicRef`
 * values are local. A flattened name list could not express any of those.
 */
export interface SourceDeclarationStream {
  /**
   * `blob_ref` fields this stream declares, with the media type each claims.
   *
   * Only the `mime_type` is carried: clause 4.8-1 governs that value and
   * nothing else about a `blob_ref`, and a fuller blob shape would invite a
   * case to assert on content the clause does not reach.
   */
  readonly blobFields?: readonly { readonly name: string; readonly mimeType: string }[];
  /** `consent_time_field`, when the stream declares one (clauses 5.2-3, 5.4-1). */
  readonly consentTimeField?: string;
  /** `cursor_field`, when the stream declares one (clauses 5.2-2, 5.4-1). */
  readonly cursorField?: string;
  readonly fields: readonly string[];
  readonly name: string;
  /** `primary_key`, when the stream declares one (clause 5.2-2). */
  readonly primaryKey?: readonly string[];
  /**
   * The embedded JSON Schema for the stream's `data` field (clause 5.2-5).
   *
   * `unknown` rather than a typed schema object on purpose: the negative cases
   * must offer documents that are NOT valid schemas (a bad `$schema` dialect, a
   * remote `$ref`, a meta-invalid constraint), and a type that only admitted
   * valid schemas could not express them.
   */
  readonly schema?: unknown;
  /**
   * Whether the declaration claims this stream supports `time_range`
   * (clause 5.4-1).
   *
   * Core derives time-range capability from `consent_time_field` PRESENCE, so a
   * stream claiming the capability without declaring the field is asking the AS
   * to infer the consent boundary from `cursor_field` — exactly what 5.4-1
   * forbids ("they serve different purposes and MUST be declared separately").
   * Carried as an explicit claim rather than inferred from `selection` because
   * the violation is the claim itself: a case must be able to make it and see
   * whether the AS refuses.
   */
  readonly timeRangeCapable?: boolean;
}

/** What the AS did with an offered declaration. */
export interface DeclarationOutcome {
  readonly accepted: boolean;
  /** Raw body, for report evidence. */
  readonly body?: unknown;
  /** Machine-readable error code, when the refusal carried one. */
  readonly errorCode?: string;
  /**
   * The content the AS retains for this key AFTER the call, when the target can
   * report it. Clause 5.8-4 requires the PREVIOUSLY accepted content to survive
   * a refused equivocation, and only this makes that half observable.
   */
  readonly retainedContent?: readonly SourceDeclarationStream[];
  readonly status?: number;
}

/**
 * A URL-hosted client identity document offered to an AS, for clauses 6.1-2
 * and 6.1-4.
 *
 * Deliberately carries the document as a raw string rather than a typed
 * object: the malformed case must offer something that is NOT a valid document,
 * and a typed field could not express it.
 */
export interface UrlHostedClientOffer {
  /**
   * The exact bytes to serve at `documentUrl`.
   *
   * The suite serves this itself, so the AS performs a real outbound fetch and
   * the case observes what it does with a document it genuinely retrieved.
   */
  readonly document: string;
  /**
   * The `client_id` the authorization attempt carries, which is also the URL
   * the document is served from. The two being the same is the whole identity
   * check.
   */
  readonly documentUrl: string;
  /** A redirect URI the document declares, for the AS to validate against. */
  readonly redirectUri: string;
}

/** What an AS did with an offered URL-hosted client identity. */
export interface UrlHostedClientOutcome {
  /**
   * Whether the AS ACCEPTED the identity — resolved the document and admitted
   * the client. False means it refused the identity itself.
   */
  readonly accepted: boolean;
  /** Raw body, for report evidence. */
  readonly body?: unknown;
  /** Whether the AS actually fetched the document the suite served. */
  readonly documentFetched?: boolean;
  /** Machine-readable error code, when the refusal carried one. */
  readonly errorCode?: string;
  /**
   * True when the AS resolved the identity successfully and then declined
   * authorization under LOCAL POLICY.
   *
   * Clause 6.1-3 permits exactly this: the server "MAY still deny
   * authorization, rate-limit the client, or require a registry-derived trust
   * or admission result, under local policy and for any reason other than the
   * absence of preregistration". Without this flag a permitted denial and a
   * forbidden rejection are the same observation, and the cases would report a
   * conforming server as non-conformant.
   */
  readonly policyDenied?: boolean;
  readonly status?: number;
}

/**
 * A per-stream authorization minimum, as PR #1 (v0.2) defines it.
 *
 * The floor beneath the request's ceiling: `fields`/`time_range` on a stream
 * say what the client may receive AT MOST, and `minimum` says what it must
 * receive for the stream to be worth retaining at all. The AS resolves between
 * the two, and refuses a required stream it cannot satisfy.
 *
 * Deliberately NOT modelled as "the request minus what the owner dropped".
 * PR #1 makes the minimum an explicit client assertion, and the whole point of
 * `v0.2/6.5-5` is that the AS must not infer one from a schema's `required`
 * array. A suite that derived the minimum instead of sending it could not tell
 * an AS that honours an explicit floor from one that invented it.
 */
export interface AuthorizationMinimum {
  readonly fields?: readonly string[];
  readonly timeRange?: { readonly since: string; readonly until: string };
}

/**
 * Narrowing the OWNER applies at the consent step, for the v0.2 cases.
 *
 * v0.2's central obligation is that the owner's choices bound the grant, so a
 * case cannot demonstrate it without a way to express a choice. PR #1 does not
 * specify how a choice reaches the AS — batch 28's receipt records the
 * query-string vocabulary as that implementation's own — so this is the
 * suite's neutral description of the choice, and each adapter maps it to
 * whatever its target accepts. An adapter with no owner-narrowing surface
 * returns null and the case reports `skip`, not `fail`: Core does not require
 * the affordance, only that choices are honoured when made.
 */
export interface OwnerChoices {
  /** Streams the owner declines outright. */
  readonly declineStreams?: readonly string[];
  /** Fields the owner keeps, per stream. A stream absent here is unnarrowed. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  /** Time window the owner keeps, per stream. */
  readonly timeRange?: Readonly<Record<string, { readonly since?: string; readonly until?: string }>>;
}

/** A selection request expressed in the shapes Core Section 6 defines. */
export interface SelectionRequest {
  /** An unsupported PDPP-Version, for AS-17. */
  readonly pdppVersion?: string;
  readonly purposeCode?: string;
  /** Mutually exclusive with `streams` — AS-5 requires exactly one. */
  readonly selectionPreset?: string;
  /**
   * Send this request under a specific PDPP revision's RFC 9396 detail type.
   *
   * Defaults to v0.1 so every existing case keeps sending exactly the bytes it
   * sent before. A v0.2 case sets `"0.2"`, and the adapter emits
   * `https://pdpp.dev/data-access/0.2` instead. This is a request-shape switch,
   * not a feature flag: v0.2 is a SEPARATE detail type, so the same body means
   * different things under each and a target may implement one without the
   * other.
   */
  readonly specVersion?: "0.1" | "0.2";
  /**
   * Omit `fields` to test AS-4 expansion; name an undeclared one to test AS-2.
   *
   * `view` names a view at request scope (Core Section 6 request parameters).
   * It is mutually exclusive with `fields`, and a request setting both is
   * exactly the 6.8-1 negative: the AS must answer 400 `invalid_request`. The
   * suite can therefore send an invalid combination on purpose, which is why
   * both are optional and independently settable rather than a union.
   */
  readonly streams?: readonly {
    readonly name: string;
    readonly fields?: readonly string[];
    /**
     * The v0.2 floor for this stream. Ignored under v0.1, where the member does
     * not exist — `v0.2/1-1` requires an AS implementing both types to resolve
     * a v0.1 request rather than drop it, so a case can send exactly that.
     */
    readonly minimum?: AuthorizationMinimum;
    /** v0.2 `necessity`. Absent means the AS applies its default, `required`. */
    readonly necessity?: "required" | "optional";
    readonly view?: string;
  }[];
  /**
   * A temporal constraint to request on every named stream.
   *
   * Carried on the request rather than per stream because the negative these
   * clauses need is "ask for `time_range` on a stream that declares no
   * `consent_time_field`", and the case names exactly one stream when it does
   * so. A target that ignores this field entirely cannot be distinguished from
   * one that refuses correctly, so the cases pair it with a positive control
   * against a time-range-capable stream.
   */
  readonly timeRange?: { readonly since?: string; readonly until?: string };
}

/**
 * A refresh-token family, for the AS-20 rotation and reuse-detection oracle.
 *
 * `refresh` returns null when the AS refuses, which is the expected outcome for
 * the reuse leg and a failure for the rotation leg — the case distinguishes them.
 */
export interface RefreshableGrant {
  readonly accessToken: string;
  readonly refresh: (token: string) => Promise<RefreshableGrant | null>;
  readonly refreshToken: string;
}

/**
 * A known, already-seeded blob and the grant needed to reach it, for the RS-1
 * "get a blob" case.
 *
 * Section 8 names `GET /v1/blobs/:blob_id` as one of the RS-1 query endpoints,
 * but the byte-fetch route needs a persisted blob and a referencing record with
 * `blob_ref` in scope — neither of which the suite can seed itself (Core leaves
 * blob storage deployment-specific). Optional: a target with no seeded blob
 * fixture reports RS-1's blob case `skip` naming this hook, rather than the
 * suite fabricating a blob or reading the byte-fetch requirement as satisfied
 * by a target that merely declares `capabilities.blobs`.
 */
export interface BlobFixture {
  /** Known blob id to fetch at `GET {queryBase}/blobs/:blobId`. */
  readonly blobId: string;
  /** Independent proof of the stored bytes when the adapter does not retain them: their SHA-256 digest and exact length. */
  readonly digest?: { readonly sha256: string; readonly length: number };
  /** Grant request that includes the stream/field carrying `blob_ref` for the seeded record. */
  readonly grantRequest: GrantRequest;
  /** Declared MIME type, expected as the fetch response's `Content-Type`. */
  readonly mimeType: string;
  /**
   * A second, persisted blob id that exists on the target but is NOT
   * referenced by any record in `grantRequest`'s streams — i.e. a blob the
   * `grantRequest` grant cannot discover through an authorized record.
   *
   * Section 8 "Get a blob" (spec-core.md#resource-server-interface): "A
   * `blob_id` alone does not grant access. The client MUST have discovered
   * the blob through an authorized record." This is the fact that makes that
   * requirement observable: without a second, out-of-grant blob that is known
   * to exist, a 404/403 on a made-up id proves nothing (a target could 404
   * everything and still leak real ids). Optional: a target that cannot
   * provision a second blob outside the grant reports the negative case
   * `skip` naming this field, rather than the suite fabricating an id or
   * treating a bare 404 on an unknown id as proof of enforcement.
   */
  readonly outOfGrantBlobId?: string;
  /**
   * The exact bytes stored at upload time, when the adapter can hold them in
   * memory. Mutually exclusive in practice with `digest` — supply whichever is
   * cheaper for the target to retain; the case only needs one independent way
   * to prove the returned bytes are the ones that were stored, not both.
   */
  readonly rawBytes?: Uint8Array;
}

/** The grant shape a test needs. The adapter arranges consent out of band. */
export interface GrantRequest {
  readonly accessMode?: "single_use" | "continuous" | "recurring";
  /**
   * Client-authored, non-enforceable statements about THIS authorization
   * request (Core Section 6 "Client claims").
   *
   * Carried here because the clauses about them are all about what happens to
   * claims a client actually submitted: 7.2-4 (they stay outside the resolved
   * grant and RS enforcement) and 6.3-2 (if rendered, they are bound exactly,
   * with attribution, into the final approval artifact). Neither is observable
   * against a request that carried none — an absent claim is trivially outside
   * the grant, so the negative would pass against a server that silently
   * dropped every claim it was given.
   */
  readonly clientClaims?: { readonly commitments?: readonly string[] };
  /**
   * Explicit affirmative consent to the `ai_training` purpose code, carried
   * separately from the ordinary approval so AS-14's positive and negative
   * controls request the SAME grant shape and differ only in this flag.
   */
  readonly explicitAiTrainingConsent?: boolean;
  /**
   * Narrowing the owner applies before approving, for the v0.2 cases.
   *
   * Absent means the owner approves the request as made, which is what every
   * v0.1 case does and must keep doing.
   */
  readonly ownerChoices?: OwnerChoices;
  /** Purpose code for this request. Defaults to the adapter's own default when absent. */
  readonly purposeCode?: string;
  /**
   * Retention terms to request (Core Section 6), for clause 7.2-2.
   *
   * Clause 7.2-2 requires the final approval artifact to state retention, and a
   * server can only state what the request asked for — retention is a REQUESTED
   * term, not something the AS invents. A suite that never sent one and then
   * reported the artifact as missing retention would be publishing a finding
   * against a server that behaved correctly, which is exactly the kind of false
   * finding this suite exists not to produce.
   *
   * `maxDuration` is an ISO 8601 duration; `onExpiry` is what happens to the
   * data when it elapses.
   */
  readonly retention?: { readonly maxDuration: string; readonly onExpiry: "delete" | "anonymize" };
  /**
   * Request this grant under a specific PDPP revision's detail type.
   *
   * Defaults to v0.1, so existing cases are byte-identical. See
   * `SelectionRequest.specVersion` — the same switch, on the grant path.
   */
  readonly specVersion?: "0.1" | "0.2";
  readonly streams: readonly {
    readonly name: string;
    readonly fields: readonly string[];
    /** The v0.2 floor for this stream. */
    readonly minimum?: AuthorizationMinimum;
    /** v0.2 `necessity`. Absent means the AS applies its default, `required`. */
    readonly necessity?: "required" | "optional";
    /**
     * Request this stream's field set BY VIEW NAME instead of by `fields`.
     *
     * Core Section 5 "View evolution": the grant is bound to the field set
     * resolved at issuance, and `fields` in the StreamGrant is authoritative,
     * not the view name. Clause 5.6-2a is precisely that a later widening of
     * the view must not widen an already-issued grant — which is only
     * observable if a grant can be obtained by view name in the first place.
     * `fields` above stays required so a caller always records what it expects
     * the view to resolve to; the case compares that against the issued grant.
     */
    readonly view?: string;
  }[];
  /** Frozen time constraint, when the test exercises time-bound enforcement. */
  readonly timeConstraint?: {
    readonly field: string;
    readonly from?: string;
    readonly to?: string;
  };
}

/**
 * What a target must provide to be testable. Implemented once per target; the
 * in-repo reference target under `src/targets/` is one implementation and
 * carries no privileges the contract does not give every other.
 */
export interface TargetAdapter {
  /**
   * Base URL of the authorization server, when it is a separate service.
   *
   * The AS cases discover its endpoints from RFC 8414 metadata published here.
   * Absent for a co-located deployment, where there is no separate AS to query
   * and the introspection requirements do not apply.
   */
  readonly authorizationServerUrl?: string | undefined;
  /**
   * Base URL of the resource server, e.g. "http://localhost:4000".
   */
  readonly baseUrl: string;

  /**
   * A known, already-seeded blob plus the grant needed to reach it, for RS-1's
   * byte-fetch case. Returns null when this deployment has no seeded blob to
   * offer, which reports the case `skip` rather than treating
   * `capabilities.blobs` alone as evidence the byte-fetch endpoint works —
   * a target can declare the capability without this suite run having a
   * persisted blob to point at.
   */
  blobFixture?: () => Promise<BlobFixture | null>;
  readonly capabilities: TargetCapabilities;

  /**
   * Call a known co-located introspection endpoint directly, when the target
   * exposes one but publishes no RFC 8414 `introspection_endpoint` for
   * `discoverIntrospectionEndpoint` to find (Core Section 8's local-equivalent
   * allowance covers the endpoint's existence, not its discoverability).
   *
   * This is AS-9 evidence only — grant-bound tokens carrying the PDPP
   * introspection extension fields — not a general substitute for RFC 7662
   * client-credential introspection. A co-located deployment's local
   * equivalent commonly authenticates its introspection route with the SAME
   * owner-bearer credential used elsewhere on that deployment, which is a
   * distinct authentication model from the RS client-credential Basic auth
   * `introspectionCredentials` carries: this hook lets an adapter use its own
   * auth for that specific endpoint rather than forcing it through the RFC
   * 7662 shape. Absent means the target has no such reachable endpoint;
   * AS-9 reports `skip` (missing evidence), not `fail`.
   */
  coLocatedIntrospect?: (accessToken: string) => Promise<PdppResponse | null>;

  /**
   * The views this deployment's AS defines, per stream, as the ADAPTER's own
   * record of what it declared — never read back from the target.
   *
   * Core Section 5 "Views" makes the AS authoritative for views used in consent
   * and issued grants, and declaration-published views merely advisory. So the
   * suite cannot discover a view to test with: asking the target what views it
   * has and then checking the answer against itself measures nothing. The
   * adapter states what it arranged, and the cases check the target's behaviour
   * against that statement.
   *
   * `fields` is what the view is expected to resolve to. A view naming a field
   * absent from the stream's declared schema is the 5.6-2 violation, so the
   * adapter may deliberately declare one for a negative case — this is a
   * record of intent, not a promise of validity.
   *
   * Optional: a target that defines no views reports the view cases `skip`
   * naming this hook. Returning an empty array is the same thing said
   * explicitly. Gated on `capabilities.views`: a target declaring the
   * capability and then offering no view fails RS-14's honesty check rather
   * than silently skipping.
   */
  declaredViews?: () => Promise<
    readonly {
      readonly stream: string;
      readonly view: string;
      readonly fields: readonly string[];
    }[]
  >;

  /**
   * An access token whose bound grant has expired.  /**
   * An access token whose bound grant has expired. Exercised by the
   * expired-grant oracle. Optional: not every target can fabricate one.
   */
  expiredGrantToken?: () => Promise<string | null>;

  /**
   * Expire a `changes_since` token this target issued, for clause 4.3-2.
   *
   * Core Section 4 "Cursor expiry": expiring historical version data is a MAY,
   * but a server that DOES expire a cursor "MUST return HTTP 410 Gone with
   * error code `cursor_expired`" — a client's correctness depends on telling
   * "your cursor is too old, re-sync" apart from every other refusal, because
   * only the first calls for discarding its baseline and starting over.
   *
   * Aging a cursor is the one thing a black-box client cannot do for itself:
   * the alternative is sleeping out a real retention period, which is not a
   * test, or faking a clock, which tests the fake. So the target is asked to
   * retire a token it issued.
   *
   * Returns false when this deployment never expires cursors, which reports the
   * case `skip`: declining an optional retention policy is not a violation, and
   * the suite must not read it as one.
   */
  expireSyncCursor?: (stream: string, token: string) => Promise<boolean>;

  /**
   * A token for a DIFFERENT subject than the seeded one. Powers the
   * cross-subject negative oracle (RS-12): a target that cannot produce a
   * second subject cannot demonstrate subject scoping, and the case is
   * recorded `unsupported` rather than passing by absence of evidence.
   */
  foreignSubjectOwnerToken?: () => Promise<string | null>;

  /**
   * Mint a token bound to a grant whose GRANT SCHEMA version is `version`,
   * for clause 7.4-2.
   *
   * Core Section 7 "Version layering" keeps three version axes apart and
   * forbids conflating them. `grant.version` is the schema of the grant
   * artifact itself, and the RS "MUST reject grants with unsupported major
   * versions, returning 400 `unsupported_version`". That is a different axis
   * from the `PDPP-Version` request header, which is the only one the suite
   * could previously reach — a target could pass every header-axis case while
   * happily enforcing a grant whose schema it does not understand.
   *
   * The version is a parameter rather than a fixed "bad" constant so a case can
   * mint BOTH halves through one hook: the target's own supported major (the
   * positive control, which must still read) and an unsupported one (which must
   * be refused). Without the control, a target that refuses every token
   * produced by this hook satisfies the negative while being broken.
   *
   * Returns null when this deployment cannot bind a token to an arbitrary grant
   * schema version, which reports the case `skip` naming this hook. The suite
   * will not forge a grant body: the obligation is on the RS's handling of a
   * grant its own AS issued, and a suite-authored artifact would test the
   * suite's idea of the grant schema rather than the target's.
   */
  grantWithSchemaVersion?: (
    version: string,
    request: GrantRequest
  ) => Promise<{ readonly accessToken: string; readonly grantId: string } | null>;

  /**
   * Credentials a resource server uses to authenticate at the introspection
   * endpoint (RFC 7662 Section 2.1 client authentication).
   *
   * Required to exercise the introspection-content requirements at all: a
   * conforming AS rejects an unauthenticated caller, so without these the AS
   * cases can only observe that rejection and never the response body. Supplying
   * them does not weaken the AS-18 case, which deliberately calls without them.
   */
  readonly introspectionCredentials?: { readonly clientId: string; readonly clientSecret: string } | undefined;

  /**
   * Arrange consent for the requested grant and return a bound access token.
   * Returns null when the target cannot produce that grant shape, which the
   * runner records as `unsupported` rather than `fail`.
   */
  issueGrant: (request: GrantRequest) => Promise<IssuedGrant | null>;

  /**
   * Issue a grant that carries a refresh token, for the AS-20 family oracle.
   *
   * Separate from `issueGrant` because most cases neither need nor should see a
   * refresh token, and because a target may support grants without supporting
   * rotation. Returns null when this deployment issues none, which reports
   * `unsupported` rather than `fail`.
   */
  issueRefreshableGrant?: (request: GrantRequest) => Promise<RefreshableGrant | null>;

  /**
   * Offer a URL-hosted client identity document as the `client_id` of an
   * authorization attempt, and report what the AS did — clauses 6.1-2, 6.1-4.
   *
   * Core Section 6 "Client display": "a conforming authorization server MUST
   * NOT reject a valid client ID metadata document solely because the client is
   * not preregistered" (6.1-2), and "a conforming authorization server MUST
   * accept a valid URL-hosted client identity unless local policy denies
   * authorization" (6.1-4).
   *
   * `documentUrl` is BOTH the `client_id` and where the document is served
   * from. That identity is what the check turns on: the document must assert
   * the URL it was retrieved from, or any host could publish a document
   * claiming to be someone else's client.
   *
   * The AS is handed a URL by an untrusted caller and asked to fetch it, which
   * is an SSRF primitive, so every real implementation bounds it with a host
   * allowlist. The suite must therefore serve its document from a host the
   * deployment trusts — otherwise every case here observes a policy denial
   * (which clause 6.1-3 explicitly permits) and concludes nothing about 6.1-2
   * or 6.1-4.
   *
   * `accepted` is the IDENTITY decision alone. A target that resolved the
   * document and then denied authorization under local policy reports
   * `accepted: true` with `policyDenied: true` — the distinction 6.1-3 draws,
   * and the only thing keeping these cases from reading a permitted denial as a
   * violation.
   */
  offerUrlHostedClientIdentity?: (offer: UrlHostedClientOffer) => Promise<UrlHostedClientOutcome | null>;

  /**
   * Query parameters this deployment requires on owner-token reads.
   *
   * Core scopes an owner token to one subject's data store but does not say how
   * a deployment serving several connector instances disambiguates between them.
   * A reference deployment requires `connector_id`, and omitting it is a 400 for
   * a malformed request, not a refusal of the owner's authority. Without this the
   * suite would read that 400 as a failure of subject scoping (RS-12) or of
   * self-export (RS-13) — reporting a deployment convention as a spec violation.
   */
  readonly ownerReadParams?: Readonly<Record<string, string>> | undefined;

  /** An owner token for the seeded subject, when the target issues them. */
  ownerToken: () => Promise<string | null>;

  /**
   * Path prefix the Section 8 endpoint paths extend, e.g. "/v1".
   *
   * This exists because Core does not fix it. Section 8 publishes
   * `pdpp_core_query_base` in the RFC 9728 metadata document precisely "so a
   * client composes a record query without assuming a version segment". A suite
   * that hardcoded "/v1" would fail a conforming server that mounts its query
   * surface elsewhere, and would be testing its own assumption rather than the
   * spec. Defaults to "/v1" when a target does not say otherwise.
   */
  readonly queryBase?: string | undefined;

  /**
   * Attempt to issue a client access token against a SPECIFIC already-consumed
   * `single_use` grant, identified by `grantId`. Returns the token if the
   * target (incorrectly) issued one, or null if it refused.
   *
   * This exists because issuing a second, DIFFERENT grant proves nothing about
   * whether the first one can be reused: only an attempt to reissue against the
   * exact consumed `grantId` isolates AS-10's atomic-consumption requirement.
   * Optional: a target whose issuance path cannot be redirected at a specific
   * grant id reports the case `skip` naming this hook rather than passing on no
   * evidence.
   */
  reissueAgainstConsumedGrant?: (grantId: string) => Promise<IssuedGrant | null>;

  /** Human-review packets for clauses the executable suite cannot observe. */
  readonly reviewEvidence?: readonly ReviewEvidence[];

  /**
   * The streams and fields a staged request resolved to, before approval.
   *
   * Section 9 AS item 4 requires request-time conveniences (an omitted field
   * list, a wildcard, an implied instance) to be expanded into explicit terms
   * BEFORE issuance. A finished grant cannot show that: by then the expansion
   * either happened or the grant is wrong, and both look like a field list.
   * Reading the reviewed grant is what makes the resolution step observable.
   */
  reviewedStreams?: (
    handle: string
  ) => Promise<readonly { readonly name: string; readonly fields: readonly string[] }[] | null>;

  /** Revoke a previously issued grant, for the revocation negative oracles. */
  revokeGrant: (grantId: string) => Promise<void>;
  /** Roles this target claims to implement and wants assessed. */
  readonly roles: readonly Role[];

  /** Bring the target to a known state and seed records. Called once per run. */
  setup: () => Promise<{ readonly streams: readonly SeededStream[] }>;

  /**
   * Stage an authorization request and stop before approval, exposing the
   * server's own approval-review artifact.
   *
   * This is what makes Section 9 AS items 15 and 16 observable from outside.
   * Both are about what the server binds and retains BETWEEN review and
   * approval — a revision that a stale approval must be rejected against, and a
   * declaration snapshot that a later declaration may not replace. Neither is
   * visible from a finished grant, so an adapter that can only produce grants
   * leaves them untestable. Optional: a target whose consent flow has no
   * separable review step reports those cases `skip` rather than `fail`.
   */
  stageApproval?: (request: GrantRequest) => Promise<StagedApproval | null>;

  /**
   * Offer a source declaration to the AS's onboarding surface and report
   * whether it was accepted, WITHOUT approving anything.
   *
   * Core Section 5 "Declaration trust" governs what an AS may accept as a
   * declaration and when it must refuse, and none of it is observable from a
   * grant: the suite can otherwise only use declarations a target already
   * holds, so a server that accepts anything looks exactly like one that
   * validated carefully.
   *
   * Two families of clause need this, and each needs a different thing offered.
   *
   * Declaration TRUST — is this document's authority accepted:
   * - 5.8-1: a declaration naming a source authority the AS never onboarded
   *   (a client MUST NOT introduce a new source authority during
   *   authorization).
   * - 5.8-2: a `provider_native` declaration whose `source.id` differs from the
   *   protected-resource identifier the AS already accepted.
   * - 5.8-4: a SECOND, different document under an accepted
   *   (authority, source.id, declaration_version) key. That is equivocation:
   *   the AS must refuse it AND retain the previously accepted content.
   *
   * Declaration VALIDITY — is this document internally coherent, asked of a
   * document whose authority is already accepted:
   * - 4.8-1: a `blob_ref` field whose `mime_type` is not a valid IANA media type.
   * - 5.2-2: a `primary_key` or `cursor_field` naming a field the stream's
   *   schema does not declare.
   * - 5.2-3: a `consent_time_field` naming a field the schema does not declare.
   * - 5.2-5: an embedded stream schema that declares the wrong `$schema`
   *   dialect, fails meta-validation, or carries a non-local `$ref`.
   * - 5.4-1: a `consent_time_field` left undeclared and inferred from
   *   `cursor_field` instead.
   *
   * The two families share one hook because they share one surface: both ask
   * the AS to decide about an offered document before consent, and a target
   * that can answer one can answer the other.
   *
   * `accepted` is the decision. `retainedContent` is what the AS holds for that
   * key AFTER the call, which 5.8-4 needs: refusing the second document is only
   * half the obligation, and a server that refused but then overwrote its
   * retained copy has still lost the content the owner consented against.
   * Absent when the target cannot report what it retained, which reports the
   * retention half `skip` rather than assuming it.
   *
   * Optional: a target with no onboarding surface reports these cases `skip`
   * naming this hook.
   */
  submitDeclaration?: (declaration: SourceDeclarationSubmission) => Promise<DeclarationOutcome | null>;

  /**
   * Submit a selection request and report what the AS did, without approving.
   *
   * Makes the selection-time validation requirements (Section 9 AS items 2, 4,
   * 5, 6 and 17) observable. `issueGrant` cannot reach them: it only exercises
   * requests the server accepts, and these requirements are about what it must
   * refuse and how it must classify the refusal. Optional — a target without
   * this hook reports those cases `skip` naming it.
   */
  submitSelection?: (request: SelectionRequest) => Promise<SelectionOutcome | null>;

  /**
   * The grant schema version this deployment supports, as the ADAPTER's own
   * statement — the positive control for `grantWithSchemaVersion`.
   *
   * Required alongside that hook and not inferable: Core fixes no value for
   * `grant.version`, so a suite that hardcoded one would be testing its own
   * constant and would report a conforming target at any other version as
   * broken. The case mints a grant at THIS version, proves it reads, then mints
   * one at an unsupported major and requires the refusal.
   */
  readonly supportedGrantSchemaVersion?: string;
  /** Stable identifier recorded in the report, e.g. "acme-rs". */
  readonly targetId: string;
  /** Version string of the implementation under test, recorded in the report. */
  readonly targetVersion: string;

  /** Release whatever `setup` acquired. Always called, including after failure. */
  teardown: () => Promise<void>;

  /**
   * Mint a token whose introspection result reports `pdpp_token_kind` as
   * `kind`, for clause 8.2-3.
   *
   * Core Section 8 "Token kind extensibility": deployments MAY add token kinds
   * in companion profiles, and "a resource server that receives a
   * `pdpp_token_kind` value it does not recognize MUST treat the token as
   * unauthorized for all operations defined in this specification". Core
   * defines exactly `owner` and `client`.
   *
   * The suite cannot reach this by any other route. It obtains tokens from the
   * AS and cannot change what introspection says about them, and it must not
   * forge a token: Section 8 makes token FORMAT opaque to the RS, so a
   * suite-minted string is not a token of an unknown kind — it is a token of no
   * kind, which a conforming RS rejects at authentication for an entirely
   * different reason. That would pass the case against a server which has never
   * implemented the rule.
   *
   * So the token must be genuine, and the injection must be at the introspection
   * result the RS resolves it through. On a co-located target that is the local
   * equivalent Core Section 8 allows. Returns null when the deployment has no
   * such seam, which reports the case `skip` naming this hook.
   */
  tokenWithIntrospectedKind?: (kind: string, request: GrantRequest) => Promise<{ readonly accessToken: string } | null>;

  /**
   * Hosts this deployment will fetch a URL-hosted client identity document
   * from, as the ADAPTER's own statement of its configured allowlist.
   *
   * A refusal is only attributable to these clauses when the host was trusted
   * in the first place. Empty or absent means the deployment performs no
   * outbound client-document fetch at all, which reports the cases `skip`
   * rather than `fail`: declining to implement an optional discovery path is
   * not rejecting a valid identity.
   */
  readonly urlHostedClientHosts?: readonly string[];

  /**
   * Location of the RFC 9728 protected resource metadata document.
   *
   * RFC 9728 Section 3 derives this from the resource identifier, which for a
   * target mounted under a path prefix is not the bare host. Recorded per target
   * so RS-16 checks the document where the target actually publishes it.
   */
  readonly wellKnownPath?: string | undefined;

  /**
   * Add a field to an already-defined view, AFTER a grant has been issued
   * against it. Returns the view's new field list, or null when the target
   * cannot evolve a view.
   *
   * This is the only way to observe clause 5.6-2a. The obligation is that view
   * evolution never silently widens an existing grant, and an unevolved view
   * cannot demonstrate it: a grant that still serves its original fields is
   * consistent both with a correct server and with one that would have widened
   * had the view ever changed. The case issues a grant by view name, widens the
   * view here, and then re-reads with the ORIGINAL token.
   *
   * The added field must be one the stream's schema declares, so that a server
   * refusing to widen is doing so because the grant is frozen and not because
   * the field was invalid — otherwise the case would pass for the wrong reason.
   */
  widenView?: (stream: string, view: string, addField: string) => Promise<readonly string[] | null>;

  /**
   * Write a single FIELD of an existing record, for clauses 8.9-13 and 8.9-14.
   *
   * The unit is a field rather than a record because clause 8.9-13 turns on
   * which fields a change touched: "Eligibility for `changes_since` MUST be
   * computed on the grant-authorized projection, not on the unprojected record.
   * Returning a record whose authorized projection is unchanged is a protocol
   * violation because it leaks that hidden fields changed." A whole-record
   * write cannot express that distinction, which is why the existing seeding
   * hook could not reach the clause.
   *
   * Returns false when the target cannot write (or cannot target a single
   * field), which reports the dependent cases `skip` naming this hook.
   */
  writeRecordField?: (stream: string, recordId: string, field: string, value: unknown) => Promise<boolean>;
}

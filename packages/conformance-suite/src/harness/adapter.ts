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

import type { Role } from "../requirements/catalog.ts";

/**
 * A stream the target has provisioned for the run, with the facts the suite
 * needs to build valid and invalid requests against it.
 */
export interface SeededStream {
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
  /** Streams and the exact fields frozen into the grant. */
  readonly streams: readonly {
    readonly name: string;
    readonly fields: readonly string[];
  }[];
}

/**
 * An authorization request staged but not yet approved, with the handles needed
 * to attempt approval — correctly, twice, or with a stale revision.
 */
export interface StagedApproval {
  /** Approve this staged request. Returns the grant, or null if refused. */
  readonly approve: (revision?: string) => Promise<IssuedGrant | null>;
  /** Opaque handle for the pending request (a session id, request_uri, ...). */
  readonly handle: string;
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

/** A selection request expressed in the shapes Core Section 6 defines. */
export interface SelectionRequest {
  /** An unsupported PDPP-Version, for AS-17. */
  readonly pdppVersion?: string;
  readonly purposeCode?: string;
  /** Mutually exclusive with `streams` — AS-5 requires exactly one. */
  readonly selectionPreset?: string;
  /** Omit `fields` to test AS-4 expansion; name an undeclared one to test AS-2. */
  readonly streams?: readonly { readonly name: string; readonly fields?: readonly string[] }[];
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

/** The grant shape a test needs. The adapter arranges consent out of band. */
export interface GrantRequest {
  readonly accessMode?: "single_use" | "continuous" | "recurring";
  readonly streams: readonly {
    readonly name: string;
    readonly fields: readonly string[];
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
  readonly capabilities: TargetCapabilities;

  /**
   * An access token whose bound grant has expired. Exercised by the
   * expired-grant oracle. Optional: not every target can fabricate one.
   */
  expiredGrantToken?: () => Promise<string | null>;

  /**
   * A token for a DIFFERENT subject than the seeded one. Powers the
   * cross-subject negative oracle (RS-12): a target that cannot produce a
   * second subject cannot demonstrate subject scoping, and the case is
   * recorded `unsupported` rather than passing by absence of evidence.
   */
  foreignSubjectOwnerToken?: () => Promise<string | null>;

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
   * Submit a selection request and report what the AS did, without approving.
   *
   * Makes the selection-time validation requirements (Section 9 AS items 2, 4,
   * 5, 6 and 17) observable. `issueGrant` cannot reach them: it only exercises
   * requests the server accepts, and these requirements are about what it must
   * refuse and how it must classify the refusal. Optional — a target without
   * this hook reports those cases `skip` naming it.
   */
  submitSelection?: (request: SelectionRequest) => Promise<SelectionOutcome | null>;
  /** Stable identifier recorded in the report, e.g. "acme-rs". */
  readonly targetId: string;
  /** Version string of the implementation under test, recorded in the report. */
  readonly targetVersion: string;

  /** Release whatever `setup` acquired. Always called, including after failure. */
  teardown: () => Promise<void>;

  /**
   * Location of the RFC 9728 protected resource metadata document.
   *
   * RFC 9728 Section 3 derives this from the resource identifier, which for a
   * target mounted under a path prefix is not the bare host. Recorded per target
   * so RS-16 checks the document where the target actually publishes it.
   */
  readonly wellKnownPath?: string | undefined;
}

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

  /** Revoke a previously issued grant, for the revocation negative oracles. */
  revokeGrant: (grantId: string) => Promise<void>;
  /** Roles this target claims to implement and wants assessed. */
  readonly roles: readonly Role[];

  /** Bring the target to a known state and seed records. Called once per run. */
  setup: () => Promise<{ readonly streams: readonly SeededStream[] }>;
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

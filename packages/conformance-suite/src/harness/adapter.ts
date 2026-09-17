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
   * Base URL of the resource server, e.g. "http://localhost:4000". Section 8
   * endpoint paths are appended to it.
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
   * Arrange consent for the requested grant and return a bound access token.
   * Returns null when the target cannot produce that grant shape, which the
   * runner records as `unsupported` rather than `fail`.
   */
  issueGrant: (request: GrantRequest) => Promise<IssuedGrant | null>;

  /** An owner token for the seeded subject, when the target issues them. */
  ownerToken: () => Promise<string | null>;

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
}

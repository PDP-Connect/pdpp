// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The requirement catalogue: every numbered conformance item in Core Section 9,
// transcribed one-for-one, plus the normative level each carries.
//
// This file is the suite's DENOMINATOR. Coverage is reported against it, so a
// requirement with no test is visible as `not-tested` rather than invisible. An
// item is never removed to make a report look better; see docs/README.md.
//
// Transcription rule: `id` encodes role and the item's own number in Section 9
// (AS-3 is Section 9 "Authorization Server conformance" item 3). Those numbers
// are the spec's, not ours, so a reader can check any row against the spec text
// without a mapping table. `statement` is a faithful precis, not a replacement
// for the spec: `specAnchor` is where the binding text lives.

/** The role a requirement constrains. Core Section 9 defines exactly these. */
export type Role = "authorization-server" | "resource-server" | "client";

/**
 * Normative level per Core Section 2 "Requirements Language" (BCP 14).
 *
 * `must` and `should` differ in how a failure is reported: a failed MUST is a
 * conformance failure, a failed SHOULD is reported as a failure of a
 * recommendation and is shown separately in the report summary. Neither is
 * silently downgraded.
 */
export type NormativeLevel = "must" | "should" | "may";

/**
 * Whether the requirement applies to every implementation of the role, or only
 * to those that implement an optional capability / deployment shape.
 *
 * `conditional` requirements carry `appliesWhen` prose naming the condition.
 * When a target declares the capability absent, results are `unsupported`, not
 * `fail` — an implementation is not non-conformant for declining an option.
 */
export type Applicability = "always" | "conditional";

export interface Requirement {
  readonly applicability: Applicability;
  /** Prose naming the condition, when `applicability` is `conditional`. */
  readonly appliesWhen?: string;
  readonly id: string;
  readonly level: NormativeLevel;
  readonly role: Role;
  /** Section anchor in the spec source, for evidence references. */
  readonly specAnchor: string;
  /** The item number within its Section 9 role list. */
  readonly specItem: number;
  readonly statement: string;
}

/**
 * The spec revision this catalogue was transcribed from. Every report carries
 * it, so a result is never ambiguous about which text it was judged against.
 * Bump this together with any re-transcription after a spec change.
 */
export const SPEC_SOURCE = {
  document: "PDPP Core",
  version: "v0.1.0",
  section: "9",
  /** Repository-relative path of the normative source. */
  path: "spec-core.md",
} as const;

const AUTHORIZATION_SERVER: readonly Requirement[] = [
  {
    id: "AS-1",
    role: "authorization-server",
    specItem: 1,
    level: "must",
    applicability: "always",
    statement:
      'Accepts selection requests using the RFC 9396 `authorization_details` envelope with type "https://pdpp.dev/data-access".',
    specAnchor: "#conformance",
  },
  {
    id: "AS-2",
    role: "authorization-server",
    specItem: 2,
    level: "must",
    applicability: "always",
    statement:
      "Validates selection requests against one retained SourceDeclaration snapshot: rejects unknown streams, unsupported selection parameters, and unrecognized selection presets.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-3",
    role: "authorization-server",
    specItem: 3,
    level: "must",
    applicability: "always",
    statement:
      "Issues grants conforming to the Section 7 grant schema, with all fields derived from the selection request, client registration, or AS policy.",
    specAnchor: "#grant",
  },
  {
    id: "AS-4",
    role: "authorization-server",
    specItem: 4,
    level: "must",
    applicability: "always",
    statement:
      "Expands wildcards and selection presets into explicit stream names, fields, per-stream instance handles, resources, and frozen time constraints before issuing the grant.",
    specAnchor: "#grant",
  },
  {
    id: "AS-5",
    role: "authorization-server",
    specItem: 5,
    level: "must",
    applicability: "always",
    statement:
      "Produces a Source validation failure when a request contains both or neither of `streams` and `selection_preset`.",
    specAnchor: "#selection-request",
  },
  {
    id: "AS-6",
    role: "authorization-server",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement:
      "MUST NOT reject a `purpose_code` solely because it is absent from the PDPP registry; displays `purpose_description` or the raw URI for unrecognized codes.",
    specAnchor: "#selection-request",
  },
  {
    id: "AS-7",
    role: "authorization-server",
    specItem: 7,
    level: "must",
    applicability: "always",
    statement:
      "Renders requester identity, declaration-authored descriptions, policy declarations, and client claims as distinct categories; MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms.",
    specAnchor: "#client-claims",
  },
  {
    id: "AS-8",
    role: "authorization-server",
    specItem: 8,
    level: "must",
    applicability: "always",
    statement:
      "Tracks grant lifecycle (active, expired, revoked) and reflects revocation immediately in introspection responses (`active: false`).",
    specAnchor: "#revocation",
  },
  {
    id: "AS-9",
    role: "authorization-server",
    specItem: 9,
    level: "must",
    applicability: "always",
    statement: "Issues access tokens bound to specific grants, carrying the PDPP introspection extension fields.",
    specAnchor: "#token-introspection",
  },
  {
    id: "AS-10",
    role: "authorization-server",
    specItem: 10,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS supports `single_use` grants",
    statement:
      "For `single_use` grants, consumes the grant atomically with first client-token issuance and rejects later attempts to issue new client access tokens against it.",
    specAnchor: "#access-modes",
  },
  {
    id: "AS-11",
    role: "authorization-server",
    specItem: 11,
    level: "must",
    applicability: "always",
    statement: "Validates stream/field/view/resource-id shape at grant issuance.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-12",
    role: "authorization-server",
    specItem: 12,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS supports views",
    statement: "MUST NOT define a view including fields absent from the retained SourceDeclaration schema.",
    specAnchor: "#views",
  },
  {
    id: "AS-13",
    role: "authorization-server",
    specItem: 13,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS supports views",
    statement: "Resolves view names to field lists at issuance time and stores resolved `fields` in the StreamGrant.",
    specAnchor: "#views",
  },
  {
    id: "AS-14",
    role: "authorization-server",
    specItem: 14,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS issues grants carrying the ai_training purpose code",
    statement:
      "Obtains explicit affirmative user consent before issuing grants with `purpose_code: https://pdpp.dev/purpose/ai_training`.",
    specAnchor: "#ai-training-consent",
  },
  {
    id: "AS-15",
    role: "authorization-server",
    specItem: 15,
    level: "must",
    applicability: "always",
    statement:
      "Resolves omitted instance IDs before final approval, binds resolved instances and decision fields to an immutable review revision, and rejects stale approval when eligibility or the reviewed revision changed.",
    specAnchor: "#grant",
  },
  {
    id: "AS-16",
    role: "authorization-server",
    specItem: 16,
    level: "must",
    applicability: "always",
    statement:
      "Retains one exact SourceDeclaration snapshot through validation, consent, narrowing, issuance, and consent evidence; a later declaration never substitutes for it.",
    specAnchor: "#declaration-acceptance",
  },
  {
    id: "AS-17",
    role: "authorization-server",
    specItem: 17,
    level: "must",
    applicability: "always",
    statement: "Returns 400 `unsupported_version` when the `PDPP-Version` header specifies an unsupported version.",
    specAnchor: "#errors",
  },
  {
    id: "AS-18",
    role: "authorization-server",
    specItem: 18,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS and RS are separated deployments",
    statement:
      "Authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response.",
    specAnchor: "#token-introspection",
  },
  {
    id: "AS-19",
    role: "authorization-server",
    specItem: 19,
    level: "must",
    applicability: "always",
    statement:
      "Consumes each OAuth authorization code atomically on first successful redemption and rejects every later redemption with `invalid_grant`.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-20",
    role: "authorization-server",
    specItem: 20,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the AS issues refresh tokens",
    statement:
      "Issues refresh tokens only for `continuous` grants, rotates by family, and on reuse of a superseded token revokes the family and every family-linked access token, returning `invalid_grant`.",
    specAnchor: "#access-modes",
  },
  {
    id: "AS-21",
    role: "authorization-server",
    specItem: 21,
    level: "must",
    applicability: "always",
    statement:
      "Rejects unsupported persisted authorization state before introspection or request handling, without reconstructing missing facts from current configuration.",
    specAnchor: "#errors",
  },
];

const RESOURCE_SERVER: readonly Requirement[] = [
  {
    id: "RS-1",
    role: "resource-server",
    specItem: 1,
    level: "must",
    applicability: "always",
    statement:
      "Implements the Section 8 query endpoints: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "RS-2",
    role: "resource-server",
    specItem: 2,
    level: "must",
    applicability: "always",
    statement:
      "Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, and `resources` filter.",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "RS-3",
    role: "resource-server",
    specItem: 3,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the deployment separates AS and RS",
    statement:
      "Resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, makes no second AS lookup while handling the request, and caches positive results no longer than min(token_exp, 60 seconds).",
    specAnchor: "#token-introspection",
  },
  {
    id: "RS-4",
    role: "resource-server",
    specItem: 4,
    level: "must",
    applicability: "always",
    statement:
      "Distinguishes owner tokens from client tokens via `pdpp_token_kind`, determined solely from the introspection response and never from token syntax.",
    specAnchor: "#token-introspection",
  },
  {
    id: "RS-5",
    role: "resource-server",
    specItem: 5,
    level: "must",
    applicability: "always",
    statement:
      "For owner tokens computes the effective filter as the permitted owner request filter alone; for client tokens in v0.1 rejects request-time predicate filters and enforces the frozen grant constraints.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-6",
    role: "resource-server",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement: "Returns structured errors as defined in the Section 8 unified error table.",
    specAnchor: "#errors",
  },
  {
    id: "RS-7",
    role: "resource-server",
    specItem: 7,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target serves at least one `mutable_state` stream",
    statement:
      "Supports incremental sync via `changes_since` for `mutable_state` streams, including tombstones, omission of records whose grant-authorized projection did not change, and HTTP 410 `cursor_expired` on expiry.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-8",
    role: "resource-server",
    specItem: 8,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target supports `changes_since`",
    statement: "Returns `next_changes_since` on the terminal page of every `changes_since` response.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-9",
    role: "resource-server",
    specItem: 9,
    level: "must",
    applicability: "always",
    statement:
      "Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-10",
    role: "resource-server",
    specItem: 10,
    level: "must",
    applicability: "always",
    statement:
      "Rejects unknown query parameters and unsupported query shapes with 400 instead of silently ignoring them.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-11",
    role: "resource-server",
    specItem: 11,
    level: "must",
    applicability: "always",
    statement: "Implements `PDPP-Version` header negotiation.",
    specAnchor: "#errors",
  },
  {
    id: "RS-12",
    role: "resource-server",
    specItem: 12,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target issues owner tokens",
    statement:
      "Scopes owner token access to a single subject's data store, deriving `subject_id` from the introspection response.",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "RS-13",
    role: "resource-server",
    specItem: 13,
    level: "should",
    applicability: "conditional",
    appliesWhen: "the target declares `pdpp_self_export_supported`",
    statement:
      "SHOULD support owner-authenticated access to the record query endpoints without a client grant (self-export).",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "RS-14",
    role: "resource-server",
    specItem: 14,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target issues owner tokens",
    statement:
      "For owner-token stream-metadata reads, returns the full current stream metadata within the owner's scope, including current query, view, and relationship capabilities.",
    specAnchor: "#stream-metadata",
  },
  {
    id: "RS-15",
    role: "resource-server",
    specItem: 15,
    level: "must",
    applicability: "always",
    statement:
      "For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context, excluding current view/relationship/filter/expansion/aggregation capability and any post-issuance declaration change.",
    specAnchor: "#stream-metadata",
  },
  {
    id: "RS-16",
    role: "resource-server",
    specItem: 16,
    level: "must",
    applicability: "always",
    statement:
      "Publishes RFC 9728 protected resource metadata at the RFC 9728 Section 3 location carrying `resource` and the four `pdpp_` members, and returns a `WWW-Authenticate: Bearer` challenge with `resource_metadata` on 401.",
    specAnchor: "#protected-resource-metadata",
  },
];

const CLIENT: readonly Requirement[] = [
  {
    id: "CL-1",
    role: "client",
    specItem: 1,
    level: "must",
    applicability: "always",
    statement: "Submits selection requests using the RFC 9396 `authorization_details` envelope.",
    specAnchor: "#selection-request",
  },
  {
    id: "CL-2",
    role: "client",
    specItem: 2,
    level: "must",
    applicability: "always",
    statement: "Uses access tokens (not raw grants) to authenticate with the resource server.",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "CL-3",
    role: "client",
    specItem: 3,
    level: "must",
    applicability: "always",
    statement:
      "Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces; MUST NOT use a `next_cursor` value as a `changes_since` parameter.",
    specAnchor: "#list-records",
  },
  {
    id: "CL-4",
    role: "client",
    specItem: 4,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the client performs incremental sync",
    statement:
      "Stores `next_changes_since` from the terminal page of a `changes_since` response for the next sync session.",
    specAnchor: "#list-records",
  },
  {
    id: "CL-5",
    role: "client",
    specItem: 5,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the client performs incremental sync",
    statement:
      "Respects HTTP 410 `cursor_expired` by performing a full re-sync rather than retrying with the expired cursor.",
    specAnchor: "#list-records",
  },
  {
    id: "CL-6",
    role: "client",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement: "Honors retention commitments declared in the grant.",
    specAnchor: "#retention",
  },
  {
    id: "CL-7",
    role: "client",
    specItem: 7,
    level: "must",
    applicability: "always",
    statement:
      "Treats unrecognized error codes as opaque, falling back to the actual HTTP status code and headers, and never fails to parse on an unknown `code` or `type`.",
    specAnchor: "#errors",
  },
  {
    id: "CL-8",
    role: "client",
    specItem: 8,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the client has provenance-dependent local policy",
    statement:
      "Reads `source.kind` from the issued grant and applies provenance policy before first use of the records; MUST NOT assume a provenance class it did not read from the grant.",
    specAnchor: "#source-kinds",
  },
];

/** Every Core Section 9 requirement, in spec order. The coverage denominator. */
export const REQUIREMENTS: readonly Requirement[] = [...AUTHORIZATION_SERVER, ...RESOURCE_SERVER, ...CLIENT];

const BY_ID = new Map(REQUIREMENTS.map((r) => [r.id, r]));

export function requirementById(id: string): Requirement | undefined {
  return BY_ID.get(id);
}

export function requirementsForRole(role: Role): readonly Requirement[] {
  return REQUIREMENTS.filter((r) => r.role === role);
}

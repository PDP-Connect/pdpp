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
  version: "v0.1.0 locked text (27 October 2026)",
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
      'Accepts selection requests using the RFC 9396 `authorization_details` envelope with `type: "https://pdpp.dev/data-access"`.',
    specAnchor: "#conformance",
  },
  {
    id: "AS-2",
    role: "authorization-server",
    specItem: 2,
    level: "must",
    applicability: "always",
    statement:
      "Validates public request structure and owner-independent capabilities, rejecting public invalidity with `invalid_authorization_details`. Resolves selections against one retained SourceDeclaration snapshot. Treats an otherwise valid selection that is infeasible under privately accepted capabilities as owner-dependent eligibility, only within authenticated review. There, omits an optional unapproved stream or refuses under the required-stream/minimum rules with indistinguishable `access_denied`, without client-visible private diagnostics, as Authorization privacy boundary requires.",
    specAnchor: "#authorization-privacy",
  },
  {
    id: "AS-3",
    role: "authorization-server",
    specItem: 3,
    level: "must",
    applicability: "always",
    statement:
      "For Core `data-access` details, issues grants that conform to the grant schema defined in Section 7 (normative field tables). The AS generates `grant_id` and `issued_at`; it resolves other grant fields from authenticated identities, the selection request, the accepted source declaration, eligible instance handles, user approval, AS policy, or AS-resolved client metadata.",
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
      "Produces a binding-neutral Source validation failure when a Core `data-access` detail contains both or neither of `streams` and `selection_preset`. The OAuth/RAR binding maps it to RFC 9396 `invalid_authorization_details`. Rejects a request in which any authorization-details object has an unsupported type or is invalid under its type's definition (Section 6).",
    specAnchor: "#selection-request",
  },
  {
    id: "AS-6",
    role: "authorization-server",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement:
      "MUST NOT reject a complete detail solely because its `purpose_code` is not in Appendix A. Rejects a detail with a code outside Appendix A that lacks a non-empty `purpose_description`, and displays that description. MAY reject a `purpose_code` based on local policy.",
    specAnchor: "#selection-request",
  },
  {
    id: "AS-7",
    role: "authorization-server",
    specItem: 7,
    level: "must",
    applicability: "always",
    statement:
      "Renders requester identity metadata, declaration-authored data descriptions, structured policy declarations, and client-authored claims as semantically distinct categories during consent. MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms. If `client_claims` are rendered during final review, binds the normalized exact claims into the immutable final approval artifact and review revision, and preserves that binding in retained consent evidence, without adding them to the resolved grant or RS enforcement. Records in the issued grant's `client.client_display` the exact `policy_uri` and `tos_uri` it presented during consent, and omits any it did not present.",
    specAnchor: "#client-claims",
  },
  {
    id: "AS-8",
    role: "authorization-server",
    specItem: 8,
    level: "must",
    applicability: "always",
    statement:
      "Tracks grant lifecycle (active, expired, revoked). Reflects revocation immediately in introspection: the revoked grant is inactive at once, and a token is `active: false` when no grant it covers is active.",
    specAnchor: "#revocation",
  },
  {
    id: "AS-9",
    role: "authorization-server",
    specItem: 9,
    level: "must",
    applicability: "always",
    statement:
      "For Core `data-access` details, issues access tokens bound to specific grants. Access tokens include the PDPP introspection extension fields. Binds each Core client token to exactly one grant. Without a companion credential binding, rejects more than one Core data-access detail with `invalid_authorization_details`.",
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
      "For `single_use` grants, consumes the grant atomically with first client-token issuance. Gives that access token a finite expiration set by local policy and, when the grant has `expires_at`, no later than `expires_at`; that expiry ends the grant's one read window. Lets a later token in the same refresh-token family carry the grant only inside the window, reports the grant inactive for reads after it, and otherwise rejects access-token issuance against the consumed grant.",
    specAnchor: "#access-modes",
  },
  {
    id: "AS-11",
    role: "authorization-server",
    specItem: 11,
    level: "must",
    applicability: "always",
    statement:
      "Validates stream/field/view/resource-id shape at grant issuance. Rejects `resources` on a stream with more than one instance. Rejects `resources` entries that are not canonical under Section 4 and does not percent-decode JSON `resources` values.",
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
    statement:
      "Resolves view names to field lists at issuance time; stores resolved `fields` and `required_fields` in the `StreamGrant`. Freezes `cursor_field` as `sort_field` when its format is `date` or `date-time` and the grant includes it; otherwise omits `sort_field`. Client-token record reads reject query-time `view` in v0.1. Owner-token current-capability reads MAY resolve current views.",
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
      "Rejects a detail whose `processing_permissions` is malformed or contains a duplicate, unknown, or unsupported value, with `invalid_authorization_details`, and never ignores, substitutes, or narrows such a value or issues an ordinary grant in its place. Advertises in `pdpp_processing_permissions_supported`, and grants, only permissions whose complete defining contract it implements. Treats `https://pdpp.dev/processing/ai_training` as unsupported until the PDPP AI Training Profile is published and its registration is approved, and afterwards supports it only by conforming to that profile.",
    specAnchor: "#ai-training-consent",
  },
  {
    id: "AS-15",
    role: "authorization-server",
    specItem: 15,
    level: "must",
    applicability: "always",
    statement:
      "For Core `data-access` details, resolves omitted instance IDs before the final approval surface. Binds exact resolved instances and all final decision fields to an immutable review revision or digest. Rejects stale approval if eligibility or the reviewed revision changes before approval.",
    specAnchor: "#grant",
  },
  {
    id: "AS-16",
    role: "authorization-server",
    specItem: 16,
    level: "must",
    applicability: "always",
    statement:
      "Retains one exact SourceDeclaration snapshot through request validation, consent display, narrowing, issuance, and consent evidence. A later current declaration never substitutes for it.",
    specAnchor: "#declaration-acceptance",
  },
  {
    id: "AS-17",
    role: "authorization-server",
    specItem: 17,
    level: "may",
    applicability: "conditional",
    appliesWhen: "Never: Core marks this item not used.",
    statement:
      "Not used. `PDPP-Version` negotiation is a Resource Server requirement and does not version Authorization Server endpoints.",
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
      "For a separated AS and RS, authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response, including `pdpp_instance_bindings`. Never returns `pdpp_instance_bindings` to a client.",
    specAnchor: "#token-introspection",
  },
  {
    id: "AS-19",
    role: "authorization-server",
    specItem: 19,
    level: "must",
    applicability: "always",
    statement:
      "Consumes each OAuth authorization code atomically on its first successful redemption. Rejects every later redemption with `invalid_grant` and does not issue another token.",
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
      "For a token response that covers only Core `data-access` grants, issues a refresh token only when at least one covered grant is `continuous`. Never extends a `single_use` grant's read window through refresh. Rotates refresh tokens by family. Reuse of a superseded token revokes the family and every family-linked access token, returns `invalid_grant`, and requires fresh authorization.",
    specAnchor: "#access-modes",
  },
  {
    id: "AS-21",
    role: "authorization-server",
    specItem: 21,
    level: "must",
    applicability: "always",
    statement:
      "Rejects unsupported persisted authorization state before introspection or request handling. Does not reconstruct missing facts from current configuration and requires fresh consent when no migration applies.",
    specAnchor: "#errors",
  },
  {
    id: "AS-22",
    role: "authorization-server",
    specItem: 22,
    level: "must",
    applicability: "always",
    statement:
      "Rejects a source declaration containing an unrecognized `source.kind` or `streams[].semantics` value. Rejects a language map or `display.default_language` that breaks a structural or language-tag rule in Display text languages. MAY reject a declaration whose language versions it detects do not state the same meaning.",
    specAnchor: "#display-text-languages",
  },
  {
    id: "AS-23",
    role: "authorization-server",
    specItem: 23,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The AS issues a grant with `grantors`.",
    statement:
      "Issues a grant with `grantors` only after each listed representative approves the same immutable final review revision. Authenticates each representative and, before showing any subject-specific information or accepting approval, verifies their authority under Representative approval. Binds each identity and capacity to that revision and retained consent evidence, and keeps the data subject in `subject`.",
    specAnchor: "#representative-approval",
  },
  {
    id: "AS-24",
    role: "authorization-server",
    specItem: 24,
    level: "must",
    applicability: "always",
    statement:
      "For Core `data-access` details, lets the owner approve or decline each detail of a request on its own. Issues one grant for each approved, resolved detail, covering one subject, one source, and one purpose, with its own lifecycle. Identifies grants by `grant_id` and does not treat subject, source, and purpose as a grant key.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-25",
    role: "authorization-server",
    specItem: 25,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The AS offers client-initiated revocation.",
    statement:
      "For Core `data-access` details, if it offers client-initiated revocation, ends grants as Section 10 defines. Revoking a refresh token, current or superseded, ends every grant its family covers; revoking an access token ends its grants only when no refresh-token family covers them. In the OAuth binding, implements it as RFC 7009 token revocation and advertises `revocation_endpoint` in RFC 8414 metadata. Accepts `pdpp_disposition` on that request and records it only when the request carries current client authentication.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-26",
    role: "authorization-server",
    specItem: 26,
    level: "must",
    applicability: "always",
    statement:
      "Ends one grant among several that share a credential without revoking that credential or ending the other grants.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-27",
    role: "authorization-server",
    specItem: 27,
    level: "must",
    applicability: "always",
    statement:
      "Rejects a declaration that names an ineligible `consent_time_field` or a non-boolean `consent_time_content_may_exceed`. Rejects a `time_range` with no bound, a bound whose type does not match the field's format, an invalid bound, or a `since` not before `until`; the OAuth/RAR binding returns `invalid_authorization_details`. This error applies only to public invalidity. A failure that depends on a declaration accepted privately for the owner is an eligibility failure under Authorization privacy boundary and MUST NOT produce a client-visible declaration-dependent validation error. Never converts or rounds a bound. Sets `time_constraint.type` from the field's format in the retained declaration.",
    specAnchor: "#authorization-privacy",
  },
  {
    id: "AS-28",
    role: "authorization-server",
    specItem: 28,
    level: "must",
    applicability: "always",
    statement:
      "For each time-bounded stream, renders the exact bounds with their inclusive and exclusive meaning and the declared meaning of the field. Shows a relative label only when it has verified it for those bounds. Discloses that matched records can contain data from outside the bounds when the stream declares `consent_time_content_may_exceed: true`. For a `continuous` grant, discloses that the client can see records leave the window.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-29",
    role: "authorization-server",
    specItem: 29,
    level: "must",
    applicability: "always",
    statement:
      "Gives each client pairwise identifiers: `subject.id`, `grantors[].id`, instance handles, and any ID Token `sub` differ between clients for the same subject, grantor, or instance. They stay the same for one client, are never reassigned, and cannot be reversed by a client. Sets ID Token `sub` to the authenticated person's identifier, which is a grantor's identifier when a representative authenticates. Uses a globally resolvable `subject.id` only when the owner explicitly chooses to disclose it to that client, and binds that identifier and the client into the final approval artifact and retained consent evidence. Returns an internal subject identifier and `pdpp_instance_bindings` only to the RS.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-30",
    role: "authorization-server",
    specItem: 30,
    level: "must",
    applicability: "always",
    statement:
      "Resolves each request as Request resolution defines before final approval. Treats requested instances, resources, time bounds, and the field ceiling as upper limits, never narrows below schema-required fields, and adds nothing to compensate for a refused selection. Checks required streams and each retained stream's `minimum` before issuing a grant or client token. Reports an unmet minimum on a required stream as `access_denied` and a malformed `minimum` as `invalid_authorization_details`.",
    specAnchor: "#request-resolution",
  },
  {
    id: "AS-31",
    role: "authorization-server",
    specItem: 31,
    level: "must",
    applicability: "always",
    statement:
      "Resolves purpose and retention only from the current request or recipient-authorized standing terms, and retains the evidence identifying those terms with the consent evidence. Rejects a `retention.max_duration` that is not in the form `PnD`. Discloses during owner review that envelope identifiers are part of every disclosed record.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-32",
    role: "authorization-server",
    specItem: 32,
    level: "must",
    applicability: "always",
    statement:
      "Returns one `{ type, grant }` element per covered grant in every token response that issues a client access token, including refresh responses, as Client-visible authorization result defines. Returns the same element shape in introspection.",
    specAnchor: "#authorization-result",
  },
  {
    id: "AS-33",
    role: "authorization-server",
    specItem: 33,
    level: "must",
    applicability: "always",
    statement:
      "Advertises `https://pdpp.dev/data-access` and `https://pdpp.dev/grant-lifecycle` in `authorization_details_types_supported` and rejects unknown detail types, and a detail that carries a member it does not define.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-34",
    role: "authorization-server",
    specItem: 34,
    level: "must",
    applicability: "always",
    statement:
      "Chooses one version of each language-map display value it renders by the procedure in Display language. Does not reject a request solely because a requested language is unsupported. Binds the identity, exact string, and any chosen language tag of each declaration display value shown on final review into the final approval artifact, the review revision or digest, and retained consent evidence. Records display text from an earlier consent step as Section 7 requires.",
    specAnchor: "#display-language",
  },
  {
    id: "AS-35",
    role: "authorization-server",
    specItem: 35,
    level: "should",
    applicability: "always",
    statement:
      "SHOULD give every client access token a finite expiration and SHOULD issue it from a refresh-token family for a `continuous` grant, which allows renewal without re-consent while the family remains valid.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-36",
    role: "authorization-server",
    specItem: 36,
    level: "must",
    applicability: "always",
    statement:
      "For a detail that carries a processing permission, requires a distinct affirmative owner selection, never preselects it, and never makes another detail depend on it. Renders each permission as a labeled term distinct from the purpose. Requires a non-empty `purpose_description` on an AI training detail. Issues the grant with its exact permission set or not at all, and never adds a permission to a detail that did not request it. Binds that set into final owner review, the review revision, retained consent evidence, the grant, token results, and introspection, and requires a new review when the set changes after review. Includes a reviewed `expires_at` in every training grant. On the approval surface for an AI training detail, makes the statements and avoids the claims that AI training consent lists.",
    specAnchor: "#ai-training-consent",
  },
  {
    id: "AS-37",
    role: "authorization-server",
    specItem: 37,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The AS supports a processing permission.",
    statement:
      "When it supports a processing permission, keeps read access and processing authority distinct as Read access and processing authority defines. Issues no further processing authority after grant revocation or grant expiry. When the grant has `expires_at`, issues no processing authority that outlasts it. Never lets a processing credential confer read access. Does not treat read-window closure, access-token expiry, or refresh-token replay detection alone as ending processing authority or prohibiting its renewal.",
    specAnchor: "#processing-authority",
  },
  {
    id: "AS-38",
    role: "authorization-server",
    specItem: 38,
    level: "must",
    applicability: "always",
    statement:
      "Its operator does not use owner data held in the AS role for AI training, except under a training grant issued to it as a client.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-39",
    role: "authorization-server",
    specItem: 39,
    level: "must",
    applicability: "always",
    statement:
      "Provides the grant lifecycle operation and advertises `pdpp_grant_lifecycle_endpoint`, as Grant lifecycle operation defines. For queries, accepts any token it issued to the client that covers the grant, whether active, expired, superseded, or revoked. Requires current client authentication for writes. Returns indistinguishable `invalid_grant` entries for unknown, foreign, and uncovered grants. Stores token digests, not tokens, and can disable any token it issued for lifecycle use. Admits at least one query per grant per retry interval from each client. Records a client-conveyed `delete` as that client's `received` report only when the request reports the client's first receipt time.",
    specAnchor: "#grant-lifecycle",
  },
  {
    id: "AS-40",
    role: "authorization-server",
    specItem: 40,
    level: "must",
    applicability: "always",
    statement:
      "Returns a positive assessment only when no erasure instruction applies to the grant, whatever its read state, and only from state ordered after every terminal event it has acknowledged.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-41",
    role: "authorization-server",
    specItem: 41,
    level: "must",
    applicability: "always",
    statement:
      "On every interface through which the owner ends a grant, requires an explicit disposition for each grant in the action's scope, rejects a request without one, and applies no default. Presents `keep` and `delete` with neither preselected, and lists the complete affected set as Ending paths defines, including already-ended and consumed grants whose held data may remain and grants that carry a processing permission.",
    specAnchor: "#ending-paths",
  },
  {
    id: "AS-42",
    role: "authorization-server",
    specItem: 42,
    level: "must",
    applicability: "always",
    statement:
      "Records each erasure instruction durably before acknowledging it and preserves its terminal effect. An immediate instruction revokes an active grant. An advance instruction takes effect at grant end and does not itself end the grant earlier. Records acceptance, first return, reported receipt, and reported completion or exception separately. Accepts `retained_until` only in its three forms, and shows a `retained` report's end in that form, never as completed deletion. From the effective time, issues no further processing authority that permits use of the covered data.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-43",
    role: "authorization-server",
    specItem: 43,
    level: "must",
    applicability: "always",
    statement:
      "Shows the owner the stop-use and deletion statements that Erasure requires, and the time by which covered processing stops. Never shows a receipt-based deletion deadline calculated from acceptance or first return. Until a receipt is reported, shows the latest recorded stage and no deletion date.",
    specAnchor: "#erasure",
  },
  {
    id: "AS-44",
    role: "authorization-server",
    specItem: 44,
    level: "must",
    applicability: "always",
    statement:
      "Meets Lifecycle durability: records terminal events before acknowledging them, in a history that no restore or failover through a path its mechanism detects can make an enforcement point treat as current while it omits an acknowledged terminal event. Records the other events that section lists before a response discloses or relies on them, and never reuses a `grant_id` or `instruction_id`. Never returns a positive assessment, an active introspection result, or a token that contradicts an acknowledged terminal event, on any issuance or assessment path, including code, device-code, and refresh exchanges, token re-delivery, lifecycle write authentication, and package fan-out. This holds except after a restore or rollback path that it discloses as undetected. After restore or failover, treats a history as current only when its declared mechanism establishes that the history includes every acknowledged terminal event, and otherwise fails closed. Describes the durability it actually provides, including the disk and host losses it does not survive, the restore and rollback paths its mechanism does not detect, and what such a path can revive. While its history is unavailable, accepts, records, and later applies owner revocations, dispositions, and erasure requests. For an action affecting several grants, records a result per grant and reports the action complete only when every requested ending and disposition is recorded. Keeps lifecycle and authentication bindings for as long as that section requires.",
    specAnchor: "#lifecycle-durability",
  },
  {
    id: "AS-45",
    role: "authorization-server",
    specItem: 45,
    level: "must",
    applicability: "always",
    statement:
      "Shows in final owner review what happens to held data after the grant ends, as Recipient commitments and approval defines.",
    specAnchor: "#recipient-commitments",
  },
  {
    id: "AS-46",
    role: "authorization-server",
    specItem: 46,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The AS ends a grant for a security reason.",
    statement:
      "On security revocation, shows the owner the ending and its reason and offers the disposition. Before decommission, offers a disposition for every grant whose held data may remain, shows the stage of each disposition, and warns about each `delete` that no client has received. In a narrowing flow, states the effect of each disposition as Grant narrowing defines. Lets the owner request erasure for an ended grant while its held data may remain.",
    specAnchor: "#grant-narrowing",
  },
  {
    id: "AS-47",
    role: "authorization-server",
    specItem: 47,
    level: "must",
    applicability: "always",
    statement: "Supports lifecycle recovery, and gives a recovery token no read access and no refresh token.",
    specAnchor: "#lifecycle-recovery",
  },
  {
    id: "AS-48",
    role: "authorization-server",
    specItem: 48,
    level: "must",
    applicability: "always",
    statement:
      "Retrieves declarations over HTTPS without ambient credentials. Validates every redirect and final URL against its accepted pointer and network policy. Validates the destination immediately before each connection and connects only to that validated address. Rejects automatic remote-schema retrieval and fails closed on any failed check, as Section 5 requires.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-49",
    role: "authorization-server",
    specItem: 49,
    level: "must",
    applicability: "always",
    statement:
      "Renders all declaration display values and client-authored values, including `client_display`, resolved client metadata, `purpose_description`, and `client_claims`, safely for their output context under Section 5.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-50",
    role: "authorization-server",
    specItem: 50,
    level: "must",
    applicability: "always",
    statement:
      "Accepts a valid client ID metadata document as an identity without requiring preregistration. Keeps that identity-form acceptance distinct from authorization or admission denial under local policy, as Section 6 requires.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-51",
    role: "authorization-server",
    specItem: 51,
    level: "must",
    applicability: "always",
    statement:
      "Freezes each stream's schema-required consent floor from the retained declaration into `required_fields` before issuance. Includes the set in reviewed decision evidence, the client-visible grant, and the grant returned through introspection. Includes an empty array for an empty floor. Keeps the set unchanged for the life of that grant.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-52",
    role: "authorization-server",
    specItem: 52,
    level: "must",
    applicability: "always",
    statement:
      "Applies Authorization privacy boundary to every supported authorization entry point. Performs owner-independent syntax and binding checks without querying private owner availability. Defers owner-dependent resolution to authenticated review.",
    specAnchor: "#authorization-privacy",
  },
  {
    id: "AS-53",
    role: "authorization-server",
    specItem: 53,
    level: "must",
    applicability: "always",
    statement:
      "Keeps optional ineligible streams unapproved. Refuses required ineligible streams and unmet required authorization minima with `access_denied`. Preserves `invalid_authorization_details` for malformed or unsupported details and any error defined for a specific authorization-details type.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-54",
    role: "authorization-server",
    specItem: 54,
    level: "must",
    applicability: "always",
    statement:
      "Demonstrates equivalent pre-authentication observables when only protected owner state varies. Demonstrates equivalent client-visible eligibility denials after review. Includes status, response shape and size, redirects, headers, transaction behavior, and timing in its evidence.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-55",
    role: "authorization-server",
    specItem: 55,
    level: "must",
    applicability: "always",
    statement:
      "Records the entry points, protected-state variants, timing method, and observation limits exercised by its authorization-privacy tests. Reports an unobserved supported path as UNVERIFIED rather than passed.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-56",
    role: "authorization-server",
    specItem: 56,
    level: "must",
    applicability: "always",
    statement:
      "States during final owner review that ordinary access confers no independent-recipient disclosure authority. Distinguishes parties acting for the client. Does not claim that this duty technically prevents onward disclosure. Applies the closed processing-permission rules without substitution or fallback.",
    specAnchor: "#conformance",
  },
  {
    id: "AS-57",
    role: "authorization-server",
    specItem: 57,
    level: "must",
    applicability: "always",
    statement:
      "Passes a differential authorization-privacy case that varies private declaration acceptance, temporal capability, and view availability against a matched owner refusal. The client-visible result, the callback, and any transaction-status channel are equivalent across the variants, and no unapproved diagnostic reaches the client.",
    specAnchor: "#conformance",
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
      "Implements the query endpoints defined in Section 8: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).",
    specAnchor: "#resource-server-interface",
  },
  {
    id: "RS-2",
    role: "resource-server",
    specItem: 2,
    level: "must",
    applicability: "always",
    statement:
      "Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, `required_fields`, frozen `sort_field`, and `resources` filter. Authorizes each disclosure under one grant and never combines the constraints of different grants. Uses Section 4's canonical key representation, never percent-decodes JSON key values, and decodes an HTTP path key exactly once before comparison.",
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
      "In a separated deployment, resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, and makes no second AS lookup while handling the request. A co-located deployment may use a local equivalent. Caches positive results for no more than 60 seconds and never past `exp` when present.",
    specAnchor: "#token-introspection",
  },
  {
    id: "RS-4",
    role: "resource-server",
    specItem: 4,
    level: "must",
    applicability: "always",
    statement:
      "Distinguishes owner tokens from client tokens via `pdpp_token_kind`, and authorizes Core operations only for those two kinds, each under its own rules.",
    specAnchor: "#token-introspection",
  },
  {
    id: "RS-5",
    role: "resource-server",
    specItem: 5,
    level: "must",
    applicability: "always",
    statement:
      "For owner tokens, computes the effective filter as the permitted owner request filter alone (there is no grant filter). For client tokens in v0.1, rejects request-time predicate filters and enforces the frozen grant constraints.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-6",
    role: "resource-server",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement: "Returns structured errors as defined in Section 8 (unified error table).",
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
      "Supports incremental sync via `changes_since` on every stream, starting from `beginning`, with tombstone entries and HTTP 410 with error code `cursor_expired` on cursor expiry. Returns every record not visible at h0 and visible at h1, and omits a record visible at both horizons whose projection did not change, unless the previous session withheld it, or redacted a reference in it, after a deletion. The projection is the grant-authorized projection for a client token, and the session's effective `fields` or resolved `view` projection for an owner token.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-8",
    role: "resource-server",
    specItem: 8,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target supports `changes_since`",
    statement:
      "Returns `next_changes_since` on the terminal page of every `changes_since` response and on no other page.",
    specAnchor: "#list-records",
  },
  {
    id: "RS-9",
    role: "resource-server",
    specItem: 9,
    level: "must",
    applicability: "always",
    statement:
      "Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata; owner-token current-capability reads MAY retain declared filter behavior.",
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
    statement:
      "Implements API versioning: supports the exact `0.1` contract, selects it for an absent header, rejects malformed or unsupported values without fallback, reports the selected contract in responses, and publishes the matching default in protected resource metadata. Binds cursors and synchronization tokens to the selected contract and preserves all grant and profile enforcement independently of it.",
    specAnchor: "#api-versioning",
  },
  {
    id: "RS-12",
    role: "resource-server",
    specItem: 12,
    level: "must",
    applicability: "conditional",
    appliesWhen: "the target issues owner tokens",
    statement:
      "Scopes owner token access to a single subject's data store; derives `subject_id` from introspection response. Never discloses the introspection `subject_id` to a client.",
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
      "SHOULD support owner-authenticated access to the `/v1/streams/{stream}/records` query endpoints without a client grant, allowing the data subject to export their own data directly (self-export).",
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
      "For owner-token stream-metadata reads, returns the full current stream metadata within the owner's subject/source/connection scope, including current query, view, and relationship capabilities.",
    specAnchor: "#stream-metadata",
  },
  {
    id: "RS-15",
    role: "resource-server",
    specItem: 15,
    level: "must",
    applicability: "always",
    statement:
      "For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context: the granted stream and its explicitly granted fields, and immutable/frozen grant facts. MUST NOT include current view, relationship, filter, expansion, or aggregation capability unless that capability is explicitly part of a future frozen grant vocabulary, and MUST NOT surface a source-declaration change made after grant issuance.",
    specAnchor: "#stream-metadata",
  },
  {
    id: "RS-16",
    role: "resource-server",
    specItem: 16,
    level: "must",
    applicability: "always",
    statement:
      "Publishes RFC 9728 protected resource metadata at the location RFC 9728 Section 3 derives from its resource identifier, carrying `resource`, the four required `pdpp_`-prefixed members defined in Section 8, and `authorization_servers` when its issuer set is enumerable. Also carries `pdpp_freshness_granularity_seconds` when it attaches `freshness` to client-token responses. Returns a `WWW-Authenticate: Bearer` challenge on 401 per RFC 6750 Section 3, carrying the RFC 9728 `resource_metadata` parameter.",
    specAnchor: "#protected-resource-metadata",
  },
  {
    id: "RS-17",
    role: "resource-server",
    specItem: 17,
    level: "must",
    applicability: "always",
    statement:
      "Does not interpret an unrecognized stream semantic as `append_only` or `mutable_state`, or an unrecognized grant `source.kind` as a known provenance class.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-18",
    role: "resource-server",
    specItem: 18,
    level: "must",
    applicability: "always",
    statement:
      "Serves a blob only when a record the requesting token may currently read, including its field projection, references it. Otherwise returns 404 `blob_not_found`. Gives a redirect's signed URL an expiry no later than the positive-status cache expiry, or, when no result was cached, 60 seconds after the RS sent the introspection request that validated the token. The expiry is also no later than the token or grant expiration when present. A delayed response never restarts this deadline.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-19",
    role: "resource-server",
    specItem: 19,
    level: "must",
    applicability: "always",
    statement:
      'Returns 401 with `WWW-Authenticate: Bearer error="invalid_token"` for every inactive access token. Uses the structured code `grant_expired` or `grant_revoked` only when authenticated context establishes that cause, otherwise `authentication_error`.',
    specAnchor: "#conformance",
  },
  {
    id: "RS-20",
    role: "resource-server",
    specItem: 20,
    level: "must",
    applicability: "always",
    statement:
      "Emits a tombstone for each record visible at the previous horizon and not visible at the new one, and for no other record. Retains the state needed to determine visibility at every unexpired horizon, and otherwise fails the session with 410 `cursor_expired`. Uses the exact client tombstone shape for client tokens. For owner tokens, adds `removal`, and `deleted_at` and `emitted_at` only for a deletion.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-21",
    role: "resource-server",
    specItem: 21,
    level: "must",
    applicability: "always",
    statement:
      "Binds each page cursor and `changes_since` token to its grant, or owner subject and scope, and to its query context, and rejects a mismatch as `invalid_cursor`. Orders a `changes_since` session by `instance_id` and then canonical key string, does not serve a record deleted after the session's first page, and rejects `expand[]` and `expand_limit[...]` on `changes_since`. Issues tokens and page cursors that reveal no readable position, time, or field value, and whose equality or ordering signals no change outside the grant or owner scope.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-22",
    role: "resource-server",
    specItem: 22,
    level: "must",
    applicability: "always",
    statement:
      "Compares time values and bounds by the grant's frozen `time_constraint.type`, never a current declaration, as calendar dates or exact instants, without a host, viewer, or owner time zone. Validates values itself under RFC 3339, including its leap-second rule. Excludes a record whose value is absent, null, or invalid from every read surface. Applies the same rules to owner-token range filters on `date` and `date-time` fields, using the declared format.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-23",
    role: "resource-server",
    specItem: 23,
    level: "must",
    applicability: "always",
    statement:
      "Puts `instance_id` on every record and tombstone it serves: the grant's handle for a client token, and the owner's handle for an owner token. Serves each `resource_ref` in the resolved or redacted form according to the token-kind, source, and sync-horizon rules in Section 4. In the next session, returns each referring record that the previous session served with a reference redacted after a target deletion, as Section 4 requires. Identifies records within a stream by instance and canonical key in sync, removals, cursors, and single-record reads. Requires `instance_id` on a single-record read or record delete when the query context covers more than one instance of the stream, and on every blob fetch. Rejects a missing one with 400 `invalid_request`.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-24",
    role: "resource-server",
    specItem: 24,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The deployment separates the AS and the RS.",
    statement:
      "In a separated deployment, resolves every handle through `pdpp_instance_bindings`. Fails a client request with 403 `grant_invalid` when a handle the request needs has no binding or names no stored instance. Treats an owner instance without a binding as outside the owner scope.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-25",
    role: "resource-server",
    specItem: 25,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The RS attaches `freshness` to a response.",
    statement:
      "When it attaches `freshness`, lists exactly one entry for each instance that the query context authorizes for the stream, whatever the page contains. Computes `last_success_at` over the full authorized scope of the query, counts only successful operations as Section 8 defines them, and reports null when it cannot establish relevance safely. In a client-token response, carries no failure time, truncates each value to its declared granularity of at least 3600 seconds, and reports no value before its interval ends. Takes a snapshot of the array on the first page of a `changes_since` session and repeats that exact snapshot on every later page. Reports no staleness verdict.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-26",
    role: "resource-server",
    specItem: 26,
    level: "must",
    applicability: "always",
    statement:
      "Builds disclosed `data` only from the top-level members the grant and the request-time field selection permit, with no nulls or fabricated values for withheld members. Refuses a read it cannot serve that way with 403 `disclosure_unavailable`.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-27",
    role: "resource-server",
    specItem: 27,
    level: "must",
    applicability: "always",
    statement:
      "Enforces the resolved grant independently of provider action permission, as Existing permissions and action results defines. Never treats a data grant as action permission or lets a broad read scope widen a grant, and discloses existing data in an action response only under the applicable data grant.",
    specAnchor: "#existing-permissions",
  },
  {
    id: "RS-28",
    role: "resource-server",
    specItem: 28,
    level: "must",
    applicability: "always",
    statement:
      "Delivers an `evidence` item only when it implements the item's type, the proof is valid over the served values and authenticates the attester, the item's record binding verifies for the caller, and the item does not widen the disclosure. Decides per record whether to deliver an item only when that decision is independent of hidden data. Adds no member to an item, delivers no item with an unresolved local reference, never passes an unchecked item through, and marks no item as verified or unverified. Sends no evidence on a tombstone, and does not return a record in a `changes_since` session only because its evidence changed. Delivers evidence on owner-token reads only for types whose profile supports them.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-29",
    role: "resource-server",
    specItem: 29,
    level: "must",
    applicability: "always",
    statement:
      "Never treats `processing_permissions` or a processing credential as read authority. Its operator does not use owner data it holds in the RS role for AI training, except under a training grant issued to it as a client.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-30",
    role: "resource-server",
    specItem: 30,
    level: "must",
    applicability: "always",
    statement:
      "Validates each StreamGrant's explicit `required_fields` and its containment in `fields` before disclosure. Rejects missing or malformed context with 403 `grant_invalid`. Applies the frozen floor to every client record-data projection and its evidence without declaration lookup. Preserves tombstone shape and existing sync eligibility rules.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-31",
    role: "resource-server",
    specItem: 31,
    level: "must",
    applicability: "always",
    statement:
      "For a client request whose explicit `fields` contains both granted and ungranted names, returns 403 `field_not_granted` and no records. The error names only the ungranted names.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-32",
    role: "resource-server",
    specItem: 32,
    level: "must",
    applicability: "always",
    statement:
      "Given the same request and grant, returns the same status, headers, and body, apart from `request_id`, `Request-Id`, and `Date`, when the same well-formed outside-grant name exists in the current schema and when it is invented. It performs no source-schema or record-data lookup before rejection.",
    specAnchor: "#conformance",
  },
  {
    id: "RS-33",
    role: "resource-server",
    specItem: 33,
    level: "must",
    applicability: "always",
    statement:
      "For a client list read whose grant omits the declared date `cursor_field`, uses descending `(instance_id, canonical key)` order by default, even when date order differs. When the grant includes the field, it uses the frozen `sort_field`.",
    specAnchor: "#conformance",
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
      "Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces. MUST NOT use a `next_cursor` value as a `changes_since` parameter.",
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
      "Stores `next_changes_since` from the terminal page of a `changes_since` response for use in the next sync session.",
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
      "Respects HTTP 410 `cursor_expired` responses by starting again from `beginning`, rather than retrying with the expired token. After every completed `beginning` session, replaces its copy of the stream synchronized under that grant and query context with that session's result. Applies each returned record as a replacement of its copy within the same projection, never as a partial update: omission of an optional field inside that projection removes it, and a present `null` is a stored null.",
    specAnchor: "#list-records",
  },
  {
    id: "CL-6",
    role: "client",
    specItem: 6,
    level: "must",
    applicability: "always",
    statement:
      "Honors retention commitments declared in the grant. Counts each record's retention ceiling from its first acquisition, never restarts it, and applies `on_expiry` at the ceiling to the record and its derivatives with no grace period.",
    specAnchor: "#retention",
  },
  {
    id: "CL-7",
    role: "client",
    specItem: 7,
    level: "must",
    applicability: "always",
    statement:
      "Treats unrecognized error codes as opaque, falling back to the exact HTTP status code and applicable response headers rather than failing on an unknown code. Takes the actual status code and headers as the authoritative outcome. Uses a recognized `error.type` only to refine category or presentation, and only when compatible with that outcome. Ignores an absent, unrecognized, or status-incompatible `type` for control flow, and never fails to parse on an unknown `code` or `type`.",
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
      "Where local policy depends on source provenance, MUST read `source.kind` from the issued grant and apply that policy before first use of the records. A client MUST NOT assume a provenance class it did not read from the grant, and MUST NOT treat an unrecognized `source.kind` as either known value. A client with no provenance-dependent policy has nothing to check.",
    specAnchor: "#source-kinds",
  },
  {
    id: "CL-9",
    role: "client",
    specItem: 9,
    level: "must",
    applicability: "always",
    statement:
      "Stops using an access token on a 401 with Bearer error `invalid_token`, and stops requests against a grant on `grant_revoked`. Does not treat an inactive token as proof of revocation. Starts a grant lifecycle query before further use of held data of that grant.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-10",
    role: "client",
    specItem: 10,
    level: "must",
    applicability: "always",
    statement:
      "Identifies each record within a stream by its `instance_id` and `id` together. Treats a tombstone for a record it does not hold as a no-op. Reconciles records it obtained outside sync sessions itself, because the sync guarantee covers only a copy built from sync sessions.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-11",
    role: "client",
    specItem: 11,
    level: "must",
    applicability: "always",
    statement:
      "Does not infer from an empty result, the end of pagination, a tombstone, or a 404 that a record does not exist at the source or that collection is complete. Treats a null `last_success_at` only as the absence of a reportable timestamp.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-12",
    role: "client",
    specItem: 12,
    level: "must",
    applicability: "always",
    statement: "Establishes that the AS advertises `https://pdpp.dev/data-access` before requesting it.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-13",
    role: "client",
    specItem: 13,
    level: "must",
    applicability: "always",
    statement:
      "Inspects the authorization result in each token response, including refresh responses, before requesting record disclosure, and requests no disclosure when it cannot obtain or interpret the result. Does not infer authorization from its original request, a tool listing, or token syntax.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-14",
    role: "client",
    specItem: 14,
    level: "must",
    applicability: "always",
    statement: "Does not validate a projected `data` object as a full stream record.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-15",
    role: "client",
    specItem: 15,
    level: "must",
    applicability: "always",
    statement:
      "Ignores any member that it does not recognize in a Core-defined JSON object that a Section 8 endpoint returns. Does not fail to parse because of that member, as Response forward compatibility requires. This rule does not reach inside profile-defined objects such as an evidence item's `proof`; their profiles define parsing and verification failure.",
    specAnchor: "#response-forward-compatibility",
  },
  {
    id: "CL-16",
    role: "client",
    specItem: 16,
    level: "must",
    applicability: "always",
    statement:
      "Treats an evidence item as absent unless it verifies the item under the profile for its type. Ignores an item with an unknown `type` or `attester.role`. Treats a local reference to an item that the response does not carry as absent, and retrieves a URI reference only as the type's profile defines. Infers record provenance from an item only when it has verified the item's binding to its own record context. For a composed binding, it also verifies the whole chain and trusts the mapping attester. Does not treat delivery as verification, and decides itself whether to trust the attester.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-17",
    role: "client",
    specItem: 17,
    level: "must",
    applicability: "always",
    statement:
      "Trains on PDPP inputs only when every contributing PDPP input has covering training permission and valid processing authority, as AI training defines, regardless of purpose code or acquisition grant. Applies this rule to derivatives and imposes it on every recipient or subprocessor receiving PDPP inputs. Treats the legacy purpose code `https://pdpp.dev/purpose/ai_training` as conferring no training authority.",
    specAnchor: "#ai-training",
  },
  {
    id: "CL-18",
    role: "client",
    specItem: 18,
    level: "must",
    applicability: "always",
    statement:
      "Requests a processing permission only when the AS advertises it in `pdpp_processing_permissions_supported`, in a detail separate from any ordinary access, and with a `purpose_description` where Section 6 requires one.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-19",
    role: "client",
    specItem: 19,
    level: "must",
    applicability: "always",
    statement:
      "After a grant ends, uses its held data only within the grant's surviving-use terms, including only the limited continuation of already-issued processing authority permitted by the defining profile. Otherwise keeps, but does not use, data held only under a grant that carries a processing permission.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-20",
    role: "client",
    specItem: 20,
    level: "must",
    applicability: "always",
    statement:
      "Holds a positive assessment before first use of a grant's held data. Never treats record delivery, introspection, a read error, or a package read status as an assessment.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-21",
    role: "client",
    specItem: 21,
    level: "must",
    applicability: "always",
    statement:
      "While it runs and it or a party acting for it holds held data of a grant, attempts a lifecycle query at least once per reconciliation interval, starting one interval after first acquisition. Retries failed or unanswered attempts as Positive assessment and reconciliation requires, including its `Retry-After` and transport-failure widening rules, until an attempt succeeds or it holds no held data of the grant. Also starts a query before further use after a failure that shows the grant may have ended, and after resuming from suspension or power-off if an attempt fell due meanwhile. Does not treat a failed or unanswered query as a reason to stop use the grant's terms permit.",
    specAnchor: "#reconciliation",
  },
  {
    id: "CL-22",
    role: "client",
    specItem: 22,
    level: "must",
    applicability: "always",
    statement:
      "On learning of an erasure instruction, stops use as soon as practicable and no later than the stop-use bound after its effective time, or at once if it learns of the instruction after that deadline. Deletes the covered data, with the scope and by the deadline Erasure defines. Records its first receipt, never restarts a deadline, and treats the instruction as terminal.",
    specAnchor: "#erasure",
  },
  {
    id: "CL-23",
    role: "client",
    specItem: 23,
    level: "must",
    applicability: "always",
    statement:
      "Applies the overdue-disposal rules in Erasure before further use. Treats backups and legally retained data as Erasure defines.",
    specAnchor: "#erasure",
  },
  {
    id: "CL-24",
    role: "client",
    specItem: 24,
    level: "must",
    applicability: "always",
    statement:
      "Imposes the held-data duties on every party acting for it, and relays erasure instructions with absolute deadlines to it, as Downstream holders defines.",
    specAnchor: "#downstream-holders",
  },
  {
    id: "CL-25",
    role: "client",
    specItem: 25,
    level: "must",
    applicability: "conditional",
    appliesWhen: "The client offers its own disconnect flow.",
    statement:
      "If it offers its own disconnect, states what happens to held data and offers `keep` and `delete` with neither preselected. Treats `delete` as an erasure instruction effective at once.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-26",
    role: "client",
    specItem: 26,
    level: "must",
    applicability: "always",
    statement:
      "Keeps the records that Erasure requires. Exercises already-issued processing authority after effective erasure only within that section's limited continuation and the defining profile's stop requirements.",
    specAnchor: "#erasure",
  },
  {
    id: "CL-27",
    role: "client",
    specItem: 27,
    level: "must",
    applicability: "always",
    statement:
      "Sends a non-empty `purpose_description` that the owner can understand with any purpose code outside Appendix A.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-28",
    role: "client",
    specItem: 28,
    level: "must",
    applicability: "always",
    statement:
      "Retains the authenticated AS issuer with every grant and does not infer it from `grant_id`, `source.id`, or an untrusted credential, as Section 8 requires.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-29",
    role: "client",
    specItem: 29,
    level: "must",
    applicability: "always",
    statement:
      "Discloses PDPP data to an independent recipient only under an expressly covering registered processing permission and valid authority under its defining profile, except for the required-by-law case in Section 7.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-30",
    role: "client",
    specItem: 30,
    level: "must",
    applicability: "always",
    statement:
      "Classifies a receiving party by the operation it performs. Does not treat independent use as processing for the client. Applies the rule to derivatives and service outputs as well as source records.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-31",
    role: "client",
    specItem: 31,
    level: "must",
    applicability: "always",
    statement:
      "Does not infer independent-recipient disclosure authority from purpose, an owner action instruction, a claim, a positive assessment, an erasure exception, or read-token activity. Records any required-by-law disclosure as Section 7 requires.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-32",
    role: "client",
    specItem: 32,
    level: "must",
    applicability: "always",
    statement:
      "Pins a supported HTTP contract with `PDPP-Version` on each Core RS operation, including retries and pagination, and verifies the selected version before using a successful response. Does not infer a contract from a URL path, grant schema, document release, or profile version, and does not silently fall back after a version failure.",
    specAnchor: "#conformance",
  },
  {
    id: "CL-33",
    role: "client",
    specItem: 33,
    level: "must",
    applicability: "always",
    statement:
      "Reads each StreamGrant's `required_fields` from the authorization result before requesting disclosure. Expects those fields in every returned record's `data` when the stored record version has a value for them, and does not infer the set from a declaration.",
    specAnchor: "#conformance",
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

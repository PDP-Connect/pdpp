// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The clause-level normative matrix for Core sections 4-8 and 10.
//
// WHY THIS EXISTS, given catalog.ts already exists. catalog.ts transcribes the
// 45 numbered items in Section 9. Those items are SUMMARIES: Section 9 AS item 2
// is one sentence standing in for six separate normative sentences spread across
// sections 5 and 6. A report that says "23 of 36 applicable items" is therefore
// not a statement about how much of the specification was exercised, because the
// denominator is a list of summaries rather than a list of obligations.
//
// This file is the inventory that makes a coverage claim checkable. Each entry is
// one normative clause of the spec's own text, mapped to the Section 9 item(s)
// that roll it up and to the case IDs that exercise it. Section 9 is used as an
// INDEX, not as the sole authority.
//
// TRANSCRIPTION RULES, applied without exception:
//
//  1. `text` is VERBATIM. Never paraphrased, never trimmed to the keyword. A
//     reader must be able to grep spec-core.md for it.
//  2. `level` is the spec's own keyword. An RFC 2119 SHOULD is recorded as
//     `should`, never promoted to `must` because it sounds important. Promoting
//     one would report a conforming implementation as non-conformant.
//     Eight entries are the exception and say so in their own `gapNote`:
//     5.6-2a, 6.6-1, 7.1-1, 7.2-0, 7.10-1, 8.1-1a, 8.9-16 and 8.14-1 quote
//     subsections that carry NO RFC 2119 keyword, yet a Section 9 item states
//     the same obligation as a MUST. Their level is the conformance list's, not
//     the quoted text's, and the note records that provenance so a reader does
//     not mistake it for a keyword this file invented. Without these entries
//     seven Section 9 items — AS-11, AS-13, AS-17, RS-5, CL-4, CL-6, CL-8 —
//     would trace to no spec text at all, which is itself the finding.
//  3. `requirementIds` may be EMPTY. A clause that no Section 9 item summarizes
//     is a real finding about the spec's conformance section, and it is recorded
//     as such rather than forced into the nearest-looking item.
//  4. Where role or applicability is genuinely undecidable from the text,
//     `observable` is `review-only` and `gapNote` says why. Ambiguity is
//     recorded, not resolved by guessing.
//  5. `caseIds` are real registered case IDs. The self-tests reject a typo.

import type { Applicability, NormativeLevel } from "./catalog.ts";

/**
 * Who a clause binds.
 *
 * Wider than catalog.ts's `Role` because sections 4-8 also bind the party that
 * authors a SourceDeclaration, which Section 9 has no conformance list for.
 * `source-declaration` clauses are why `requirementIds` is sometimes empty.
 */
export type ClauseRole = "authorization-server" | "resource-server" | "client" | "source-declaration";

/**
 * How a clause could be checked, at all — independent of whether this suite
 * checks it today.
 *
 * - `black-box-http`: observable by speaking HTTP to a running target.
 * - `declaration-static`: observable by validating a SourceDeclaration document.
 * - `client-capture`: needs the outgoing requests of a client under test, which
 *   requires a reverse channel the current adapter does not have.
 * - `review-only`: not observable from outside at all (a rendered consent
 *   surface, an internal ordering, a legal commitment), or the clause's binding
 *   is ambiguous. Never silently counted as covered.
 */
export type Observable = "black-box-http" | "declaration-static" | "client-capture" | "review-only";

export interface ClauseEntry {
  /**
   * Condition under which the clause binds. Reuses catalog.ts's `Applicability`
   * vocabulary where it fits; otherwise a short phrase naming the condition, so
   * an `unsupported` result can cite the same words the matrix used.
   */
  readonly applicability: Applicability | string;
  /** Case IDs that exercise this clause. Empty means no executable evidence. */
  readonly caseIds: readonly string[];
  /**
   * Stable identifier: `<section>.<subsection>-<n>`, where `<n>` counts
   * normative clauses within that subsection in document order. `7.4-2` is the
   * second normative clause of Section 7's fourth subsection.
   */
  readonly clauseId: string;
  /**
   * Required when `caseIds` is empty and `level` is `must`: the exact missing
   * hook, fixture, or target capability, in one sentence. Also used to record
   * why a clause is `review-only`.
   */
  readonly gapNote?: string;
  readonly level: NormativeLevel;
  readonly observable: Observable;
  /** Section 9 item(s) that summarize this clause. Empty means none does. */
  readonly requirementIds: readonly string[];
  readonly role: readonly ClauseRole[];
  /** Heading anchor in spec-core.md. Verified against the file by a self-test. */
  readonly specAnchor: string;
  /** Verbatim clause text from spec-core.md. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Section 4: Record Model
// ---------------------------------------------------------------------------

const SECTION_4: readonly ClauseEntry[] = [
  {
    clauseId: "4.3-1",
    requirementIds: ["RS-7"],
    level: "may",
    role: ["resource-server"],
    text: "Resource servers MAY expire historical version data after a retention period.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the target serves at least one `mutable_state` stream",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "4.3-2",
    requirementIds: ["RS-7"],
    level: "must",
    role: ["resource-server"],
    text: "If a client's cursor has expired, the resource server MUST return HTTP 410 Gone with error code `cursor_expired`.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the target serves at least one `mutable_state` stream",
    observable: "black-box-http",
    caseIds: ["RS-7/expired-sync-cursor-reported-as-gone"],
  },
  {
    clauseId: "4.3-3",
    requirementIds: ["CL-5"],
    level: "must",
    role: ["client"],
    text: "The client MUST perform a full re-sync to re-establish its baseline.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the client performs incremental sync",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Client conformance needs a reverse channel: the adapter can only call into a target, so there is no way to observe a client-under-test's outgoing requests after a 410.",
  },
  {
    clauseId: "4.3-4",
    requirementIds: ["CL-3"],
    level: "must",
    role: ["client"],
    text: "A client MUST NOT use a `next_cursor` value as a `changes_since` parameter; they are different token spaces and will produce a protocol error if confused.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Needs a client-adapter hook that captures the client's outgoing query parameters across two sync sessions; the RS-side mirror of this clause is tested as RS-6/cursor-not-accepted-as-changes-since.",
  },
  {
    clauseId: "4.3-5",
    requirementIds: ["RS-8"],
    level: "must",
    role: ["resource-server"],
    text: "The terminal page of a `changes_since` result MUST include a `next_changes_since` field.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the target supports `changes_since`",
    observable: "black-box-http",
    caseIds: ["RS-8/terminal-page-carries-next-changes-since"],
  },
  {
    clauseId: "4.3-6",
    requirementIds: ["RS-7"],
    level: "must",
    role: ["resource-server"],
    text: "When a record is deleted from a `mutable_state` stream, the resource server MUST include a tombstone entry in incremental sync responses for clients whose cursor predates the deletion.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the target serves at least one `mutable_state` stream",
    observable: "black-box-http",
    caseIds: ["RS-7/deletion-surfaces-as-a-tombstone"],
  },
  {
    clauseId: "4.3-7",
    requirementIds: ["RS-7"],
    level: "should",
    role: ["resource-server"],
    text: "If the source system deletion time is unknown, the RS SHOULD use the `emitted_at` value of the delete directive as `deleted_at`.",
    specAnchor: "#incremental-sync-for-mutable-streams",
    applicability: "the target serves at least one `mutable_state` stream",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Not observable: whether the source deletion time was known is internal state, so a `deleted_at` value cannot be judged against this clause from outside.",
  },
  {
    clauseId: "4.5-1",
    requirementIds: [],
    level: "must",
    role: ["source-declaration", "resource-server"],
    text: "Each primary-key component MUST be serialized as a string in the canonical encoding. Non-string primary-key field values (e.g., integers, dates) MUST be converted to their string representation before encoding.",
    specAnchor: "#the-record-envelope",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-1/compound-primary-key-canonically-encoded"],
  },
  {
    clauseId: "4.5-2",
    requirementIds: [],
    level: "must",
    role: ["resource-server"],
    text: "For any record, the values of the `data` fields named by the stream's `primary_key` MUST match the values in the `key` envelope field (in order). A resource server or profile-defined write interface MUST reject a record before storage when those values disagree.",
    specAnchor: "#the-record-envelope",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it.",
  },
  {
    clauseId: "4.6-1",
    requirementIds: [],
    level: "should",
    role: ["source-declaration"],
    text: "Connector authors SHOULD use these names when the platform provides them, rather than inventing platform-specific names.",
    specAnchor: "#timestamps",
    applicability: "always",
    observable: "declaration-static",
    caseIds: [],
  },
  {
    clauseId: "4.8-1",
    requirementIds: [],
    level: "must",
    role: ["source-declaration"],
    text: "`mime_type` MUST be a valid IANA media type (see [IANA Media Types](https://www.iana.org/assignments/media-types/)).",
    specAnchor: "#binary-data-blobref",
    applicability: "the declaration declares a `blob_ref` field",
    observable: "declaration-static",
    caseIds: ["AS-16/blob-ref-invalid-mime-type-refused"],
    gapNote:
      "No Section 9 item covers declaration field validity, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes.",
  },
];

// ---------------------------------------------------------------------------
// Section 5: Source Declaration
// ---------------------------------------------------------------------------

const SECTION_5: readonly ClauseEntry[] = [
  {
    clauseId: "5.2-1",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "The authorization server MUST treat `publisher.id` as authenticated only where an accepted channel or configured mapping binds that publisher to the declaration; absent that binding it MUST NOT support source acceptance, redirect policy, attribution, or any other trust decision.",
    specAnchor: "#sourcedeclaration-fields",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause.",
  },
  {
    clauseId: "5.2-2",
    requirementIds: [],
    level: "must",
    role: ["source-declaration"],
    text: "`primary_key` and `cursor_field` MUST reference fields declared here.",
    specAnchor: "#sourcedeclaration-fields",
    applicability: "always",
    observable: "declaration-static",
    caseIds: ["AS-16/key-field-not-declared-in-schema-refused"],
    gapNote:
      "No Section 9 item covers declaration internal consistency, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes.",
  },
  {
    clauseId: "5.2-3",
    requirementIds: [],
    level: "must",
    role: ["source-declaration"],
    text: "MUST reference a field declared in the schema.",
    specAnchor: "#sourcedeclaration-fields",
    applicability: "the stream declares `consent_time_field`",
    observable: "declaration-static",
    caseIds: ["AS-16/consent-time-field-not-declared-in-schema-refused"],
    gapNote:
      "No Section 9 item covers `consent_time_field` declaration validity, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes.",
  },
  {
    clauseId: "5.2-4",
    requirementIds: ["AS-2"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST reject grants that request `time_range` on a stream without a `consent_time_field`, or that request an unsupported selection parameter.",
    specAnchor: "#sourcedeclaration-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-2/time-range-without-consent-time-field-refused"],
  },
  {
    clauseId: "5.2-5",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server", "source-declaration"],
    text: "If `$schema` is present, it MUST equal `https://json-schema.org/draft/2020-12/schema`. This dialect choice does not by itself guarantee identical validator behavior. The AS MUST meta-validate each embedded stream schema before accepting the declaration. Embedded `$ref` and `$dynamicRef` values MUST be local fragment references. A declaration MUST NOT make consent interpretation depend on a mutable remote schema.",
    specAnchor: "#sourcedeclaration-fields",
    applicability: "always",
    observable: "declaration-static",
    caseIds: ["AS-16/embedded-schema-remote-reference-refused"],
    gapNote:
      "Partially covered. The case exercises the local-reference obligation (`$ref`/`$dynamicRef` must be local fragments), which is the half that makes consent interpretation depend on a mutable remote schema. The `$schema` dialect equality and full metaschema meta-validation are implemented by the reference target but not separately asserted: a case for each would need its own defect to discriminate, and the remote-reference oracle already fails a target that skips embedded-schema validation altogether.",
  },
  {
    clauseId: "5.3-1",
    requirementIds: [],
    level: "may",
    role: ["source-declaration"],
    text: "Streams MAY include a `display` object with human-readable metadata for the consent UI.",
    specAnchor: "#stream-display",
    applicability: "always",
    observable: "declaration-static",
    caseIds: [],
  },
  {
    clauseId: "5.3-2",
    requirementIds: ["AS-7"],
    level: "should",
    role: ["authorization-server"],
    text: "If absent, the AS SHOULD display `streams[].description` or fall back to the stream name.",
    specAnchor: "#stream-display",
    applicability: "the declaration omits `display.label`",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Consent-surface rendering is not observable over HTTP; a case could only assert on a deployment's HTML, which tests the deployment rather than the protocol.",
  },
  {
    clauseId: "5.3-3",
    requirementIds: ["AS-7"],
    level: "may",
    role: ["authorization-server"],
    text: "If absent, the AS MAY generate a description from the stream schema, or display no detail.",
    specAnchor: "#stream-display",
    applicability: "the declaration omits `display.detail`",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "5.3-4",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["client"],
    text: "The requesting client MUST NOT override or supplement these descriptions in the selection request.",
    specAnchor: "#stream-display",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Needs a client-adapter hook capturing the client's outgoing selection request so its payload can be inspected for declaration-display overrides.",
  },
  {
    clauseId: "5.4-1",
    requirementIds: [],
    level: "must",
    role: ["source-declaration"],
    text: "The `consent_time_field` may be the same field as `cursor_field`, but they serve different purposes and MUST be declared separately:",
    specAnchor: "#consenttimefield",
    applicability: "always",
    observable: "declaration-static",
    caseIds: ["AS-16/consent-time-field-not-inferred-from-cursor-field"],
    gapNote:
      "No Section 9 item covers it, so `requirementIds` stays empty. The case reads the clause's MUST as its observable consequence: a stream claiming time-range capability without declaring `consent_time_field` forces the AS to infer the consent boundary from `cursor_field`, which is what separate declaration forbids.",
  },
  {
    clauseId: "5.4-2",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "The `consent_time_field` MUST be rendered in human-readable consent UX.",
    specAnchor: "#consenttimefield",
    applicability: "the grant carries a `time_constraint`",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed.",
  },
  {
    clauseId: "5.6-1",
    requirementIds: [],
    level: "may",
    role: ["source-declaration"],
    text: "Declaration publishers MAY suggest views.",
    specAnchor: "#views",
    applicability: "always",
    observable: "declaration-static",
    caseIds: [],
  },
  {
    clauseId: "5.6-2",
    requirementIds: ["AS-12"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST NOT define a view that includes fields absent from the retained SourceDeclaration schema for the relevant stream.",
    specAnchor: "#views",
    applicability: "the AS supports views",
    observable: "black-box-http",
    caseIds: ["AS-12/view-within-declared-schema"],
  },
  {
    clauseId: "5.6-2a",
    requirementIds: ["AS-13"],
    level: "must",
    role: ["authorization-server"],
    text: "Grants are bound to the resolved field set at issuance time: `fields` in the `StreamGrant` is authoritative, not the view name. View evolution (adding new fields to a view) never silently widens existing grants. Re-consent is required before a client can access new fields, even if those fields are subsequently added to a named view the client already has a grant for.",
    specAnchor: "#views",
    applicability: "the AS supports views",
    observable: "black-box-http",
    caseIds: ["AS-13/view-evolution-does-not-widen-an-issued-grant"],
    gapNote:
      "Recorded as MUST-equivalent because Section 9 AS item 13 states it as one; the spec's own sentence here carries no RFC 2119 keyword, so the binding level is the conformance list's rather than this subsection's. The covering case exercises the field-widening half against a target whose view evolves after issuance; the re-consent half binds a consent flow the suite cannot drive.",
  },
  {
    clauseId: "5.6-3",
    requirementIds: [],
    level: "must",
    role: ["authorization-server", "resource-server", "client"],
    text: "Implementations MUST treat unrecognized view URIs as opaque identifiers.",
    specAnchor: "#views",
    applicability: "the AS supports views",
    observable: "black-box-http",
    caseIds: ["AS-13/unrecognized-view-uri-treated-as-opaque"],
  },
  {
    clauseId: "5.8-1",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["client"],
    text: "A client MUST NOT introduce a new source authority or declaration URI during authorization.",
    specAnchor: "#declaration-acceptance",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-16/unonboarded-source-authority-refused"],
  },
  {
    clauseId: "5.8-2",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "For a `provider_native` source, `source.id` MUST be identical to the protected-resource identifier the authorization server has already accepted for that resource. The authorization server MUST reject any mismatch before consent or grant issuance.",
    specAnchor: "#declaration-acceptance",
    applicability: "the source kind is `provider_native`",
    observable: "black-box-http",
    caseIds: ["AS-16/provider-native-source-id-mismatch-refused"],
  },
  {
    clauseId: "5.8-3",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "Without such a binding, the authorization server MUST NOT rely on `publisher.id` for source acceptance, attribution, redirect policy, or any other trust decision.",
    specAnchor: "#declaration-acceptance",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Restates 5.2-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome.",
  },
  {
    clauseId: "5.8-4",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "Different parsed content under an accepted key is equivocation: the authorization server MUST reject it and retain the previously accepted content, and MUST NOT infer ordering or freshness from `declaration_version`.",
    specAnchor: "#declaration-acceptance",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-16/declaration-equivocation-refused-and-prior-content-retained"],
  },
  {
    clauseId: "5.8-5",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "When retrieving a declaration, the authorization server MUST use HTTPS without ambient credentials. It MUST validate every redirect target and the final URL against its accepted declaration pointer and network policy. It MUST reject a declaration that requires automatic retrieval of a remote schema, and MUST fail closed when any check fails.",
    specAnchor: "#declaration-acceptance",
    applicability: "the AS retrieves declarations over the network",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Retrieval hygiene is observed from the AS's outbound side; the suite has no way to host a declaration and watch how the AS fetches it, which would need an inbound HTTP fixture the harness does not provide.",
  },
  {
    clauseId: "5.8-6",
    requirementIds: ["AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "The authorization server MUST validate the destination address against its network policy immediately before each connection attempt, including each redirect hop. It MUST connect only to an address from that validated result.",
    specAnchor: "#declaration-acceptance",
    applicability: "the AS retrieves declarations over the network",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client.",
  },
  {
    clauseId: "5.8-7",
    requirementIds: ["AS-7", "AS-16"],
    level: "must",
    role: ["authorization-server"],
    text: "An authorization server MUST render declaration display values safely for the output context, by context-appropriate escaping, by sanitization, or by any construction that guarantees the value cannot be interpreted as markup, script, or a control sequence in that context.",
    specAnchor: "#declaration-acceptance",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges.",
  },
  {
    clauseId: "5.8-8",
    requirementIds: ["AS-16", "RS-15"],
    level: "must",
    role: ["authorization-server", "resource-server"],
    text: "Current declaration capabilities MUST NOT widen an issued grant.",
    specAnchor: "#declaration-acceptance",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-15/client-metadata-projection-closed"],
  },
];

// ---------------------------------------------------------------------------
// Section 6: Selection Request
// ---------------------------------------------------------------------------

const SECTION_6: readonly ClauseEntry[] = [
  {
    clauseId: "6.1-1",
    requirementIds: ["AS-7"],
    level: "may",
    role: ["authorization-server"],
    text: "The AS MAY replace or augment inline values with locally registered metadata, validated binding metadata, validated software-statement metadata, or trust-registry metadata.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "6.1-2",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "a conforming authorization server MUST NOT reject a valid client ID metadata document solely because the client is not preregistered.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-7/valid-url-hosted-client-identity-accepted", "AS-7/malformed-url-hosted-client-identity-refused"],
  },
  {
    clauseId: "6.1-3",
    requirementIds: [],
    level: "may",
    role: ["authorization-server"],
    text: "the server MAY still deny authorization, rate-limit the client, or require a registry-derived trust or admission result, under local policy and for any reason other than the absence of preregistration.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "6.1-4",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "For PDPP Core v0.1 interoperability, a conforming authorization server MUST accept a valid URL-hosted client identity unless local policy denies authorization.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-7/valid-url-hosted-client-identity-accepted", "AS-7/malformed-url-hosted-client-identity-refused"],
  },
  {
    clauseId: "6.1-5",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST resolve requester identity metadata from the best available source. Source precedence is local registration or trust-registry metadata, then validated software-statement metadata if supported, then validated binding metadata, then inline `client_display`, then `client_id` fallback.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable.",
  },
  {
    clauseId: "6.1-6",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "If the resolved metadata contains a display name, the AS MUST display it to the user during consent. If no display name is available, the AS MUST display `client_id` as the requester identity.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered.",
  },
  {
    clauseId: "6.1-7",
    requirementIds: ["AS-7"],
    level: "may",
    role: ["authorization-server"],
    text: "If the resolved metadata contains `policy_uri` or `tos_uri`, the AS MAY display them as secondary links or disclosures.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "6.1-8",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: 'If the server has a positive trust signal for the client (e.g., verified domain control, trust registry membership), it MUST render that status distinctly (e.g., a "verified" badge). If it has no positive trust signal, it MUST treat the client as unverified and SHOULD display an "unverified app" indicator.',
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives.",
  },
  {
    clauseId: "6.1-9",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: 'The AS MAY treat verified domain control as a positive trust signal under obligation 4, and when it does it MUST name the verified domain rather than assert an unqualified verification (for example "Verified domain: example.com", not "Verified app"). [...] the AS MUST NOT present it as one.',
    specAnchor: "#client-display",
    applicability: "the AS treats verified domain control as a trust signal",
    observable: "review-only",
    caseIds: [],
    gapNote: "Consent-surface wording obligation; not observable without asserting on a deployment's rendered text.",
  },
  {
    clauseId: "6.1-10",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST treat `logo_uri` as untrusted content until it has been accepted under local policy. It MUST NOT fetch and render a client-supplied remote logo in the consent UI unless the client is verified or the asset has been proxied, cached, and approved under local policy. For unverified clients, the AS SHOULD generate a monogram from the resolved display name.",
    specAnchor: "#client-display",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Observing whether the AS fetched a remote logo needs an inbound HTTP fixture the AS would call out to, which the harness does not provide.",
  },
  {
    clauseId: "6.1-11",
    requirementIds: ["AS-7"],
    level: "should",
    role: ["authorization-server"],
    text: "If neither resolved metadata nor inline `client_display` provides a display name, the consent UI SHOULD clearly indicate that the client has not provided display metadata.",
    specAnchor: "#client-display",
    applicability: "the client provides no display name",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "6.2-1",
    requirementIds: [],
    level: "may",
    role: ["authorization-server"],
    text: "An authorization server MAY support clients that are public and pre-registered by the deployment rather than dynamically registered.",
    specAnchor: "#pre-registered-public-clients",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "6.2-2",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "the field MUST NOT contain secrets, access tokens, owner-scoped clients, dynamically registered clients, or private registration state.",
    specAnchor: "#pre-registered-public-clients",
    applicability: "the AS advertises `pre_registered_public` in `pdpp_registration_modes_supported`",
    observable: "black-box-http",
    caseIds: ["AS-7/pre-registered-public-clients-carry-no-private-state"],
  },
  {
    clauseId: "6.3-1",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: 'The AS MUST render `client_claims` content separately from protocol-enforced grant terms and MUST attribute it to the client (e.g., "[client name] says:"). The AS MUST NOT render client claims in the same visual register as protocol-enforced grant terms, structured policy declarations, or declaration-authored data descriptions.',
    specAnchor: "#client-claims",
    applicability: "the selection request carries `client_claims`",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle.",
  },
  {
    clauseId: "6.3-2",
    requirementIds: ["AS-15"],
    level: "must",
    role: ["authorization-server"],
    text: "If rendered on the final owner review surface, `client_claims` MUST be normalized and bound exactly, with client attribution, into the immutable final approval artifact and review revision. Retained consent evidence MUST preserve that binding.",
    specAnchor: "#client-claims",
    applicability: "`client_claims` are rendered on the final review surface",
    observable: "black-box-http",
    caseIds: ["AS-15/rendered-client-claims-bound-with-attribution"],
  },
  {
    clauseId: "6.3-3",
    requirementIds: ["AS-3"],
    level: "should",
    role: ["authorization-server", "client"],
    text: 'Structured grant fields (e.g., `retention.max_duration`, `access_mode`) SHOULD be rendered by the AS as server-generated display text (e.g., "Deleted within 90 days", "Ongoing access until you revoke it"). Clients SHOULD NOT duplicate machine-readable constraints as free-text commitments.',
    specAnchor: "#client-claims",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "6.4-1",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server"],
    text: "A conformant AS MUST preserve the distinction between protocol-enforced terms, structured policy declarations, declaration-authored data descriptions, and client-authored claims. It MUST NOT flatten these categories into a single undifferentiated consent surface.",
    specAnchor: "#semantic-classes-and-consent-surface-rendering",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered.",
  },
  {
    clauseId: "6.5-1",
    requirementIds: ["AS-6"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST accept any syntactically valid absolute-URI purpose code. For unrecognized codes, the AS MUST display `purpose_description` if present, or the raw URI if not, and MUST NOT reject the request solely because the purpose code is unrecognized.",
    specAnchor: "#request-level-parameters",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-6/unregistered-purpose-not-rejected"],
  },
  {
    clauseId: "6.5-2",
    requirementIds: ["AS-7"],
    level: "must",
    role: ["authorization-server", "client"],
    text: "Clients SHOULD provide this field. When present, the AS MUST display it.",
    specAnchor: "#request-level-parameters",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam.",
  },
  {
    clauseId: "6.6-1",
    requirementIds: ["CL-8"],
    level: "must",
    role: ["client", "authorization-server"],
    text: "A selection request does not carry `source.kind`. The authorization server derives the provenance class from the declaration it accepted for `source.id`, and records it in consent evidence and any issued grant, where a client reads it back through introspection. A client whose policy depends on provenance therefore reads it from the issued grant rather than asserting an expectation in the request; Section 9 states that as a client requirement.",
    specAnchor: "#source-kinds",
    applicability: "the client has provenance-dependent local policy",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "The subsection is descriptive and carries no RFC 2119 keyword; its MUST level is Section 9 CL item 8's, not this text's. Testing the client half needs the client reverse channel the adapter lacks.",
  },
  {
    clauseId: "6.7-1",
    requirementIds: ["AS-14"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST obtain explicit affirmative user consent before issuing any grant with `purpose_code` value `https://pdpp.dev/purpose/ai_training`.",
    specAnchor: "#ai-training-consent",
    applicability: "the AS issues grants carrying the ai_training purpose code",
    observable: "review-only",
    caseIds: ["AS-14/explicit-consent-required-for-ai-training"],
  },
  {
    clauseId: "6.8-1",
    requirementIds: ["AS-2", "AS-5"],
    level: "must",
    role: ["authorization-server"],
    text: "Mutually exclusive with `fields` in a request; both MUST NOT be present simultaneously. AS returns 400 `invalid_request` if both are present.",
    specAnchor: "#stream-selection-parameters",
    applicability: "the AS supports views",
    observable: "black-box-http",
    caseIds: ["AS-2/view-and-fields-mutually-exclusive"],
  },
  {
    clauseId: "6.8-2",
    requirementIds: ["AS-2"],
    level: "must",
    role: ["authorization-server"],
    text: "The authorization server MUST reject selection requests that specify `time_range` on a stream without that field.",
    specAnchor: "#stream-selection-parameters",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-2/time-range-without-consent-time-field-refused"],
  },
  {
    clauseId: "6.8-3",
    requirementIds: ["AS-2", "AS-4"],
    level: "must",
    role: ["authorization-server"],
    text: "A wildcard entry MUST be the only entry in `streams`. Otherwise stream names MUST be unique within the request.",
    specAnchor: "#stream-selection-parameters",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-2/wildcard-beside-named-stream-refused", "AS-2/duplicate-stream-name-refused"],
  },
  {
    clauseId: "6.8-4",
    requirementIds: ["CL-1"],
    level: "should",
    role: ["client"],
    text: "Clients SHOULD request only the data they need (see [Section 11, Data Minimization](#data-minimization)).",
    specAnchor: "#stream-selection-parameters",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
  },
  {
    clauseId: "6.9-1",
    requirementIds: ["AS-2"],
    level: "must",
    role: ["authorization-server"],
    text: "Each selection preset MUST NOT contain the same stream name more than once.",
    specAnchor: "#selection-presets",
    applicability: "the AS supports selection presets",
    observable: "black-box-http",
    caseIds: ["AS-16/duplicate-stream-in-a-selection-preset-refused"],
  },
];

// ---------------------------------------------------------------------------
// Section 7: Grant
// ---------------------------------------------------------------------------

const SECTION_7: readonly ClauseEntry[] = [
  {
    clauseId: "7.1-1",
    requirementIds: ["AS-3", "AS-11"],
    level: "must",
    role: ["authorization-server"],
    text: "**The following field table is normative.** [Section 13](#typescript-types)'s TypeScript types are a non-normative convenience mirror; on conflict, this table wins.",
    specAnchor: "#grant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [
      "AS-3/issued-grant-artifact-matches-section-7-schema",
      "AS-3/resolved-grant-matches-observable-schema-fields",
    ],
  },
  {
    clauseId: "7.2-0",
    requirementIds: ["AS-11"],
    level: "must",
    role: ["authorization-server"],
    text: "Unique non-empty resolved field allowlist, authoritative for RS enforcement. Top-level field names only.",
    specAnchor: "#streamgrant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-2/dotted-nested-field-refused"],
    gapNote:
      "The `fields` row of the normative StreamGrant table; carries no RFC 2119 keyword, so its MUST level is Section 9 AS item 11's. The top-level-only constraint is tested; uniqueness and non-emptiness of the issued allowlist are not.",
  },
  {
    clauseId: "7.2-1",
    requirementIds: ["AS-15", "AS-4"],
    level: "must",
    role: ["authorization-server"],
    text: "Before the final approval surface is shown, the AS MUST resolve omitted `instance_ids` to exact eligible instance handles or require an explicit owner choice.",
    specAnchor: "#streamgrant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-4/omitted-fields-expanded-before-issuance"],
  },
  {
    clauseId: "7.2-2",
    requirementIds: ["AS-15"],
    level: "must",
    role: ["authorization-server"],
    text: "The final approval artifact MUST include the exact resolved `instance_ids`, stream names, fields, resources, temporal field, `since`, `until`, purpose, retention, client identity, and grant expiry.",
    specAnchor: "#streamgrant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-15/final-approval-artifact-carries-resolved-terms"],
  },
  {
    clauseId: "7.2-3",
    requirementIds: ["AS-15"],
    level: "must",
    role: ["authorization-server"],
    text: "The approval mutation MUST bind to an immutable review revision or digest over the authorization decision fields.",
    specAnchor: "#streamgrant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-15/approval-requires-the-issued-revision"],
  },
  {
    clauseId: "7.2-4",
    requirementIds: ["AS-3", "AS-15"],
    level: "must",
    role: ["authorization-server", "resource-server"],
    text: "`client_claims` MUST remain outside the resolved grant and RS enforcement.",
    specAnchor: "#streamgrant-fields",
    applicability: "the selection request carries `client_claims`",
    observable: "black-box-http",
    caseIds: ["AS-3/client-claims-stay-outside-the-resolved-grant"],
  },
  {
    clauseId: "7.2-5",
    requirementIds: ["AS-15"],
    level: "must",
    role: ["authorization-server"],
    text: "If instance eligibility or the reviewed revision becomes stale before approval, the AS MUST reject approval and require a new review.",
    specAnchor: "#streamgrant-fields",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-15/approval-requires-the-issued-revision"],
  },
  {
    clauseId: "7.4-1",
    requirementIds: [],
    level: "must",
    role: ["authorization-server", "resource-server", "client"],
    text: "Three independent version axes exist in PDPP. They MUST NOT be conflated:",
    specAnchor: "#version-layering",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.4-2, AS-17, and RS-11.",
  },
  {
    clauseId: "7.4-2",
    requirementIds: ["RS-11"],
    level: "must",
    role: ["resource-server"],
    text: "RS MUST reject grants with unsupported major versions, returning 400 `unsupported_version`.",
    specAnchor: "#version-layering",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-11/unsupported-grant-schema-version-rejected"],
  },
  {
    clauseId: "7.4-3",
    requirementIds: ["AS-21"],
    level: "must",
    role: ["authorization-server", "resource-server"],
    text: "The current persisted-authorization-state reader MUST reject any persisted authorization state whose version or shape it cannot validate against a supported contract before its caller continues introspection or route handling. The reader MUST NOT reconstruct missing authorization or binding facts from current configuration. A deployment that cannot support or explicitly migrate such state MUST require fresh consent.",
    specAnchor: "#version-layering",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling.",
  },
  {
    clauseId: "7.5-1",
    requirementIds: ["AS-10"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST reject subsequent attempts to issue new client access tokens against the same consumed grant.",
    specAnchor: "#access-modes",
    applicability: "the AS supports `single_use` grants",
    observable: "black-box-http",
    caseIds: ["AS-10/single-use-grant-consumed"],
  },
  {
    clauseId: "7.5-2",
    requirementIds: ["AS-10"],
    level: "may",
    role: ["client"],
    text: "The client MAY retry or resume pagination using the same access token.",
    specAnchor: "#access-modes",
    applicability: "the AS supports `single_use` grants",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "7.8-1",
    requirementIds: [],
    level: "should",
    role: ["authorization-server"],
    text: "Authorization server UIs SHOULD model this flow as revocation followed by a new grant request.",
    specAnchor: "#grant-narrowing",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "7.10-1",
    requirementIds: ["CL-6"],
    level: "must",
    role: ["client"],
    text: "Retention is a structured policy declaration and policy commitment by the data recipient (the client). PDPP does not technically enforce retention. Enforcement is through legal agreements or contractual obligations; a trust registry supports admission and accountability for a retention commitment rather than enforcing it, because Core defines no compliance-evidence query a registry could answer.",
    specAnchor: "#retention",
    applicability: "the grant carries a `retention` policy",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The spec states outright that PDPP does not technically enforce retention, so no protocol test can exist; Section 9 CL item 6 states it as a client MUST, and the only available evidence is contractual rather than executable.",
  },
];

// ---------------------------------------------------------------------------
// Section 8: Resource Server Interface
// ---------------------------------------------------------------------------

const SECTION_8: readonly ClauseEntry[] = [
  {
    clauseId: "8.1-1",
    requirementIds: ["RS-3"],
    level: "must",
    role: ["resource-server"],
    text: "Positive introspection results MUST NOT be cached longer than `min(token_exp, 60 seconds)`.",
    specAnchor: "#grant-enforcement",
    applicability: "the deployment separates AS and RS",
    observable: "black-box-http",
    caseIds: [],
    gapNote:
      "Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports.",
  },
  {
    clauseId: "8.1-1a",
    requirementIds: ["RS-5"],
    level: "must",
    role: ["resource-server"],
    text: "For owner-token current-capability reads, the effective filter is the permitted owner request filter alone: an owner token carries no grant, so there is no grant filter to intersect. Request filters can only narrow the current owner read and cannot widen it. [...] In v0.1, client-token reads do not have request-time predicate filters (see List records below); the resource server enforces the frozen grant constraints and rejects a client request-time predicate filter rather than evaluating it.",
    specAnchor: "#grant-enforcement",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-exact-filter-rejected", "RS-10/owner-filter-unknown-field-rejected"],
    gapNote:
      "Carries no RFC 2119 keyword here; its MUST level is Section 9 RS item 5's, and the enforceable half is restated with keywords at 8.9-2 and 8.9-9. The owner-side \"cannot widen\" property is not directly tested — that needs an owner filter naming a record outside the owner's scope.",
  },
  {
    clauseId: "8.1-2",
    requirementIds: ["RS-2", "RS-15"],
    level: "must",
    role: ["resource-server"],
    text: "The RS MUST NOT re-validate authorization against the current SourceDeclaration. All enforcement constraints are in the resolved grant. Current serving metadata MAY route a granted instance, describe current schemas or query capabilities, or reject a request that cannot currently be served. It MUST NOT widen or reinterpret a stream, instance, field, time field, bound, or resource key.",
    specAnchor: "#grant-enforcement",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-15/client-metadata-projection-closed", "RS-2/field-projection-not-exceeded"],
  },
  {
    clauseId: "8.1-3",
    requirementIds: ["RS-4"],
    level: "must",
    role: ["resource-server"],
    text: "The RS MUST determine the token's properties (including `pdpp_token_kind`) solely from the introspection response, never from token syntax.",
    specAnchor: "#grant-enforcement",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-4/token-kind-not-inferred-from-syntax"],
  },
  {
    clauseId: "8.2-1",
    requirementIds: ["RS-3", "AS-18"],
    level: "must",
    role: ["resource-server"],
    text: "For separated AS/RS deployments, the RS MUST authenticate to the AS introspection endpoint as required by RFC 7662.",
    specAnchor: "#token-introspection",
    applicability: "the deployment separates AS and RS",
    observable: "black-box-http",
    caseIds: ["AS-18/introspection-requires-authentication"],
  },
  {
    clauseId: "8.2-2",
    requirementIds: ["AS-18", "RS-3"],
    level: "must",
    role: ["authorization-server", "resource-server"],
    text: "The introspection response MUST contain the complete context needed to enforce the request. The separated RS MUST enforce only from that response and MUST NOT make a second AS lookup while handling the request.",
    specAnchor: "#token-introspection",
    applicability: "the deployment separates AS and RS",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer.",
  },
  {
    clauseId: "8.2-3",
    requirementIds: ["RS-4"],
    level: "must",
    role: ["resource-server"],
    text: "A resource server that receives a `pdpp_token_kind` value it does not recognize MUST treat the token as unauthorized for all operations defined in this specification.",
    specAnchor: "#token-introspection",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-4/unrecognized-token-kind-is-unauthorized"],
  },
  {
    clauseId: "8.2-4",
    requirementIds: ["RS-3"],
    level: "must",
    role: ["resource-server"],
    text: "Self-contained JWTs (e.g., signed JWTs) are allowed as an optimization but MUST NOT be the sole revocation mechanism; the RS MUST still be able to check active status through introspection or local equivalent.",
    specAnchor: "#token-introspection",
    applicability: "the RS issues or accepts self-contained tokens",
    observable: "black-box-http",
    caseIds: ["AS-8/revoked-grant-refused"],
  },
  {
    clauseId: "8.3-1",
    requirementIds: ["RS-12"],
    level: "must",
    role: ["resource-server"],
    text: "The RS MUST derive the `subject_id` from the introspection response and MUST reject any request attempting to access data outside that subject's scope.",
    specAnchor: "#authentication",
    applicability: "the target issues owner tokens",
    observable: "black-box-http",
    caseIds: ["RS-12/foreign-subject-cannot-read"],
  },
  {
    clauseId: "8.3-2",
    requirementIds: ["RS-13"],
    level: "should",
    role: ["resource-server"],
    text: "An owner holding a valid owner token MAY query their own data using the standard client query endpoints without a client grant. This is the v0.1 self-export mechanism and does not require a separate grant. Conformant Core RS implementations SHOULD support this capability (see Section 9 conformance item 13).",
    specAnchor: "#authentication",
    applicability: "the target declares `pdpp_self_export_supported`",
    observable: "black-box-http",
    caseIds: ["RS-13/self-export-supported"],
  },
  {
    clauseId: "8.4-1",
    requirementIds: ["RS-16"],
    level: "must",
    role: ["resource-server"],
    text: "A resource server MUST publish OAuth 2.0 Protected Resource Metadata as defined in RFC 9728.",
    specAnchor: "#protected-resource-metadata",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-16/protected-resource-metadata-published"],
  },
  {
    clauseId: "8.4-2",
    requirementIds: ["RS-16"],
    level: "must",
    role: ["resource-server"],
    text: 'On a 401, the resource server MUST include a `WWW-Authenticate: Bearer` challenge, as RFC 6750 Section 3 requires. It MUST set `error="invalid_token"` when a token was presented and rejected. And it MUST include the `resource_metadata` parameter RFC 9728 Section 5.1 defines, carrying the URL of this document.',
    specAnchor: "#protected-resource-metadata",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-16/401-carries-resource-metadata-challenge", "RS-16/unauthenticated-request-refused"],
  },
  {
    clauseId: "8.4-3",
    requirementIds: ["RS-16"],
    level: "should",
    role: ["resource-server"],
    text: "a resource server SHOULD publish it because a consent surface has no other name to display for the resource.",
    specAnchor: "#protected-resource-metadata",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "8.4-4",
    requirementIds: ["RS-16"],
    level: "must",
    role: ["resource-server"],
    text: "A PDPP resource server MUST publish `authorization_servers` when that set is enumerable, so a client can reach the issuer without prior configuration. When the set is not enumerable, the resource server MUST omit the member rather than publish a partial list.",
    specAnchor: "#protected-resource-metadata",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability.",
  },
  {
    clauseId: "8.7-1",
    requirementIds: ["RS-15"],
    level: "must",
    role: ["resource-server"],
    text: "Current query, view, relationship, filter, expansion, and aggregation capabilities MUST NOT appear unless that capability is explicitly part of a future frozen grant vocabulary. Current metadata MAY report availability/freshness or reject an unavailable operation, but MUST NOT make the grant appear broader or semantically different than what was issued. A source declaration change made after the grant was issued (e.g., a new field) MUST NOT become visible through this endpoint for that grant.",
    specAnchor: "#stream-metadata",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-15/client-metadata-projection-closed"],
  },
  {
    clauseId: "8.8-1",
    requirementIds: [],
    level: "may",
    role: ["resource-server"],
    text: "A resource server MAY attach a `freshness` object to stream listings, stream metadata, and record-list responses.",
    specAnchor: "#freshness-metadata",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "8.9-1",
    requirementIds: ["CL-3"],
    level: "must",
    role: ["client"],
    text: "Clients MUST NOT parse or construct cursor tokens.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Needs a client-adapter hook capturing outgoing cursor values across pages so a constructed cursor is distinguishable from an echoed one.",
  },
  {
    clauseId: "8.9-2",
    requirementIds: ["RS-9"],
    level: "must",
    role: ["resource-server"],
    text: "Owner-token current-capability filters only. Client-token requests MUST reject exact and range forms in v0.1.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-exact-filter-rejected"],
  },
  {
    clauseId: "8.9-3",
    requirementIds: ["RS-9"],
    level: "must",
    role: ["resource-server"],
    text: "Client-token records requests MUST reject `view`; clients use explicit `fields` or the field projection already frozen into the grant. Mutually exclusive with `fields`.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-view-rejected"],
    gapNote:
      "The client-token rejection half is covered. The sentence's second half — `view` and `fields` being mutually exclusive — is an owner-token concern (a client token must reject `view` outright, so the pair can never both be honoured there) and is tracked at 6.8-1, which needs a view-declaring target.",
  },
  {
    clauseId: "8.9-4",
    requirementIds: ["RS-9"],
    level: "must",
    role: ["resource-server"],
    text: "Client-token requests MUST reject this parameter in v0.1.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-expand-rejected"],
  },
  {
    clauseId: "8.9-5",
    requirementIds: ["RS-9", "RS-10"],
    level: "must",
    role: ["resource-server"],
    text: "Client-token requests MUST reject this parameter in v0.1.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-expand-limit-rejected"],
  },
  {
    clauseId: "8.9-6",
    requirementIds: ["RS-14"],
    level: "must",
    role: ["resource-server", "source-declaration"],
    text: "Advanced stream-specific query power MUST be declared in stream metadata under `query`.",
    specAnchor: "#list-records",
    applicability: "the target supports advanced query capability",
    observable: "black-box-http",
    caseIds: ["RS-14/owner-metadata-full-current-document"],
  },
  {
    clauseId: "8.9-7",
    requirementIds: ["RS-10"],
    level: "must",
    role: ["resource-server"],
    text: "Unknown query parameters and unsupported query shapes MUST be rejected with HTTP 400 and MUST NOT be silently ignored.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [
      "RS-10/unknown-parameter-rejected",
      "RS-10/unsupported-bracketed-shape-rejected",
      "RS-10/owner-filter-unknown-field-rejected",
      "RS-10/owner-expand-undeclared-relation-rejected",
    ],
  },
  {
    clauseId: "8.9-8",
    requirementIds: ["RS-10"],
    level: "must",
    role: ["resource-server", "client"],
    text: "clients SHOULD branch on `code`, not on message text. [...] Warnings are not errors and MUST NOT change the HTTP status.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-10/oversized-limit-clamped-with-warning"],
  },
  {
    clauseId: "8.9-9",
    requirementIds: ["RS-9"],
    level: "must",
    role: ["resource-server"],
    text: "Client-token requests that contain any exact or range `filter[...]` parameter MUST be rejected with HTTP 400 `invalid_request` before the RS consults current SourceDeclaration or serving metadata. This rejection applies regardless of whether the field or operator would otherwise be declared.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-exact-filter-rejected"],
    gapNote:
      'The status and code are tested; the ordering half ("before the RS consults ... metadata") is not, and black-box observation cannot establish it.',
  },
  {
    clauseId: "8.9-10",
    requirementIds: ["RS-9"],
    level: "must",
    role: ["resource-server"],
    text: "Client-token requests that contain `expand[]` or `expand_limit[...]` MUST be rejected with HTTP 400 `invalid_request` before the RS consults current SourceDeclaration or serving metadata.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-9/client-token-expand-rejected"],
  },
  {
    clauseId: "8.9-11",
    requirementIds: ["RS-6", "CL-3"],
    level: "must",
    role: ["resource-server", "client"],
    text: "a client MUST follow a `next_cursor` with the same `order` value that produced it. To change direction, the client MUST restart pagination without a cursor. Resource servers MUST reject order-mismatched page cursors as `invalid_cursor`.",
    specAnchor: "#list-records",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-6/order-mismatched-cursor-rejected"],
    gapNote:
      "The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test.",
  },
  {
    clauseId: "8.9-12",
    requirementIds: ["CL-5"],
    level: "must",
    role: ["client"],
    text: "If the cursor has expired (HTTP 410 Gone with error code `cursor_expired`), the client MUST perform a full re-sync.",
    specAnchor: "#list-records",
    applicability: "the client performs incremental sync",
    observable: "client-capture",
    caseIds: [],
    gapNote: "Restates 4.3-3 in the endpoint section; needs the same client reverse channel.",
  },
  {
    clauseId: "8.9-13",
    requirementIds: ["RS-7"],
    level: "must",
    role: ["resource-server"],
    text: "Eligibility for `changes_since` MUST be computed on the grant-authorized projection, not on the unprojected record. Returning a record whose authorized projection is unchanged is a protocol violation because it leaks that hidden fields changed.",
    specAnchor: "#list-records",
    applicability: "the target supports `changes_since`",
    observable: "black-box-http",
    caseIds: ["RS-7/sync-eligibility-computed-on-the-authorized-projection"],
  },
  {
    clauseId: "8.9-14",
    requirementIds: ["RS-7", "RS-8"],
    level: "must",
    role: ["resource-server"],
    text: "If a `changes_since` response is paginated, all pages in that session MUST be anchored to the same session horizon selected on the first page. New writes arriving after page 1 MUST NOT appear in later pages of that same session; they surface in the next session via the terminal-page `next_changes_since`.",
    specAnchor: "#list-records",
    applicability: "the target supports `changes_since`",
    observable: "black-box-http",
    caseIds: ["RS-7/paginated-sync-session-anchored-to-one-horizon"],
  },
  {
    clauseId: "8.9-15",
    requirementIds: ["RS-8"],
    level: "must",
    role: ["resource-server"],
    text: "The terminal page of a `changes_since` request (i.e., `has_more: false`) MUST include `next_changes_since`.",
    specAnchor: "#list-records",
    applicability: "the target supports `changes_since`",
    observable: "black-box-http",
    caseIds: ["RS-8/terminal-page-carries-next-changes-since"],
  },
  {
    clauseId: "8.9-16",
    requirementIds: ["CL-4"],
    level: "must",
    role: ["client"],
    text: "then store `next_changes_since` from the terminal page for the next session.",
    specAnchor: "#list-records",
    applicability: "the client performs incremental sync",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Stated without an RFC 2119 keyword in Section 4's sync narrative; its MUST level is Section 9 CL item 4's. Needs a client-adapter hook observing what the client persists between two sync sessions.",
  },
  {
    clauseId: "8.12-1",
    requirementIds: ["RS-1", "RS-2"],
    level: "must",
    role: ["client"],
    text: "A `blob_id` alone does not grant access. The client MUST have discovered the blob through an authorized record.",
    specAnchor: "#get-a-blob",
    applicability: "the target serves blobs",
    observable: "black-box-http",
    caseIds: ["RS-1/blob-outside-grant-refused", "RS-1/blob-unauthenticated-refused"],
  },
  {
    clauseId: "8.12-2",
    requirementIds: ["RS-1"],
    level: "must",
    role: ["resource-server"],
    text: "**Direct response** MUST include: [...] `Content-Type` (IANA media type) [...] `Cache-Control: private, no-store`",
    specAnchor: "#get-a-blob",
    applicability: "the target serves blobs",
    observable: "black-box-http",
    caseIds: ["RS-1/get-blob-bytes"],
  },
  {
    clauseId: "8.12-3",
    requirementIds: ["RS-1"],
    level: "must",
    role: ["resource-server"],
    text: "**Redirect response** (HTTP 302) MUST include: [...] `Location` header pointing to a short-lived signed URL (valid for at least 60 seconds) [...] `Cache-Control: no-store`",
    specAnchor: "#get-a-blob",
    applicability: "the target answers blob fetches with a 302",
    observable: "black-box-http",
    caseIds: ["RS-1/get-blob-bytes"],
    gapNote:
      'The header half is checked; the "valid for at least 60 seconds" half is not, because the suite deliberately does not follow the signed URL and so cannot observe its expiry.',
  },
  {
    clauseId: "8.13-1",
    requirementIds: ["CL-7"],
    level: "must",
    role: ["client"],
    text: "Clients MUST treat unrecognized error codes as opaque and fall back to the actual HTTP status code and applicable response headers.",
    specAnchor: "#errors",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Needs a client under test plus a way to serve it an unknown error code; the adapter drives targets, not clients.",
  },
  {
    clauseId: "8.13-2",
    requirementIds: ["CL-7"],
    level: "may",
    role: ["client"],
    text: "A recognized `error.type` or `error.code` MAY refine PDPP-specific category, presentation, or recovery behavior only when its defined semantics are compatible with the actual status code and headers.",
    specAnchor: "#errors",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
  },
  {
    clauseId: "8.13-3",
    requirementIds: ["CL-7"],
    level: "must",
    role: ["client"],
    text: "An absent, unknown, malformed, or status-incompatible `type` or `code` is opaque and MUST NOT override the actual status code or relevant headers.",
    specAnchor: "#errors",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote: "Same missing client reverse channel as 8.13-1.",
  },
  {
    clauseId: "8.13-4",
    requirementIds: ["CL-7"],
    level: "must",
    role: ["client"],
    text: "Unknown identifiers MUST NOT cause parse failure.",
    specAnchor: "#errors",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote: "Same missing client reverse channel as 8.13-1.",
  },
  {
    clauseId: "8.13-5",
    requirementIds: ["CL-7"],
    level: "may",
    role: ["client"],
    text: "Clients MAY retain unknown identifiers for diagnostics, subject to local size limits, safe rendering/escaping, and privacy policy.",
    specAnchor: "#errors",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
  },
  {
    clauseId: "8.14-1",
    requirementIds: ["AS-17", "RS-11"],
    level: "must",
    role: ["resource-server", "authorization-server"],
    text: "If the `PDPP-Version` header is absent, the RS uses the current stable version and returns the selected version in the `PDPP-Version` response header. If the requested version is not supported, the RS returns 400 `unsupported_version`.",
    specAnchor: "#api-versioning",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["RS-11/unsupported-version-rejected", "AS-17/unsupported-version-rejected"],
    gapNote:
      "Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook.",
  },
];

// ---------------------------------------------------------------------------
// Section 10: Security Considerations
// ---------------------------------------------------------------------------

const SECTION_10: readonly ClauseEntry[] = [
  {
    clauseId: "10.1-1",
    requirementIds: ["AS-16"],
    level: "should",
    role: ["authorization-server"],
    text: "An authorization server SHOULD enforce configured response-size, time, and redirect-depth limits when retrieving a declaration, and SHOULD resolve DNS freshly for each connection attempt.",
    specAnchor: "#declaration-retrieval-hygiene",
    applicability: "the AS retrieves declarations over the network",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The spec itself states these limits are set by local judgment and that a peer cannot observe which values a server chose, so no interoperability test can exist for this clause.",
  },
  {
    clauseId: "10.2-1",
    requirementIds: ["RS-3", "AS-18"],
    level: "must",
    role: ["resource-server"],
    text: "For separated AS/RS deployments, the RS MUST authenticate to the AS introspection endpoint (RFC 7662) and enforce only from its response. It MUST NOT make a second AS lookup while handling the request.",
    specAnchor: "#token-security",
    applicability: "the deployment separates AS and RS",
    observable: "black-box-http",
    caseIds: ["AS-18/introspection-requires-authentication"],
    gapNote:
      "The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2.",
  },
  {
    clauseId: "10.2-2",
    requirementIds: ["RS-3", "AS-8"],
    level: "must",
    role: ["resource-server"],
    text: "Positive introspection results MUST NOT be cached longer than `min(token_exp, 60 seconds)`. This bounds the propagation window for revocation.",
    specAnchor: "#token-security",
    applicability: "the deployment separates AS and RS",
    observable: "black-box-http",
    caseIds: [],
    gapNote:
      "Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support.",
  },
  {
    clauseId: "10.2-3",
    requirementIds: ["AS-9", "AS-20"],
    level: "must",
    role: ["authorization-server"],
    text: "An access token issued with or from a refresh-token family MUST be linked to that family and MUST have a short, token-specific expiration no later than the family or grant expiration. A token response MUST derive `expires_in` from the access token's persisted expiration. It MUST omit `expires_in` when the access token has no expiration. An RFC 7662 response MUST likewise omit `exp` when no expiration exists.",
    specAnchor: "#token-security",
    applicability: "the AS issues refresh tokens",
    observable: "black-box-http",
    caseIds: ["AS-20/refresh-reuse-revokes-the-family"],
    gapNote:
      "Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token.",
  },
  {
    clauseId: "10.2-4",
    requirementIds: ["AS-9"],
    level: "must",
    role: ["authorization-server"],
    text: "Every successful OAuth token response that contains an access token or refresh token MUST include `Cache-Control: no-store` and `Pragma: no-cache` before the response is serialized.",
    specAnchor: "#token-security",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-9/token-response-forbids-caching"],
  },
  {
    clauseId: "10.2-5",
    requirementIds: ["AS-19"],
    level: "must",
    role: ["authorization-server"],
    text: "An authorization code MUST be consumed atomically on its first successful redemption. A later redemption, including one with the same valid PKCE verifier, MUST return `invalid_grant` and MUST NOT issue another token.",
    specAnchor: "#token-security",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-19/authorization-code-redemption-is-not-replayable"],
  },
  {
    clauseId: "10.2-6",
    requirementIds: ["AS-20"],
    level: "must",
    role: ["authorization-server"],
    text: "each token MUST belong to a family and MUST rotate after successful use. The AS MUST atomically supersede the presented token and issue one active successor. Reuse of any superseded token, including a retry after a lost successful response, MUST revoke the token family and every access token linked to that family, return `invalid_grant`, and require fresh authorization.",
    specAnchor: "#token-security",
    applicability: "the AS issues refresh tokens",
    observable: "black-box-http",
    caseIds: ["AS-20/refresh-reuse-revokes-the-family"],
  },
  {
    clauseId: "10.2-7",
    requirementIds: ["AS-20", "AS-8"],
    level: "must",
    role: ["authorization-server"],
    text: "Introspection MUST report every family-linked access token inactive after the replay is detected. An AS MUST NOT issue refresh tokens for a `single_use` grant. It MUST NOT issue one for a grant package unless every child grant is `continuous`.",
    specAnchor: "#token-security",
    applicability: "the AS issues refresh tokens",
    observable: "black-box-http",
    caseIds: ["AS-20/refresh-reuse-revokes-the-family"],
    gapNote:
      "The introspection half is covered; the prohibition on issuing refresh tokens for a `single_use` grant is not, and needs a target supporting both `single_use` and refresh tokens at once.",
  },
  {
    clauseId: "10.2-8",
    requirementIds: ["AS-21"],
    level: "must",
    role: ["authorization-server"],
    text: "On upgrade, an implementation MUST NOT infer family linkage for an existing bearer. Any live refresh family without persisted bearer linkage MUST be revoked together with its grant- or package-bound bearer tokens and MUST require fresh authorization.",
    specAnchor: "#token-security",
    applicability: "the AS issues refresh tokens",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do.",
  },
  {
    clauseId: "10.2-9",
    requirementIds: [],
    level: "should",
    role: ["resource-server", "authorization-server"],
    text: "Deployments handling sensitive standing access SHOULD consider sender-constrained tokens, which bind a token to a client-held key so that possession of the token alone is not sufficient to use it.",
    specAnchor: "#token-security",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "The spec marks this subsection non-normative guidance; recorded so the scan's keyword hit is accounted for rather than appearing as an untracked clause.",
  },
  {
    clauseId: "10.3-1",
    requirementIds: ["AS-3"],
    level: "must",
    role: ["authorization-server", "resource-server"],
    text: "Implementations MUST treat grants as tamper-sensitive.",
    specAnchor: "#grant-integrity",
    applicability: "always",
    observable: "review-only",
    caseIds: [],
    gapNote:
      '"Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check.',
  },
  {
    clauseId: "10.3-2",
    requirementIds: ["AS-1"],
    level: "should",
    role: ["authorization-server", "client"],
    text: "Production deployments SHOULD use Pushed Authorization Requests (PAR, RFC 9126).",
    specAnchor: "#grant-integrity",
    applicability: "always",
    observable: "black-box-http",
    caseIds: [],
  },
  {
    clauseId: "10.4-1",
    requirementIds: [],
    level: "must",
    role: ["resource-server"],
    text: "Runtimes MUST NOT log or persist credential data.",
    specAnchor: "#credential-handling",
    applicability: "the deployment implements the Collection Profile INTERACTION channel",
    observable: "review-only",
    caseIds: [],
    gapNote:
      "Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read.",
  },
  {
    clauseId: "10.5-1",
    requirementIds: [],
    level: "should",
    role: ["resource-server"],
    text: "Production deployments SHOULD mitigate this by sandboxing connector processes (restricting network egress), using connectors from trusted registries only, or having the runtime authenticate on behalf of the connector and pass only session tokens.",
    specAnchor: "#connector-trust",
    applicability: "the deployment runs Collection Profile connectors",
    observable: "review-only",
    caseIds: [],
  },
  {
    clauseId: "10.7-1",
    requirementIds: ["AS-8"],
    level: "must",
    role: ["authorization-server"],
    text: "The AS MUST reflect revocation immediately in introspection responses (`active: false`).",
    specAnchor: "#revocation",
    applicability: "always",
    observable: "black-box-http",
    caseIds: ["AS-8/revoked-token-introspects-inactive", "AS-8/revoked-grant-refused"],
  },
  {
    clauseId: "10.7-2",
    requirementIds: ["CL-2"],
    level: "must",
    role: ["client"],
    text: "Upon receiving any 403 `grant_revoked` response, the client MUST stop further requests against that grant.",
    specAnchor: "#revocation",
    applicability: "always",
    observable: "client-capture",
    caseIds: [],
    gapNote:
      "Needs a client-adapter hook that observes whether a client under test issues further requests after a 403; the suite drives targets, not clients.",
  },
];

/**
 * Every enumerated normative clause of Core sections 4-8 and 10, in document
 * order. Sections 1-3, 9, 11-13 are excluded: 1-3 and 11-13 are framing,
 * terminology, privacy discussion and type listings that carry no clause the
 * suite judges, and Section 9 is the catalogue this matrix maps INTO rather
 * than a source of independent obligations.
 */
export const CLAUSE_MATRIX: readonly ClauseEntry[] = [
  ...SECTION_4,
  ...SECTION_5,
  ...SECTION_6,
  ...SECTION_7,
  ...SECTION_8,
  ...SECTION_10,
];

const BY_CLAUSE_ID = new Map(CLAUSE_MATRIX.map((c) => [c.clauseId, c]));

export function clauseById(clauseId: string): ClauseEntry | undefined {
  return BY_CLAUSE_ID.get(clauseId);
}

/** Clauses that roll up to a Section 9 requirement, in matrix order. */
export function clausesForRequirement(requirementId: string): readonly ClauseEntry[] {
  return CLAUSE_MATRIX.filter((c) => c.requirementIds.includes(requirementId));
}

/**
 * Clauses no Section 9 item summarizes.
 *
 * Not an error: Section 9 numbers conformance items for three roles and has no
 * list for a SourceDeclaration author, so declaration-static clauses have
 * nowhere to roll up. Exposed as a function because it is a finding about the
 * spec's coverage, and the report should be able to state it.
 */
export function clausesWithoutRequirement(): readonly ClauseEntry[] {
  return CLAUSE_MATRIX.filter((c) => c.requirementIds.length === 0);
}

/** MUST-level clauses with no case exercising them. Each carries a `gapNote`. */
export function uncoveredMustClauses(): readonly ClauseEntry[] {
  return CLAUSE_MATRIX.filter((c) => c.level === "must" && c.caseIds.length === 0);
}

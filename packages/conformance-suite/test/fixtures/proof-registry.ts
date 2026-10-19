// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The single declared registry of proof-of-failure entries. The discrimination
// tests run these rows; `case-proof-coverage.test.ts` reads the same data to
// assert that every registered case has at least one. Keeping the rows here,
// rather than inside a test file, lets both consumers read data instead of
// scraping source text.

import type { ClientDefect } from "../../src/harness/client-adapter.ts";
import type { Defect } from "../../src/targets/reference-server.ts";

export const TARGET_DISCRIMINATION_MATRIX: readonly {
  readonly caseId: string;
  readonly defect: Defect;
  /** A conformant target can make this particular observation unavailable. */
  readonly cleanExpected?: "skip";
  /** No semantic hook: this row proves review-only honesty, not a failure oracle. */
  readonly reviewOnly?: true;
}[] = [
  { caseId: "RS-2/ungranted-stream-refused", defect: "ignore-grant-streams" },
  {
    caseId: "RS-2/field-projection-not-exceeded",
    defect: "ignore-field-projection",
  },
  {
    caseId: "RS-2/field-projection-not-exceeded",
    defect: "serve-undeclared-extra-field",
  },
  {
    caseId: "RS-2/field-projection-not-exceeded",
    defect: "malformed-narrowed-read",
  },
  {
    caseId: "RS-9/client-token-exact-filter-rejected",
    defect: "accept-client-filters",
  },
  // The `view` and `expand_limit[...]` rows of Section 8's client-token
  // parameter table are separate clauses (8.9-3 and 8.9-5) from the filter row
  // above, and a server can honour one while rejecting another.
  //
  // `view` pairs with `serve-client-token-view`, not `accept-client-filters`,
  // and the difference was found by this test rather than reasoned about: under
  // `accept-client-filters` the reference server still refuses `view` through
  // its GENERIC unknown-parameter branch (`view` is not in KNOWN_PARAMS), so
  // the first version of this row passed a target that had never implemented
  // the client-token `view` rule. The defect below serves the view instead,
  // which is the violation clause 8.9-3 actually describes.
  {
    caseId: "RS-9/client-token-view-rejected",
    defect: "serve-client-token-view",
  },
  {
    caseId: "RS-9/client-token-expand-limit-rejected",
    defect: "accept-client-filters",
  },
  // Clause 8.9-11. Paired with a defect that accepts a GENUINE cursor under the
  // wrong direction, not with `crash-on-bad-cursor`: the cursor this case
  // replays is one the server minted moments earlier, so any oracle that only
  // validates cursor syntax would pass both runs and prove nothing.
  {
    caseId: "RS-6/order-mismatched-cursor-rejected",
    defect: "accept-order-mismatched-cursor",
  },
  { caseId: "RS-10/unknown-parameter-rejected", defect: "ignore-unknown-params" },
  // The bundled target serves blobs directly, so the redirect case reports
  // `unsupported` against it; its proof stays bespoke (below).
  // The bundled adapter reads the staged review back through `reviewedStreams`.
  { caseId: "AS-4/omitted-fields-expanded-before-issuance", defect: "carry-unexpanded-selection-into-review" },
  { caseId: "AS-4/wildcard-stream-name-expanded-before-issuance", defect: "carry-unexpanded-selection-into-review" },
  { caseId: "AS-3/issued-grant-artifact-matches-section-7-schema", defect: "issued-grant-omits-version" },
  { caseId: "AS-19/authorization-code-redemption-is-not-replayable", defect: "redeem-authorization-code-repeatedly" },
  { caseId: "RS-5/owner-filter-narrows-and-never-widens", defect: "owner-filter-fails-open" },
  { caseId: "RS-9/owner-view-and-fields-are-mutually-exclusive", defect: "accept-owner-view-and-fields-together" },
  {
    caseId: "RS-9/client-token-filter-rejected-whether-or-not-declared",
    defect: "client-filter-consults-metadata-first",
  },
  { caseId: "RS-6/page-cursor-rejected-under-another-query-shape", defect: "cursor-context-omits-query-shape" },
  { caseId: "AS-16/embedded-schema-remote-reference-refused", defect: "accept-remote-schema-reference" },
  { caseId: "AS-16/embedded-schema-remote-dynamic-reference-refused", defect: "accept-remote-schema-reference" },
  { caseId: "AS-16/embedded-schema-wrong-dialect-refused", defect: "accept-wrong-schema-dialect" },
  { caseId: "AS-16/embedded-schema-failing-metaschema-refused", defect: "accept-meta-invalid-schema" },
  { caseId: "AS-15/stale-review-approval-refused", defect: "approve-stale-review" },
  { caseId: "AS-10/single-use-window-end-deactivates-the-grant", defect: "single-use-window-never-ends" },
  { caseId: "AS-10/single-use-grant-consumed", defect: "single-use-grant-reissuable" },
  { caseId: "AS-10/single-use-first-token-has-finite-expiry", defect: "single-use-token-without-expiry" },
  {
    caseId: "AS-26/ending-one-grant-spares-the-shared-credential",
    defect: "revoking-one-grant-revokes-shared-credential",
  },
  {
    caseId: "AS-8/shared-credential-inactive-only-when-no-grant-is-active",
    defect: "revoking-one-grant-revokes-shared-credential",
  },
  {
    caseId: "AS-8/shared-credential-inactive-only-when-no-grant-is-active",
    defect: "shared-credential-active-after-all-grants-end",
  },
  {
    caseId: "AS-16/declaration-retrieval-sends-no-ambient-credentials",
    defect: "declaration-fetch-sends-ambient-credentials",
  },
  {
    caseId: "AS-16/declaration-retrieval-validates-redirect-targets",
    defect: "declaration-fetch-follows-redirects-unvalidated",
  },
  {
    caseId: "AS-16/declaration-retrieval-does-not-fetch-remote-schema",
    defect: "declaration-fetch-retrieves-remote-schema",
  },
  { caseId: "AS-7/unverified-client-logo-is-not-fetched", defect: "fetch-client-logo-on-consent-render" },
  {
    caseId: "AS-2/time-range-refused-where-only-a-cursor-field-is-declared",
    defect: "derive-consent-boundary-from-cursor-field",
  },
  { caseId: "RS-1/blob-range-support-is-advertised", defect: "blob-ranges-unadvertised" },
  { caseId: "RS-1/get-blob-bytes", defect: "blob-wrong-bytes" },
  { caseId: "RS-1/get-blob-bytes", defect: "blob-response-cacheable" },
  { caseId: "RS-1/blob-ref-mime-type-valid", defect: "blob-ref-invalid-mime-type" },
  { caseId: "RS-1/blob-outside-grant-refused", defect: "serve-blob-without-reference-check" },
  { caseId: "RS-1/blob-unauthenticated-refused", defect: "serve-without-authentication" },
  { caseId: "RS-1/blob-referenced-outside-projection-refused", defect: "serve-blob-ignoring-projection" },
  { caseId: "RS-1/blob-referencing-record-outside-window-refused", defect: "serve-blob-ignoring-window" },
  {
    caseId: "RS-10/owner-filter-unknown-field-rejected",
    defect: "ignore-owner-filter-unknown-field",
  },
  {
    caseId: "RS-10/unsupported-bracketed-shape-rejected",
    defect: "ignore-unknown-params",
  },
  {
    caseId: "RS-10/owner-expand-undeclared-relation-rejected",
    defect: "ignore-owner-expand-undeclared-relation",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "truncate-owner-metadata",
  },
  // RS-14 checks five independent things (schema presence, schema content,
  // views, relationships, query capability). truncate-owner-metadata above
  // proves only schema-truncation-plus-everything-else-dropped; a mutation
  // that drops everything and fails at the schema-presence check would not
  // prove the views/relationships/query checks ever run. Each row below pairs
  // the case with a defect that corrupts exactly one category and leaves the
  // rest of the document (including schema field presence) intact, so each
  // failure is independent proof of the category's own check.
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-schema-field-type",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-views",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-views",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-relationships",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-relationships",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-query",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-query",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-schema-required-field",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-schema-nested-constraint",
  },
  {
    caseId: "RS-15/client-metadata-projection-closed",
    defect: "leak-current-metadata",
  },
  {
    caseId: "RS-16/401-carries-resource-metadata-challenge",
    defect: "weak-401-challenge",
  },
  { caseId: "AS-8/revoked-grant-refused", defect: "ignore-revocation" },
  // Revised 8.13-6: an inactive token is 401 behind a Bearer `invalid_token`
  // challenge. One row per half: the former 403 with no challenge, and a 401
  // whose challenge omits `error="invalid_token"`.
  { caseId: "AS-8/revoked-grant-refused", defect: "inactive-grant-as-403" },
  { caseId: "AS-8/revoked-grant-refused", defect: "omit-invalid-token-error" },
  { caseId: "AS-8/expired-grant-refused", defect: "inactive-grant-as-403" },
  { caseId: "AS-8/expired-grant-refused", defect: "omit-invalid-token-error" },
  // Added after independent review: these three are negative-shaped oracles
  // (they exist to catch a cross-subject leak, a fake self-export declaration,
  // and syntax-derived token kind) and previously had only a passes-clean
  // control, which does not show the assertion can fire.
  {
    caseId: "RS-4/token-kind-not-inferred-from-syntax",
    defect: "infer-token-kind-from-syntax",
  },
  { caseId: "RS-12/foreign-subject-cannot-read", defect: "ignore-subject-scope" },
  {
    caseId: "RS-6/ungranted-stream-error-classification",
    defect: "misclassify-stream-denial",
  },
  { caseId: "RS-6/malformed-cursor-rejected", defect: "crash-on-bad-cursor" },
  {
    caseId: "RS-10/oversized-limit-clamped-with-warning",
    defect: "silent-limit-clamp",
  },
  {
    caseId: "RS-13/self-export-supported",
    defect: "declare-self-export-but-refuse",
  },
  // Selection-time validation. Each defect models the server taking the
  // client's word for something the retained declaration is supposed to settle.
  {
    caseId: "AS-2/undeclared-stream-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/undeclared-field-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/unrecognized-preset-refused",
    defect: "accept-undeclared-selection",
  },
  // Clause 6.8-3. Paired with `accept-malformed-stream-list` rather than
  // `accept-undeclared-selection`, because both shapes are built from names the
  // retained snapshot DOES declare: a server that validates every name against
  // the snapshot and stops there accepts them both, so the undeclared-selection
  // defect would leave these oracles passing against a violating target.
  {
    caseId: "AS-2/wildcard-beside-named-stream-refused",
    defect: "accept-malformed-stream-list",
  },
  {
    caseId: "AS-2/duplicate-stream-name-refused",
    defect: "accept-malformed-stream-list",
  },
  // ---- Core Section 5 views (clauses 5.6-2, 5.6-2a, 5.6-3, 6.8-1) ----
  //
  // Each view oracle pairs with a defect that violates ITS clause and no other.
  // That separation was checked rather than assumed: the four defects were run
  // against all four cases, and each case failed only under its own. A shared
  // defect would have left the narrower oracles passing against a target that
  // violates only the clause they are supposed to own.
  //
  // Clause 5.6-2 binds the AS's view DEFINITIONS, not a request, so its defect
  // corrupts the definition (adding a field no schema declares) rather than
  // sending a bad request — a bad request is refused for an unrelated reason
  // and would prove nothing about view validation.
  {
    caseId: "AS-12/view-within-declared-schema",
    defect: "define-view-with-undeclared-field",
  },
  // Clause 5.6-2a. The defect re-resolves the view at READ time instead of
  // serving the field list frozen at issuance, which is the only way an
  // already-approved grant can silently widen. Without it a grant's projection
  // never changes and the case would pass against a target that has no view
  // evolution at all.
  {
    caseId: "AS-13/view-evolution-does-not-widen-an-issued-grant",
    defect: "widen-existing-grants-on-view-change",
  },
  // Clause 5.6-3. The defect searches for a known view name INSIDE the supplied
  // URI — the "helpful normalization" shape of treating an opaque identifier as
  // structured. A defect that simply rejected everything would leave this
  // oracle passing for the wrong reason.
  {
    caseId: "AS-13/unrecognized-view-uri-treated-as-opaque",
    defect: "resolve-view-uri-by-substring",
  },
  // Clause 6.8-1. Both halves of the request are individually valid (a real
  // view, real declared fields), so only a server checking the COMBINATION
  // refuses it; no existing field- or name-validation defect produces this.
  {
    caseId: "AS-2/view-and-fields-mutually-exclusive",
    defect: "accept-view-and-fields-together",
  },
  // Revised 6.8-1: the refusal is classified `invalid_authorization_details`,
  // so a server that refuses with the former `invalid_request` must now fail.
  {
    caseId: "AS-2/view-and-fields-mutually-exclusive",
    defect: "misclassify-view-and-fields-refusal",
  },

  // Clauses 5.2-4 and 6.8-2. The defect accepts `time_range` on a stream that
  // declares no `consent_time_field`, which is the violation both clauses name.
  // No existing defect produces it: every field- and name-validation defect
  // operates on the selection's CONTENT, while this one is about a capability
  // the stream's declaration never claimed.
  {
    caseId: "AS-2/time-range-without-consent-time-field-refused",
    defect: "accept-time-range-without-consent-time-field",
  },
  // ---- The final approval artifact (clauses 7.2-2, 6.3-2, 7.2-4) ----
  //
  // Clause 7.2-2. The defect keeps the streams and fields — the facts an
  // implementer thinks of first — and drops retention, grant expiry and the
  // resolved instance ids. A case asserting only that an artifact EXISTS passes
  // against that, which is why the oracle checks the whole field inventory.
  {
    caseId: "AS-15/final-approval-artifact-carries-resolved-terms",
    defect: "thin-approval-artifact",
  },
  // Clause 6.3-2 has two halves and a server can fail either alone, so the
  // oracle is paired with a defect for each. `mutate-bound-client-claims`
  // paraphrases the claims (violating "bound exactly");
  // `drop-client-claim-attribution` keeps them verbatim but unattributed, which
  // is the subtler failure: the text survives, and what is lost is the signal
  // that these are the client's unverifiable promises rather than enforced
  // terms. Both were confirmed to fail this case and no other.
  {
    caseId: "AS-15/rendered-client-claims-bound-with-attribution",
    defect: "mutate-bound-client-claims",
  },
  {
    caseId: "AS-15/rendered-client-claims-bound-with-attribution",
    defect: "drop-client-claim-attribution",
  },
  // Clause 7.2-4. The oracle searches the grant by claim CONTENT at any depth
  // rather than for a `client_claims` key, so a server that leaked the claims
  // under another name or nested in a stream row is caught too.
  {
    caseId: "AS-3/client-claims-stay-outside-the-resolved-grant",
    defect: "leak-client-claims-into-grant",
  },
  // ---- Declaration trust (clauses 5.8-2, 5.8-4) ----
  //
  // One defect per clause, each confirmed to fail its own case and no other.
  // They have to be separate: the two obligations are checked in sequence, so
  // a shared defect would let the first refusal mask the others and leave the
  // later oracles passing against a server that never implements them.
  {
    caseId: "AS-16/provider-native-source-id-mismatch-refused",
    defect: "accept-provider-native-id-mismatch",
  },
  // The equivocation defect does the opposite of BOTH halves of 5.8-4: it
  // accepts the second document and overwrites what was retained. The oracle
  // checks both, so a server that refuses correctly but has already clobbered
  // its retained copy still fails.
  {
    caseId: "AS-16/declaration-equivocation-refused-and-prior-content-retained",
    defect: "accept-declaration-equivocation",
  },
  {
    caseId: "AS-5/both-streams-and-preset-refused",
    defect: "accept-malformed-selection",
  },
  {
    caseId: "AS-5/neither-streams-nor-preset-refused",
    defect: "accept-malformed-selection",
  },
  // AS-6 is the inverted one: the defect is OVER-refusal, so the violating
  // target rejects a request the clean one accepts.
  {
    caseId: "AS-6/unregistered-purpose-not-rejected",
    defect: "reject-unregistered-purpose",
  },
  {
    caseId: "AS-17/unsupported-version-rejected",
    defect: "accept-unsupported-version",
  },
  // AS-2 field-selection validation reuses accept-undeclared-selection: the
  // reference server's exact-match field check (firstUndeclaredReason) is the
  // one path both a nonexistent field name and a dotted nested-field selector
  // fail, and that check is exactly what the defect bypasses.
  {
    caseId: "AS-2/nonexistent-field-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/dotted-nested-field-refused",
    defect: "accept-undeclared-selection",
  },
  // Clause 10.2-4. The defect changes ONLY the two cache headers: the token is
  // valid, the status is 200, and every other case still passes against it. So
  // this row is the only thing standing between the clause and an oracle that
  // would pass against a server which never set the headers at all.
  {
    caseId: "AS-9/token-response-forbids-caching",
    defect: "token-response-without-no-store",
  },
  // Clause 7.4-2, the grant-schema version axis. Paired with a defect that
  // ENFORCES the unknown-schema grant rather than with anything touching the
  // PDPP-Version header: Core forbids conflating the two axes, and a defect on
  // the header axis would let this case pass against a server that never looks
  // at `grant.version` at all — the exact violation it exists to catch.
  {
    caseId: "RS-11/unsupported-grant-schema-version-rejected",
    defect: "accept-unsupported-grant-schema-version",
  },
  // Clause 6.2-2. The defect leaks three DIFFERENT prohibited categories at
  // once (a secret field, an owner-scoped client, a dynamically registered
  // one), because the clause names four and a server can publish any of them
  // alone. The case checks the allowed keys as an allowlist rather than
  // scanning for known-bad names, which is what makes one defect enough here.
  {
    caseId: "AS-7/pre-registered-public-clients-carry-no-private-state",
    defect: "leak-private-registration-state",
  },
  // Clause 8.2-3. Paired with a defect that FALLS BACK to client handling, not
  // with one that mishandles token syntax: the token here is genuine and
  // authenticates, so `infer-token-kind-from-syntax` (which RS-4's other case
  // owns) never fires on it and would leave this oracle passing against a
  // server with no kind check at all.
  {
    caseId: "RS-4/unrecognized-token-kind-is-unauthorized",
    defect: "honour-unrecognized-token-kind",
  },
  // Clauses 6.1-2 / 6.1-4. The defect refuses a document that is fetched,
  // valid, and asserts its own URL — for the one reason Core names as
  // insufficient. It deliberately does NOT model a local-policy denial, which
  // clause 6.1-3 expressly permits and which the case reports as `skip`: an
  // oracle that failed on any refusal would call a conforming server broken.
  {
    caseId: "AS-7/valid-url-hosted-client-identity-accepted",
    defect: "reject-unregistered-url-hosted-client",
  },
  // The mirror. Without this row, "accept unregistered clients" could be
  // satisfied by an AS that validates nothing — which replaces a closed door
  // with an open one rather than fixing the interoperability failure.
  {
    caseId: "AS-7/malformed-url-hosted-client-identity-refused",
    defect: "accept-unbound-url-hosted-client-document",
  },
  // Clause 8.9-15. The reference target now implements `changes_since`, so
  // RS-8 passes against it — which means the oracle needs a defect to be worth
  // anything. `omit-next-changes-since` restores exactly the behaviour that
  // made RS-8 fail before this batch, so the case is proven to catch the very
  // defect the target was just fixed for.
  {
    // Append-only positive and negative controls: query-schema-regression.test.ts.
    caseId: "RS-8/terminal-page-carries-next-changes-since",
    defect: "omit-next-changes-since",
  },
  // Core Section 4 "Tombstones". Paired with a defect that DROPS the tombstone
  // rather than one that breaks sync generally: a client that stops seeing a
  // record cannot tell deletion from "no longer matches my filter", so silence
  // is the violation and the case must catch silence specifically.
  {
    caseId: "RS-7/deletion-surfaces-as-a-tombstone",
    defect: "omit-tombstones",
  },
  // Clause 8.9-13. The defect computes eligibility on the UNPROJECTED record,
  // so a record whose authorized projection is unchanged still surfaces. The
  // payload stays correct throughout — only the record's presence leaks — which
  // is why no field-projection defect can stand in for this one.
  {
    caseId: "RS-7/sync-eligibility-computed-on-the-authorized-projection",
    defect: "ignore-projection-for-sync-eligibility",
  },
  // Clause 8.9-14. Under `re-anchor-sync-session-per-page` this case fails on
  // its SECOND half — the mid-session write is withheld from its own session
  // and then never delivered by the next one either. That is the damage the
  // clause describes (a record the client never receives, with nothing
  // reporting the gap), and a case checking only "no duplicate on page 2" would
  // have passed the violating target.
  {
    caseId: "RS-7/paginated-sync-session-anchored-to-one-horizon",
    defect: "re-anchor-sync-session-per-page",
  },
  // Clause 4.3-2. The defect answers an expired cursor 400 `invalid_cursor`
  // rather than 410 `cursor_expired` — it still REFUSES, so an oracle checking
  // only "not 200" would pass it. The status is the whole obligation: 400 reads
  // as a client error and invites a retry that cannot succeed, where 410 tells
  // the client to discard its baseline.
  {
    // Append-only positive and negative controls: query-schema-regression.test.ts.
    caseId: "RS-7/expired-sync-cursor-reported-as-gone",
    defect: "misclassify-expired-sync-cursor",
  },
  // Clause 4.5-1. The defect drops only the stringification, so the id is still
  // a well-formed minified JSON array and every other case passes against it.
  // An oracle checking "the id looks like an array" would not catch it.
  {
    caseId: "RS-1/compound-primary-key-canonically-encoded",
    defect: "unstringified-compound-key",
  },
  // Clause 6.9-1. The defect ACCEPTS the duplicate-bearing declaration, which
  // is the deferral Core forecloses ("They are not deferred to grant
  // issuance"). Not paired with `accept-undeclared-selection`: the preset here
  // names a stream the snapshot really declares, so name validation passes and
  // only a check on the preset's own shape refuses it.
  {
    caseId: "AS-16/duplicate-stream-in-a-selection-preset-refused",
    defect: "accept-duplicate-preset-stream",
  },
  // ---- Declaration validity (clauses 5.2-2, 5.2-3, 5.2-5) ----
  //
  // One defect per clause, for the same reason the trust rows above need one
  // each: the validity checks run in sequence over the submitted document, so a
  // shared defect would let an earlier refusal mask a later oracle and leave it
  // passing against a server that never implements the clause it owns. Each
  // defect was run against all three cases and fails only its own.
  //
  // None of these pairs with an existing selection-time defect. Every one of
  // those operates on a REQUEST validated against a declaration the target
  // already holds; these three are about the acceptance decision on the
  // declaration itself, which happens earlier and on a different document.
  {
    caseId: "AS-16/key-field-not-declared-in-schema-refused",
    defect: "accept-undeclared-key-field-reference",
  },
  // Separate from the row above even though both are "a field the schema does
  // not declare": the reference target checks them in separate branches
  // precisely because a server can implement one and miss the other, and a
  // single defect disabling both would leave whichever oracle runs second
  // unproven.
  {
    caseId: "AS-16/consent-time-field-not-declared-in-schema-refused",
    defect: "accept-undeclared-consent-time-field",
  },
  {
    caseId: "AS-16/embedded-schema-remote-reference-refused",
    defect: "accept-invalid-embedded-schema",
  },
  // RFC 9396 Section 7, which Core adopts by normative reference and does not
  // restate — so this row has no Core clause id, by design (see the matrix
  // header, "Obligations from referenced standards"). The defect omits the
  // field from the token response while leaving the token, the grant and
  // introspection all correct, which is the whole shape of the violation.
  {
    caseId: "AS-9/token-response-carries-granted-authorization-details",
    defect: "omit-token-response-authorization-details",
  },
  // ---- Regression cases for known reference-implementation divergences ----
  //
  // Each defect reproduces the divergent behaviour exactly as the reference
  // implementation showed it; see the README "Regression cases" table.
  //
  // A tombstone run through the sparse `fields=` projection.
  {
    // Conformant context-bound control: query-schema-regression.test.ts.
    caseId: "RS-7/tombstone-envelope-survives-sparse-fields",
    defect: "project-tombstones-through-fields",
  },
  // The four multi-instance list-records defects. Each pairs with the one case
  // that owns it; the page-walk helper in multi-instance.ts deliberately
  // `skip`s (rather than fails) the OTHER cases when a walk cannot continue.
  {
    caseId: "RS-1/list-page-size-bounded-by-limit-across-instances",
    defect: "per-instance-limit-concatenated",
  },
  {
    caseId: "RS-1/list-sort-order-across-instances",
    defect: "concatenate-instances-unsorted",
  },
  {
    caseId: "RS-1/list-has-more-carries-next-cursor-across-instances",
    defect: "has-more-without-next-cursor",
  },
  {
    caseId: "RS-7/changes-since-accepted-on-multi-instance-grant",
    defect: "reject-multi-instance-changes-since",
  },
  {
    caseId: "RS-1/owner-sparse-fields-keep-required-fields",
    defect: "drop-required-fields-on-sparse-read",
  },
  {
    caseId: "RS-10/malformed-limit-rejected",
    defect: "coerce-invalid-limit",
  },
  // `weak-401-challenge` above drops resource_metadata; this one keeps it and
  // drops only error="invalid_token", the half of clause 8.4-x it cannot reach.
  {
    caseId: "RS-16/401-carries-resource-metadata-challenge",
    defect: "omit-invalid-token-error",
  },
  // Proofs for cases the first measurement found without one. Over-refusal
  // defects (granted-stream-readable, declared-field-accepted) break a positive
  // control; the rest violate the one requirement the case checks.
  { caseId: "RS-1/list-streams-envelope", defect: "list-streams-without-envelope" },
  { caseId: "RS-2/granted-stream-readable", defect: "refuse-bare-granted-read" },
  { caseId: "RS-16/unauthenticated-request-refused", defect: "serve-without-authentication" },
  { caseId: "RS-9/client-token-expand-rejected", defect: "accept-client-filters" },
  { caseId: "RS-11/unsupported-version-rejected", defect: "ignore-pdpp-version-header" },
  { caseId: "RS-16/protected-resource-metadata-published", defect: "omit-pdpp-resource-metadata" },
  {
    caseId: "AS-3/resolved-grant-matches-observable-schema-fields",
    defect: "invalid-access-mode-in-authorization-details",
  },
  { caseId: "AS-15/approval-requires-the-issued-revision", defect: "accept-forged-review-revision" },
  { caseId: "AS-8/expired-grant-refused", defect: "serve-expired-grant" },
  { caseId: "AS-2/declared-field-accepted", defect: "refuse-field-selection" },
  // Append-only positive and negative controls: query-schema-regression.test.ts.
  { caseId: "RS-6/cursor-not-accepted-as-changes-since", defect: "accept-page-cursor-as-changes-since" },
  { caseId: "RS-1/single-record-read", defect: "serve-unknown-record-id" },
  { caseId: "RS-2/time-constraint-enforced", defect: "ignore-time-constraint" },
  // Revised-text clauses (declaration members, selection shape, time_range
  // bounds). One defect per case, each switching off only that case's check.
  { caseId: "AS-22/unrecognized-stream-semantics-refused", defect: "accept-unrecognized-semantics" },
  { caseId: "AS-22/unrecognized-source-kind-refused", defect: "accept-unrecognized-source-kind" },
  { caseId: "AS-27/non-boolean-consent-time-content-may-exceed-refused", defect: "accept-non-boolean-may-exceed" },
  { caseId: "AS-27/ineligible-consent-time-field-refused", defect: "accept-ineligible-consent-time-field" },
  { caseId: "AS-2/star-beside-named-field-refused", defect: "accept-star-beside-fields" },
  { caseId: "AS-2/stream-request-without-fields-or-view-refused", defect: "accept-stream-without-fields-or-view" },
  { caseId: "AS-27/time-range-without-bound-refused", defect: "accept-empty-time-range" },
  { caseId: "AS-27/time-range-bound-wrong-type-refused", defect: "accept-wrong-type-time-range-bound" },
  { caseId: "AS-27/time-range-invalid-bound-refused", defect: "accept-invalid-time-range-bound" },
  { caseId: "AS-27/time-range-since-not-before-until-refused", defect: "accept-since-not-before-until" },
  { caseId: "AS-27/time-range-bound-not-converted", defect: "normalize-time-constraint-bounds" },
  // Incremental-sync visibility and token binding (clauses 4.3-6, 4.3-9, 4.3-11,
  // 4.3-16, 8.9-11, 8.9-17, 8.9-18).
  { caseId: "RS-11/absent-version-header-reports-the-selected-version", defect: "omit-pdpp-version-response-header" },
  { caseId: "AS-9/introspection-carries-exp-for-an-expiring-token", defect: "omit-introspection-exp" },
  {
    caseId: "AS-15/final-approval-artifact-states-bound-inclusivity",
    defect: "omit-bound-inclusivity-statement",
    reviewOnly: true,
  },
  { caseId: "RS-22/time-window-compared-as-instants-not-text", defect: "compare-time-bounds-as-text" },
  { caseId: "AS-25/revocation-endpoint-is-advertised", defect: "omit-revocation-endpoint-metadata" },
  { caseId: "AS-25/client-revocation-of-an-access-token-ends-it", defect: "revocation-endpoint-ignores-access-tokens" },
  { caseId: "RS-8/non-terminal-page-omits-next-changes-since", defect: "next-changes-since-on-every-page" },
  { caseId: "RS-6/page-cursor-rejected-under-another-context", defect: "accept-cursor-under-other-context" },
  {
    caseId: "RS-21/changes-since-token-rejected-under-another-context",
    defect: "accept-sync-token-under-other-context",
  },
  {
    // Core 4.3 permits freshly randomized tokens. Equality is unavailable on
    // the clean target; the explicit deterministic violating fixture must fail.
    caseId: "RS-21/token-does-not-reveal-writes-the-grant-cannot-see",
    defect: "token-reveals-hidden-writes",
    cleanExpected: "skip",
  },
  {
    caseId: "RS-7/record-deleted-after-page-1-not-served-on-a-later-page",
    defect: "serve-deleted-record-from-session-snapshot",
  },
  { caseId: "RS-7/never-visible-record-produces-no-tombstone", defect: "tombstone-for-never-visible-record" },
  { caseId: "RS-7/record-leaving-time-window-surfaces-as-a-tombstone", defect: "omit-tombstone-on-leaving-window" },
];

export const CLIENT_DISCRIMINATION_MATRIX: readonly { caseId: string; defect: ClientDefect }[] = [
  { caseId: "CL-2/grant-revocation-stops-further-requests", defect: "retry-revoked-grant" },
  { caseId: "CL-3/changes-since-does-not-reuse-next-cursor", defect: "reuse-next-cursor-as-changes-since" },
  { caseId: "CL-4/stores-terminal-next-changes-since", defect: "reuse-next-cursor-as-changes-since" },
  // Revised 4.3-3: a session starts, and restarts after `cursor_expired`, at
  // `changes_since=beginning`; omitting the parameter is no longer accepted.
  { caseId: "CL-4/stores-terminal-next-changes-since", defect: "omit-beginning-on-first-sync" },
  { caseId: "CL-5/full-resync-after-cursor-expired", defect: "omit-beginning-on-resync" },
  { caseId: "CL-5/endpoint-cursor-expiry-also-full-resyncs", defect: "omit-beginning-on-resync" },
  { caseId: "CL-5/full-resync-after-cursor-expired", defect: "retry-expired-cursor" },
  { caseId: "CL-5/endpoint-cursor-expiry-also-full-resyncs", defect: "retry-expired-cursor" },
  { caseId: "AS-7/client-does-not-override-display-descriptions", defect: "add-selection-display" },
  { caseId: "CL-3/forwards-cursors-as-opaque-values", defect: "construct-cursor" },
  { caseId: "CL-7/unknown-error-code-keeps-http-status-authoritative", defect: "throw-on-unknown-error" },
  { caseId: "CL-7/status-incompatible-code-does-not-override-status", defect: "override-status-with-error-code" },
  { caseId: "CL-7/unknown-error-identifiers-do-not-break-parser", defect: "parse-unknown-identifier" },
  { caseId: "CL-8/reads-source-kind-from-grant", defect: "assume-source-kind" },
  // Revised-text client clauses (Section 4 copy handling, Section 10 revocation, Section 6 source.kind).
  { caseId: "AS-16/client-does-not-introduce-authority-or-declaration-uri", defect: "introduce-declaration-uri" },
  { caseId: "CL-9/invalid-token-challenge-stops-use-of-the-token", defect: "retry-after-invalid-token" },
  { caseId: "CL-9/inactive-token-is-not-recorded-as-revocation", defect: "treat-inactive-as-revoked" },
  { caseId: "CL-8/unrecognized-source-kind-not-treated-as-known", defect: "coerce-unrecognized-source-kind" },
  { caseId: "CL-10/tombstone-for-unheld-id-is-a-no-op", defect: "throw-on-unknown-tombstone" },
  { caseId: "CL-5/beginning-session-replaces-the-stored-copy", defect: "merge-copy-on-beginning" },
];

/**
 * Cases whose proof of failure is a bespoke test (a hook-driven adapter wrapper
 * or a purpose-built HTTP server) rather than a `Defect` switch on the bundled
 * server. `proof` names where the failing run lives.
 */
export const BESPOKE_PROOFS: readonly { readonly caseId: string; readonly proof: string }[] = [
  {
    caseId: "AS-9/introspection-carries-pdpp-extensions",
    proof:
      "as9-colocated-introspect.test.ts: wrong-token-kind / wrong-grant-id / missing-subject / missing-client stubs",
  },
  {
    caseId: "AS-8/revoked-token-introspects-inactive",
    proof: "as8-colocated-introspect.test.ts: stays-active-after-revoke stub",
  },
  {
    caseId: "AS-3/issued-grant-artifact-matches-section-7-schema",
    proof:
      "grant-schema-oracle.test.ts: missing-version artifact; query-schema-regression.test.ts: missing and unknown time_constraint.type",
  },
  {
    caseId: "AS-18/introspection-requires-authentication",
    proof: "as18-open-introspection.test.ts: open introspection endpoint",
  },
  {
    caseId: "AS-10/single-use-grant-consumed",
    proof: "oracle-discrimination.test.ts: AS-10 cannot be satisfied by an unrelated new grant",
  },
  {
    caseId: "AS-14/explicit-consent-required-for-ai-training",
    proof: "oracle-discrimination.test.ts: AS-14 silent issuance",
  },
  {
    caseId: "AS-19/authorization-code-redemption-is-not-replayable",
    proof: "oracle-discrimination.test.ts: AS-19 replay oracle",
  },
  {
    caseId: "RS-1/get-blob-bytes",
    proof: "oracle-discrimination.test.ts: get-blob-bytes wrong-bytes / empty-200 / missing-cache-control",
  },
  {
    caseId: "RS-1/blob-redirect-response-valid",
    proof: "oracle-discrimination.test.ts: redirect-malformed; direct 200 is unsupported",
  },
  {
    caseId: "RS-1/blob-ref-mime-type-valid",
    proof: "oracle-discrimination.test.ts: records-invalid-mime",
  },
  { caseId: "RS-1/blob-outside-grant-refused", proof: "oracle-discrimination.test.ts: leaks-out-of-grant-blob" },
  { caseId: "RS-1/blob-unauthenticated-refused", proof: "oracle-discrimination.test.ts: leaks-unauthenticated" },
];

/**
 * Cases that need a hook the bundled adapter does not expose to the CLI run
 * (exposing it would change the bundled summary), so the proof wraps the
 * adapter. `adapter` names the wrapper in `adapter-hook-proofs.test.ts`.
 */
export const HOOKED_DISCRIMINATION_MATRIX: readonly {
  readonly caseId: string;
  readonly defect: Defect;
  readonly adapter: "refreshable";
}[] = [
  { caseId: "AS-20/refresh-reuse-revokes-the-family", defect: "refresh-without-rotation", adapter: "refreshable" },
  {
    caseId: "AS-20/refresh-reuse-revokes-the-family",
    defect: "accept-superseded-refresh-token",
    adapter: "refreshable",
  },
  {
    caseId: "AS-20/refresh-reuse-revokes-the-family",
    defect: "refresh-reuse-keeps-family-alive",
    adapter: "refreshable",
  },
  {
    caseId: "AS-25/refresh-token-revocation-ends-the-family-grants",
    defect: "revocation-endpoint-ignores-refresh-tokens",
    adapter: "refreshable",
  },
  {
    caseId: "AS-25/access-token-revocation-spares-a-grant-a-family-covers",
    defect: "revoke-family-grant-on-access-token-revocation",
    adapter: "refreshable",
  },
];

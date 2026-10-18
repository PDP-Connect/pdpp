// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A minimal, in-process PDPP resource server used to exercise the suite itself.
//
// This is NOT the PDPP reference implementation and makes no conformance claim
// on its behalf. It exists for one reason: a conformance suite whose oracles
// have never been shown to fail is untrustworthy. A test that asserts "the
// server refused the ungranted stream" passes equally against a correct server
// and against a suite whose assertion is unreachable. So this server is built
// with a `defects` switch, and the suite's own test file runs every negative
// oracle twice — once against the clean server (expecting pass) and once
// against a server with the matching defect enabled (expecting fail).
//
// That is the independent failure proof: each negative oracle is demonstrated
// to distinguish a conforming target from a violating one. Without the defect
// variants the suite would be a set of assertions nobody has ever seen fire.
//
// It speaks real HTTP over a real socket, so the suite exercises the same code
// path it would against a remote vendor: no in-process short circuit, no
// privileged access to internal state.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { compareDateTimes, parseDateTime, parseFullDate } from "./rfc3339.ts";

/** Behaviours that violate a specific normative requirement, for oracle proof. */
export type Defect =
  /** Serves any stream regardless of grant membership (violates RS-2). */
  | "ignore-grant-streams"
  /** Returns all schema fields regardless of the grant projection (RS-2). */
  | "ignore-field-projection"
  /**
   * CONFORMANT, not a violation: resolves a narrowed request to one more field
   * than it named, as a schema-required field forces (Core Section 7 "Note on
   * `fields`"). A positive control that projection oracles judge the RESOLVED
   * allowlist rather than the request.
   */
  | "resolve-extra-field-into-narrowed-grant"
  /** Adds a field the seeded schema never declared to client record data (RS-2). */
  | "serve-undeclared-extra-field"
  /** Answers a read under a field-narrowed grant with 200 and a body that is not a list envelope (RS-2). */
  | "malformed-narrowed-read"
  /** Silently ignores unknown query parameters instead of 400 (RS-10). */
  | "ignore-unknown-params"
  /** Accepts client-token filter[...] instead of 400 (RS-9). */
  | "accept-client-filters"
  /** Keeps serving a revoked grant (AS-8). */
  | "ignore-revocation"
  /**
   * CONFORMANT, not a violation: introspection flips to inactive at once, but
   * resource reads keep serving for 3 seconds, as Section 8 (Revocation)
   * permits up to 60. A positive control that the revocation case does not
   * fail a target inside the ceiling.
   */
  | "lag-revocation-within-ceiling"
  /**
   * Refuses an inactive (revoked or expired) grant with the former 403
   * `permission_error` and no Bearer challenge, instead of the revised 401
   * `authentication_error` behind `WWW-Authenticate: Bearer error="invalid_token"`
   * (AS-8, clause 8.13-6).
   */
  | "inactive-grant-as-403"
  /** Omits resource_metadata from the 401 challenge (RS-16). */
  | "weak-401-challenge"
  /** Discloses current views/relationships to a client token (RS-15). */
  | "leak-current-metadata"
  /** Truncates schema/omits a declared capability from owner metadata (RS-14). */
  | "truncate-owner-metadata"
  /** Keeps every schema field but changes one field's declared type (RS-14). */
  | "corrupt-owner-schema-field-type"
  /** Drops the views array entirely from owner metadata (RS-14). */
  | "omit-owner-views"
  /** Keeps a views array but with the wrong fields (RS-14). */
  | "corrupt-owner-views"
  /** Drops the relationships array entirely from owner metadata (RS-14). */
  | "omit-owner-relationships"
  /** Keeps a relationships array but points it at the wrong target stream (RS-14). */
  | "corrupt-owner-relationships"
  /** Drops query capability entirely from owner metadata (RS-14). */
  | "omit-owner-query"
  /** Keeps query capability but with the wrong range-filter operators (RS-14). */
  | "corrupt-owner-query"
  /** Omits a declared required field from the schema's `required` array (RS-14). */
  | "omit-owner-schema-required-field"
  /** Keeps every schema field's type but drops a declared nested constraint (array `items.type`) (RS-14). */
  | "corrupt-owner-schema-nested-constraint"
  /** Refuses an ungranted stream, but with 401 instead of 403 (RS-6). */
  | "misclassify-stream-denial"
  /** Crashes on a malformed cursor instead of returning 400 (RS-6). */
  | "crash-on-bad-cursor"
  /** Clamps an oversized limit but omits the limit_clamped warning (RS-10). */
  | "silent-limit-clamp"
  /** Reads token kind from the token string instead of its principal (RS-4). */
  | "infer-token-kind-from-syntax"
  /** Serves any subject's store to any owner token (RS-12). */
  | "ignore-subject-scope"
  /** Declares self-export but refuses owner reads (RS-13). */
  | "declare-self-export-but-refuse"
  /** Accepts a selection naming an undeclared stream, field, or preset (AS-2). */
  | "accept-undeclared-selection"
  /** Accepts a selection with both or neither of streams/preset (AS-5). */
  | "accept-malformed-selection"
  /** Rejects a purpose_code merely for being unregistered (AS-6). */
  | "reject-unregistered-purpose"
  /**
   * CONFORMANT, not a violation: refuses every purpose outside the PDPP
   * namespace under a local policy whose prose mentions the registry only to deny it (AS item
   * 6 "MAY reject a purpose_code based on local policy"). AS-6 must skip.
   */
  | "reject-purpose-by-local-policy"
  /** Proceeds on an unsupported PDPP-Version instead of 400 (AS-17). */
  | "accept-unsupported-version"
  /** Issues an ai_training grant without explicit affirmative consent (AS-14). */
  | "bypass-ai-training-consent"
  /** Silently ignores an owner-token filter[...] naming an undeclared field instead of 400 (RS-10). */
  | "ignore-owner-filter-unknown-field"
  /** Silently serves an owner-token expand[] naming a relation absent from the stream's declared relationships (RS-10). */
  | "ignore-owner-expand-undeclared-relation"
  /** Rejects every owner record read, despite issuing a valid owner token. */
  | "deny-owner-records"
  /**
   * Honours `view` on a client token as if it were an owner-token
   * current-capability read, serving the page instead of rejecting it (RS-9,
   * clause 8.9-3).
   *
   * Distinct from `accept-client-filters`, and the distinction is what makes
   * the `view` oracle discriminating. Under `accept-client-filters` this server
   * still rejects `view` — just through the GENERIC unknown-parameter branch,
   * because `view` is not in `KNOWN_PARAMS`. A case asserting only "400
   * invalid_request" therefore passes against a server that never implemented
   * the client-token `view` rule at all. The violation the clause actually
   * describes is a server that SERVES the view, so that is what this defect
   * does.
   */
  | "serve-client-token-view"
  /**
   * Accepts a page cursor replayed under the opposite `order` value instead of
   * rejecting it as `invalid_cursor` (RS-6, clause 8.9-11).
   *
   * Models the common shape of this defect: a server that validates the cursor
   * decodes but never compares the direction it was minted under against the
   * direction of the request replaying it. The cursor is genuine, so syntax
   * validation — which `crash-on-bad-cursor` exercises — cannot catch this.
   */
  | "accept-order-mismatched-cursor"
  /**
   * Accepts a `streams` array that pairs a wildcard entry with a named stream,
   * or that names the same stream twice, instead of refusing it (AS-2, clause
   * 6.8-3).
   *
   * Separate from `accept-undeclared-selection`, which models a server that
   * never checks names against the retained snapshot at all. Both malformed
   * shapes here are built from names the snapshot DOES declare (or from the
   * wildcard, which is always well-formed on its own), so a server can validate
   * every name successfully and still fail this clause.
   */
  | "accept-malformed-stream-list"
  /**
   * Accepts a selection request carrying BOTH `view` and `fields` on one
   * stream, instead of refusing it (clause 6.8-1).
   *
   * Distinct from every field-validation defect: both halves of the request are
   * individually valid here — a real view name and real declared fields — so a
   * server that validates each part and never checks their combination accepts
   * it. That is exactly the server the 6.8-1 oracle must be able to catch, and
   * no existing defect produces it.
   */
  | "accept-view-and-fields-together"
  /** Reports the global version clock as `next_changes_since`, so token equality reveals writes the grant cannot see (clause 4.3-9). */
  | "token-reveals-hidden-writes"
  /** Accepts a page cursor presented under another grant, scope or `fields` selection (clauses 8.9-11, 8.9-17). */
  | "accept-cursor-under-other-context"
  /** Accepts a `changes_since` token presented under another grant, scope or stream (clause 8.9-17). */
  | "accept-sync-token-under-other-context"
  /** Emits `next_changes_since` on every page of a paginated session, not only the terminal one (clause 4.3-16). */
  | "next-changes-since-on-every-page"
  /** Serves a record on a later page after it was deleted post page 1, by reading the session snapshot (clause 8.9-18). */
  | "serve-deleted-record-from-session-snapshot"
  /** Emits a tombstone for a deleted record the grant could never see (clause 4.3-11). */
  | "tombstone-for-never-visible-record"
  /** Does not emit a tombstone when a record moves out of the grant's time window (clause 4.3-6). */
  | "omit-tombstone-on-leaving-window"
  /** Accepts `fields: ["*", "<name>"]`, instead of requiring `*` to be the only element (clause 6.8-7). */
  | "accept-star-beside-fields"
  /** Accepts a stream request carrying neither `fields` nor `view` (clause 6.8-12). */
  | "accept-stream-without-fields-or-view"
  /** Accepts a `time_range` with no `since` and no `until` (clauses 6.8-9, 6.8-10). */
  | "accept-empty-time-range"
  /** Accepts a `time_range` bound whose type does not match the field's format (clauses 6.8-8, 6.8-10). */
  | "accept-wrong-type-time-range-bound"
  /** Accepts a `time_range` bound that is not a valid RFC 3339 value (clause 6.8-10). */
  | "accept-invalid-time-range-bound"
  /** Accepts a `time_range` whose `since` is not before its `until` (clause 6.8-10). */
  | "accept-since-not-before-until"
  /** Rewrites an issued `time_constraint` bound to a UTC instant instead of keeping it as requested (clause 6.8-11). */
  | "normalize-time-constraint-bounds"
  /** Accepts a declaration with an unrecognized `streams[].semantics` value (clause 4.2-1). */
  | "accept-unrecognized-semantics"
  /** Accepts a declaration with an unrecognized `source.kind` (clause 6.6-2). */
  | "accept-unrecognized-source-kind"
  /** Accepts a non-boolean `consent_time_content_may_exceed` (clause 5.2-6). */
  | "accept-non-boolean-may-exceed"
  /** Accepts a `consent_time_field` that is nested, not a string, or not format `date`/`date-time` (clauses 5.2-3, 5.4-3, 5.4-4). */
  | "accept-ineligible-consent-time-field"
  /**
   * Refuses a selection carrying BOTH `view` and `fields`, but as
   * `invalid_request` rather than the RFC 9396 `invalid_authorization_details`
   * the revised OAuth/RAR binding names (clause 6.8-1). Enforcement is intact;
   * only the classification is wrong, which is what the changed oracle checks.
   */
  | "misclassify-view-and-fields-refusal"
  /**
   * Defines a view naming a field absent from the stream's declared schema,
   * and lets it be used (clause 5.6-2).
   *
   * The AS is authoritative for views, so nothing else in the system will
   * refuse this: the violation is the AS's own definition, which is why the
   * defect has to inject the bad definition rather than a bad request.
   */
  | "define-view-with-undeclared-field"
  /**
   * Widens an already-issued grant when the view it was resolved from later
   * gains a field (clause 5.6-2a).
   *
   * Models the server that stored the view NAME on the grant and re-resolves it
   * at read time, rather than freezing the resolved field list at issuance.
   * Without this defect a grant's projection never changes and the widening
   * case passes against a target that has no view evolution at all.
   */
  | "widen-existing-grants-on-view-change"
  /**
   * Resolves an unrecognized view URI by looking for a known view name INSIDE
   * it, instead of treating the URI as opaque (clause 5.6-3).
   *
   * This is the realistic shape of the violation: nobody writes a server that
   * deliberately mis-resolves view URIs, but plenty of servers "helpfully"
   * normalize an identifier — strip a namespace prefix, take the last path
   * segment, match a fragment — and that is exactly what treating an opaque
   * identifier as structured means. The result is a grant issued for a view the
   * AS never defined, under a name the owner never saw.
   */
  | "resolve-view-uri-by-substring"
  /**
   * Accepts `time_range` on a stream that declares no `consent_time_field`,
   * instead of refusing it (clauses 5.2-4 and 6.8-2).
   *
   * Models the server that treats `time_range` as a generic query filter and
   * applies it to whatever timestamp it happens to have, rather than to the
   * declared consent boundary. The damage is quiet: the owner approves "data
   * from the last 6 months" against a stream that has no meaning for that
   * phrase, and every party then believes a temporal limit is in force that
   * nothing actually evaluates.
   */
  | "accept-time-range-without-consent-time-field"
  /**
   * Binds client claims into the final approval artifact without client
   * attribution (clause 6.3-2). The claims remain intact, but without attribution
   * the artifact can make a client statement look like a protocol-enforced term.
   */
  | "drop-client-claim-attribution"
  /**
   * Paraphrases client claims when binding them into the final approval
   * artifact, instead of binding them exactly (clause 6.3-2).
   *
   * Separate from dropping attribution because a server can do either alone.
   * "Bound exactly" is the obligation: retained consent evidence that says
   * something the client did not say cannot support the consent it records.
   */
  | "mutate-bound-client-claims"
  /**
   * Leaks `client_claims` into the resolved grant (clause 7.2-4).
   *
   * Core places claims outside authorization equality, the resolved grant,
   * introspection rights and RS enforcement. A server that copies them into the
   * grant turns an unenforceable promise into something downstream components
   * may read as an authorization term.
   */
  | "leak-client-claims-into-grant"
  /**
   * Omits resolved facts from the final approval artifact (clause 7.2-2).
   *
   * Models the common shape: an artifact that names the streams and fields but
   * drops the temporal and lifecycle facts — retention, grant expiry, the
   * resolved instance ids — so the owner approves a screen that does not say
   * how long the access lasts or which instance it reaches.
   */
  | "thin-approval-artifact"
  /**
   * Accepts a `provider_native` declaration whose `source.id` differs from the
   * protected-resource identifier already accepted for that resource (clause
   * 5.8-2).
   *
   * The binding is what ties a declaration to the resource server that will
   * serve it. Broken, the owner consents against a description of one surface
   * while the grant reaches another.
   */
  | "accept-provider-native-id-mismatch"
  /**
   * Accepts DIFFERENT parsed content under an already-accepted
   * (authority, source.id, declaration_version) key, overwriting what was
   * retained (clause 5.8-4).
   *
   * This is equivocation, and Core requires both halves: refuse the new content
   * AND retain the old. The defect does the opposite of both, which is how the
   * oracle can tell a server that merely refuses from one that also preserves.
   */
  | "accept-declaration-equivocation"
  /**
   * Serializes a successful token response WITHOUT `Cache-Control: no-store`
   * and `Pragma: no-cache` (clause 10.2-4).
   *
   * The token itself is correct and everything downstream of it works, which is
   * why this defect is invisible to every other case: the damage is done by an
   * intermediary that was never told not to store the response, and it shows up
   * as a credential served from a cache long after issuance.
   */
  | "token-response-without-no-store"
  /**
   * Enforces a grant whose schema major version this server does not support,
   * instead of refusing it with 400 `unsupported_version` (clause 7.4-2).
   *
   * Models the server that never checks `grant.version` at all — the common
   * shape, because the grant parses well enough to read the fields the server
   * happens to know about. What it is then enforcing is its own guess at the
   * meaning of an artifact written against a schema it has never seen, which is
   * exactly the silent mis-enforcement the clause exists to prevent.
   */
  | "accept-unsupported-grant-schema-version"
  /**
   * Publishes secrets, owner-scoped clients and dynamically registered clients
   * in `pdpp_pre_registered_public_clients` (clause 6.2-2).
   *
   * The document stays otherwise well-formed and every advertised client still
   * works, so nothing else in the suite notices. What leaks is the deployment's
   * private registration state, out of an endpoint that is unauthenticated by
   * design because it exists to be discovered.
   */
  | "leak-private-registration-state"
  /**
   * Serves a token whose introspection result names a `pdpp_token_kind` this
   * server does not recognize, by falling back to client handling (clause
   * 8.2-3).
   *
   * The realistic shape of the violation. Nobody writes a server that
   * deliberately honours unknown kinds; they write one whose branch is
   * `if (kind === "owner") { ... } else { ...treat as client... }`, which is
   * indistinguishable from correct until a companion profile introduces a third
   * kind. At that point a token carrying permissions this specification never
   * defined is enforced under the rules for one it did — and the grant the
   * server reaches for is whatever the token happens to be bound to.
   */
  | "honour-unrecognized-token-kind"
  /**
   * Refuses a valid URL-hosted client identity document solely because the
   * client is not preregistered (clauses 6.1-2, 6.1-4).
   *
   * The document is fetched, valid, and asserts the URL it came from — the
   * client has done everything the spec asks. The refusal is for the one reason
   * Core names as insufficient, which is what makes this the violation rather
   * than the local-policy denial clause 6.1-3 expressly permits.
   */
  | "reject-unregistered-url-hosted-client"
  /**
   * Accepts a client identity document that asserts a DIFFERENT `client_id`
   * than the URL it was retrieved from (clauses 6.1-2, 6.1-4).
   *
   * The mirror of the defect above, and it is what keeps "accept unregistered
   * clients" from collapsing into "accept anything". Without the identity
   * binding, any host able to serve a document can claim to be someone else's
   * client and inherit whatever trust that client has earned — so an AS that
   * satisfies 6.1-2 by skipping validation altogether has replaced a closed
   * door with an open one.
   */
  | "accept-unbound-url-hosted-client-document"
  /**
   * Computes `changes_since` eligibility on the UNPROJECTED record, so a change
   * confined to fields outside the grant's projection still surfaces the record
   * (clause 8.9-13).
   *
   * The returned record looks correct — it carries only authorized fields — so
   * a case comparing the payload against the projection cannot catch this. What
   * leaks is not a field value but the FACT that a hidden field changed, which
   * the client learns from the record's mere presence in the delta.
   */
  /** Answers GET /v1/streams with a bare array instead of the Section 8 list envelope (RS-1). */
  | "list-streams-without-envelope"
  /** Refuses a client token's bare read of a stream its grant names (RS-2 over-refusal). */
  | "refuse-bare-granted-read"
  /** Serves a request carrying no Authorization header as if it were the owner (RS-16). */
  | "serve-without-authentication"
  /** Answers a client revocation of a refresh token with 200 but leaves its family's grants active (clause 10.7-3). */
  | "revocation-endpoint-ignores-refresh-tokens"
  /** Ends the whole grant when a client revokes one access token, although a refresh-token family covers the grant (clause 10.7-5). */
  | "revoke-family-grant-on-access-token-revocation"
  /** States no `expires_in` for the first token of a `single_use` grant (clause 7.5-3). */
  | "single-use-token-without-expiry"
  /** Answers a client revocation of an access token with 200 but leaves the token active (clause 10.7-4). */
  | "revocation-endpoint-ignores-access-tokens"
  /** Offers a revocation endpoint but does not advertise `revocation_endpoint` in its RFC 8414 metadata (clause 10.7-8). */
  | "omit-revocation-endpoint-metadata"
  /** Leaves out the statement that `since` is inclusive and `until` exclusive from the final approval artifact (clause 7.2-2). */
  | "omit-bound-inclusivity-statement"
  /** Compares a time window's bounds as text instead of as RFC 3339 instants (clause 7.6-1). */
  | "compare-time-bounds-as-text"
  /** Leaves `exp` out of a positive introspection response for a token that expires (clause 8.12-5). */
  | "omit-introspection-exp"
  /** Omits the `PDPP-Version` response header, so a client that sent none cannot learn the selected version (clause 8.14-1). */
  | "omit-pdpp-version-response-header"
  /** Ignores the PDPP-Version header instead of refusing an unsupported value (RS-11). */
  | "ignore-pdpp-version-header"
  /** Publishes protected resource metadata without the `pdpp_` members (RS-16). */
  | "omit-pdpp-resource-metadata"
  /** Reports `access_mode` outside Section 7's closed set in authorization_details (AS-3). */
  | "invalid-access-mode-in-authorization-details"
  /** Keeps serving a grant whose expiry has passed (AS-8). */
  | "serve-expired-grant"
  /** Accepts a page cursor presented as `changes_since` and serves a full page (RS-6). */
  | "accept-page-cursor-as-changes-since"
  /** Answers GET /records/{id} for an id that does not exist with 200 (RS-1). */
  | "serve-unknown-record-id"
  /** Skips the grant's frozen time_constraint when selecting records (RS-2). */
  | "ignore-time-constraint"
  /** Approves a staged request without checking the review revision (AS-15). */
  | "accept-forged-review-revision"
  /** Carries an omitted field list or a wildcard stream name into the reviewed grant unexpanded (AS-4). */
  | "carry-unexpanded-selection-into-review"
  /** Refuses any selection request that names fields, though the fields are declared (AS-2 over-refusal). */
  | "refuse-field-selection"
  /** Returns the same refresh token on use, so no token is ever superseded (AS-20). */
  | "refresh-without-rotation"
  /** Issues a further token for a superseded refresh token instead of refusing it (AS-20). */
  | "accept-superseded-refresh-token"
  /** Refuses a superseded refresh token but leaves the family's access tokens live (AS-20). */
  | "refresh-reuse-keeps-family-alive"
  | "ignore-projection-for-sync-eligibility"
  /**
   * Re-anchors a paginated `changes_since` session on every page instead of
   * holding the horizon chosen on page 1 (clause 8.9-14).
   *
   * The damage is not the duplicate: it is the RECORD THAT IS NEVER RETURNED.
   * A write arriving mid-session appears in a later page of that session, and
   * the terminal page then hands back a horizon at or beyond it — so the next
   * session skips it too. The client never sees that record and nothing reports
   * the gap.
   */
  | "re-anchor-sync-session-per-page"
  /**
   * Omits `next_changes_since` from the terminal page of a `changes_since`
   * response (clause 8.9-15).
   *
   * Exactly the behaviour the reference target exhibited before this batch,
   * kept as a defect so the RS-8 oracle is proven against the real thing rather
   * than a stand-in. A client with no resume token must full-resync every
   * session, which is the cost incremental sync exists to avoid.
   */
  | "omit-next-changes-since"
  /**
   * Drops tombstones from incremental sync responses (Core Section 4).
   *
   * Silence is the violation. A client that simply stops seeing a record cannot
   * distinguish deletion from the record falling outside its filter, so it
   * keeps serving data the owner deleted — and nothing in the exchange ever
   * says otherwise.
   */
  | "omit-tombstones"
  /**
   * Answers an expired `changes_since` cursor with an ordinary refusal instead
   * of 410 `cursor_expired` (clause 4.3-2).
   *
   * A 400 `invalid_cursor` looks like a client bug and invites a retry with a
   * corrected token, which cannot exist. Only the 410 tells the client the
   * thing it must act on: its baseline is unrecoverable and a full re-sync is
   * the only way forward. A client that never learns this silently stops
   * syncing.
   */
  | "misclassify-expired-sync-cursor"
  /**
   * Encodes a compound primary key without stringifying non-string components
   * (clause 4.5-1).
   *
   * `["session_a",1]` instead of `["session_a","1"]`. The record is otherwise
   * correct and every other case passes against it, which is the point: this
   * disagreement is invisible within one implementation and only surfaces when
   * two meet — or when a grant's `resources[]` entry, built from one form, is
   * matched against a record keyed the other.
   */
  | "unstringified-compound-key"
  /**
   * Accepts a declaration whose selection preset names the same stream twice
   * (clause 6.9-1).
   *
   * Models the server that defers the problem to issuance and deduplicates
   * there. Core forecloses that explicitly — "They are not deferred to grant
   * issuance" — because the retained declaration is what the owner's consent is
   * written against, and a document whose preset means two different things
   * depending on who expands it cannot support that consent.
   */
  | "accept-duplicate-preset-stream"
  /**
   * Accepts a declaration whose `primary_key` or `cursor_field` names a field
   * the stream's schema does not declare (clause 5.2-2).
   *
   * Models the server that validates the document's shape but never
   * cross-checks its internal references. The result is a retained declaration
   * whose record identity and sort order name fields that do not exist, which
   * no resource server can honour — discovered at read time, long after
   * consent.
   */
  | "accept-undeclared-key-field-reference"
  /**
   * Accepts a declaration whose `consent_time_field` names a field the schema
   * does not declare (clause 5.2-3).
   *
   * Separate from `accept-undeclared-key-field-reference` because a server can
   * check the sync-mechanics fields and miss this one, and this is the more
   * dangerous miss: `consent_time_field` is the field a `time_range` grant is
   * evaluated against, so an undeclared one means the owner's time-bounded
   * consent is filtered on nothing.
   */
  | "accept-undeclared-consent-time-field"
  /**
   * Accepts a declaration carrying an embedded stream schema that declares the
   * wrong `$schema` dialect, fails meta-validation, or references a remote
   * document (clause 5.2-5).
   *
   * Core requires the AS to "meta-validate each embedded stream schema before
   * accepting the declaration" and confines `$ref`/`$dynamicRef` to local
   * fragments. The remote-reference half is the one with teeth: a declaration
   * whose meaning depends on a document the AS never retained can change after
   * consent without anyone editing the declaration.
   */
  | "accept-invalid-embedded-schema"
  /**
   * Omits `authorization_details` from a token response for a request that
   * carried them (RFC 9396 Section 7, adopted by Core's Section 2 normative
   * reference and not restated in Core).
   *
   * Everything else about the exchange is correct — the token works, the grant
   * is right, introspection reports it faithfully. What a client loses is the
   * ability to learn what it was granted from the response that granted it: it
   * must instead introspect, which on a separated deployment is an endpoint
   * authenticated for resource servers, not for it.
   */
  | "omit-token-response-authorization-details"
  /** Applies the sparse `fields=` projection to tombstones, so they lose their envelope (RS-7, clause 4.3-6). */
  | "project-tombstones-through-fields"
  /** Applies `limit` per instance and concatenates, so a page can exceed `limit` (Section 8 `limit`). */
  | "per-instance-limit-concatenated"
  /** Concatenates each instance's own sorted run instead of merging across instances (Section 8 stable sort). */
  | "concatenate-instances-unsorted"
  /** Reports `has_more: true` on a multi-instance read but mints no `next_cursor` (Section 8 pagination). */
  | "has-more-without-next-cursor"
  /** Rejects `changes_since` with 400 when the grant lists more than one instance (RS-7). */
  | "reject-multi-instance-changes-since"
  /** Drops schema-required fields from an owner-token sparse read (Section 8 `fields`). */
  | "drop-required-fields-on-sparse-read"
  /** Coerces a malformed `limit` (`abc`, `-1`, `1.5`, `1junk`) instead of rejecting it with 400 (clause 8.9-7). */
  | "coerce-invalid-limit"
  /** Leaves `error="invalid_token"` out of the 401 challenge for a presented-and-rejected token (RS-16). */
  | "omit-invalid-token-error"
  /** Serves different bytes than the blob stores (RS-1, clause 8.12-2). */
  | "blob-wrong-bytes"
  /** Serves a blob without `Cache-Control: private, no-store` (RS-1, clause 8.12-2). */
  | "blob-response-cacheable"
  /** Publishes a `blob_ref.mime_type` that is not an IANA media type (RS-1, clause 4.8-1). */
  | "blob-ref-invalid-mime-type"
  /** Serves any stored blob to any valid token, whether or not a readable record references it (RS-1, clause 8.12-1). */
  | "serve-blob-without-reference-check"
  /** Counts a record as referencing a blob through a field the grant's projection excludes (RS-1, clause 8.12-1). */
  | "serve-blob-ignoring-projection"
  /** Counts a record outside the grant's time window as referencing a blob (RS-1, clause 8.12-1). */
  | "serve-blob-ignoring-window";

/** The sole purpose code Core Section 9 AS item 14 requires explicit consent for. */
export const AI_TRAINING_PURPOSE = "https://pdpp.dev/purpose/ai_training";

export type Record_ = { readonly id: string } & Record<string, unknown>;

export interface StreamFixture {
  /**
   * The field `time_range` is evaluated against (Core Section 5). OMITTING it
   * is the normative signal that the stream is not time-range-capable, which is
   * what clauses 5.2-4 and 6.8-2 need a stream to demonstrate.
   */
  readonly consentTimeField?: string;
  /** RFC 3339 format of `consentTimeField` (Core Section 5); defaults to `date-time`. */
  readonly consentTimeFormat?: "date" | "date-time";
  readonly cursorField?: string;
  /** Declared item type for array-typed fields (JSON Schema `items.type`), a nested constraint RS-14 checks. */
  readonly fieldItemTypes?: Readonly<Record<string, string>>;
  readonly fields: readonly string[];
  /** Per-field JSON Schema type, so RS-14 has real schema content to check (not just field names). */
  readonly fieldTypes?: Readonly<Record<string, string>>;
  /**
   * Records carry a hidden `_instance` handle (never a schema field, so never
   * projected) and the collection is served in Section 8 stable-sort order
   * `(cursor_field, primary_key)`. Only the stream provisioned by
   * `provisionMultiInstanceStream` sets this; the seeded streams keep
   * insertion order.
   */
  readonly multiInstance?: boolean;
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly records: readonly Record_[];
  /** Declared relationships to other streams, for RS-14's relationship-corruption cases. */
  readonly relationships?: readonly { readonly id: string; readonly targetStream: string; readonly type: string }[];
  /** Fields that must be present per the schema's `required` array (Core Section 5). */
  readonly requiredFields?: readonly string[];
  readonly semantics: "append_only" | "mutable_state";
  /**
   * Named views this AS defines over the stream (Core Section 5 "Views").
   *
   * The AS is authoritative for views, so these are the server's own
   * definitions rather than anything a declaration publisher suggested. A view
   * whose `fields` name something outside `fields` above is the 5.6-2
   * violation and is only ever declared by a defect-injected fixture.
   */
  readonly views?: readonly { readonly id: string; readonly fields: readonly string[] }[];
}

/** One state of a record at a version (Core Section 4 "Visibility"); `snapshot` is null once deleted. */
interface HistoryEntry {
  readonly at: string;
  readonly changed: ReadonlySet<string>;
  readonly snapshot: Record<string, unknown> | null;
  readonly version: number;
}

interface GrantState {
  /**
   * Core Section 7 required grant facts, retained so the introspection
   * projection can report them.
   *
   * They were absent, and nothing noticed while AS-3's schema case could not
   * reach this target's introspection response. A grant that does not retain
   * its own purpose, source and access mode cannot describe itself to a
   * resource server, which is the whole job of the introspection projection.
   */
  readonly accessMode: string;
  expired: boolean;
  readonly grantId: string;
  readonly purposeCode: string;
  revoked: boolean;
  revokedAt?: number;
  /**
   * The grant SCHEMA version (Core Section 7 "Version layering",
   * `grant.version`) — not the HTTP API contract version the `PDPP-Version`
   * header carries. The two are separate axes that Core forbids conflating,
   * and this field is what makes the grant axis reachable at all.
   */
  readonly schemaVersion: string;
  readonly source: { readonly kind: string; readonly id: string };
  readonly streams: readonly {
    name: string;
    fields: readonly string[];
    /** Instance handles the grant lists for this stream (Core Section 7); absent means the single seeded instance. */
    instanceIds?: readonly string[];
    /** Frozen consent window, when the grant carries one (Core Section 7). */
    timeConstraint?: { field: string; from?: string; to?: string };
    /**
     * The view name this stream's `fields` were resolved FROM, when the request
     * named one.
     *
     * Retained as provenance only. A conforming read never consults it —
     * `fields` above is authoritative per Core Section 5 "View evolution" — and
     * the ONLY code that reads it is the `widen-existing-grants-on-view-change`
     * defect, which re-resolves from it to model the server that got this
     * wrong. Keeping it here rather than in the defect lets the defect be a
     * read-time behaviour change instead of a different issuance path.
     */
    resolvedFromView?: string;
  }[];
  readonly subjectId: string;
}

/**
 * What a bearer token resolves to, as an introspection response would report.
 *
 * The third member is the whole of clause 8.2-3: a token that authenticates
 * perfectly well and whose introspection result names a `pdpp_token_kind` this
 * server does not recognize. It is deliberately NOT an invalid token — Core
 * makes token format opaque to the RS, so "unrecognized kind" and "unparseable
 * credential" are different conditions and only the first is what this clause
 * governs.
 */
type Principal =
  | { kind: "client"; grantId: string }
  | { kind: "owner"; subjectId: string }
  | { kind: "unrecognized"; reportedKind: string };

/** Lifetime a token response states and introspection reports as `exp` (clause 8.12-5). */
const TOKEN_LIFETIME_SECONDS = 3600;

export const PDPP_VERSION = "2026-04-06";
const SUPPORTED_VERSION = PDPP_VERSION;

/**
 * The grant schema version this server supports, and the major it accepts.
 *
 * Deliberately a different shape from `PDPP_VERSION` above: Core Section 7
 * treats the grant schema axis and the HTTP contract axis as independent, and
 * giving them the same value here would let a conflating implementation pass by
 * coincidence.
 */
export const GRANT_SCHEMA_VERSION = "1.0";
const SUPPORTED_GRANT_MAJOR = "1";

/** The major component of a grant schema version, per Core's major-version rule. */
function grantMajor(version: string): string {
  return version.split(".")[0] ?? version;
}
/** A `limit` is a plain non-negative integer; anything else is an unsupported query shape (clause 8.9-7). */
const LIMIT_PATTERN = /^[0-9]+$/;

/** Comma-separated `fields=` value as a set of top-level field names. */
function parseFieldsParam(raw: string | null): ReadonlySet<string> | undefined {
  return raw === null ? undefined : new Set(raw.split(",").filter((name) => name.length > 0));
}

const KNOWN_PARAMS = new Set(["limit", "cursor", "order", "fields", "changes_since"]);

/**
 * Map key for a view definition.
 *
 * A composed key needs a separator that cannot occur in either component.
 * Clause 5.6-3 requires unrecognized view URIs to be treated as opaque
 * identifiers, so a view id may contain spaces, slashes, colons — anything. A
 * newline cannot appear in a stream name or a view id supplied through the
 * adapter contract, and nothing ever parses this key back apart (`allViews`
 * walks the fixtures instead), so the separator only has to be collision-free.
 */
function viewKey(stream: string, view: string): string {
  return `${stream}\n${view}`;
}

/** Map key for a record's version history. Same separator rationale as `viewKey`. */
function recordKey(stream: string, recordId: string): string {
  return `${stream}\n${recordId}`;
}

/**
 * The `changes_since` token space, deliberately shaped so it can never be
 * confused with a page cursor.
 *
 * Section 8: "`cursor`/`next_cursor` are pagination tokens within a single
 * query execution; `changes_since`/`next_changes_since` are incremental sync
 * tokens across sessions ... they are different token spaces and will produce a
 * protocol error if confused." Page cursors here are `ok:<order>:<offset>`, so
 * the two prefixes are disjoint and each can reject the other's tokens.
 */
const SYNC_PREFIX = "sync:";

/**
 * Encode a sync horizon as an opaque token, bound to the query context that
 * produced it (Section 8: a token is bound to the grant or owner scope and to
 * the query context). `beginning` is the one token with no binding.
 */
function syncToken(version: number, context: string): string {
  return `${SYNC_PREFIX}${version}:${context}`;
}

/** The Section 4 "Starting a sync" value: an empty horizon at which no record is visible. */
const SYNC_BEGINNING = "beginning";

/** A short stable digest of a query context, for binding tokens to it. */
function contextDigest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

/**
 * Decode a sync token to its horizon and bound context, or null when it is not
 * one of ours.
 *
 * `beginning` opens a fresh session from horizon 0, which is how a client with
 * no prior cursor establishes its baseline. It never expires and carries no
 * binding. An empty value is not a bootstrap and is refused as malformed.
 */
function parseSyncToken(raw: string): { readonly context?: string; readonly version: number } | null {
  if (raw === SYNC_BEGINNING) {
    return { version: 0 };
  }
  if (!raw.startsWith(SYNC_PREFIX)) {
    return null;
  }
  const [versionText, context] = raw.slice(SYNC_PREFIX.length).split(":");
  const version = Number(versionText);
  if (!(Number.isInteger(version) && version >= 0) || context === undefined || context.length === 0) {
    return null;
  }
  return { context, version };
}

const RECORDS_PATH = /^\/v1\/streams\/([^/]+)\/records$/;
const SINGLE_RECORD_PATH = /^\/v1\/streams\/([^/]+)\/records\/([^/]+)$/;
const METADATA_PATH = /^\/v1\/streams\/([^/]+)$/;
const BLOB_PATH = /^\/v1\/blobs\/([^/]+)$/;

/** The seeded subject. A second subject exists so cross-subject scoping is testable. */
/** The client this target issues grants to, as introspection reports it. */
export const CLIENT_ID = "pdpp-conformance-client";

export const SEEDED_SUBJECT = "subject_seeded";

/**
 * The single connector instance this target's fixtures belong to.
 *
 * Core Section 7's StreamGrant table requires a non-empty `instance_ids` in an
 * issued grant: an empty list means fan-in was never resolved. This server
 * serves exactly one instance, so resolution is trivial here — but it still has
 * to be STATED, because a resource server enforces from the introspected grant
 * and cannot infer an instance the AS never named.
 */
const SEEDED_INSTANCE = "instance_seeded";

/** Source the seeded streams belong to (Core Section 7 `source`). */
const SEEDED_SOURCE = { kind: "connector", id: "https://registry.pdpp.dev/connectors/reference" } as const;

/** Purpose bound to a grant whose request named none (Core Section 7 `purpose_code`). */
const DEFAULT_PURPOSE = "https://pdpp.dev/purpose/personalization";
export const FOREIGN_SUBJECT = "subject_foreign";

export class ReferenceServer {
  private server?: Server;
  private port = 0;
  private readonly grants = new Map<string, GrantState>();
  private readonly tokens = new Map<string, Principal>();
  private counter = 0;
  private readonly streams: readonly StreamFixture[];
  private readonly defects: ReadonlySet<Defect>;
  /** Streams provisioned on demand (multi-instance, blobs): served, but not part of the seeded inventory or the owner stream list. */
  private readonly provisionedStreams: StreamFixture[] = [];

  /** Stored blobs by id, provisioned on demand by `provisionBlobStreams`. */
  private readonly blobs = new Map<string, { readonly bytes: Buffer; readonly mimeType: string }>();

  /**
   * The AS's current view definitions, keyed by the `viewKey` helper below.
   *
   * Held apart from the readonly fixtures because views EVOLVE: clause 5.6-2a
   * is about what happens to an already-issued grant when a view later gains a
   * field, so the current definition must be mutable while the grant's frozen
   * field list is not. Seeded from the fixtures at construction.
   */
  private readonly views = new Map<string, string[]>();

  /**
   * Grant a token of an unrecognized kind is bound to, keyed by the kind it
   * reports (clause 8.2-3).
   *
   * Held so the `honour-unrecognized-token-kind` defect has a REAL grant to
   * fall back to. Without it the defect would deny for lack of a grant and the
   * oracle could not tell "refused because the kind is unknown" from "refused
   * because there was nothing to serve" — the defect would appear to work while
   * proving nothing.
   */
  private readonly unrecognizedKindGrants = new Map<string, string>();

  /**
   * Monotonic version stamp per record, keyed `stream\nrecordId`, and the
   * counter that issues them. This is the internal version history Core
   * Section 4 says a `mutable_state` stream maintains to support incremental
   * sync: "This is an implementation detail: the protocol surface is a standard
   * cursor-based query."
   *
   * A stamp is what a `changes_since` token names, so a record is eligible for
   * a session exactly when its stamp exceeds the token's. Seeded records all
   * start at version 1, so an opening session returns the whole stream, which
   * is the baseline a client syncs from.
   */
  private readonly recordVersions = new Map<string, number>();
  private versionClock = 0;

  /** Seconds since the epoch when this server started; every token it issues lives `TOKEN_LIFETIME_SECONDS` from it. */
  private readonly tokenIssuedAtSeconds = Math.floor(Date.now() / 1000);

  /**
   * Every state a record has had, oldest first, keyed `stream\nrecordId`.
   *
   * Core Section 4 "Visibility": whether a record is visible is judged at a
   * HORIZON, from the record's version at that horizon, so a session needs the
   * state each record was in then -- not just the latest. A deletion is a final
   * entry with a null snapshot. The history is what lets a session tell "left
   * the grant's window" from "never in it", which a latest-version stamp cannot.
   */
  private readonly history = new Map<string, HistoryEntry[]>();

  /**
   * Fields whose change is NOT visible to a given grant, recorded per record so
   * clause 8.9-13 is observable.
   *
   * Core: "Eligibility for `changes_since` MUST be computed on the
   * grant-authorized projection, not on the unprojected record. Returning a
   * record whose authorized projection is unchanged is a protocol violation
   * because it leaks that hidden fields changed." So a write has to record
   * WHICH fields it touched, or the server cannot tell an in-projection change
   * from an out-of-projection one and the clause has nothing to act on.
   */
  private readonly changedFields = new Map<string, Set<string>>();

  /**
   * Deleted records, retained so a sync session whose cursor predates the
   * deletion can be told about it (Core Section 4 "Tombstones").
   *
   * Held separately from `streams` because a tombstone is not a record: it has
   * no `data`, cannot be read directly, and exists only to be reported in a
   * delta. Merging the two would make every ordinary read have to remember to
   * filter deletions out.
   */
  /**
   * Individual `changes_since` tokens this server has retired (clause 4.3-2).
   *
   * Deliberately a set of exact tokens rather than a horizon below which
   * everything is expired. A horizon would retroactively expire every token
   * issued at or before it — including ones a later, unrelated session is still
   * legitimately holding — so one case's expiry would leak into another's
   * resume and surface as a spurious 410. Found exactly that way: the tombstone
   * case began failing with "Resuming a sync from a valid next_changes_since
   * returned 410" once the expiry case ran before it.
   *
   * Empty by default: expiry is a MAY and this server retires nothing on its
   * own.
   */
  private readonly expiredSyncTokens = new Set<string>();

  private readonly tombstones = new Map<
    string,
    { readonly stream: string; readonly recordId: string; readonly version: number; readonly deletedAt: string }
  >();

  constructor(streams: readonly StreamFixture[], defects: ReadonlySet<Defect> = new Set()) {
    // Copy the record set per instance. `writeField` and `deleteRecord` mutate
    // it, and the fixtures handed in here are module-level constants shared by
    // every adapter in the process — so without this copy one case's deletion
    // is visible to the next server built from the same fixtures.
    //
    // Found by a test, not by reading: after the reference target gained
    // `changes_since`, the RS-7 tombstone case deleted a record from
    // DEFAULT_FIXTURES and a LATER case in the same file, running against a
    // freshly constructed server, could no longer paginate two records. A
    // shared-fixture bug in a suite whose whole job is isolating targets is
    // worse than the defect it would mask.
    this.streams = streams.map((stream) => ({ ...stream, records: stream.records.map((record) => ({ ...record })) }));
    this.defects = defects;
    for (const stream of this.streams) {
      for (const view of stream.views ?? []) {
        this.views.set(viewKey(stream.name, view.id), [...view.fields]);
      }
      // Every seeded record starts at version 1, with every field counted as
      // changed: an opening `changes_since` session must return the whole
      // stream, because that is the baseline the client has yet to receive.
      for (const record of stream.records) {
        this.versionClock += 1;
        this.recordVersions.set(recordKey(stream.name, record.id), this.versionClock);
        this.changedFields.set(recordKey(stream.name, record.id), new Set(stream.fields));
        this.recordHistory(stream.name, record.id, { ...record }, new Set(stream.fields));
      }
    }
  }

  /**
   * Write one field of an existing record, stamping a new version.
   *
   * The unit is a FIELD rather than a record because clause 8.9-13 turns on
   * which fields a change touched: a write to a field outside a grant's
   * projection must not make the record eligible for that grant's sync. A
   * whole-record write could never express that distinction.
   */
  writeField(stream: string, recordId: string, field: string, value: unknown): boolean {
    const fixture = this.streams.find((s) => s.name === stream);
    const record = fixture?.records.find((r) => r.id === recordId);
    if (!(fixture && record)) {
      return false;
    }
    (record as Record<string, unknown>)[field] = value;
    this.versionClock += 1;
    const key = recordKey(stream, recordId);
    this.recordVersions.set(key, this.versionClock);
    this.changedFields.set(key, new Set([field]));
    this.recordHistory(stream, recordId, { ...record }, new Set([field]));
    return true;
  }

  /** Append a state to a record's history at the current version. */
  private recordHistory(
    stream: string,
    recordId: string,
    snapshot: Record<string, unknown> | null,
    changed: ReadonlySet<string>
  ): void {
    const key = recordKey(stream, recordId);
    const entries = this.history.get(key) ?? [];
    entries.push({ at: new Date().toISOString(), changed, snapshot, version: this.versionClock });
    this.history.set(key, entries);
  }

  /**
   * Retire a `changes_since` token, so a later session presenting it is past
   * this server's retention horizon (clause 4.3-2).
   *
   * Models a retention policy without a clock: the horizon moves, rather than
   * time passing. That keeps the case deterministic — a test that slept out a
   * real retention period would be slow and flaky, and a faked clock would test
   * the fake.
   */
  expireSyncCursor(token: string): boolean {
    const horizon = parseSyncToken(token);
    if (horizon === null) {
      return false;
    }
    this.expiredSyncTokens.add(token);
    return true;
  }

  /** The current version clock, for a caller that wants to bound a session. */
  get currentVersion(): number {
    return this.versionClock;
  }

  /**
   * Delete a record, retaining a tombstone.
   *
   * Core Section 4: "When a record is deleted from a `mutable_state` stream,
   * the resource server MUST include a tombstone entry in incremental sync
   * responses for clients whose cursor predates the deletion." The record is
   * removed from the live set and a stamped tombstone takes its place, so a
   * client that already has the record learns it is gone rather than merely
   * ceasing to see it — which is indistinguishable from the record falling
   * outside the client's filter.
   *
   * Only for `mutable_state`: an append-only stream has no deletion semantics
   * to express.
   */
  deleteRecord(stream: string, recordId: string): boolean {
    const fixture = this.streams.find((s) => s.name === stream);
    if (fixture?.semantics !== "mutable_state") {
      return false;
    }
    const index = fixture.records.findIndex((r) => r.id === recordId);
    if (index < 0) {
      return false;
    }
    (fixture.records as Record_[]).splice(index, 1);
    this.versionClock += 1;
    this.tombstones.set(recordKey(stream, recordId), {
      stream,
      recordId,
      version: this.versionClock,
      deletedAt: new Date().toISOString(),
    });
    this.recordVersions.set(recordKey(stream, recordId), this.versionClock);
    this.recordHistory(stream, recordId, null, new Set(fixture.fields));
    return true;
  }

  /** A seeded or provisioned stream by name. */
  private findStream(name: string): StreamFixture | undefined {
    return this.streams.find((s) => s.name === name) ?? this.provisionedStreams.find((s) => s.name === name);
  }

  /**
   * Provision (once) the `mutable_state` stream that two instance handles share,
   * for the multi-instance list-records cases.
   *
   * The shape is chosen so each defect has something to get wrong: 140 records
   * so one page at the maximum `limit` cannot hold them all; cursor values that
   * interleave across the two instances, so concatenation and a true merge
   * differ; every tenth pair sharing a cursor value, so the primary-key
   * tiebreak decides; and records with no cursor value at all, which Section 8
   * sorts after every present value.
   */
  provisionMultiInstanceStream(): {
    readonly cursorField: string;
    readonly instanceIds: readonly string[];
    readonly records: readonly { readonly id: string; readonly instanceId: string; readonly cursor: string | null }[];
    readonly stream: string;
  } {
    const name = "multi_instance_notes";
    const cursorField = "updated_at";
    const instanceIds = ["instance_a", "instance_b"] as const;
    const seeded: { id: string; instanceId: string; cursor: string | null }[] = [];
    const perInstance = 70;
    const cursorAt = (minute: number) => new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString().replace(".000Z", "Z");
    for (let i = 0; i < perInstance; i += 1) {
      const missing = i % 17 === 5;
      const tag = String(i).padStart(3, "0");
      seeded.push({ id: `a_${tag}`, instanceId: instanceIds[0], cursor: missing ? null : cursorAt(2 * i) });
      seeded.push({
        id: `b_${tag}`,
        instanceId: instanceIds[1],
        cursor: missing ? null : cursorAt(i % 10 === 0 ? 2 * i : 2 * i + 1),
      });
    }
    if (!this.provisionedStreams.some((s) => s.name === name)) {
      const records: Record_[] = seeded.map((r) => ({
        id: r.id,
        label: `note ${r.id}`,
        ...(r.cursor === null ? {} : { [cursorField]: r.cursor }),
        _instance: r.instanceId,
      }));
      this.provisionedStreams.push({
        name,
        fields: ["id", "label", cursorField],
        fieldTypes: { id: "string", label: "string", [cursorField]: "string" },
        requiredFields: ["id"],
        primaryKey: ["id"],
        cursorField,
        semantics: "mutable_state",
        multiInstance: true,
        records,
      });
      for (const record of records) {
        this.versionClock += 1;
        this.recordVersions.set(recordKey(name, record.id), this.versionClock);
        this.changedFields.set(recordKey(name, record.id), new Set(["id", "label", cursorField]));
        this.recordHistory(name, record.id, { ...record }, new Set(["id", "label", cursorField]));
      }
    }
    return { stream: name, cursorField, instanceIds, records: seeded };
  }

  /**
   * Provision (once) the streams and blobs the blob cases need.
   *
   * `blob_attachments` holds two records that reference blobs through two
   * fields, so each way a reference can fail to authorize has a blob that
   * exercises it: `blob_ref` (the primary blob, readable under the fixture
   * grant), `thumbnail_ref` (a blob referenced ONLY through a field the fixture
   * grant's projection excludes), and a second record dated outside the window
   * the windowed grant consents to. `blob_private_attachments` is a stream no
   * fixture grant lists, so its blob exists but no record in the grant
   * references it.
   */
  provisionBlobStreams(): {
    readonly bytes: Buffer;
    readonly mimeType: string;
    readonly ids: {
      readonly blob: string;
      readonly outOfGrant: string;
      readonly outsideProjection: string;
      readonly outsideWindow: string;
    };
    readonly stream: string;
    readonly window: { readonly field: string; readonly from: string; readonly to: string };
  } {
    const stream = "blob_attachments";
    const mimeType = "text/plain";
    const store = (id: string, content: string) => {
      const bytes = Buffer.from(content);
      this.blobs.set(id, { bytes, mimeType });
      return {
        blob_id: id,
        mime_type: this.has("blob-ref-invalid-mime-type") ? "not a media type" : mimeType,
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const ids = {
      blob: "blob_att_1",
      outsideProjection: "blob_att_1_thumbnail",
      outsideWindow: "blob_att_2",
      outOfGrant: "blob_private_1",
    } as const;
    const text = (id: string) => `pdpp-conformance-blob:${id}`;
    if (!this.provisionedStreams.some((s) => s.name === stream)) {
      const fields = ["id", "title", "taken_at", "blob_ref", "thumbnail_ref"];
      const fixtureFor = (name: string, fieldList: string[], records: Record_[]): StreamFixture => ({
        name,
        fields: fieldList,
        fieldTypes: Object.fromEntries(fieldList.map((f) => [f, f.endsWith("_ref") ? "object" : "string"])),
        requiredFields: ["id"],
        primaryKey: ["id"],
        consentTimeField: "taken_at",
        semantics: "append_only",
        records,
      });
      const attachments = fixtureFor(stream, fields, [
        {
          id: "att_1",
          title: "In window",
          taken_at: "2026-03-01T00:00:00Z",
          blob_ref: store(ids.blob, text(ids.blob)),
          thumbnail_ref: store(ids.outsideProjection, text(ids.outsideProjection)),
        },
        {
          id: "att_2",
          title: "Outside window",
          taken_at: "2026-09-01T00:00:00Z",
          blob_ref: store(ids.outsideWindow, text(ids.outsideWindow)),
          thumbnail_ref: store("blob_att_2_thumbnail", text("blob_att_2_thumbnail")),
        },
      ]);
      const priv = fixtureFor(
        "blob_private_attachments",
        ["id", "taken_at", "blob_ref"],
        [{ id: "priv_1", taken_at: "2026-03-01T00:00:00Z", blob_ref: store(ids.outOfGrant, text(ids.outOfGrant)) }]
      );
      for (const fixture of [attachments, priv]) {
        this.provisionedStreams.push(fixture);
        for (const record of fixture.records) {
          this.versionClock += 1;
          this.recordVersions.set(recordKey(fixture.name, record.id), this.versionClock);
          this.changedFields.set(recordKey(fixture.name, record.id), new Set(fixture.fields));
          this.recordHistory(fixture.name, record.id, { ...record }, new Set(fixture.fields));
        }
      }
    }
    const stored = this.blobs.get(ids.blob);
    return {
      stream,
      mimeType,
      bytes: stored?.bytes ?? Buffer.alloc(0),
      ids,
      window: { field: "taken_at", from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    };
  }

  /**
   * Whether a record this token may currently read references `blobId`
   * (Core Section 8 "Get a blob").
   *
   * Evaluated per request against the grant as it stands. For a client token a
   * reference counts only when the grant lists the stream, the record is inside
   * the grant's time window, and the field holding the `blob_ref` is in the
   * grant's field projection; for an owner token, when the stream belongs to
   * the owner's subject.
   */
  private blobReferencedByReadableRecord(
    blobId: string,
    principalKind: Principal["kind"],
    grant: GrantState | undefined,
    subjectScoped: boolean
  ): boolean {
    for (const fixture of [...this.streams, ...this.provisionedStreams]) {
      const granted = grant?.streams.find((g) => g.name === fixture.name);
      if (principalKind === "client" ? granted === undefined : !subjectScoped) {
        continue;
      }
      const projection =
        principalKind === "client" && !this.has("serve-blob-ignoring-projection")
          ? this.grantedFields(granted)
          : fixture.fields;
      const constraint = this.has("serve-blob-ignoring-window") ? undefined : granted?.timeConstraint;
      for (const record of fixture.records) {
        if (constraint && !this.inWindow(record, constraint)) {
          continue;
        }
        if (projection.some((field) => (record[field] as { blob_id?: unknown } | undefined)?.blob_id === blobId)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Whether a record's date-time value for the constraint's field lies in `[from, to)` (Core Section 8 "Comparison"). */
  private inWindow(record: Record_, constraint: { field: string; from?: string; to?: string }): boolean {
    const value = record[constraint.field];
    const instant = typeof value === "string" ? parseDateTime(value) : null;
    if (instant === null) {
      return false;
    }
    const from = constraint.from === undefined ? null : parseDateTime(constraint.from);
    const to = constraint.to === undefined ? null : parseDateTime(constraint.to);
    return !((from && compareDateTimes(instant, from) < 0) || (to && compareDateTimes(instant, to) >= 0));
  }

  /** Answers GET/HEAD /v1/blobs/{blob_id}: a direct response, or 404 `blob_not_found` for every non-readable id. */
  private serveBlob(
    blobId: string,
    readable: boolean,
    method: string,
    res: import("node:http").ServerResponse,
    notFound: () => void
  ): void {
    const blob = this.blobs.get(blobId);
    if (!(blob && (readable || this.has("serve-blob-without-reference-check")))) {
      notFound();
      return;
    }
    this.counter += 1;
    const body = this.has("blob-wrong-bytes") ? Buffer.from("not the stored blob") : blob.bytes;
    res.writeHead(200, {
      "content-type": blob.mimeType,
      "content-length": String(body.length),
      ...(this.has("blob-response-cacheable") ? {} : { "cache-control": "private, no-store" }),
      "pdpp-version": SUPPORTED_VERSION,
      "request-id": `req_${this.counter}`,
    });
    res.end(method === "HEAD" ? undefined : body);
  }

  /** Current field list for a view, or undefined when the AS defines no such view. */
  viewFields(stream: string, view: string): readonly string[] | undefined {
    return this.views.get(viewKey(stream, view));
  }

  /**
   * The field set a client token may see for one granted stream.
   *
   * Conforming behaviour is to return the grant's OWN frozen `fields`, which is
   * what Core Section 5 "View evolution" makes authoritative. Under
   * `widen-existing-grants-on-view-change` the server instead re-resolves the
   * view the grant was issued from, so a view that has since gained a field
   * silently widens an already-approved grant — the violation clause 5.6-2a
   * names. A grant not issued from a view is unaffected either way, which is
   * why the defect cannot disturb any other case.
   */
  private grantedFields(granted: GrantState["streams"][number] | undefined): readonly string[] {
    if (!granted) {
      return [];
    }
    if (this.has("widen-existing-grants-on-view-change") && granted.resolvedFromView !== undefined) {
      return this.views.get(viewKey(granted.name, granted.resolvedFromView)) ?? granted.fields;
    }
    return granted.fields;
  }

  /**
   * Every view this AS currently defines, as the adapter's `declaredViews`
   * record.
   *
   * Rebuilt by walking the fixtures rather than by splitting the map key:
   * clause 5.6-3 makes view URIs opaque identifiers, so a view id may contain
   * any character, and parsing one back out of a composed key is a bug waiting
   * for the first URI-shaped view name.
   */
  allViews(): readonly { readonly stream: string; readonly view: string; readonly fields: readonly string[] }[] {
    return this.streams.flatMap((stream) =>
      (stream.views ?? []).map((view) => ({
        stream: stream.name,
        view: view.id,
        fields: [...(this.views.get(viewKey(stream.name, view.id)) ?? view.fields)],
      }))
    );
  }

  /**
   * Add a field to a view's CURRENT definition. Issued grants are untouched by
   * design — that separation is the whole of clause 5.6-2a.
   */
  widenView(stream: string, view: string, addField: string): readonly string[] | null {
    const key = viewKey(stream, view);
    const fields = this.views.get(key);
    if (!fields) {
      return null;
    }
    if (!fields.includes(addField)) {
      fields.push(addField);
    }
    return [...fields];
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private has(defect: Defect): boolean {
    return this.defects.has(defect);
  }

  /**
   * Resolve a token's principal to the enforcement context, or the denial that
   * Section 8 requires. A client token carries a grant whose lifecycle is
   * checked here; an owner token carries none (Section 8 "Grant enforcement").
   */
  private resolvePrincipal(
    principal: Principal
  ):
    | { grant: GrantState | undefined; subjectId: string }
    | { denial: { code: string; inactive?: true; message: string } } {
    if (principal.kind === "owner") {
      return { grant: undefined, subjectId: principal.subjectId };
    }
    // Only reachable under `honour-unrecognized-token-kind` — the handler
    // refuses this kind before getting here otherwise. This is the fallback
    // branch itself: an unknown kind handled under the rules for `client`,
    // against whatever grant the token is bound to.
    if (principal.kind === "unrecognized") {
      const fallback = this.unrecognizedKindGrants.get(principal.reportedKind);
      const grant = fallback === undefined ? undefined : this.grants.get(fallback);
      return grant
        ? { grant, subjectId: grant.subjectId }
        : { denial: { code: "grant_invalid", message: "Unknown grant." } };
    }
    const grant = this.grants.get(principal.grantId);
    if (!grant) {
      return { denial: { code: "grant_invalid", message: "Unknown grant." } };
    }
    const lagging =
      this.has("lag-revocation-within-ceiling") && grant.revokedAt !== undefined && Date.now() - grant.revokedAt < 3000;
    if (grant.revoked && !lagging && !this.has("ignore-revocation")) {
      return { denial: { code: "grant_revoked", message: "Grant was revoked.", inactive: true } };
    }
    if (grant.expired && !this.has("serve-expired-grant")) {
      return { denial: { code: "grant_expired", message: "Grant has expired.", inactive: true } };
    }
    return { grant, subjectId: grant.subjectId };
  }

  async start(): Promise<void> {
    // Owner tokens for both subjects are minted up front; how an owner obtains
    // one is out of scope for Core (Section 8 "Authentication").
    this.tokens.set("owner-seeded", {
      kind: "owner",
      subjectId: SEEDED_SUBJECT,
    });
    this.tokens.set("owner-foreign", {
      kind: "owner",
      subjectId: FOREIGN_SUBJECT,
    });

    const server = createServer((req, res) => {
      this.handle(req.url ?? "/", req.headers, res, req.method ?? "GET");
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  issueGrant(
    requested: readonly {
      name: string;
      fields: readonly string[];
      instanceIds?: readonly string[];
      timeConstraint?: { field: string; from?: string; to?: string };
      /** The view the fields were resolved from, when the request named one. */
      resolvedFromView?: string;
    }[],
    options: {
      /** Core Section 7 `access_mode`. Defaults to `continuous`. */
      accessMode?: string;
      expired?: boolean;
      purposeCode?: string;
      explicitAiTrainingConsent?: boolean;
      /** Grant schema version to bind (clause 7.4-2). Defaults to the supported one. */
      schemaVersion?: string;
    } = {}
  ): { grantId: string; accessToken: string } | { deniedReason: "ai_training_consent_required" } | null {
    // Reject a grant naming a stream this server does not serve: an AS must
    // validate against the retained declaration (Section 9 AS item 2).
    for (const s of requested) {
      if (!this.findStream(s.name)) {
        return null;
      }
    }
    // Core Section 9 AS item 14: the sole purpose code with a protocol-level
    // consent requirement. The defect models a server that issues the grant
    // anyway, so the oracle can prove it actually checks this rather than
    // passing on every target regardless.
    if (
      options.purposeCode === AI_TRAINING_PURPOSE &&
      !options.explicitAiTrainingConsent &&
      !this.defects.has("bypass-ai-training-consent")
    ) {
      return { deniedReason: "ai_training_consent_required" };
    }
    this.counter += 1;
    const grantId = `grant_${this.counter}`;
    const accessToken = `token_${this.counter}`;
    this.grants.set(grantId, {
      grantId,
      subjectId: SEEDED_SUBJECT,
      streams: requested.map((s) => ({
        name: s.name,
        fields: this.resolveFields(s.name, s.fields),
        ...(s.instanceIds ? { instanceIds: [...s.instanceIds] } : {}),
        ...(s.timeConstraint ? { timeConstraint: s.timeConstraint } : {}),
        ...(s.resolvedFromView === undefined ? {} : { resolvedFromView: s.resolvedFromView }),
      })),
      revoked: false,
      expired: options.expired ?? false,
      schemaVersion: options.schemaVersion ?? GRANT_SCHEMA_VERSION,
      purposeCode: options.purposeCode ?? DEFAULT_PURPOSE,
      source: SEEDED_SOURCE,
      accessMode: options.accessMode ?? "continuous",
    });
    this.tokens.set(accessToken, { kind: "client", grantId });
    return { grantId, accessToken };
  }

  private resolveFields(streamName: string, requested: readonly string[]): string[] {
    const declared = this.findStream(streamName)?.fields ?? [];
    const widen = this.has("resolve-extra-field-into-narrowed-grant") ? declared.at(-1) : undefined;
    return widen !== undefined && requested.length < declared.length && !requested.includes(widen)
      ? [...requested, widen]
      : [...requested];
  }

  /**
   * A genuine token bound to `grantId` whose introspection result reports
   * `kind` (clause 8.2-3).
   *
   * The token is real and authenticates normally; the ONLY thing distinguishing
   * it from an ordinary client token is what this server's introspection
   * equivalent says its kind is. That is what makes a refusal attributable to
   * the kind rather than to the credential.
   */
  mintTokenWithKind(kind: string, grantId: string): string | null {
    if (!this.grants.has(grantId)) {
      return null;
    }
    this.counter += 1;
    const accessToken = `token_kind_${this.counter}`;
    this.tokens.set(accessToken, { kind: "unrecognized", reportedKind: kind });
    this.unrecognizedKindGrants.set(kind, grantId);
    return accessToken;
  }

  /**
   * The RFC 9396 `authorization_details` entry for a grant, as granted.
   *
   * One shape, used by BOTH the token response and the co-located introspection
   * equivalent, so the two cannot drift: the case that compares them is only
   * meaningful if a server could have got them out of step, and a server that
   * derives both from the same resolved grant is the conforming one.
   */
  private grantedAuthorizationDetails(grantId: string): Record<string, unknown> | null {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return null;
    }
    return {
      type: "https://pdpp.dev/data-access",
      source: { ...grant.source },
      purpose_code: grant.purposeCode,
      access_mode: this.has("invalid-access-mode-in-authorization-details") ? "unlimited" : grant.accessMode,
      streams: grant.streams.map((stream) => ({
        name: stream.name,
        // Section 7's StreamGrant table: non-empty and unique. This server
        // serves one instance, so the resolved list is that one -- stated
        // rather than left implicit, because an RS enforces from this and
        // cannot infer an instance the AS never named.
        instance_ids: stream.instanceIds ? [...stream.instanceIds] : [SEEDED_INSTANCE],
        fields: [...this.grantedFields(stream)],
        ...(stream.timeConstraint
          ? {
              time_constraint: {
                field: stream.timeConstraint.field,
                ...(stream.timeConstraint.from === undefined
                  ? {}
                  : { since: this.issuedBound(stream.timeConstraint.from) }),
                ...(stream.timeConstraint.to === undefined
                  ? {}
                  : { until: this.issuedBound(stream.timeConstraint.to) }),
              },
            }
          : {}),
      })),
    };
  }

  /**
   * A frozen `time_constraint` bound as the grant reports it (clause 6.8-11):
   * verbatim. `normalize-time-constraint-bounds` converts a `date-time` to a UTC
   * instant at millisecond precision, which is the conversion and rounding the
   * clause forbids.
   */
  private issuedBound(bound: string): string {
    const instant = this.has("normalize-time-constraint-bounds") ? Date.parse(bound) : Number.NaN;
    return Number.isNaN(instant) ? bound : new Date(instant).toISOString();
  }

  /** The access token bound to a grant, for the token endpoint to re-serve. */
  private tokenForGrant(grantId: string): string | null {
    if (!this.grants.has(grantId)) {
      return null;
    }
    for (const [credential, principal] of this.tokens) {
      if (principal.kind === "client" && principal.grantId === grantId) {
        return credential;
      }
    }
    return null;
  }

  /**
   * The co-located introspection equivalent Core Section 8 permits, as a
   * PdppResponse the adapter can hand straight to a case.
   *
   * Answers from the SAME `grantedAuthorizationDetails` the token endpoint
   * uses, because it is the same grant. That is what makes the RFC 9396
   * Section 7 comparison meaningful rather than circular: the two surfaces
   * agreeing is the conforming behaviour, and the defect makes exactly one of
   * them stop reporting.
   */
  introspect(accessToken: string): import("../harness/http.ts").PdppResponse | null {
    const principal = this.tokens.get(accessToken);
    if (principal?.kind !== "client") {
      return null;
    }
    const grant = this.grants.get(principal.grantId);
    // Revocation and expiry are reported here, not just enforced at the query
    // surface: Section 9 AS item 8 requires revocation to be reflected in
    // introspection, and a stub that always answered `active: true` would make
    // the AS-8 oracle pass against a server that never propagates it.
    const active = grant !== undefined && !(grant.revoked || grant.expired) && !this.endedTokens.has(accessToken);
    const detail = this.grantedAuthorizationDetails(principal.grantId);
    const body = active
      ? {
          active: true,
          pdpp_token_kind: "client",
          grant_id: principal.grantId,
          // Core Section 8 requires the client-token context to name both the
          // subject whose data is reachable and the client it was issued to.
          subject_id: grant?.subjectId ?? SEEDED_SUBJECT,
          client_id: CLIENT_ID,
          // Clause 8.12-5: every positive introspection response for an
          // expiring token carries `exp`. Tokens here are issued with an
          // `expires_in`, so they are expiring tokens.
          ...(this.has("omit-introspection-exp") ? {} : { exp: this.tokenIssuedAtSeconds + TOKEN_LIFETIME_SECONDS }),
          ...(detail ? { authorization_details: [detail] } : {}),
        }
      : { active: false };
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: body,
      text: JSON.stringify(body),
      evidence: {
        request: { method: "POST", url: `${this.baseUrl}/introspect`, headers: {} },
        response: { status: 200, headers: {}, body: JSON.stringify(body) },
      },
    };
  }

  /** URL of this server's RFC 7009 revocation endpoint (the token travels as a query parameter here). */
  get revocationEndpoint(): string {
    return `${this.baseUrl}/oauth/revoke`;
  }

  /** Base URL of this server's token endpoint, for the adapter to call. */
  get tokenEndpoint(): string {
    return `${this.baseUrl}/oauth/token`;
  }

  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.revoked = true;
      grant.revokedAt = Date.now();
    }
  }

  /**
   * Refresh-token families (AS-20): every refresh token ever minted maps to its
   * family, and the family remembers which token is current and which have
   * been superseded. A superseded token presented again is the reuse signal.
   */
  /** Access tokens a client ended through the revocation endpoint while their grant stayed active (clause 10.7-5). */
  private readonly endedTokens = new Set<string>();

  private readonly refreshFamilyOf = new Map<
    string,
    { readonly grantId: string; current: string; readonly superseded: Set<string> }
  >();

  /** Mint the first refresh token of a new family bound to `grantId`. */
  issueRefreshToken(grantId: string): string | null {
    if (!this.grants.has(grantId)) {
      return null;
    }
    this.counter += 1;
    const refreshToken = `refresh_${this.counter}`;
    this.refreshFamilyOf.set(refreshToken, { grantId, current: refreshToken, superseded: new Set() });
    return refreshToken;
  }

  /**
   * Redeem a refresh token. Rotation supersedes the presented token; reuse of a
   * superseded one is refused AND revokes the family's grant, which kills every
   * access token linked to it, including the successor already handed out.
   */
  redeemRefreshToken(refreshToken: string): { accessToken: string; refreshToken: string } | null {
    const family = this.refreshFamilyOf.get(refreshToken);
    if (!family) {
      return null;
    }
    if (family.superseded.has(refreshToken)) {
      if (!this.has("accept-superseded-refresh-token")) {
        if (!this.has("refresh-reuse-keeps-family-alive")) {
          this.revokeGrant(family.grantId);
        }
        return null;
      }
    } else if (family.current !== refreshToken) {
      return null;
    }
    this.counter += 1;
    const successor = this.has("refresh-without-rotation") ? refreshToken : `refresh_${this.counter}`;
    if (successor !== refreshToken) {
      family.superseded.add(refreshToken);
      family.current = successor;
      this.refreshFamilyOf.set(successor, family);
    }
    const accessToken = `token_${this.counter}`;
    this.tokens.set(accessToken, { kind: "client", grantId: family.grantId });
    return { accessToken, refreshToken: successor };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the HTTP router, and its branches ARE the Section 8 request pipeline in the order the spec applies them — metadata, authentication, token kind, version, grant lifecycle, subject scope, route, parameters, then projection. Splitting it to move the number would relocate that order into call sites without simplifying it, and the ordering is load-bearing: several cases (RS-6 vs RS-11, 8.2-3 vs 8.9-x) exist precisely to check that an earlier gate fires before a later one. A behaviour-preserving decomposition is worth doing, but it is a refactor with its own verification, not part of a lint commit that must change nothing.
  private handle(
    url: string,
    headers: NodeJS.Dict<string | string[]>,
    res: import("node:http").ServerResponse,
    method: string
  ): void {
    const parsed = new URL(url, "http://127.0.0.1");
    const path = parsed.pathname;

    const send = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
      this.counter += 1;
      res.writeHead(status, {
        "content-type": "application/json",
        ...(this.has("omit-pdpp-version-response-header") ? {} : { "pdpp-version": SUPPORTED_VERSION }),
        "request-id": `req_${this.counter}`,
        ...extraHeaders,
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    const error = (
      status: number,
      code: string,
      type: string,
      message: string,
      extraHeaders: Record<string, string> = {}
    ) => {
      send(status, { error: { type, code, message } }, extraHeaders);
    };

    // --- RFC 9728 protected resource metadata (RS-16) ---
    if (path === "/.well-known/oauth-protected-resource") {
      send(200, this.protectedResourceMetadata());
      return;
    }

    // --- RFC 8414 authorization server metadata (clause 6.2-2) ---
    if (path === "/.well-known/oauth-authorization-server") {
      send(200, this.authorizationServerMetadata());
      return;
    }

    // --- RFC 7009 revocation endpoint (clauses 10.7-4, 10.7-8) ---
    //
    // A client revoking an access token ends that token: the grant it is bound
    // to is ended, because no refresh-token family covers it here (clause
    // 10.7-5). Always answers 200, as RFC 7009 requires, whatever it did.
    if (path === "/oauth/revoke" && method === "POST") {
      const credential = parsed.searchParams.get("token") ?? "";
      const family = this.refreshFamilyOf.get(credential);
      const presented = this.tokens.get(credential);
      if (family) {
        // Clause 10.7-3: revoking a refresh token, current or superseded, ends
        // every grant its family covers and every access token under them.
        if (!this.has("revocation-endpoint-ignores-refresh-tokens")) {
          this.revokeGrant(family.grantId);
        }
      } else if (presented?.kind === "client" && !this.has("revocation-endpoint-ignores-access-tokens")) {
        // Clause 10.7-4 ends the token. Clause 10.7-5 ends its grant too, but
        // only when no refresh-token family covers the grant.
        const covered = [...this.refreshFamilyOf.values()].some((f) => f.grantId === presented.grantId);
        this.endedTokens.add(credential);
        if (!covered || this.has("revoke-family-grant-on-access-token-revocation")) {
          this.revokeGrant(presented.grantId);
        }
      }
      send(200, {});
      return;
    }

    // --- OAuth token endpoint (clause 10.2-4) ---
    //
    // Before the bearer check, because a token endpoint is where a caller goes
    // to GET a credential and cannot be asked to present one. The grant is
    // already issued by the time this is called; this route exists so the
    // headers of a real, successful, token-bearing HTTP response are observable
    // over the wire rather than asserted about an in-process return value.
    if (path === "/oauth/token") {
      const grantId = parsed.searchParams.get("grant_id") ?? "";
      const issuedToken = this.tokenForGrant(grantId);
      if (!issuedToken) {
        error(400, "invalid_grant", "invalid_request_error", "Unknown grant.");
        return;
      }
      // RFC 6749 Section 5.1 and clause 10.2-4. Omitted under the defect, and
      // ONLY under the defect: nothing else about the response changes, so a
      // case asserting on the token or the status cannot detect it.
      const cacheHeaders = this.has("token-response-without-no-store")
        ? {}
        : { "cache-control": "no-store", pragma: "no-cache" };
      // RFC 9396 Section 7: a token response for a request that carried
      // `authorization_details` MUST itself carry the authorization_details AS
      // GRANTED. Core adopts the RFC 9396 envelope by normative reference and
      // describes the introspection response, but never restates this — so a
      // server can satisfy every Core clause and still leave a client unable to
      // learn what it was actually granted without a separate introspection
      // call it may not be authorized to make.
      //
      // Built from the grant's OWN resolved state, never echoed from the
      // request, so it reports what was granted rather than what was asked for.
      const detail = this.grantedAuthorizationDetails(grantId);
      send(
        200,
        {
          access_token: issuedToken,
          token_type: "Bearer",
          ...(this.has("single-use-token-without-expiry") && this.grants.get(grantId)?.accessMode === "single_use"
            ? {}
            : { expires_in: TOKEN_LIFETIME_SECONDS }),
          ...(detail && !this.has("omit-token-response-authorization-details")
            ? { authorization_details: [detail] }
            : {}),
        },
        cacheHeaders
      );
      return;
    }

    // --- Authentication (RS-4, RS-16) ---
    const principal =
      this.resolveToken(headers.authorization) ??
      (this.has("serve-without-authentication") && headers.authorization === undefined
        ? ({ kind: "owner", subjectId: SEEDED_SUBJECT } as const)
        : undefined);
    if (!principal) {
      error(401, "authentication_error", "authentication_error", "Missing or invalid access token.", {
        "www-authenticate": this.bearerChallenge(),
      });
      return;
    }

    // --- Unrecognized token kind (clause 8.2-3) ---
    //
    // Checked immediately after authentication and before ANY Core operation,
    // because the clause says "unauthorized for all operations defined in this
    // specification" — not for record reads specifically. A server that gated
    // only its records route would still serve stream listings and metadata to
    // a token it admits it does not understand.
    //
    // 403, not 401: the credential is valid and the server knows exactly who
    // presented it. What it does not know is what this kind of token is
    // permitted to do, and Core's answer is nothing.
    if (principal.kind === "unrecognized" && !this.has("honour-unrecognized-token-kind")) {
      error(
        403,
        "access_denied",
        "permission_error",
        `Token kind '${principal.reportedKind}' is not recognized by this resource server.`
      );
      return;
    }

    // --- PDPP-Version negotiation (RS-11) ---
    const requestedVersion = headers["pdpp-version"];
    if (
      typeof requestedVersion === "string" &&
      requestedVersion !== SUPPORTED_VERSION &&
      !this.has("ignore-pdpp-version-header")
    ) {
      error(400, "unsupported_version", "invalid_request_error", `PDPP-Version ${requestedVersion} is not supported.`);
      return;
    }

    // Resolve the client authorization context, mirroring what a separated RS
    // would read from an RFC 7662 introspection response.
    const resolved = this.resolvePrincipal(principal);
    if ("denial" in resolved) {
      // Section 8 "Inactive tokens": a token whose grant is revoked or expired
      // is inactive, and every inactive access token is 401 behind a Bearer
      // `invalid_token` challenge. `grant_invalid` is a different condition (a
      // grant the server cannot serve) and stays 403.
      if (resolved.denial.inactive && !this.has("inactive-grant-as-403")) {
        error(401, resolved.denial.code, "authentication_error", resolved.denial.message, {
          "www-authenticate": this.bearerChallenge(),
        });
        return;
      }
      error(403, resolved.denial.code, "permission_error", resolved.denial.message);
      return;
    }
    const { grant, subjectId } = resolved;

    // --- Grant schema version (clause 7.4-2) ---
    //
    // Separate from the lifecycle denials above, and deliberately NOT routed
    // through them: those are 403 `permission_error` (the grant is real but no
    // longer confers access), while Core names 400 `unsupported_version` here
    // (the server cannot validate what the grant SAYS). Folding this into the
    // 403 path would report a comprehension failure as an authorization
    // decision, and a client would retry forever against a grant that can never
    // work.
    //
    // Checked on the grant's own `version`, never on the PDPP-Version header
    // handled above — Core Section 7 forbids conflating the two axes.
    if (
      grant &&
      grantMajor(grant.schemaVersion) !== SUPPORTED_GRANT_MAJOR &&
      !this.has("accept-unsupported-grant-schema-version")
    ) {
      error(
        400,
        "unsupported_version",
        "invalid_request_error",
        `Grant schema version ${grant.schemaVersion} has an unsupported major version.`
      );
      return;
    }

    // An owner token reaches only its own subject's store (RS-12). The seeded
    // fixtures belong to SEEDED_SUBJECT, so a foreign owner sees an empty store.
    const subjectScoped = subjectId === SEEDED_SUBJECT;

    // --- GET /v1/blobs/{blob_id} (RS-1, clauses 8.12-1 .. 8.12-3) ---
    const blobMatch = BLOB_PATH.exec(path);
    if (blobMatch && (method === "GET" || method === "HEAD")) {
      const blobId = decodeURIComponent(blobMatch[1] ?? "");
      this.serveBlob(
        blobId,
        this.blobReferencedByReadableRecord(blobId, principal.kind, grant, subjectScoped),
        method,
        res,
        () => error(404, "blob_not_found", "not_found_error", "Blob not found.")
      );
      return;
    }

    // --- GET /v1/streams (RS-1) ---
    if (path === "/v1/streams") {
      const visible = this.streams.filter((s) => {
        if (principal.kind === "owner") {
          return subjectScoped;
        }
        return grant?.streams.some((g) => g.name === s.name) ?? false;
      });
      const streamList = visible.map((s) => ({
        object: "stream",
        name: s.name,
        record_count: s.records.length,
      }));
      send(200, this.has("list-streams-without-envelope") ? streamList : { object: "list", data: streamList });
      return;
    }

    const recordsMatch = RECORDS_PATH.exec(path);
    const singleMatch = SINGLE_RECORD_PATH.exec(path);
    const metadataMatch = METADATA_PATH.exec(path);
    const streamName = decodeURIComponent(recordsMatch?.[1] ?? singleMatch?.[1] ?? metadataMatch?.[1] ?? "");
    const fixture = this.findStream(streamName);

    if (!fixture) {
      error(404, "not_found", "not_found_error", "Stream not found.");
      return;
    }

    // Stream access: grant membership for a client, subject scope for an owner.
    const grantedStream = grant?.streams.find((g) => g.name === streamName);
    const denial = this.denyStreamAccess(principal.kind, streamName, grantedStream !== undefined, subjectScoped);
    if (denial) {
      // The misclassification defect still refuses the request — enforcement is
      // intact — but reports it outside the Section 8 error table, which is
      // exactly the shape RS-6 exists to catch.
      if (this.has("misclassify-stream-denial")) {
        error(401, "context.stream_not_allowed", "authentication_error", denial);
        return;
      }
      error(403, "grant_stream_not_allowed", "permission_error", denial);
      return;
    }

    // --- GET /v1/streams/{stream} (RS-14, RS-15) ---
    if (metadataMatch && !singleMatch) {
      send(200, this.streamMetadata(fixture, principal.kind, grantedStream?.fields ?? []));
      return;
    }

    // --- DELETE /v1/streams/{stream}/records/{id} (RS-7 tombstones) ---
    //
    // Deletion is an OWNER operation: a client token carries a read grant, and
    // nothing in Core gives a grant the authority to destroy the owner's data.
    if (singleMatch && method === "DELETE") {
      if (principal.kind !== "owner") {
        error(403, "access_denied", "permission_error", "Deletion requires an owner token.");
        return;
      }
      const recordId = decodeURIComponent(singleMatch[2] ?? "");
      if (this.deleteRecord(fixture.name, recordId)) {
        send(204, undefined);
        return;
      }
      error(404, "not_found", "not_found_error", "Record not found or stream is not mutable_state.");
      return;
    }

    // --- GET /v1/streams/{stream}/records/{id} (RS-1) ---
    if (singleMatch) {
      const recordId = decodeURIComponent(singleMatch[2] ?? "");
      const record = fixture.records.find((r) => r.id === recordId);
      if (!record) {
        if (this.has("serve-unknown-record-id")) {
          send(200, { object: "record", id: recordId, stream: fixture.name, data: {} });
          return;
        }
        error(404, "not_found", "not_found_error", "Record not found.");
        return;
      }
      const projection =
        principal.kind === "client" && !this.has("ignore-field-projection")
          ? this.grantedFields(grantedStream)
          : fixture.fields;
      send(200, {
        object: "record",
        id: record.id,
        stream: fixture.name,
        data: Object.fromEntries(Object.entries(record).filter(([key]) => projection.includes(key))),
      });
      return;
    }

    // --- GET /v1/streams/{stream}/records (RS-2, RS-5, RS-9, RS-10) ---
    if (recordsMatch) {
      if (
        principal.kind === "client" &&
        this.has("refuse-bare-granted-read") &&
        [...parsed.searchParams].length === 0
      ) {
        error(403, "grant_stream_not_allowed", "permission_error", "Granted stream refused.");
        return;
      }
      if (principal.kind === "owner" && this.has("deny-owner-records")) {
        error(403, "access_denied", "authorization_error", "Owner reads denied by fixture.");
        return;
      }
      const rejection = this.rejectUnsupportedParams(parsed.searchParams, principal.kind, fixture);
      if (rejection) {
        error(400, rejection.code, "invalid_request_error", rejection.message);
        return;
      }

      // Clause 8.9-7: a `limit` that is not a plain integer is an unsupported
      // query shape. Coercing it (`abc` -> default, `1.5` -> 1, `1junk` -> 1)
      // answers a question the client did not ask.
      const rawLimit = parsed.searchParams.get("limit");
      if (rawLimit !== null && !this.has("coerce-invalid-limit") && !LIMIT_PATTERN.test(rawLimit)) {
        error(400, "invalid_request", "invalid_request_error", `limit '${rawLimit}' is not an integer.`);
        return;
      }

      // A malformed cursor must be a 400, not a crash: the defect models a server
      // that lets a decode error escape as a 500.
      const rawCursor = parsed.searchParams.get("cursor");
      if (
        !this.has("ignore-unknown-params") &&
        rawCursor !== null &&
        rawCursor !== "" &&
        !rawCursor.startsWith("ok:")
      ) {
        if (this.has("crash-on-bad-cursor")) {
          error(500, "api_error", "api_error", "Internal server error.");
          return;
        }
        error(400, "invalid_cursor", "invalid_request_error", "Cursor token is malformed or unrecognized.");
        return;
      }

      // Section 8 makes page cursors and sync cursors distinct token spaces: a
      // page cursor offered in the changes_since slot is refused rather than
      // treated as an absent parameter and answered with a full page.
      const rawSyncCursor = parsed.searchParams.get("changes_since");
      const pageCursorAsSync = rawSyncCursor?.startsWith("ok:") === true;
      // Under `accept-page-cursor-as-changes-since` the page cursor is treated
      // as an absent parameter, so a full page is served in its place.
      const syncCursor = pageCursorAsSync && this.has("accept-page-cursor-as-changes-since") ? null : rawSyncCursor;
      if (pageCursorAsSync && syncCursor !== null) {
        error(
          400,
          "invalid_cursor",
          "invalid_request_error",
          "A page cursor is not a changes_since token; the two are distinct token spaces."
        );
        return;
      }
      // A changes_since token this server did not mint is malformed, not a
      // reason to fall back to a full read — falling back would silently return
      // the whole stream to a client that asked for a delta.
      const parsedSyncToken = syncCursor === null ? null : parseSyncToken(syncCursor);
      let syncHorizon = parsedSyncToken === null ? null : parsedSyncToken.version;
      if (syncCursor !== null && parsedSyncToken === null) {
        error(400, "invalid_cursor", "invalid_request_error", "changes_since token is malformed or unrecognized.");
        return;
      }
      // Clause 4.3-2: a cursor past this server's retention horizon is 410
      // `cursor_expired`, which is the only answer that tells the client to
      // discard its baseline and full re-sync. Checked after the malformed
      // branch above, because an unparseable token is a different condition
      // with a different remedy. A well-formed token that is merely too old is
      // NOT a client error, and reporting it as one invites a retry that can
      // never succeed.
      if (syncCursor !== null && this.expiredSyncTokens.has(syncCursor)) {
        if (this.has("misclassify-expired-sync-cursor")) {
          error(400, "invalid_cursor", "invalid_request_error", "changes_since token is malformed or unrecognized.");
          return;
        }
        error(410, "cursor_expired", "gone_error", "changes_since cursor is too old; full re-sync required.");
        return;
      }

      // Section 8: a token is bound to the grant (owner: subject and scope) and
      // to the stream it was issued for, and the RS MUST reject it under
      // another as `invalid_cursor`. `fields` is deliberately not part of the
      // binding for a sync token: Core's rule for a token names the query
      // context without listing it, and the tombstone cases read one token
      // under several `fields` selections.
      const scopeKey = principal.kind === "client" ? `grant:${grant?.grantId}` : `owner:${subjectId}`;
      const syncContext = contextDigest(["sync", scopeKey, fixture.name]);
      if (
        parsedSyncToken?.context !== undefined &&
        parsedSyncToken.context !== syncContext &&
        !this.has("accept-sync-token-under-other-context")
      ) {
        error(
          400,
          "invalid_cursor",
          "invalid_request_error",
          "changes_since token was issued under another grant, scope or stream."
        );
        return;
      }

      // Section 8 "Stable sort": page cursors are direction-bound. This server
      // mints `ok:<order>:<offset>`, so the direction a cursor was produced
      // under travels with it and a mismatch is detectable — which is what
      // makes the requirement observable at all. Under
      // `accept-order-mismatched-cursor` the comparison is skipped and the page
      // is served against the wrong direction.
      const requestedOrder = parsed.searchParams.get("order") ?? "desc";
      let cursorOffset = 0;
      /** Session horizon carried by a sync-session page cursor (clause 8.9-14). */
      let cursorHorizon: number | null = null;
      // Clause 8.9-11: a page cursor is bound to the whole query context that
      // produced it -- grant or owner scope, stream, `fields`, `order`, and any
      // `filter[...]` / `expand` parameter -- and is rejected under another as
      // `invalid_cursor`. `order` keeps its own, more specific refusal below.
      const contextParams = [...parsed.searchParams.entries()]
        .filter(([key]) => key === "fields" || key.startsWith("filter[") || key.startsWith("expand"))
        .map(
          ([key, value]) => `${key}=${key === "fields" ? [...(parseFieldsParam(value) ?? [])].sort().join(",") : value}`
        )
        .sort((a, b) => a.localeCompare(b));
      const pageContext = contextDigest(["page", scopeKey, fixture.name, ...contextParams]);
      if (rawCursor?.startsWith("ok:")) {
        const [, cursorOrder, offsetText, horizonText, fromText, cursorContext] = rawCursor.split(":");
        if (cursorContext !== pageContext && !this.has("accept-cursor-under-other-context")) {
          error(
            400,
            "invalid_cursor",
            "invalid_request_error",
            "Cursor was issued under another grant, scope or query context."
          );
          return;
        }
        if (
          cursorOrder !== undefined &&
          cursorOrder !== requestedOrder &&
          !this.has("accept-order-mismatched-cursor")
        ) {
          error(
            400,
            "invalid_cursor",
            "invalid_request_error",
            `Cursor was issued for order=${cursorOrder} and cannot be followed with order=${requestedOrder}.`
          );
          return;
        }
        const parsedOffset = Number(offsetText);
        cursorOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
        // The fourth component, present only within a sync session, is the
        // horizon that session was anchored to on its first page (clause
        // 8.9-14). Carrying it in the cursor is what makes the anchoring
        // survive across pages without the server holding session state.
        //
        // Under `re-anchor-sync-session-per-page` it is discarded, so each page
        // re-reads the clock and writes that arrived mid-session leak into
        // later pages of the session that should not contain them.
        const parsedHorizon = Number(horizonText);
        if (horizonText !== undefined && Number.isInteger(parsedHorizon)) {
          cursorHorizon = this.has("re-anchor-sync-session-per-page") ? null : parsedHorizon;
        }
        // The fifth component is the session's lower bound (the `changes_since`
        // token that opened it). Core says to pass `changes_since` on the first
        // request and follow `next_cursor` on later pages, so a cursor alone
        // must be enough to continue the session; an explicit `changes_since`
        // on a later page still wins.
        const parsedFrom = Number(fromText);
        if (syncHorizon === null && fromText !== undefined && Number.isInteger(parsedFrom)) {
          syncHorizon = parsedFrom;
        }
      }

      const projection =
        principal.kind === "client" && !this.has("ignore-field-projection")
          ? this.grantedFields(grantedStream)
          : fixture.fields;

      // Enforce the grant's frozen time constraint (Section 8 "Grant
      // enforcement"): records outside the consented window are not the client's
      // to see, whatever the request asked for.
      const constraint = this.has("ignore-time-constraint") ? undefined : grantedStream?.timeConstraint;
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the window and sync-visibility rules are one ordered pass; each branch carries its own defect switch.
      const withinWindow = (record: Record_): boolean => {
        if (!constraint) {
          return true;
        }
        const value = record[constraint.field];
        if (typeof value !== "string") {
          return false;
        }
        // Section 8 "Comparison": date-time values are compared as instants at
        // their full stated precision, never as text -- text order is wrong when
        // offsets differ. A value that is not a valid RFC 3339 value fails the
        // filter. `compare-time-bounds-as-text` restores the text comparison.
        if (this.has("compare-time-bounds-as-text")) {
          if (constraint.from && value < constraint.from) {
            return false;
          }
          return !(constraint.to && value >= constraint.to);
        }
        const instant = parseDateTime(value);
        if (instant === null) {
          const day = parseFullDate(value);
          if (day === null) {
            return false;
          }
          return !((constraint.from && day < constraint.from) || (constraint.to && day >= constraint.to));
        }
        const [from, to] = [
          constraint.from && parseDateTime(constraint.from),
          constraint.to && parseDateTime(constraint.to),
        ];
        if (from && compareDateTimes(instant, from) < 0) {
          return false;
        }
        return !(to && compareDateTimes(instant, to) >= 0);
      };

      // --- Incremental sync session (Section 8, clauses 8.9-13/14/15) ---
      //
      // The session HORIZON is chosen on the first page and then travels in the
      // page cursor, because clause 8.9-14 requires every page of one session to
      // be anchored to it: "New writes arriving after page 1 MUST NOT appear in
      // later pages of that same session; they surface in the next session via
      // the terminal-page `next_changes_since`." A server that re-read the
      // clock on each page would leak later writes into an earlier session and
      // hand back a cursor that skips them — the client then never sees those
      // records at all, and nothing reports the gap.
      const isSync = syncHorizon !== null;
      const sessionHorizon = cursorHorizon ?? this.versionClock;

      // Sparse fieldset (Section 8 `fields`): the request narrows what the
      // caller may already see, never widens it. Schema-required fields are
      // always included for an owner read; a client read stays inside the
      // grant's own projection. Eligibility above keeps using `projection`.
      const requestedFields = parseFieldsParam(parsed.searchParams.get("fields"));
      const required = fixture.requiredFields ?? [];
      const dataFields =
        requestedFields === undefined
          ? projection
          : projection.filter(
              (field) =>
                requestedFields.has(field) ||
                (principal.kind === "owner" &&
                  required.includes(field) &&
                  !this.has("drop-required-fields-on-sparse-read"))
            );

      // Instances the grant lists for this stream. A multi-instance fixture
      // serves the union of them as one collection (Core Section 7/8).
      const instanceIds = fixture.multiInstance ? (grantedStream?.instanceIds ?? undefined) : undefined;
      const inGrantInstances = (record: Record_): boolean =>
        instanceIds === undefined || instanceIds.includes(String(record._instance));
      const sortKeyOf = (record: Record_) => {
        const value = fixture.cursorField === undefined ? undefined : record[fixture.cursorField];
        return typeof value === "string" ? value : null;
      };
      // Section 8 stable sort: `(cursor_field, primary_key)`, absent cursor
      // values after every present one; `order=desc` reverses both keys.
      const sortRecords = (records: readonly Record_[]): Record_[] => {
        const direction = requestedOrder === "asc" ? 1 : -1;
        return [...records].sort((a, b) => {
          const ca = sortKeyOf(a);
          const cb = sortKeyOf(b);
          if (ca === null || cb === null) {
            if (ca === cb) {
              return direction * a.id.localeCompare(b.id);
            }
            return ca === null ? 1 : -1;
          }
          return direction * (ca.localeCompare(cb) || a.id.localeCompare(b.id));
        });
      };

      const toEnvelope = (record: Record_) => ({
        object: "record",
        id: this.canonicalKey(fixture, record),
        stream: fixture.name,
        data: Object.fromEntries(Object.entries(record).filter(([key]) => dataFields.includes(key))),
      });

      // Core Section 4 "Visibility": a session compares the two horizons only.
      // A record is visible at a horizon if its version AT that horizon exists
      // and passes the grant's instances and time window. Not visible -> visible
      // returns the record; visible -> visible returns it only if its
      // grant-authorized projection changed (clause 8.9-13); visible -> not
      // visible (deleted, or moved out of the window) is one tombstone; and a
      // record never visible produces nothing (clause 4.3-11).
      const streamKeys = [...this.history.keys()].filter((key) => key.startsWith(`${fixture.name}\n`));
      const entryAt = (key: string, horizon: number): HistoryEntry | undefined => {
        let found: HistoryEntry | undefined;
        for (const entry of this.history.get(key) ?? []) {
          if (entry.version > horizon) {
            break;
          }
          found = entry;
        }
        return found;
      };
      const visibleIn = (entry: HistoryEntry | undefined): boolean =>
        entry?.snapshot !== undefined &&
        entry.snapshot !== null &&
        inGrantInstances(entry.snapshot as Record_) &&
        withinWindow(entry.snapshot as Record_);
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the window and sync-visibility rules are one ordered pass; each branch carries its own defect switch.
      const syncDelta = (h0: number, h1: number) => {
        const records: Record_[] = [];
        const tombstones: Record<string, unknown>[] = [];
        let visibleHorizon = 0;
        for (const key of streamKeys) {
          const entries = this.history.get(key) ?? [];
          const [at0, at1] = [entryAt(key, h0), entryAt(key, h1)];
          const [v0, v1] = [visibleIn(at0), visibleIn(at1)];
          const inRange = entries.filter((entry) => entry.version > h0 && entry.version <= h1);
          const changesProjection = inRange.some(
            (entry) =>
              this.has("ignore-projection-for-sync-eligibility") ||
              [...entry.changed].some((f) => projection.includes(f))
          );
          // Clause 8.9-18: a record deleted AFTER page 1 (past the session
          // horizon) is not served on a later page, even though it was visible
          // at the horizon.
          const last = entries.at(-1);
          const deletedAfterHorizon = last?.snapshot === null && last.version > h1;
          if (
            v1 &&
            (!v0 || changesProjection) &&
            (!deletedAfterHorizon || this.has("serve-deleted-record-from-session-snapshot"))
          ) {
            records.push(at1?.snapshot as Record_);
          }
          const leftWindow = v0 && !v1;
          const stillExists = at1?.snapshot !== null;
          const skippedMove = this.has("omit-tombstone-on-leaving-window") && stillExists;
          const neverVisibleDeletion =
            this.has("tombstone-for-never-visible-record") && at1?.snapshot === null && inRange.length > 0;
          if (!this.has("omit-tombstones") && ((leftWindow && !skippedMove) || neverVisibleDeletion)) {
            const at = inRange.at(-1)?.at ?? new Date().toISOString();
            const id = key.slice(fixture.name.length + 1);
            tombstones.push({
              object: "record",
              id,
              stream: fixture.name,
              deleted: true,
              deleted_at: at,
              emitted_at: at,
            });
          }
          // The token names the last event this context could SEE (clause
          // 4.3-9), not the global clock: a write confined to fields the grant
          // does not carry must not move it.
          let previouslyVisible = false;
          for (const entry of entries) {
            if (entry.version > h1) {
              break;
            }
            const nowVisible = visibleIn(entry);
            if (
              nowVisible !== previouslyVisible ||
              (nowVisible && [...entry.changed].some((f) => projection.includes(f)))
            ) {
              visibleHorizon = Math.max(visibleHorizon, entry.version);
            }
            previouslyVisible = nowVisible;
          }
        }
        return { records, tombstones, visibleHorizon };
      };
      const sync = syncHorizon === null ? undefined : syncDelta(syncHorizon, sessionHorizon);
      const eligible = sync ? sync.records : fixture.records.filter(inGrantInstances).filter(withinWindow);
      // Clause 4.3-6: a changes_since feed on a grant that lists several
      // instances is still a changes_since feed (Section 9 RS item 7).
      if (isSync && (instanceIds?.length ?? 0) > 1 && this.has("reject-multi-instance-changes-since")) {
        error(400, "invalid_request", "invalid_request_error", "changes_since is not supported across instances.");
        return;
      }

      // Per-instance partitions, used only by the defects that mishandle
      // fan-in; the conforming path pages one merged, sorted collection.
      const partitions =
        instanceIds !== undefined && instanceIds.length > 1
          ? instanceIds.map((instance) => sortRecords(eligible.filter((r) => r._instance === instance)))
          : undefined;

      let orderedRecords: Record_[] = eligible;
      if (fixture.multiInstance) {
        orderedRecords =
          partitions !== undefined && this.has("concatenate-instances-unsorted")
            ? partitions.flat()
            : sortRecords(eligible);
      }
      const live = orderedRecords.map(toEnvelope);

      // Tombstones for deletions inside this session's window (Core Section 4).
      // Only within a sync session: an ordinary read reports what exists, and a
      // deleted record simply does not. It is the DELTA that has to say a
      // record went away, because a client holding that record cannot otherwise
      // tell deletion from "no longer matches".
      //
      // A tombstone is a fixed envelope with no `data`; `fields=` narrows
      // `data` and nothing else, so it never reaches this object. Under
      // `project-tombstones-through-fields` it does, which empties the
      // envelope for `fields=name` and strips everything but `id` for
      // `fields=id`.
      const deletions = (sync?.tombstones ?? []).map((envelope) =>
        requestedFields !== undefined && this.has("project-tombstones-through-fields")
          ? Object.fromEntries(Object.entries(envelope).filter(([key]) => requestedFields.has(key)))
          : envelope
      );
      const data = [...live, ...deletions];

      // An oversized limit is clamped with a non-fatal warning (Section 8). The
      // defect clamps silently, which a client reads as the end of the stream.
      const requestedLimit = this.has("coerce-invalid-limit")
        ? Number.parseInt(rawLimit ?? "25", 10)
        : Number(rawLimit ?? "25");
      const clamped = Number.isFinite(requestedLimit) && requestedLimit > 100;
      const effectiveLimit = clamped ? 100 : Math.max(1, Math.trunc(requestedLimit) || 25);

      // `limit` is records per PAGE (Section 8). Under
      // `per-instance-limit-concatenated` it is applied to each instance's run
      // and the runs are joined, so a page can hold `limit` rows per instance.
      let window_: unknown[];
      let hasMore: boolean;
      let nextOffset: number;
      if (partitions !== undefined && this.has("per-instance-limit-concatenated")) {
        const runs = partitions.map((run) => run.map(toEnvelope).slice(cursorOffset, cursorOffset + effectiveLimit));
        window_ = [...runs.flat(), ...deletions];
        nextOffset = cursorOffset + effectiveLimit;
        hasMore = partitions.some((run) => run.length > nextOffset);
      } else {
        window_ = data.slice(cursorOffset, cursorOffset + effectiveLimit);
        nextOffset = cursorOffset + window_.length;
        hasMore = nextOffset < data.length;
      }
      const omitNextCursor = this.has("has-more-without-next-cursor") && partitions !== undefined;
      if (
        this.has("malformed-narrowed-read") &&
        principal.kind === "client" &&
        this.grantedFields(grantedStream).length < fixture.fields.length
      ) {
        send(200, { ok: true });
        return;
      }
      send(200, {
        object: "list",
        url: path,
        has_more: hasMore,
        // The cursor carries the order it was minted under, so the
        // direction-binding check above has something to compare against, and
        // — within a sync session — the horizon that session is anchored to.
        ...(hasMore && !omitNextCursor
          ? {
              next_cursor: `ok:${requestedOrder}:${nextOffset}:${isSync ? `${sessionHorizon}:${syncHorizon}` : "-:-"}:${pageContext}`,
            }
          : {}),
        // Clause 8.9-15: the terminal page of a changes_since response carries
        // the token for the NEXT session. It names this session's horizon, so
        // writes that arrived mid-session are picked up next time rather than
        // being lost between the two.
        ...(isSync && (!hasMore || this.has("next-changes-since-on-every-page")) && !this.has("omit-next-changes-since")
          ? {
              next_changes_since: syncToken(
                this.has("token-reveals-hidden-writes") ? sessionHorizon : (sync?.visibleHorizon ?? 0),
                syncContext
              ),
            }
          : {}),
        ...(clamped && !this.has("silent-limit-clamp")
          ? { meta: { warnings: [{ code: "limit_clamped", message: "limit clamped to 100" }] } }
          : {}),
        data:
          this.has("serve-undeclared-extra-field") && principal.kind === "client"
            ? window_.map((record) => {
                const row = record as { data?: Record<string, unknown> };
                return row.data ? { ...row, data: { ...row.data, internal_note: "not-in-any-grant" } } : record;
              })
            : window_,
      });
      return;
    }

    error(404, "not_found", "not_found_error", "Not found.");
  }

  /**
   * Stream metadata, actor-specific per Section 8 "Get stream metadata": whole
   * for an owner token, closed projection for a client token.
   */
  private streamMetadata(
    fixture: StreamFixture,
    kind: Principal["kind"],
    grantedFields: readonly string[]
  ): Record<string, unknown> {
    const wholeDocument = kind === "owner" || this.has("leak-current-metadata");
    // The defect models an owner-token read that projects the document as if a
    // grant existed: it truncates the schema to the field set a client-token
    // caller would see, and drops the views capability outright. Owner tokens
    // carry no grant to project against (Section 8), so either is a violation.
    const ownerTruncated = kind === "owner" && this.has("truncate-owner-metadata");
    const fields = ownerTruncated ? fixture.fields.slice(0, 1) : [...(wholeDocument ? fixture.fields : grantedFields)];
    const isOwner = kind === "owner";
    const declareCapabilities = wholeDocument && !ownerTruncated;

    // required is reported within whatever field set this read exposes: a
    // client-token projection cannot require a field it does not expose, and
    // the truncation defect above already narrows `fields` to model that.
    const requiredOmitted = isOwner && this.has("omit-owner-schema-required-field");
    const required = (fixture.requiredFields ?? []).filter(
      (f) => fields.includes(f) && !(requiredOmitted && f === fixture.requiredFields?.[0])
    );

    return {
      object: "stream_metadata",
      name: fixture.name,
      schema: { properties: this.schemaProperties(fixture, fields, isOwner), required },
      primary_key: [...fixture.primaryKey],
      ...(fixture.cursorField && { cursor_field: fixture.cursorField }),
      query: declareCapabilities ? this.queryCapability(fixture, isOwner) : {},
      views: declareCapabilities ? this.viewsCapability(fixture, isOwner) : [],
      relationships: declareCapabilities ? this.relationshipsCapability(fixture, isOwner) : [],
    };
  }

  /** Per-field JSON Schema properties, optionally corrupting the first field's declared type or a nested constraint. */
  private schemaProperties(
    fixture: StreamFixture,
    fields: readonly string[],
    isOwner: boolean
  ): Record<string, { type: string; items?: { type: string } }> {
    const corrupt = isOwner && this.has("corrupt-owner-schema-field-type");
    const corruptNested = isOwner && this.has("corrupt-owner-schema-nested-constraint");
    return Object.fromEntries(
      fields.map((f, i) => {
        const declaredType = fixture.fieldTypes?.[f] ?? "string";
        // Corrupt exactly the first field's type, leaving every other field (and
        // the field set itself) untouched, so this defect is distinguishable
        // from truncate-owner-metadata: same fields present, wrong content.
        const type = corrupt && i === 0 ? `${declaredType}-corrupted` : declaredType;
        const itemType = fixture.fieldItemTypes?.[f];
        const items = itemType ? { type: corruptNested ? `${itemType}-corrupted` : itemType } : undefined;
        return [f, { type, ...(items ? { items } : {}) }];
      })
    );
  }

  private viewsCapability(fixture: StreamFixture, isOwner: boolean): readonly Record<string, unknown>[] {
    if (isOwner && this.has("omit-owner-views")) {
      return [];
    }
    const corrupt = isOwner && this.has("corrupt-owner-views");
    return [{ id: "basic", label: "Basic", fields: corrupt ? [fixture.fields[0]] : [...fixture.fields] }];
  }

  private relationshipsCapability(fixture: StreamFixture, isOwner: boolean): readonly Record<string, unknown>[] {
    if (isOwner && this.has("omit-owner-relationships")) {
      return [];
    }
    const corrupt = isOwner && this.has("corrupt-owner-relationships");
    return (fixture.relationships ?? []).map((r) => ({
      id: r.id,
      target_stream: corrupt ? `${r.targetStream}-wrong` : r.targetStream,
      type: r.type,
    }));
  }

  private queryCapability(fixture: StreamFixture, isOwner: boolean): Record<string, unknown> {
    if (isOwner && this.has("omit-owner-query")) {
      return {};
    }
    const corrupt = isOwner && this.has("corrupt-owner-query");
    return { range_filters: { [fixture.cursorField ?? "id"]: corrupt ? ["lt"] : ["gte"] } };
  }

  /**
   * The Section 8 query-parameter gate, returning a rejection message or
   * undefined. Two distinct rules share this seam: client-token predicate and
   * expansion parameters are off the v0.1 client surface (RS-9), and unknown
   * parameters are rejected rather than ignored for any caller (RS-10).
   */
  private rejectUnsupportedParams(
    searchParams: URLSearchParams,
    kind: Principal["kind"],
    fixture: StreamFixture
  ): { code: string; message: string } | undefined {
    const params = [...searchParams.keys()];
    // Under `serve-client-token-view` the server pretends `view` is a
    // parameter it implements for every caller: it is neither rejected as
    // outside the client surface below nor caught by the generic
    // unknown-parameter branch, so the page is served. That is the shape of the
    // violation clause 8.9-3 names, and the only one a case asserting on the
    // status alone can be shown to catch.
    const servesClientView = this.has("serve-client-token-view");
    if (kind === "client" && !this.has("accept-client-filters")) {
      const offending = params.find(
        (p) =>
          p.startsWith("filter[") ||
          p === "expand[]" ||
          p.startsWith("expand[") ||
          p.startsWith("expand_limit[") ||
          (p === "view" && !servesClientView)
      );
      if (offending) {
        return {
          code: "invalid_request",
          message: `Parameter '${offending}' is not part of the v0.1 client-token query surface.`,
        };
      }
    }
    // This fixture does not implement owner predicate filters.
    if (kind === "owner" && !this.has("ignore-owner-filter-unknown-field")) {
      const offending = params.find((p) => p.startsWith("filter["));
      if (offending) {
        return { code: "invalid_request", message: `Parameter '${offending}' is unsupported.` };
      }
    }
    // Section 8 "Relationships": an owner-token expand[] naming a relation
    // absent from the stream's own declared relationships MUST 400
    // invalid_expand, not be silently served. A relation is structurally
    // present only if this fixture actually declared it.
    if (kind === "owner" && !this.has("ignore-owner-expand-undeclared-relation") && params.includes("expand[]")) {
      const declared = new Set((fixture.relationships ?? []).map((r) => r.id));
      const requested = searchParams.getAll("expand[]");
      const undeclaredRequested = requested.find((name) => !declared.has(name));
      if (undeclaredRequested !== undefined) {
        return { code: "invalid_expand", message: `Relation '${undeclaredRequested}' is not declared as expandable.` };
      }
    }
    if (!this.has("ignore-unknown-params")) {
      const unknown = params.find(
        (p) =>
          !(
            KNOWN_PARAMS.has(p) ||
            p.startsWith("filter[") ||
            p.startsWith("expand") ||
            (p === "view" && servesClientView)
          )
      );
      if (unknown) {
        return { code: "invalid_request", message: `Unknown query parameter '${unknown}'.` };
      }
    }
    return undefined;
  }

  /** The RFC 9728 document, including the four Section 8 `pdpp_` members. */
  private protectedResourceMetadata(): Record<string, unknown> {
    if (this.has("omit-pdpp-resource-metadata")) {
      return { resource: this.baseUrl, authorization_servers: [this.baseUrl] };
    }
    return {
      resource: this.baseUrl,
      resource_name: "PDPP conformance reference target",
      authorization_servers: [this.baseUrl],
      pdpp_core_query_base: "/v1",
      pdpp_token_kinds_supported: ["owner", "client"],
      pdpp_self_export_supported: true,
      pdpp_provider_connect_version: SUPPORTED_VERSION,
    };
  }

  /**
   * The RFC 8414 document, advertising `pre_registered_public` and publishing
   * the entries clause 6.2-2 governs.
   *
   * Core: "Each `pdpp_pre_registered_public_clients` entry contains
   * `client_id`, `client_name`, and `token_endpoint_auth_method` ... the field
   * MUST NOT contain secrets, access tokens, owner-scoped clients, dynamically
   * registered clients, or private registration state."
   *
   * The clause is conditional on advertising the mode, so this server advertises
   * it: a target that never does makes 6.2-2 vacuous, and "no target advertises
   * the mode" is exactly why the clause was unreachable.
   *
   * `leak-private-registration-state` adds the forbidden content. Each addition
   * is a DIFFERENT prohibited category from Core's list, because a server can
   * leak one without leaking the others and an oracle checking only for a key
   * literally named "secret" would miss the rest.
   */
  private authorizationServerMetadata(): Record<string, unknown> {
    const leaks = this.has("leak-private-registration-state");
    return {
      issuer: this.baseUrl,
      token_endpoint: `${this.baseUrl}/oauth/token`,
      ...(this.has("omit-revocation-endpoint-metadata") ? {} : { revocation_endpoint: this.revocationEndpoint }),
      pdpp_registration_modes_supported: ["pre_registered_public"],
      pdpp_pre_registered_public_clients: [
        {
          client_id: "cli_reference_public",
          client_name: "PDPP conformance reference public client",
          token_endpoint_auth_method: "none",
          // A bare secret, the obvious category.
          ...(leaks ? { client_secret: "s3cr3t-must-not-be-published" } : {}),
        },
        ...(leaks
          ? [
              // An owner-scoped client and a dynamically registered one: both
              // are prohibited entries rather than prohibited FIELDS, so a
              // check that only scanned each entry's keys for secrets would
              // pass a server publishing these.
              {
                client_id: "cli_owner_scoped",
                client_name: "Owner's own device client",
                token_endpoint_auth_method: "none",
                owner_scoped: true,
              },
              {
                client_id: "cli_dynamically_registered",
                client_name: "Dynamically registered client",
                token_endpoint_auth_method: "client_secret_basic",
                registration_access_token: "rat-must-not-be-published",
              },
            ]
          : []),
      ],
    };
  }

  /**
   * The canonical string identity of a record (Core Section 4 "Compound key
   * encoding").
   *
   * A single-field key is the value itself; a compound key is "the minified
   * JSON array of key values", with every component serialized as a string.
   * The stringification is the half that matters: without it an integer
   * component encodes as `1` rather than `"1"`, and two implementations
   * disagree about the identity of the same record.
   *
   * Falls back to the record's own `id` when the stream declares a key the
   * record does not carry, so a malformed fixture surfaces as itself rather
   * than as a key-encoding failure.
   */
  private canonicalKey(fixture: StreamFixture, record: Record_): string {
    if (fixture.primaryKey.length <= 1) {
      return record.id;
    }
    const components = fixture.primaryKey.map((field) => record[field]);
    if (components.some((value) => value === undefined)) {
      return record.id;
    }
    return this.has("unstringified-compound-key")
      ? JSON.stringify(components)
      : JSON.stringify(components.map((value) => String(value)));
  }

  /** Resolve a Bearer credential to its principal, as introspection would. */
  private resolveToken(authorization: string | string[] | undefined): Principal | undefined {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return undefined;
    }
    const credential = authorization.slice("Bearer ".length);
    const known = this.endedTokens.has(credential) ? undefined : this.tokens.get(credential);
    if (known) {
      return known;
    }
    // The defect RS-4 exists to catch: deciding token kind from the token's
    // shape rather than from the principal it resolves to. A string that merely
    // starts like an owner credential is honoured as one.
    if (this.has("infer-token-kind-from-syntax") && credential.startsWith("owner-")) {
      return { kind: "owner", subjectId: SEEDED_SUBJECT };
    }
    return undefined;
  }

  /**
   * RFC 6750 Section 3 challenge carrying the RFC 9728 `resource_metadata`
   * parameter. The `weak-401-challenge` defect drops that parameter, which is
   * exactly what the RS-16 bootstrap oracle looks for.
   */
  private bearerChallenge(): string {
    if (this.has("weak-401-challenge")) {
      return "Bearer";
    }
    const metadata = `${this.baseUrl}/.well-known/oauth-protected-resource`;
    if (this.has("omit-invalid-token-error")) {
      return `Bearer resource_metadata="${metadata}"`;
    }
    return `Bearer error="invalid_token", resource_metadata="${metadata}"`;
  }

  /**
   * Stream-level access denial, or undefined to proceed. A client token is
   * bounded by grant membership (RS-2); an owner token by subject scope (RS-12).
   */
  private denyStreamAccess(
    kind: Principal["kind"],
    streamName: string,
    inGrant: boolean,
    subjectScoped: boolean
  ): string | undefined {
    if (kind === "client") {
      return inGrant || this.has("ignore-grant-streams") ? undefined : `Grant does not include stream '${streamName}'.`;
    }
    if (this.has("declare-self-export-but-refuse")) {
      // Declares pdpp_self_export_supported in its metadata, then refuses the
      // owner read it advertised (RS-13).
      return "Self-export is not available.";
    }
    if (this.has("ignore-subject-scope")) {
      // Any owner token reaches any subject's store (RS-12).
      return undefined;
    }
    return subjectScoped ? undefined : "Owner token is scoped to a different subject.";
  }
}

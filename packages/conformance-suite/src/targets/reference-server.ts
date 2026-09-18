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

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Behaviours that violate a specific normative requirement, for oracle proof. */
export type Defect =
  /** Serves any stream regardless of grant membership (violates RS-2). */
  | "ignore-grant-streams"
  /** Returns all schema fields regardless of the grant projection (RS-2). */
  | "ignore-field-projection"
  /** Silently ignores unknown query parameters instead of 400 (RS-10). */
  | "ignore-unknown-params"
  /** Accepts client-token filter[...] instead of 400 (RS-9). */
  | "accept-client-filters"
  /** Keeps serving a revoked grant (AS-8). */
  | "ignore-revocation"
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
   * stream, instead of 400 `invalid_request` (clause 6.8-1).
   *
   * Distinct from every field-validation defect: both halves of the request are
   * individually valid here — a real view name and real declared fields — so a
   * server that validates each part and never checks their combination accepts
   * it. That is exactly the server the 6.8-1 oracle must be able to catch, and
   * no existing defect produces it.
   */
  | "accept-view-and-fields-together"
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
   * Binds client claims into the final approval artifact WITHOUT client
   * attribution (clause 6.3-2).
   *
   * The claims are all present and unaltered, so a case checking only that the
   * text survived passes. What is lost is the thing the attribution requirement
   * exists for: an unattributed commitment reads on the review surface as a
   * term the protocol enforces, when in fact it is an unverifiable promise by
   * the requesting client.
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
   * Accepts a declaration naming a source authority the AS never onboarded
   * (clause 5.8-1).
   *
   * Core: "An authorization server accepts a source declaration only through
   * explicit owner or operator onboarding, an installed catalog, an accepted
   * registry entry, or explicit local provisioning. A client MUST NOT introduce
   * a new source authority or declaration URI during authorization." A server
   * that takes the authority from the request lets a client define what the
   * owner is consenting about.
   */
  | "accept-unonboarded-source-authority"
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
  | "honour-unrecognized-token-kind";

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
  readonly cursorField?: string;
  /** Declared item type for array-typed fields (JSON Schema `items.type`), a nested constraint RS-14 checks. */
  readonly fieldItemTypes?: Readonly<Record<string, string>>;
  readonly fields: readonly string[];
  /** Per-field JSON Schema type, so RS-14 has real schema content to check (not just field names). */
  readonly fieldTypes?: Readonly<Record<string, string>>;
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

interface GrantState {
  expired: boolean;
  readonly grantId: string;
  revoked: boolean;
  /**
   * The grant SCHEMA version (Core Section 7 "Version layering",
   * `grant.version`) — not the HTTP API contract version the `PDPP-Version`
   * header carries. The two are separate axes that Core forbids conflating,
   * and this field is what makes the grant axis reachable at all.
   */
  readonly schemaVersion: string;
  readonly streams: readonly {
    name: string;
    fields: readonly string[];
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

const RECORDS_PATH = /^\/v1\/streams\/([^/]+)\/records$/;
const SINGLE_RECORD_PATH = /^\/v1\/streams\/([^/]+)\/records\/([^/]+)$/;
const METADATA_PATH = /^\/v1\/streams\/([^/]+)$/;

/** The seeded subject. A second subject exists so cross-subject scoping is testable. */
export const SEEDED_SUBJECT = "subject_seeded";
export const FOREIGN_SUBJECT = "subject_foreign";

export class ReferenceServer {
  private server?: Server;
  private port = 0;
  private readonly grants = new Map<string, GrantState>();
  private readonly tokens = new Map<string, Principal>();
  private counter = 0;
  private readonly streams: readonly StreamFixture[];
  private readonly defects: ReadonlySet<Defect>;

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

  constructor(streams: readonly StreamFixture[], defects: ReadonlySet<Defect> = new Set()) {
    this.streams = streams;
    this.defects = defects;
    for (const stream of streams) {
      for (const view of stream.views ?? []) {
        this.views.set(viewKey(stream.name, view.id), [...view.fields]);
      }
    }
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
  ): { grant: GrantState | undefined; subjectId: string } | { denial: { code: string; message: string } } {
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
    if (grant.revoked && !this.has("ignore-revocation")) {
      return { denial: { code: "grant_revoked", message: "Grant was revoked." } };
    }
    if (grant.expired) {
      return { denial: { code: "grant_expired", message: "Grant has expired." } };
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
      this.handle(req.url ?? "/", req.headers, res);
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
      timeConstraint?: { field: string; from?: string; to?: string };
      /** The view the fields were resolved from, when the request named one. */
      resolvedFromView?: string;
    }[],
    options: {
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
      if (!this.streams.some((fixture) => fixture.name === s.name)) {
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
        fields: [...s.fields],
        ...(s.timeConstraint ? { timeConstraint: s.timeConstraint } : {}),
        ...(s.resolvedFromView === undefined ? {} : { resolvedFromView: s.resolvedFromView }),
      })),
      revoked: false,
      expired: options.expired ?? false,
      schemaVersion: options.schemaVersion ?? GRANT_SCHEMA_VERSION,
    });
    this.tokens.set(accessToken, { kind: "client", grantId });
    return { grantId, accessToken };
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

  /** Base URL of this server's token endpoint, for the adapter to call. */
  get tokenEndpoint(): string {
    return `${this.baseUrl}/oauth/token`;
  }

  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.revoked = true;
    }
  }

  private handle(url: string, headers: NodeJS.Dict<string | string[]>, res: import("node:http").ServerResponse): void {
    const parsed = new URL(url, "http://127.0.0.1");
    const path = parsed.pathname;

    const send = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
      this.counter += 1;
      res.writeHead(status, {
        "content-type": "application/json",
        "pdpp-version": SUPPORTED_VERSION,
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
      send(200, { access_token: issuedToken, token_type: "Bearer" }, cacheHeaders);
      return;
    }

    // --- Authentication (RS-4, RS-16) ---
    const principal = this.resolveToken(headers.authorization);
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
    if (typeof requestedVersion === "string" && requestedVersion !== SUPPORTED_VERSION) {
      error(400, "unsupported_version", "invalid_request_error", `PDPP-Version ${requestedVersion} is not supported.`);
      return;
    }

    // Resolve the client authorization context, mirroring what a separated RS
    // would read from an RFC 7662 introspection response.
    const resolved = this.resolvePrincipal(principal);
    if ("denial" in resolved) {
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

    // --- GET /v1/streams (RS-1) ---
    if (path === "/v1/streams") {
      const visible = this.streams.filter((s) => {
        if (principal.kind === "owner") {
          return subjectScoped;
        }
        return grant?.streams.some((g) => g.name === s.name) ?? false;
      });
      send(200, {
        object: "list",
        data: visible.map((s) => ({
          object: "stream",
          name: s.name,
          record_count: s.records.length,
        })),
      });
      return;
    }

    const recordsMatch = RECORDS_PATH.exec(path);
    const singleMatch = SINGLE_RECORD_PATH.exec(path);
    const metadataMatch = METADATA_PATH.exec(path);
    const streamName = decodeURIComponent(recordsMatch?.[1] ?? singleMatch?.[1] ?? metadataMatch?.[1] ?? "");
    const fixture = this.streams.find((s) => s.name === streamName);

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

    // --- GET /v1/streams/{stream}/records/{id} (RS-1) ---
    if (singleMatch) {
      const recordId = decodeURIComponent(singleMatch[2] ?? "");
      const record = fixture.records.find((r) => r.id === recordId);
      if (!record) {
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
        data: Object.fromEntries(Object.entries(record).filter(([k]) => projection.includes(k))),
      });
      return;
    }

    // --- GET /v1/streams/{stream}/records (RS-2, RS-5, RS-9, RS-10) ---
    if (recordsMatch) {
      if (principal.kind === "owner" && this.has("deny-owner-records")) {
        error(403, "access_denied", "authorization_error", "Owner reads denied by fixture.");
        return;
      }
      const rejection = this.rejectUnsupportedParams(parsed.searchParams, principal.kind, fixture);
      if (rejection) {
        error(400, rejection.code, "invalid_request_error", rejection.message);
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

      // Section 8 makes page cursors and sync cursors distinct token spaces.
      // This fixture does not implement changes_since (which is why RS-8 fails
      // against it, by design), but it must still refuse a PAGE cursor offered
      // in the changes_since slot rather than serving a full page as if the
      // parameter were absent. Before this server paginated, no case could
      // obtain a real page cursor to present here and
      // RS-6/cursor-not-accepted-as-changes-since only ever skipped; once it
      // could, the fixture's silent acceptance became visible.
      const syncCursor = parsed.searchParams.get("changes_since");
      if (syncCursor?.startsWith("ok:")) {
        error(
          400,
          "invalid_cursor",
          "invalid_request_error",
          "A page cursor is not a changes_since token; the two are distinct token spaces."
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
      if (rawCursor?.startsWith("ok:")) {
        const [, cursorOrder, offsetText] = rawCursor.split(":");
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
      }

      const projection =
        principal.kind === "client" && !this.has("ignore-field-projection")
          ? this.grantedFields(grantedStream)
          : fixture.fields;

      // Enforce the grant's frozen time constraint (Section 8 "Grant
      // enforcement"): records outside the consented window are not the client's
      // to see, whatever the request asked for.
      const constraint = grantedStream?.timeConstraint;
      const withinWindow = (record: Record_): boolean => {
        if (!constraint) {
          return true;
        }
        const value = record[constraint.field];
        if (typeof value !== "string") {
          return false;
        }
        if (constraint.from && value < constraint.from) {
          return false;
        }
        return !(constraint.to && value >= constraint.to);
      };

      const data = fixture.records.filter(withinWindow).map((record) => ({
        object: "record",
        id: record.id,
        stream: fixture.name,
        data: Object.fromEntries(Object.entries(record).filter(([k]) => projection.includes(k))),
      }));

      // An oversized limit is clamped with a non-fatal warning (Section 8). The
      // defect clamps silently, which a client reads as the end of the stream.
      const requestedLimit = Number(parsed.searchParams.get("limit") ?? "25");
      const clamped = Number.isFinite(requestedLimit) && requestedLimit > 100;
      const effectiveLimit = clamped ? 100 : Math.max(1, Math.trunc(requestedLimit) || 25);
      const window_ = data.slice(cursorOffset, cursorOffset + effectiveLimit);
      const nextOffset = cursorOffset + window_.length;
      const hasMore = nextOffset < data.length;
      send(200, {
        object: "list",
        url: path,
        has_more: hasMore,
        // The cursor carries the order it was minted under, so the
        // direction-binding check above has something to compare against.
        ...(hasMore ? { next_cursor: `ok:${requestedOrder}:${nextOffset}` } : {}),
        ...(clamped && !this.has("silent-limit-clamp")
          ? { meta: { warnings: [{ code: "limit_clamped", message: "limit clamped to 100" }] } }
          : {}),
        data: window_,
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

  /** Resolve a Bearer credential to its principal, as introspection would. */
  private resolveToken(authorization: string | string[] | undefined): Principal | undefined {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return undefined;
    }
    const credential = authorization.slice("Bearer ".length);
    const known = this.tokens.get(credential);
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

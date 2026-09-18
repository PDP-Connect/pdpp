// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The TargetAdapter for the in-process reference target.
//
// This is the worked example a vendor copies to test their own implementation:
// it implements the adapter contract and nothing else, and it holds no
// privilege the contract does not offer everyone. Everything the suite learns
// about the target still arrives over HTTP.
//
// Several methods below are `async` without awaiting: the TargetAdapter
// contract is async because a real adapter does I/O (an HTTP call to mint a
// token, a database seed). This in-process target answers from memory. The
// `async` keyword is part of the contract's shape, not an oversight.

// biome-ignore-all lint/suspicious/useAwait: the TargetAdapter contract is async; this in-process target answers from memory.

import type {
  DeclarationOutcome,
  GrantRequest,
  IssuedGrant,
  SeededStream,
  SelectionOutcome,
  SelectionRequest,
  SourceDeclarationSubmission,
  StagedApproval,
  TargetAdapter,
  TargetCapabilities,
  UrlHostedClientOffer,
  UrlHostedClientOutcome,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";
import {
  type Defect,
  GRANT_SCHEMA_VERSION,
  PDPP_VERSION,
  ReferenceServer,
  type StreamFixture,
} from "./reference-server.ts";

/**
 * Two streams with overlapping shape: the negative oracles need a second stream
 * to hold out of a grant, and at least two fields per stream so a projection can
 * be narrowed with something left over to leak.
 */
export const DEFAULT_FIXTURES: readonly StreamFixture[] = [
  {
    name: "conversations",
    fields: ["id", "title", "source_created_at", "tags"],
    fieldTypes: { id: "string", title: "string", source_created_at: "string", tags: "array" },
    // A declared array-typed field, so RS-14's nested-constraint checks
    // (JSON Schema `items.type`) have real content to check beyond flat type.
    fieldItemTypes: { tags: "string" },
    // Declared required fields (Core Section 5), independent of field
    // presence: RS-14's required-omission case needs a field that is present
    // in the schema but expected to be marked required.
    requiredFields: ["id", "title"],
    primaryKey: ["id"],
    cursorField: "source_created_at",
    // Declared, so this stream IS time-range-capable and can serve as the
    // positive control for the refusals below.
    consentTimeField: "source_created_at",
    semantics: "mutable_state",
    // A real declared relationship, so RS-14's relationship-omission and
    // relationship-corruption cases have non-empty content to check against
    // (an always-empty relationships array could never distinguish either).
    relationships: [{ id: "conversation_messages", targetStream: "messages", type: "has_many" }],
    // A named view over a STRICT SUBSET of the declared fields (Core Section 5
    // "Views"). It must be a proper subset for the view cases to mean anything:
    // a view covering every field cannot show that a grant resolved by view
    // name is narrower than the schema, and the 5.6-2a widening case needs a
    // declared field left over to widen the view WITH.
    views: [{ id: "summary", fields: ["id", "title"] }],
    records: [
      {
        id: "conv_1",
        title: "Trip planning",
        source_created_at: "2026-03-25T18:22:11Z",
      },
      {
        id: "conv_2",
        title: "Book club",
        source_created_at: "2026-03-26T09:10:00Z",
      },
    ],
  },
  {
    name: "messages",
    fields: ["id", "body", "source_created_at"],
    fieldTypes: { id: "string", body: "string", source_created_at: "string" },
    primaryKey: ["id"],
    cursorField: "source_created_at",
    consentTimeField: "source_created_at",
    semantics: "append_only",
    records: [
      {
        id: "msg_1",
        body: "Shall we go in May?",
        source_created_at: "2026-03-25T18:23:00Z",
      },
    ],
  },
  // A stream that declares NO consent_time_field, and therefore is not
  // time-range-capable. Core Section 5: "Streams that cannot define a stable
  // `consent_time_field` simply omit it. The absence of `consent_time_field` is
  // the normative signal that the stream does not support time-range
  // filtering."
  //
  // This fixture exists for exactly one reason: clauses 5.2-4 and 6.8-2 require
  // the AS to REFUSE `time_range` on such a stream, and that negative cannot be
  // constructed at all against a deployment whose every stream declares the
  // field. Batch 4 recorded 5.2-4 as unclaimable for this reason rather than
  // claiming it on its other half.
  //
  // It still carries a cursorField: the two are separate declarations in Core,
  // and keeping sync capability here is what shows the refusal is about the
  // consent boundary rather than about the stream being unqueryable.
  {
    name: "device_events",
    fields: ["id", "kind", "observed_at"],
    fieldTypes: { id: "string", kind: "string", observed_at: "string" },
    primaryKey: ["id"],
    cursorField: "observed_at",
    semantics: "append_only",
    records: [
      {
        id: "evt_1",
        kind: "pairing",
        observed_at: "2026-03-24T08:00:00Z",
      },
    ],
  },
];

const CAPABILITIES: TargetCapabilities = {
  separatedDeployment: false,
  ownerTokens: true,
  selfExport: true,
  // Incremental sync IS implemented. It was not, and RS-8 failed against this
  // target from at least 0d50f01f0f: the fixture seeds a `mutable_state`
  // stream (`conversations`), which under Core Section 4 obliges
  // `changes_since` support, and served no `next_changes_since` at all. The
  // case was right and the target was wrong — `appliesWhen` derives RS-7/RS-8
  // applicability from seeded stream semantics precisely so a target cannot
  // hide the MUST behind a false `incrementalSync: false`.
  incrementalSync: true,
  // Views ARE implemented: the `summary` view on `conversations`, resolved at
  // issuance and frozen into the grant. This is what makes the Section 5 view
  // clauses reachable at all; every target declaring `views: false` reports
  // them `skip` naming the missing capability, which is where they sat before.
  views: true,
  singleUseGrants: false,
  refreshTokens: false,
  blobs: false,
};

const ROLES: readonly Role[] = ["resource-server", "authorization-server"];

/**
 * The field the `define-view-with-undeclared-field` defect adds to every view.
 *
 * Deliberately a name no fixture schema declares, so the resulting view is a
 * clause 5.6-2 violation on its face: it includes a field absent from the
 * retained SourceDeclaration schema for its stream.
 */
const UNDECLARED_VIEW_FIELD = "pdpp_conformance_field_absent_from_schema";

/**
 * Facts the final approval artifact must carry (clause 7.2-2) that this target
 * has no other reason to model. They are constants rather than configuration
 * because the case checks that the artifact CARRIES them, not what they are.
 */
const CLIENT_IDENTITY = "pdpp-conformance-client";
const DEFAULT_PURPOSE = "https://pdpp.dev/purpose/personalization";
const DEFAULT_RETENTION = "P30D";
const GRANT_EXPIRY = "2027-01-01T00:00:00Z";
const INSTANCE_ID = "instance_reference_1";

/**
 * The source this target was onboarded with, and the only one it accepts
 * declarations under (Core Section 5 "Declaration trust").
 *
 * `ACCEPTED_AUTHORITY` stands for the operator onboarding that put this
 * declaration in place. A declaration arriving under any other authority was
 * introduced by the requester rather than onboarded, which is what clause
 * 5.8-1 forbids. `ACCEPTED_RESOURCE_ID` is the protected-resource identifier a
 * `provider_native` declaration's `source.id` must equal (clause 5.8-2).
 */
const ACCEPTED_AUTHORITY = "https://operator.example/onboarded";
const ACCEPTED_RESOURCE_ID = "https://rs.example/pdpp/reference";

/**
 * Hosts this target will fetch a URL-hosted client identity document from
 * (clauses 6.1-2, 6.1-4).
 *
 * Loopback, because the suite's document server is necessarily on loopback.
 * A deployment reachable from a network must not trust these; the Personal
 * Server's equivalent concession is its `allowInsecureForTesting` switch.
 *
 * Both spellings are listed because the matching rule is an exact hostname
 * comparison — as in personal-server-ts `checkDeclarationUrl` — and Node's
 * document server may be addressed by either.
 */
const URL_HOSTED_TRUSTED_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];

/**
 * Whether two declaration bodies carry the same parsed content.
 *
 * Clause 5.8-4 turns on "different parsed content", so this compares content
 * rather than serialization: field ORDER is not content, and a server treating
 * a reordered field list as equivocation would refuse a legitimate idempotent
 * resubmission.
 */
function sameStreams(
  a: readonly { readonly name: string; readonly fields: readonly string[] }[],
  b: readonly { readonly name: string; readonly fields: readonly string[] }[]
): boolean {
  const normalize = (streams: readonly { readonly name: string; readonly fields: readonly string[] }[]) =>
    JSON.stringify(
      [...streams]
        .map((s) => ({ name: s.name, fields: [...s.fields].sort() }))
        .sort((x, y) => x.name.localeCompare(y.name))
    );
  return normalize(a) === normalize(b);
}

export class ReferenceTargetAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion = "0.1.0";
  readonly roles = ROLES;
  readonly capabilities = CAPABILITIES;
  /** This target's grant schema version (clause 7.4-2's positive control). */
  readonly supportedGrantSchemaVersion = GRANT_SCHEMA_VERSION;
  /** Hosts this target fetches URL-hosted client documents from (6.1-2, 6.1-4). */
  readonly urlHostedClientHosts = URL_HOSTED_TRUSTED_HOSTS;
  private readonly server: ReferenceServer;
  private readonly fixtures: readonly StreamFixture[];
  private readonly defects: ReadonlySet<Defect>;
  /** Monotonic handle/revision source for staged approvals. */
  private stagedCounter = 0;
  /**
   * Declarations accepted so far, keyed by the accepted authority binding,
   * `source.id` and `declaration_version` — exactly the key Core Section 5
   * names. Clause 5.8-4's obligation is stated against this key, and holding
   * the retained CONTENT (not merely the key) is what lets a case check that a
   * refused equivocation left the previous content in place.
   */
  private readonly acceptedDeclarations = new Map<
    string,
    readonly { readonly name: string; readonly fields: readonly string[] }[]
  >();

  constructor(fixtures: readonly StreamFixture[] = DEFAULT_FIXTURES, defects: ReadonlySet<Defect> = new Set()) {
    // Clause 5.6-2 binds the AS's view DEFINITIONS, so the violating target is
    // one whose definitions are already bad before any request arrives. The
    // defect therefore rewrites the fixtures the server is built from, adding a
    // field no stream schema declares to every view. Injecting it at the
    // request would be a different (and untested) defect: a bad request, which
    // a conforming server refuses for an unrelated reason.
    const effective = defects.has("define-view-with-undeclared-field")
      ? fixtures.map((f) => ({
          ...f,
          ...(f.views
            ? {
                views: f.views.map((v) => ({
                  ...v,
                  fields: [...v.fields, UNDECLARED_VIEW_FIELD],
                })),
              }
            : {}),
        }))
      : fixtures;
    this.fixtures = effective;
    this.defects = defects;
    this.server = new ReferenceServer(effective, defects);
    this.targetId =
      defects.size === 0 ? "pdpp-reference-target" : `pdpp-reference-target+defects(${[...defects].sort().join(",")})`;
  }

  get baseUrl(): string {
    return this.server.baseUrl;
  }

  /**
   * Co-located AS and RS, so the authorization server is the same origin.
   *
   * Published so the RFC 8414 metadata cases can find the document. This does
   * NOT declare `separatedDeployment` — the two are different facts, and the
   * introspection cases stay gated on the capability rather than on this URL.
   */
  get authorizationServerUrl(): string {
    return this.server.baseUrl;
  }

  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    await this.server.start();
    const streams: SeededStream[] = this.fixtures.map((f) => ({
      name: f.name,
      fields: [...f.fields],
      primaryKey: [...f.primaryKey],
      ...(f.cursorField && { cursorField: f.cursorField }),
      semantics: f.semantics,
      recordCount: f.records.length,
      ...(f.consentTimeField ? { consentTimeField: f.consentTimeField } : {}),
      // The declared capabilities RS-14 checks an owner-token metadata read
      // against, derived from this fixture directly rather than from anything
      // the metadata endpoint under test returns.
      expectedOwnerMetadata: {
        query: { range_filters: { [f.cursorField ?? "id"]: ["gte"] } },
        views: [{ id: "basic", label: "Basic", fields: [...f.fields] }],
        relationships: (f.relationships ?? []).map((r) => ({
          id: r.id,
          target_stream: r.targetStream,
          type: r.type,
        })),
        schemaFieldTypes: { ...(f.fieldTypes ?? Object.fromEntries(f.fields.map((field) => [field, "string"]))) },
        ...(f.fieldItemTypes ? { schemaFieldItemTypes: { ...f.fieldItemTypes } } : {}),
        ...(f.requiredFields ? { schemaRequired: [...f.requiredFields] } : {}),
      },
    }));
    return { streams };
  }

  async teardown(): Promise<void> {
    await this.server.stop();
  }

  async declaredViews(): Promise<
    readonly { readonly stream: string; readonly view: string; readonly fields: readonly string[] }[]
  > {
    return this.server.allViews();
  }

  /**
   * The field list for a view name, or null when this AS defines no such view.
   *
   * Conforming behaviour is an EXACT lookup, because clause 5.6-3 requires an
   * unrecognized view URI to be treated as an opaque identifier — not parsed,
   * not normalized, not prefix- or substring-matched. Under
   * `resolve-view-uri-by-substring` the lookup instead searches for a known
   * view name inside the supplied string, which is the "helpful normalization"
   * shape of the violation and what the 5.6-3 oracle must be able to catch.
   */
  private resolveView(stream: string, view: string): readonly string[] | null {
    const exact = this.server.viewFields(stream, view);
    if (exact) {
      return exact;
    }
    if (!this.defects.has("resolve-view-uri-by-substring")) {
      return null;
    }
    const known = this.server.allViews().find((v) => v.stream === stream && view.includes(v.view));
    return known ? (this.server.viewFields(stream, known.view) ?? null) : null;
  }

  async widenView(stream: string, view: string, addField: string): Promise<readonly string[] | null> {
    return this.server.widenView(stream, view, addField);
  }

  /**
   * The AS's declaration-onboarding decision (Core Section 5, "Declaration
   * trust"), and what it retains for the key afterwards.
   *
   * Three refusals, checked in the order the spec states them, each gated by
   * its own defect so the oracles can be shown to discriminate independently:
   *
   * 1. An authority this AS never onboarded (5.8-1). Checked first because
   *    nothing else about the document matters if the requester chose who
   *    speaks for the source.
   * 2. A `provider_native` `source.id` that is not the accepted
   *    protected-resource identifier (5.8-2). Refused "before consent or grant
   *    issuance", which is here.
   * 3. Different parsed content under an already-accepted key (5.8-4). Both
   *    halves are implemented: the new content is refused, and the retained
   *    content is left exactly as it was. `declaration_version` is deliberately
   *    NOT consulted for ordering — Core says an AS "MUST NOT infer ordering or
   *    freshness from `declaration_version`", so a repeat of an accepted
   *    version is equivocation rather than an update.
   *
   * An identical resubmission under an accepted key is accepted and idempotent:
   * the content matches, so there is nothing equivocal about it, and treating
   * it as a violation would make the positive control impossible.
   */
  async submitDeclaration(declaration: SourceDeclarationSubmission): Promise<DeclarationOutcome> {
    const authority = declaration.authority ?? ACCEPTED_AUTHORITY;
    const key = `${authority}\u0000${declaration.source.id}\u0000${declaration.declarationVersion}`;
    const retained = () => {
      const held = this.acceptedDeclarations.get(key);
      return held === undefined ? {} : { retainedContent: held };
    };
    const refuse = (errorCode: string, message: string): DeclarationOutcome => ({
      accepted: false,
      status: 400,
      errorCode,
      body: JSON.stringify({ error: errorCode, error_description: message }),
      ...retained(),
    });

    if (authority !== ACCEPTED_AUTHORITY && !this.defects.has("accept-unonboarded-source-authority")) {
      return refuse(
        "invalid_source_authority",
        `authority '${authority}' was never onboarded; a client may not introduce a source authority during authorization`
      );
    }

    if (
      declaration.source.kind === "provider_native" &&
      declaration.source.id !== ACCEPTED_RESOURCE_ID &&
      !this.defects.has("accept-provider-native-id-mismatch")
    ) {
      return refuse(
        "invalid_source_id",
        `provider_native source.id '${declaration.source.id}' is not the accepted protected-resource identifier '${ACCEPTED_RESOURCE_ID}'`
      );
    }

    const held = this.acceptedDeclarations.get(key);
    if (held !== undefined && !sameStreams(held, declaration.streams)) {
      if (this.defects.has("accept-declaration-equivocation")) {
        this.acceptedDeclarations.set(key, declaration.streams);
        return { accepted: true, status: 200, retainedContent: declaration.streams };
      }
      return refuse(
        "declaration_equivocation",
        "different content was already accepted under this (authority, source.id, declaration_version) key"
      );
    }

    this.acceptedDeclarations.set(key, declaration.streams);
    return { accepted: true, status: 200, retainedContent: declaration.streams };
  }

  /**
   * The request's streams with every `view` name resolved to a field list, or
   * null when a named view is one this AS does not define.
   *
   * Core Section 5 "View evolution": a view name is resolved AT ISSUANCE and
   * the resolved list is what the grant binds to. Resolving here — rather than
   * storing the view name on the grant — is what makes clause 5.6-2a true of
   * this target: a later `widenView` cannot reach a grant that never retained
   * the name. Shared with `stageApproval` so the artifact the owner reviews
   * describes exactly the fields the grant will carry.
   */
  private resolveStreams(request: GrantRequest): { name: string; fields: readonly string[]; view?: string }[] | null {
    const resolved: { name: string; fields: readonly string[]; view?: string }[] = [];
    for (const s of request.streams) {
      if (s.view === undefined) {
        resolved.push({ name: s.name, fields: [...s.fields] });
        continue;
      }
      const viewFields = this.resolveView(s.name, s.view);
      if (!viewFields) {
        return null;
      }
      resolved.push({ name: s.name, fields: [...viewFields], view: s.view });
    }
    return resolved;
  }

  /**
   * The `client_claims` block the final approval artifact carries.
   *
   * Clause 6.3-2: rendered claims are "normalized and bound exactly, with
   * client attribution, into the immutable final approval artifact". Two things
   * are therefore checkable and each has its own defect, because a server can
   * get either wrong on its own: the claims must be the client's own words
   * unaltered (`mutate-bound-client-claims` paraphrases them), and they must
   * carry attribution (`drop-client-claim-attribution` omits it, which is how a
   * claim stops being "the client says" and starts reading as a term the
   * protocol enforces).
   */
  private bindClaims(commitments: readonly string[]): Record<string, unknown> {
    const bound = this.defects.has("mutate-bound-client-claims")
      ? commitments.map((c) => `${c} (edited)`)
      : [...commitments];
    return this.defects.has("drop-client-claim-attribution")
      ? { commitments: bound }
      : { attributed_to: CLIENT_IDENTITY, commitments: bound };
  }

  /**
   * Stage an authorization request, stopping before approval, and publish the
   * final approval artifact the approval would be bound to.
   *
   * The artifact is built HERE, from the resolved request, rather than derived
   * from the eventual grant: clause 7.2-2 is about what the owner is shown and
   * what the approval binds to, which by definition exists before the grant
   * does. Building it from the grant afterwards would make the case unable to
   * detect the very thing it is looking for — an artifact missing facts the
   * owner needed in order to consent.
   *
   * `clientClaims` are carried into the artifact under their own key with
   * explicit attribution (clause 6.3-2), and deliberately NOT into the grant
   * (clause 7.2-4): Core places them outside authorization equality, the
   * resolved grant, introspection rights and RS enforcement.
   */
  async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
    const resolved = this.resolveStreams(request);
    if (!resolved) {
      return null;
    }
    this.stagedCounter += 1;
    const handle = `staged_${this.stagedCounter}`;
    const revision = `rev_${this.stagedCounter}`;
    const claims = request.clientClaims;

    // `thin-approval-artifact` keeps the streams and fields — the facts an
    // implementer thinks of first — and drops the lifecycle ones. That is the
    // realistic shape of a 7.2-2 violation, and it is why the case checks the
    // whole field inventory rather than just that an artifact exists.
    const thin = this.defects.has("thin-approval-artifact");
    const artifact = {
      review_revision: revision,
      client: { client_id: CLIENT_IDENTITY },
      purpose: request.purposeCode ?? DEFAULT_PURPOSE,
      ...(thin ? {} : { retention: DEFAULT_RETENTION, grant_expiry: GRANT_EXPIRY }),
      streams: resolved.map((stream) => ({
        name: stream.name,
        fields: [...stream.fields],
        ...(thin ? {} : { instance_ids: [INSTANCE_ID] }),
        resources: [],
        temporal_field: request.timeConstraint?.field ?? null,
        since: request.timeConstraint?.from ?? null,
        until: request.timeConstraint?.to ?? null,
      })),
      // Rendered on the review surface, so bound exactly and attributed. The
      // `attributed_to` key is what makes the binding checkable: a bare copy of
      // the strings would satisfy "present" without satisfying "attributed".
      ...(claims?.commitments?.length ? { client_claims: this.bindClaims(claims.commitments) } : {}),
    };

    return {
      handle,
      reviewRevision: revision,
      approvalArtifact: async () => artifact,
      approve: async (approveRevision?: string) => {
        if (approveRevision !== undefined && approveRevision !== revision) {
          return null;
        }
        return await this.issueGrant(request);
      },
    };
  }

  /**
   * The headers this target's token endpoint returned for a successful,
   * token-bearing response, lower-cased. Null on any transport failure, which
   * reports the 10.2-4 case `skip` rather than reading a failed fetch as a
   * missing header.
   */
  private async fetchTokenResponseHeaders(grantId: string): Promise<Record<string, string> | null> {
    try {
      const response = await fetch(`${this.server.tokenEndpoint}?grant_id=${encodeURIComponent(grantId)}`);
      if (!response.ok) {
        return null;
      }
      return Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v]));
    } catch {
      return null;
    }
  }

  async issueGrant(request: GrantRequest): Promise<IssuedGrant | null> {
    if (request.accessMode === "single_use") {
      // Not supported; declared absent in capabilities, so AS-10 is unsupported.
      return null;
    }
    const resolved = this.resolveStreams(request);
    if (!resolved) {
      return null;
    }
    const issued = this.server.issueGrant(
      resolved.map((s) => ({
        name: s.name,
        fields: [...s.fields],
        ...(request.timeConstraint ? { timeConstraint: request.timeConstraint } : {}),
        ...(s.view === undefined ? {} : { resolvedFromView: s.view }),
      })),
      {
        ...(request.purposeCode ? { purposeCode: request.purposeCode } : {}),
        ...(request.explicitAiTrainingConsent === undefined
          ? {}
          : { explicitAiTrainingConsent: request.explicitAiTrainingConsent }),
      }
    );
    if (!issued || "deniedReason" in issued) {
      return null;
    }
    // The resolved grant artifact, published ONLY for a request that carried
    // client claims.
    //
    // Clause 7.2-4 places `client_claims` outside the resolved grant, and the
    // case checking that needs to see the grant to confirm their absence. But
    // this target deliberately publishes no Section 7 grant otherwise: AS-3
    // reports `skip` against it, and the suite's own tests assert that skip as
    // the honest report of missing evidence. Publishing a hand-built artifact
    // unconditionally would silently convert that `skip` into a claim about a
    // grant body this target does not really produce. So the artifact appears
    // exactly where the 7.2-4 oracle needs it and nowhere else.
    //
    // `leak-client-claims-into-grant` copies the claims in, which is the
    // violation: an unenforceable client promise becomes something a downstream
    // component may read as an authorization term.
    const claims = request.clientClaims?.commitments ?? [];
    const rawGrant =
      claims.length === 0
        ? undefined
        : {
            grant_id: issued.grantId,
            purpose: request.purposeCode ?? DEFAULT_PURPOSE,
            streams: resolved.map((s) => ({ name: s.name, fields: [...s.fields] })),
            ...(this.defects.has("leak-client-claims-into-grant")
              ? { client_claims: { commitments: [...claims] } }
              : {}),
          };

    // Redeem the issued grant at the real token endpoint so the headers the
    // 10.2-4 case asserts on are the ones an HTTP client actually received.
    // Building a header map here instead would be the suite testing its own
    // constant.
    const tokenResponseHeaders = await this.fetchTokenResponseHeaders(issued.grantId);

    return {
      grantId: issued.grantId,
      accessToken: issued.accessToken,
      ...(rawGrant === undefined ? {} : { rawGrant }),
      ...(tokenResponseHeaders === null ? {} : { tokenResponseHeaders }),
      // The RESOLVED field set, not the requested one. For a request naming a
      // view these differ, and Core Section 5 makes the resolved list the
      // authoritative content of the grant; echoing the request here would
      // report a `view` name as if it were a field.
      streams: resolved.map((s) => ({
        name: s.name,
        fields: [...s.fields],
      })),
    };
  }

  /**
   * Why the first requested stream fails validation against the retained
   * snapshot, or null when every one of them checks out.
   *
   * The `accept-undeclared-selection` defect makes this always answer null,
   * which is exactly the server behaviour the AS-2 oracles must be able to
   * catch: taking the client's word for what the source offers.
   */
  private firstUndeclaredReason(
    wantedStreams: readonly { readonly name: string; readonly fields?: readonly string[] }[]
  ): string | null {
    if (this.defects.has("accept-undeclared-selection")) {
      return null;
    }
    for (const wanted of wantedStreams) {
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      if (!declared) {
        return `stream '${wanted.name}' is not declared by the retained snapshot`;
      }
      const undeclared = (wanted.fields ?? []).filter((f) => !declared.fields.includes(f));
      if (undeclared.length > 0) {
        return `stream '${wanted.name}' requests fields absent from the retained schema: ${undeclared.join(", ")}`;
      }
    }
    return null;
  }

  /**
   * Why `time_range` cannot be honoured on one of the named streams, or null
   * when the request asks for no time range or every named stream is
   * time-range-capable.
   *
   * Core Section 5: "The AS MUST reject grants that request `time_range` on a
   * stream without a `consent_time_field`" (clause 5.2-4), restated against the
   * request at clause 6.8-2. Core also fixes the meaning of the absent field:
   * "The absence of `consent_time_field` is the normative signal that the
   * stream does not support time-range filtering." So the refusal is not a
   * deployment choice — an AS that accepts the request has to evaluate the
   * window against something the declaration never nominated.
   */
  private firstBadTimeRangeReason(
    wantedStreams: readonly { readonly name: string }[],
    hasTimeRange: boolean
  ): string | null {
    if (!hasTimeRange || this.defects.has("accept-time-range-without-consent-time-field")) {
      return null;
    }
    for (const wanted of wantedStreams) {
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      if (declared && declared.consentTimeField === undefined) {
        return `stream '${wanted.name}' declares no consent_time_field, so time_range is not applicable to it`;
      }
    }
    return null;
  }

  /**
   * Why the `streams` array is malformed as a LIST, or null when its shape is
   * well-formed.
   *
   * Core Section 6 (clause 6.8-3): "A wildcard entry MUST be the only entry in
   * `streams`. Otherwise stream names MUST be unique within the request."
   *
   * Called BEFORE names are validated against the snapshot, because both
   * malformed shapes are built from names the snapshot declares: a server that
   * validated names first and stopped there would accept them. The wildcard
   * itself is not a declared stream name, so this check is also what keeps
   * `firstUndeclaredReason` from refusing a lone `"*"` for the wrong reason.
   */
  private malformedStreamListReason(wantedStreams: readonly { readonly name: string }[]): string | null {
    if (this.defects.has("accept-malformed-stream-list")) {
      return null;
    }
    const wildcards = wantedStreams.filter((s) => s.name === "*");
    if (wildcards.length > 0 && wantedStreams.length > 1) {
      return "a wildcard entry must be the only entry in streams";
    }
    const names = wantedStreams.map((s) => s.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    return duplicate === undefined ? null : `stream name '${duplicate}' appears more than once`;
  }

  /**
   * Why the first view named in the request is unusable, or null when every one
   * of them resolves within its stream's declared schema.
   *
   * Two Section 5 obligations, both about view DEFINITIONS rather than the
   * request that names them:
   *
   * - 5.6-2: "The AS MUST NOT define a view that includes fields absent from
   *   the retained SourceDeclaration schema for the relevant stream." A
   *   definition that exceeds the schema is refused rather than resolved, which
   *   is the only way an AS holds the line once a bad view exists.
   * - 5.6-3: an unrecognized view URI is an opaque identifier, so it is simply
   *   not a view this AS defines. It is refused as unrecognized, never parsed
   *   for meaning or matched by prefix (see `resolveView`).
   */
  private firstBadViewReason(
    wantedStreams: readonly { readonly name: string; readonly view?: string }[]
  ): string | null {
    for (const wanted of wantedStreams) {
      if (wanted.view === undefined) {
        continue;
      }
      const viewFields = this.resolveView(wanted.name, wanted.view);
      if (!viewFields) {
        return `view '${wanted.view}' is not defined by this authorization server for stream '${wanted.name}'`;
      }
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      const outsideSchema = viewFields.filter((f) => !(declared?.fields ?? []).includes(f));
      if (outsideSchema.length > 0) {
        return `view '${wanted.view}' includes fields absent from the retained schema for '${wanted.name}': ${outsideSchema.join(", ")}`;
      }
    }
    return null;
  }

  /**
   * Selection-request validation, modelled against the seeded fixtures as the
   * retained SourceDeclaration snapshot.
   *
   * Deliberately not an HTTP surface: these requirements are about the decision
   * the AS makes about a request, not about how the request is carried, and Core
   * pins no route for it (the two real targets this suite drives use different
   * ones). Implementing the decision here is what lets the negative oracles be
   * proven to discriminate, which is the bar every other negative case meets.
   */
  async submitSelection(request: SelectionRequest): Promise<SelectionOutcome> {
    const reject = (errorCode: string, description: string): SelectionOutcome => ({
      status: 400,
      errorCode,
      body: JSON.stringify({ error: errorCode, error_description: description }),
    });

    if (request.pdppVersion !== undefined && request.pdppVersion !== PDPP_VERSION) {
      if (this.defects.has("accept-unsupported-version")) {
        return { status: 201, body: '{"session_id":"as_defect"}' };
      }
      return reject("unsupported_version", `PDPP-Version '${request.pdppVersion}' is not supported`);
    }

    // Core Section 6: exactly one of streams / selection_preset.
    const hasStreams = request.streams !== undefined;
    const hasPreset = request.selectionPreset !== undefined;
    if (hasStreams === hasPreset && !this.defects.has("accept-malformed-selection")) {
      return reject("invalid_authorization_details", "exactly one of streams or selection_preset is required");
    }

    // Only reached when the shape is well-formed, or when the malformed-shape
    // defect waved a both-present request through. In the latter case a
    // conforming server would have refused on shape alone, so the preset must
    // not be re-examined here — refusing it would make the AS-5 oracle pass
    // against a target that ignores AS-5 entirely.
    if (hasPreset && !hasStreams && !this.defects.has("accept-undeclared-selection")) {
      // This target's declaration defines no presets, so any named one is
      // unrecognized.
      return reject(
        "invalid_authorization_details",
        `selection preset '${request.selectionPreset}' is not defined by the retained snapshot`
      );
    }

    // Core Section 6 (clause 6.8-3): "A wildcard entry MUST be the only entry
    // in `streams`. Otherwise stream names MUST be unique within the request."
    //
    // Checked BEFORE names are validated against the snapshot, because both
    // malformed shapes are built from names the snapshot declares: a server
    // that validated names first and stopped there would accept them. The
    // wildcard itself is not a declared stream name, so this check is also what
    // keeps `firstUndeclaredReason` below from refusing a lone `"*"` as
    // undeclared for the wrong reason.
    const wanted = request.streams ?? [];
    const malformedListReason = this.malformedStreamListReason(wanted);
    if (malformedListReason) {
      return reject("invalid_authorization_details", malformedListReason);
    }

    // Core Section 6 request parameters (clause 6.8-1): `view` is "mutually
    // exclusive with `fields` in a request; both MUST NOT be present
    // simultaneously. AS returns 400 `invalid_request` if both are present."
    //
    // Note the error code: `invalid_request`, NOT the `invalid_authorization_details`
    // that the other refusals in this function use. That is the spec's own
    // wording for this clause and the cases assert it exactly, because a client
    // correcting a malformed request needs to tell "your request shape is
    // wrong" apart from "your selection failed validation".
    //
    // Checked before the fields are validated against the snapshot: both parts
    // are individually valid in the case that matters, so a server validating
    // each in turn never reaches a contradiction.
    const bothPresent = this.defects.has("accept-view-and-fields-together")
      ? undefined
      : wanted.find((s) => s.view !== undefined && s.fields !== undefined);
    if (bothPresent) {
      return reject(
        "invalid_request",
        `stream '${bothPresent.name}' names both view and fields, which are mutually exclusive`
      );
    }

    // A lone wildcard is well-formed and resolves against the retained snapshot
    // rather than being looked up as a stream name.
    const undeclaredReason = this.firstUndeclaredReason(wanted.filter((s) => s.name !== "*"));
    if (undeclaredReason) {
      return reject("invalid_authorization_details", undeclaredReason);
    }

    const badViewReason = this.firstBadViewReason(wanted);
    if (badViewReason) {
      return reject("invalid_authorization_details", badViewReason);
    }

    const badTimeRangeReason = this.firstBadTimeRangeReason(wanted, request.timeRange !== undefined);
    if (badTimeRangeReason) {
      return reject("invalid_authorization_details", badTimeRangeReason);
    }

    // AS-6 is a MUST NOT: an unregistered purpose_code is not grounds for
    // refusal on its own. The defect models a server treating the registry as
    // an allowlist.
    if (
      this.defects.has("reject-unregistered-purpose") &&
      request.purposeCode !== undefined &&
      !request.purposeCode.startsWith("https://pdpp.dev/purpose/")
    ) {
      return reject("invalid_authorization_details", `purpose_code '${request.purposeCode}' is not registered`);
    }

    return { status: 201, body: '{"session_id":"as_reference"}' };
  }

  async revokeGrant(grantId: string): Promise<void> {
    this.server.revokeGrant(grantId);
  }

  async ownerToken(): Promise<string | null> {
    return "owner-seeded";
  }

  async foreignSubjectOwnerToken(): Promise<string | null> {
    return "owner-foreign";
  }

  /**
   * A token bound to a grant carrying `version` as its GRANT SCHEMA version
   * (clause 7.4-2), whatever that version is.
   *
   * Issues the grant through the ordinary path so the token is genuine and
   * everything else about it is correct: the ONLY thing distinguishing the
   * negative from the positive control is the schema version, which is what
   * makes the refusal attributable to this clause rather than to a token the
   * server was never going to honour.
   */
  async grantWithSchemaVersion(
    version: string,
    request: GrantRequest
  ): Promise<{ accessToken: string; grantId: string } | null> {
    const resolved = this.resolveStreams(request);
    if (!resolved) {
      return null;
    }
    const issued = this.server.issueGrant(
      resolved.map((s) => ({ name: s.name, fields: [...s.fields] })),
      { schemaVersion: version }
    );
    if (!issued || "deniedReason" in issued) {
      return null;
    }
    return { accessToken: issued.accessToken, grantId: issued.grantId };
  }

  /**
   * A genuine grant-bound token whose introspection result reports `kind`
   * (clause 8.2-3).
   *
   * Issues a real grant first, so the token has something to be bound to and
   * the case's negative cannot pass merely because there was nothing to serve.
   */
  async tokenWithIntrospectedKind(kind: string, request: GrantRequest): Promise<{ accessToken: string } | null> {
    const resolved = this.resolveStreams(request);
    if (!resolved) {
      return null;
    }
    const issued = this.server.issueGrant(resolved.map((s) => ({ name: s.name, fields: [...s.fields] })));
    if (!issued || "deniedReason" in issued) {
      return null;
    }
    const accessToken = this.server.mintTokenWithKind(kind, issued.grantId);
    return accessToken === null ? null : { accessToken };
  }

  /**
   * Resolve an offered URL-hosted client identity, under the same bounds the
   * Personal Server applies (clauses 6.1-2, 6.1-4).
   *
   * The allowlist semantics deliberately match `checkDeclarationUrl` in
   * personal-server-ts (`packages/core/src/pdpp/declaration.ts`, read
   * read-only): an EXACT hostname match against a configured trusted-host list.
   * They match so that a target passing here and a target passing there are
   * being held to the same rule — a suite whose reference target enforced a
   * looser or stricter allowlist would report the two implementations
   * differently for reasons that have nothing to do with the clause.
   *
   * The suite serves the document over real HTTP (`documentUrl`), so this
   * performs a genuine outbound fetch rather than being handed a body. That is
   * what makes the malformed case mean anything: a document the AS never
   * retrieved cannot be a document it wrongly accepted.
   *
   * Loopback is permitted here and ONLY here, because the suite's document
   * server is necessarily on loopback. The Personal Server's equivalent switch
   * is `allowInsecureForTesting`; naming the same concession explicitly keeps
   * this from looking like a missing SSRF guard.
   */
  async offerUrlHostedClientIdentity(offer: UrlHostedClientOffer): Promise<UrlHostedClientOutcome> {
    const refuse = (errorCode: string, message: string): UrlHostedClientOutcome => ({
      accepted: false,
      status: 400,
      errorCode,
      body: JSON.stringify({ error: errorCode, error_description: message }),
      documentFetched: false,
    });

    let parsed: URL;
    try {
      parsed = new URL(offer.documentUrl);
    } catch {
      return refuse("invalid_client", "client_id is not a URL-hosted identity");
    }

    // The SSRF gate, before any network call — exact hostname match, as the
    // Personal Server does.
    if (!URL_HOSTED_TRUSTED_HOSTS.includes(parsed.hostname)) {
      return refuse(
        "untrusted_client_url",
        `client_id host '${parsed.hostname}' is not in this deployment's client trust policy`
      );
    }

    let body: string;
    let status: number;
    try {
      const { status: fetched, text } = await fetch(parsed.toString()).then(async (response) => ({
        status: response.status,
        text: await response.text(),
      }));
      status = fetched;
      body = text;
    } catch (error) {
      return refuse("fetch_failed", error instanceof Error ? error.message : String(error));
    }
    if (status !== 200) {
      return { ...refuse("fetch_failed", `client_id document returned ${status}`), documentFetched: true };
    }

    const invalid = (message: string): UrlHostedClientOutcome => ({
      ...refuse("invalid_client", message),
      documentFetched: true,
    });

    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      return invalid("client_id document is not valid JSON");
    }
    if (typeof document !== "object" || document === null) {
      return invalid("client_id document is not a JSON object");
    }
    const fields = document as { client_id?: unknown; redirect_uris?: unknown };

    // The identity check: the document must assert the URL it came from.
    // Without it, any trusted host could publish a document claiming to be
    // someone else's client.
    if (fields.client_id !== offer.documentUrl && !this.defects.has("accept-unbound-url-hosted-client-document")) {
      return invalid("client_id document does not assert the URL it was retrieved from");
    }
    const redirectUris = Array.isArray(fields.redirect_uris)
      ? fields.redirect_uris.filter((uri): uri is string => typeof uri === "string" && uri.length > 0)
      : [];
    if (redirectUris.length === 0) {
      return invalid("client_id document declares no usable redirect_uris");
    }
    if (!redirectUris.includes(offer.redirectUri)) {
      return invalid(`redirect_uri '${offer.redirectUri}' is not declared by the client_id document`);
    }

    // Accepted on identity. `reject-unregistered-url-hosted-client` is the
    // 6.1-2 violation: the document is valid and the ONLY thing wrong with the
    // client is that this AS never preregistered it.
    if (this.defects.has("reject-unregistered-url-hosted-client")) {
      return {
        accepted: false,
        status: 400,
        errorCode: "unregistered_client",
        body: JSON.stringify({
          error: "unregistered_client",
          error_description: "client is not preregistered with this authorization server",
        }),
        documentFetched: true,
      };
    }
    return { accepted: true, status: 200, documentFetched: true };
  }

  /** Write one field of a seeded record, stamping a new version (8.9-13, 8.9-14). */
  async writeRecordField(stream: string, recordId: string, field: string, value: unknown): Promise<boolean> {
    return this.server.writeField(stream, recordId, field, value);
  }

  async expiredGrantToken(): Promise<string | null> {
    const issued = this.server.issueGrant(
      this.fixtures.map((f) => ({ name: f.name, fields: [...f.fields] })),
      { expired: true }
    );
    return issued && "accessToken" in issued ? issued.accessToken : null;
  }
}

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
  GrantRequest,
  IssuedGrant,
  SeededStream,
  SelectionOutcome,
  SelectionRequest,
  TargetAdapter,
  TargetCapabilities,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";
import { type Defect, PDPP_VERSION, ReferenceServer, type StreamFixture } from "./reference-server.ts";

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
  // The reference target does not implement incremental sync, single-use
  // grants, refresh tokens, or blobs. Declaring them absent is what turns the
  // dependent requirements into `unsupported` rather than false passes.
  incrementalSync: false,
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

export class ReferenceTargetAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion = "0.1.0";
  readonly roles = ROLES;
  readonly capabilities = CAPABILITIES;
  private readonly server: ReferenceServer;
  private readonly fixtures: readonly StreamFixture[];
  private readonly defects: ReadonlySet<Defect>;

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

  async issueGrant(request: GrantRequest): Promise<IssuedGrant | null> {
    if (request.accessMode === "single_use") {
      // Not supported; declared absent in capabilities, so AS-10 is unsupported.
      return null;
    }
    // Core Section 5 "View evolution": a view name in a request is resolved to
    // a field list AT ISSUANCE, and the resolved list is what the grant is
    // bound to. Resolving here — rather than storing the view name on the
    // grant — is what makes clause 5.6-2a true of this target: a later
    // `widenView` cannot reach a grant that never retained the name.
    const resolved: { name: string; fields: readonly string[]; view?: string }[] = [];
    for (const s of request.streams) {
      if (s.view === undefined) {
        resolved.push({ name: s.name, fields: [...s.fields] });
        continue;
      }
      const viewFields = this.resolveView(s.name, s.view);
      if (!viewFields) {
        // An unrecognized view is not a field list. Refusing is correct and
        // reports `unsupported` rather than inventing a projection.
        return null;
      }
      resolved.push({ name: s.name, fields: [...viewFields], view: s.view });
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
    return {
      grantId: issued.grantId,
      accessToken: issued.accessToken,
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

  async expiredGrantToken(): Promise<string | null> {
    const issued = this.server.issueGrant(
      this.fixtures.map((f) => ({ name: f.name, fields: [...f.fields] })),
      { expired: true }
    );
    return issued && "accessToken" in issued ? issued.accessToken : null;
  }
}

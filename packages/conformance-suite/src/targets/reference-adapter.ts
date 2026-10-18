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

import { createHash, randomBytes } from "node:crypto";
import type {
  BlobFixture,
  DeclarationOutcome,
  GrantRequest,
  IssuedGrant,
  MultiInstanceFixture,
  RefreshableGrant,
  SeededStream,
  SelectionOutcome,
  SelectionRequest,
  SourceDeclarationStream,
  SourceDeclarationSubmission,
  StagedApproval,
  TargetAdapter,
  TargetCapabilities,
  UrlHostedClientOffer,
  UrlHostedClientOutcome,
} from "../harness/adapter.ts";
import type { PdppResponse } from "../harness/http.ts";
import type { Role } from "../requirements/catalog.ts";
import {
  type Defect,
  GRANT_EXPIRES_AT,
  GRANT_SCHEMA_VERSION,
  PDPP_VERSION,
  ReferenceServer,
  SEEDED_INSTANCE,
  type StreamFixture,
} from "./reference-server.ts";
import { compareDateTimes, parseDateTime, parseFullDate } from "./rfc3339.ts";

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
      // Records beyond the first, so the RS-7 cases that each delete one record
      // (tombstone, and tombstone-under-`fields`) leave a live record behind.
      {
        id: "conv_3",
        title: "Recipes",
        source_created_at: "2026-03-27T11:00:00Z",
      },
      // Four more, spread on both sides of the middle of the date range, so the
      // sync-visibility cases can build a time window with records in and out
      // of it and still delete a few without emptying the stream.
      { id: "conv_4", title: "Garden notes", source_created_at: "2026-03-20T08:00:00Z" },
      { id: "conv_5", title: "Reading list", source_created_at: "2026-03-22T16:30:00Z" },
      { id: "conv_6", title: "Budget", source_created_at: "2026-03-28T07:45:00Z" },
      { id: "conv_7", title: "Packing", source_created_at: "2026-03-29T21:15:00Z" },
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
  // A stream with a COMPOUND primary key, one component of which is not a
  // string (clause 4.5-1).
  //
  // Both properties are load-bearing and neither alone suffices. A single-field
  // key has no array encoding to get wrong; an all-string compound key hides
  // the stringification half, because the values are already strings and a
  // server that skipped the conversion would produce the same output. The
  // `sequence` component is a number, so `["session_a","1"]` (correct) and
  // `["session_a",1]` (not) are visibly different.
  {
    name: "session_events",
    fields: ["session_id", "sequence", "kind"],
    fieldTypes: { session_id: "string", sequence: "integer", kind: "string" },
    primaryKey: ["session_id", "sequence"],
    semantics: "append_only",
    records: [
      {
        id: '["session_a","1"]',
        session_id: "session_a",
        sequence: 1,
        kind: "opened",
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
  // field. The suite records 5.2-4 as unclaimable for this reason rather than
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
  blobs: true,
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

/**
 * The source this target was onboarded with, and the only one it accepts
 * declarations under (Core Section 5 "Declaration trust").
 *
 * `ACCEPTED_AUTHORITY` stands for the operator onboarding that put this
 * declaration in place. It is internal acceptance metadata, not a member a
 * client may supply in a declaration document. `ACCEPTED_RESOURCE_ID` is the protected-resource identifier a
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
 * Both spellings are listed because hostname matching is exact and the Node
 * document server may be addressed by either name.
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
function sameStreams(a: readonly SourceDeclarationStream[], b: readonly SourceDeclarationStream[]): boolean {
  const normalize = (streams: readonly SourceDeclarationStream[]) =>
    JSON.stringify(
      [...streams]
        .map((s) => ({ name: s.name, fields: [...s.fields].sort() }))
        .sort((x, y) => x.name.localeCompare(y.name))
    );
  return normalize(a) === normalize(b);
}

/**
 * The JSON Schema dialect clause 5.2-5 fixes: "If `$schema` is present, it MUST
 * equal `https://json-schema.org/draft/2020-12/schema`."
 */
const REQUIRED_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The `type` values a meta-valid JSON Schema may declare. */
const JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

/**
 * The top-level property names an embedded stream schema declares.
 *
 * Clause 5.2-2 says `primary_key` and `cursor_field` "MUST reference fields
 * declared here" — "here" being the stream's `schema`. A stream that carries no
 * schema falls back to its `fields` list, which is the shape the trust cases
 * submit and the only description of the record those documents carry.
 */
/** Whether `field` is a top-level string field (null allowed) with format `date` or `date-time` (clause 5.4-3). */
function consentTimeFieldEligible(schema: unknown, field: string): boolean {
  const properties =
    schema !== null && typeof schema === "object" ? (schema as { properties?: unknown }).properties : undefined;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return true;
  }
  const property = (properties as Record<string, unknown>)[field];
  // An absent property is clause 5.2-3's finding and a `$ref` property is
  // clause 5.2-5's; neither is judged here.
  if (
    property === undefined ||
    (property !== null && typeof property === "object" && ("$ref" in property || "$dynamicRef" in property))
  ) {
    return true;
  }
  if (property === null || typeof property !== "object") {
    return false;
  }
  const { type, format } = property as { type?: unknown; format?: unknown };
  const types = (Array.isArray(type) ? type : [type]).filter((t) => t !== "null");
  return types.length === 1 && types[0] === "string" && (format === "date" || format === "date-time");
}

/** Order two time_range bounds of one RFC 3339 format, or null when either is not a valid value of it. */
function compareBounds(format: "date" | "date-time", a: unknown, b: unknown): number | null {
  if (format === "date") {
    const [da, db] = [parseFullDate(a), parseFullDate(b)];
    if (da === null || db === null) {
      return null;
    }
    if (da === db) {
      return 0;
    }
    return da < db ? -1 : 1;
  }
  const [ta, tb] = [parseDateTime(a), parseDateTime(b)];
  return ta === null || tb === null ? null : compareDateTimes(ta, tb);
}

function declaredFieldNames(stream: SourceDeclarationStream): ReadonlySet<string> {
  const { schema } = stream;
  const properties =
    schema !== null && typeof schema === "object" ? (schema as { properties?: unknown }).properties : undefined;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    return new Set(Object.keys(properties));
  }
  return new Set(stream.fields);
}

/**
 * The clause-5.2-5 violation one key of a schema object carries, if any.
 *
 * Split out from the recursive walk below so each obligation reads as one
 * condition: the dialect, the reference locality, and the metaschema's
 * constraint on `type`.
 */
function schemaKeyViolation(key: string, child: unknown, childPath: string): string | undefined {
  if (key === "$schema" && child !== REQUIRED_SCHEMA_DIALECT) {
    return `${childPath} declares dialect '${String(child)}', but Core fixes ${REQUIRED_SCHEMA_DIALECT}`;
  }
  // "Embedded `$ref` and `$dynamicRef` values MUST be local fragment
  // references." A remote reference makes consent interpretation depend on a
  // document the AS does not retain and cannot freeze.
  if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) {
    return `${childPath} is not a local fragment reference`;
  }
  // A `type` that names no JSON Schema type fails meta-validation: the
  // metaschema constrains it to the seven core types.
  if (key === "type") {
    const names = Array.isArray(child) ? child : [child];
    const unknown = names.find((name) => typeof name === "string" && !JSON_SCHEMA_TYPES.has(name));
    if (unknown !== undefined) {
      return `${childPath} declares '${String(unknown)}', which is not a JSON Schema type`;
    }
  }
  return undefined;
}

/**
 * Whether an embedded stream schema meta-validates and keeps its references
 * local (clause 5.2-5).
 *
 * Not a full JSON Schema meta-validator, and does not pretend to be: it checks
 * the two properties the clause states and one structural invariant a
 * meta-validator would catch. A real AS would run the 2020-12 metaschema; the
 * point here is that the oracle can tell a target that checks from one that
 * does not, and each defect is a document a metaschema genuinely rejects.
 */
function schemaViolation(schema: unknown, path: string): string | undefined {
  if (schema === null || typeof schema !== "object") {
    return `${path} is not a JSON Schema object`;
  }
  if (Array.isArray(schema)) {
    for (const [index, child] of schema.entries()) {
      // Array members are schemas (`allOf`) or plain values (`type`, `enum`,
      // `required`); only an object member is itself a schema to walk.
      if (child === null || typeof child !== "object") {
        continue;
      }
      const nested = schemaViolation(child, `${path}/${index}`);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(schema as Record<string, unknown>)) {
    const childPath = `${path}/${key}`;
    const violation =
      schemaKeyViolation(key, child, childPath) ??
      (child !== null && typeof child === "object" ? schemaViolation(child, childPath) : undefined);
    if (violation) {
      return violation;
    }
  }
  return undefined;
}

/** One stream of a request, after view resolution. */
interface ResolvedStream {
  fields: readonly string[];
  name: string;
  view?: string;
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
  /** The streams and fields each staged approval's artifact states, keyed by handle (`reviewedStreams`). */
  private readonly reviewed = new Map<string, readonly { name: string; fields: readonly string[] }[]>();
  /**
   * Declarations accepted so far, keyed by the accepted authority binding,
   * `source.id` and `declaration_version` — exactly the key Core Section 5
   * names. Clause 5.8-4's obligation is stated against this key, and holding
   * the retained CONTENT (not merely the key) is what lets a case check that a
   * refused equivocation left the previous content in place.
   */
  private readonly acceptedDeclarations = new Map<string, readonly SourceDeclarationStream[]>();

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
   * Two refusals, checked in the order the spec states them, each gated by
   * its own defect so the oracles can be shown to discriminate independently:
   *
   * 1. A `provider_native` `source.id` that is not the accepted
   *    protected-resource identifier (5.8-2). Refused "before consent or grant
   *    issuance", which is here.
   * 2. Different parsed content under an already-accepted key (5.8-4). Both
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
    const key = `${ACCEPTED_AUTHORITY}\u0000${declaration.source.id}\u0000${declaration.declarationVersion}`;
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

    // Clause 6.6-2: an unrecognized `source.kind` is refused, not defaulted.
    if (
      declaration.source.kind !== "connector" &&
      declaration.source.kind !== "provider_native" &&
      !this.defects.has("accept-unrecognized-source-kind")
    ) {
      return refuse("invalid_declaration", `source.kind '${declaration.source.kind}' is not recognized`);
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

    // Clause 6.9-1: "Each selection preset MUST NOT contain the same stream
    // name more than once. Duplicate stream names make the declaration
    // invalid. They are not deferred to grant issuance." So the refusal is on
    // the DOCUMENT, before anything is retained — a server that accepted it and
    // deduplicated at issuance would have retained a declaration the owner's
    // consent is then written against, whose meaning nobody agreed on.
    const duplicatePreset = this.defects.has("accept-duplicate-preset-stream")
      ? undefined
      : (declaration.selectionPresets ?? []).find((preset) => new Set(preset.streams).size !== preset.streams.length);
    if (duplicatePreset) {
      return refuse(
        "invalid_declaration",
        `selection preset '${duplicatePreset.name}' names the same stream more than once, which makes the declaration invalid`
      );
    }

    // Declaration VALIDITY, after trust and before retention — the order Core
    // states. A document that fails validity must never reach the retained set,
    // because the retained declaration is what the owner's consent is written
    // against.
    const invalid = this.declarationValidityViolation(declaration);
    if (invalid) {
      return refuse(invalid.errorCode, invalid.message);
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
   * The first declaration-validity clause this document violates, if any
   * (clauses 5.2-2, 5.2-3, 5.2-5).
   *
   * Separate from the trust checks in `submitDeclaration` because the questions
   * are separate: trust asks whose document this is, validity asks whether it
   * says anything coherent. A server can implement either without the other,
   * and keeping them apart is what lets each clause carry its own defect.
   *
   * Every check is gated by its own defect, and they have to be separate: the
   * checks run in sequence, so one shared defect would let an earlier refusal
   * mask a later oracle and leave it passing against a server that never
   * implements the clause it owns.
   */
  private declarationValidityViolation(
    declaration: SourceDeclarationSubmission
  ): { readonly errorCode: string; readonly message: string } | undefined {
    for (const stream of declaration.streams) {
      const violation = this.streamValidityViolation(stream);
      if (violation) {
        return violation;
      }
    }

    return undefined;
  }

  /** The first per-stream validity clause `stream` violates (5.2-2, 5.2-3, 5.2-5). */
  private streamValidityViolation(
    stream: SourceDeclarationStream
  ): { readonly errorCode: string; readonly message: string } | undefined {
    const declared = declaredFieldNames(stream);

    // Clause 4.2-1: an unrecognized `streams[].semantics` is refused.
    if (
      stream.semantics !== undefined &&
      stream.semantics !== "append_only" &&
      stream.semantics !== "mutable_state" &&
      !this.defects.has("accept-unrecognized-semantics")
    ) {
      return {
        errorCode: "invalid_declaration",
        message: `stream '${stream.name}' declares unrecognized semantics '${stream.semantics}'`,
      };
    }

    // Clause 5.2-6: `consent_time_content_may_exceed` is a boolean.
    if (
      stream.consentTimeContentMayExceed !== undefined &&
      typeof stream.consentTimeContentMayExceed !== "boolean" &&
      !this.defects.has("accept-non-boolean-may-exceed")
    ) {
      return {
        errorCode: "invalid_declaration",
        message: `stream '${stream.name}' declares a non-boolean consent_time_content_may_exceed`,
      };
    }

    // Clause 5.2-5. First, because a schema that does not meta-validate cannot
    // settle what "a field declared here" even means for 5.2-2 and 5.2-3.
    if (stream.schema !== undefined && !this.defects.has("accept-invalid-embedded-schema")) {
      const violation = schemaViolation(stream.schema, `/streams/${stream.name}/schema`);
      if (violation) {
        return { errorCode: "invalid_declaration_schema", message: violation };
      }
    }

    // Clause 5.2-2.
    if (!this.defects.has("accept-undeclared-key-field-reference")) {
      const unknownKey = (stream.primaryKey ?? []).find((field) => !declared.has(field));
      if (unknownKey !== undefined) {
        return {
          errorCode: "invalid_declaration",
          message: `stream '${stream.name}' names primary_key field '${unknownKey}', which its schema does not declare`,
        };
      }
      if (stream.cursorField !== undefined && !declared.has(stream.cursorField)) {
        return {
          errorCode: "invalid_declaration",
          message: `stream '${stream.name}' names cursor_field '${stream.cursorField}', which its schema does not declare`,
        };
      }
    }

    // Clause 5.2-3. Its own defect, not 5.2-2's: `consent_time_field` is the
    // field the owner's time_range consent is evaluated against, and a server
    // can validate the sync-mechanics fields while leaving the consent boundary
    // unchecked — which is the more dangerous of the two.
    if (
      stream.consentTimeField !== undefined &&
      !declared.has(stream.consentTimeField) &&
      !this.defects.has("accept-undeclared-consent-time-field")
    ) {
      return {
        errorCode: "invalid_declaration",
        message: `stream '${stream.name}' names consent_time_field '${stream.consentTimeField}', which its schema does not declare`,
      };
    }

    // Clauses 5.2-3, 5.4-3, 5.4-4: the field must be a top-level string field
    // whose schema declares format `date` or `date-time` (null allowed).
    // Judged on the embedded schema, so a declaration without one is left to
    // the reference check above.
    if (
      stream.consentTimeField !== undefined &&
      stream.schema !== undefined &&
      !this.defects.has("accept-ineligible-consent-time-field") &&
      !consentTimeFieldEligible(stream.schema, stream.consentTimeField)
    ) {
      return {
        errorCode: "invalid_declaration",
        message: `stream '${stream.name}' names consent_time_field '${stream.consentTimeField}', which is not a top-level field with format date or date-time`,
      };
    }
    return undefined;
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
  private resolveOneStream(s: GrantRequest["streams"][number]): ResolvedStream | null {
    const fields = s.view === undefined ? [...s.fields] : this.resolveView(s.name, s.view);
    if (!fields) {
      return null;
    }
    return { name: s.name, fields, ...(s.view === undefined ? {} : { view: s.view }) };
  }

  /**
   * Resolve the request's streams. With `expand` (the conforming behaviour,
   * Section 9 AS item 4) a wildcard stream name becomes every declared stream
   * and an omitted field list becomes the declared fields; without it both are
   * carried through verbatim, which is what a review would then show.
   */
  private resolveStreams(request: GrantRequest, expand = true): ResolvedStream[] | null {
    const resolved: ResolvedStream[] = [];
    for (const stream of request.streams) {
      if (expand && stream.name === "*") {
        resolved.push(...this.fixtures.map((f) => ({ name: f.name, fields: [...f.fields] })));
        continue;
      }
      const one = this.resolveOneStream(stream);
      if (!one) {
        return null;
      }
      if (expand && stream.view === undefined && one.fields.length === 0) {
        one.fields = [...(this.fixtures.find((f) => f.name === stream.name)?.fields ?? [])];
      }
      resolved.push(one);
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
  /** The streams and fields the staged request's artifact states, read back from what this target published for the review. */
  async reviewedStreams(handle: string) {
    return this.reviewed.get(handle) ?? null;
  }

  async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
    const resolved = this.resolveStreams(request, !this.defects.has("carry-unexpanded-selection-into-review"));
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
      // Retention is a REQUESTED term: stated when the request carried one,
      // and falling back to this target's own default otherwise. A server
      // cannot state retention nobody asked for.
      ...(thin
        ? {}
        : {
            retention: request.retention
              ? { max_duration: request.retention.maxDuration, on_expiry: request.retention.onExpiry }
              : DEFAULT_RETENTION,
            grant_expiry: GRANT_EXPIRES_AT,
          }),
      streams: resolved.map((stream) => ({
        name: stream.name,
        fields: [...stream.fields],
        ...(thin ? {} : { instance_ids: [SEEDED_INSTANCE] }),
        resources: [],
        temporal_field: request.timeConstraint?.field ?? null,
        since: request.timeConstraint?.from ?? null,
        until: request.timeConstraint?.to ?? null,
        // Clause 7.2-2: `since` is stated as inclusive and `until` as exclusive.
        ...(request.timeConstraint && !this.defects.has("omit-bound-inclusivity-statement")
          ? { time_bounds: { since: "inclusive", until: "exclusive" } }
          : {}),
      })),
      // Rendered on the review surface, so bound exactly and attributed. The
      // `attributed_to` key is what makes the binding checkable: a bare copy of
      // the strings would satisfy "present" without satisfying "attributed".
      ...(claims?.commitments?.length ? { client_claims: this.bindClaims(claims.commitments) } : {}),
    };

    this.reviewed.set(
      handle,
      artifact.streams.map((s) => ({ name: s.name, fields: [...s.fields] }))
    );
    let redemption: { code: string; verifier: string } | null = null;
    return {
      handle,
      reviewRevision: revision,
      approvalArtifact: async () => artifact,
      approve: async (approveRevision?: string) => {
        if (
          approveRevision !== undefined &&
          approveRevision !== revision &&
          !this.defects.has("accept-forged-review-revision")
        ) {
          return null;
        }
        const grant = await this.issueGrant(request);
        if (grant) {
          redemption = await this.redeemFirstCode(grant.grantId);
        }
        return grant;
      },
      // Replays the SAME code and verifier at the token endpoint. The code stays
      // inside this adapter; the case sees only what the endpoint answered.
      replayLastCode: async () => (redemption ? await this.postCode(redemption.code, redemption.verifier) : null),
    };
  }

  /**
   * Mint the authorization code an approval hands the client, bound to a fresh
   * PKCE challenge, and make its first redemption at the token endpoint.
   * Returns the code and verifier a replay needs, or null when either step
   * could not be taken (then no replay is possible and the case reads `skip`).
   */
  private async redeemFirstCode(grantId: string): Promise<{ code: string; verifier: string } | null> {
    const verifier = randomBytes(32).toString("base64url");
    const code = this.server.mintAuthorizationCode(grantId, createHash("sha256").update(verifier).digest("base64url"));
    if (!code) {
      return null;
    }
    const first = await this.postCode(code, verifier);
    return first?.accessToken ? { code, verifier } : null;
  }

  /** POST an authorization_code redemption; null on a transport failure or an unreadable body. */
  private async postCode(
    code: string,
    verifier: string
  ): Promise<{ status: number; errorCode?: string; accessToken?: string } | null> {
    try {
      const response = await fetch(
        `${this.server.tokenEndpoint}?grant_type=authorization_code&code=${encodeURIComponent(code)}&code_verifier=${encodeURIComponent(verifier)}`,
        { method: "POST" }
      );
      const body = (await response.json()) as { access_token?: unknown; error?: unknown };
      return {
        status: response.status,
        ...(typeof body.error === "string" ? { errorCode: body.error } : {}),
        ...(typeof body.access_token === "string" ? { accessToken: body.access_token } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * The headers this target's token endpoint returned for a successful,
   * token-bearing response, lower-cased. Null on any transport failure, which
   * reports the 10.2-4 case `skip` rather than reading a failed fetch as a
   * missing header.
   */
  private async fetchTokenResponse(
    grantId: string
  ): Promise<{ headers: Record<string, string>; body: unknown } | null> {
    try {
      const response = await fetch(`${this.server.tokenEndpoint}?grant_id=${encodeURIComponent(grantId)}`);
      if (!response.ok) {
        return null;
      }
      const body: unknown = await response.json();
      return {
        headers: Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body,
      };
    } catch {
      return null;
    }
  }

  /**
   * The co-located introspection equivalent Core Section 8 allows.
   *
   * Reports the SAME resolved grant the token response does, because it is the
   * same grant — which is what the RFC 9396 Section 7 case compares. A target
   * where the two could not be compared would make that case unrunnable.
   */
  async coLocatedIntrospect(accessToken: string): Promise<PdppResponse | null> {
    return await this.server.introspect(accessToken);
  }

  async issueGrant(request: GrantRequest): Promise<IssuedGrant | null> {
    if (request.accessMode === "single_use" && !this.capabilities.singleUseGrants) {
      // Not supported; declared absent in capabilities, so AS-10 is unsupported.
      return null;
    }
    const resolved = this.resolveStreams(request);
    if (!resolved) {
      return null;
    }
    const issued = this.server.issueGrant(
      resolved.map((stream) => ({
        name: stream.name,
        fields: [...stream.fields],
        ...(request.timeConstraint ? { timeConstraint: request.timeConstraint } : {}),
        ...(stream.view === undefined ? {} : { resolvedFromView: stream.view }),
      })),
      {
        ...(request.purposeCode ? { purposeCode: request.purposeCode } : {}),
        ...(request.accessMode ? { accessMode: request.accessMode } : {}),
        ...(request.explicitAiTrainingConsent === undefined
          ? {}
          : { explicitAiTrainingConsent: request.explicitAiTrainingConsent }),
      }
    );
    if (!issued || "deniedReason" in issued) {
      return null;
    }
    // The issued grant artifact, built by the server from the grant it holds.
    // Clause 7.2-4 places `client_claims` outside the resolved grant, and the
    // case checking that reads this artifact to confirm their absence;
    // `leak-client-claims-into-grant` copies the claims in, which is the
    // violation: an unenforceable client promise becomes something a downstream
    // component may read as an authorization term.
    const claims = request.clientClaims?.commitments ?? [];
    const artifact = this.server.issuedGrantArtifact(issued.grantId);
    const rawGrant =
      artifact && this.defects.has("leak-client-claims-into-grant") && claims.length > 0
        ? { ...artifact, client_claims: { commitments: [...claims] } }
        : artifact;

    // Redeem the issued grant at the real token endpoint so the headers the
    // 10.2-4 case asserts on are the ones an HTTP client actually received.
    // Building a header map here instead would be the suite testing its own
    // constant.
    const tokenResponse = await this.fetchTokenResponse(issued.grantId);

    return {
      grantId: issued.grantId,
      accessToken: issued.accessToken,
      ...(rawGrant === null ? {} : { rawGrant }),
      ...(tokenResponse === null
        ? {}
        : { tokenResponseHeaders: tokenResponse.headers, tokenResponseBody: tokenResponse.body }),
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
      const undeclared = (wanted.fields ?? []).filter((f) => f !== "*" && !declared.fields.includes(f));
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
    timeRange: { readonly since?: unknown; readonly until?: unknown } | undefined
  ): string | null {
    if (timeRange === undefined || this.defects.has("accept-time-range-without-consent-time-field")) {
      return null;
    }
    for (const wanted of wantedStreams) {
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      if (declared && declared.consentTimeField === undefined) {
        return `stream '${wanted.name}' declares no consent_time_field, so time_range is not applicable to it`;
      }
    }
    for (const wanted of wantedStreams) {
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      const reason = declared ? this.timeRangeShapeReason(declared.consentTimeFormat ?? "date-time", timeRange) : null;
      if (reason) {
        return `stream '${wanted.name}': ${reason}`;
      }
    }
    return null;
  }

  /**
   * Why a `time_range` is unusable against a field of the given RFC 3339
   * format, or null (Core Section 6 "Time range bounds"): it must carry at
   * least one bound, each bound must have the field's type and be a valid
   * RFC 3339 value of it, and `since` must be before `until`.
   *
   * One defect per rule: the rules are checked in sequence, so a shared defect
   * would let an earlier refusal mask a later oracle.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each declaration and selection rule is its own branch with its own defect, so the checks stay in one ordered pass.
  private timeRangeShapeReason(
    format: "date" | "date-time",
    timeRange: { readonly since?: unknown; readonly until?: unknown }
  ): string | null {
    const { since, until } = timeRange;
    if (since === undefined && until === undefined) {
      return this.defects.has("accept-empty-time-range") ? null : "time_range carries neither since nor until";
    }
    const other = format === "date" ? "date-time" : "date";
    for (const [name, bound] of [
      ["since", since],
      ["until", until],
    ] as const) {
      if (bound === undefined) {
        continue;
      }
      const isOther = format === "date" ? parseDateTime(bound) !== null : parseFullDate(bound) !== null;
      if (isOther && !this.defects.has("accept-wrong-type-time-range-bound")) {
        return `${name} is a ${other} but the consent_time_field has format ${format}`;
      }
      const valid = format === "date" ? parseFullDate(bound) !== null : parseDateTime(bound) !== null;
      if (!(valid || isOther || this.defects.has("accept-invalid-time-range-bound"))) {
        return `${name} is not a valid RFC 3339 ${format}`;
      }
    }
    if (since !== undefined && until !== undefined && !this.defects.has("accept-since-not-before-until")) {
      const order = compareBounds(format, since, until);
      if (order !== null && order >= 0) {
        return "since is not before until";
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each declaration and selection rule is its own branch with its own defect, so the checks stay in one ordered pass.
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

    // Over-refusal defect: refuses a well-formed selection merely for naming
    // declared fields, which is what the AS-2 positive control must catch.
    if (
      this.defects.has("refuse-field-selection") &&
      request.streams?.some((s) => s.view === undefined && (s.fields?.length ?? 0) > 0)
    ) {
      return reject("invalid_authorization_details", "field selection is not supported");
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
    // simultaneously. The OAuth/RAR binding maps a request with both to RFC 9396
    // `invalid_authorization_details`."
    //
    // Checked before the fields are validated against the snapshot: both parts
    // are individually valid in the case that matters, so a server validating
    // each in turn never reaches a contradiction.
    const bothPresent = this.defects.has("accept-view-and-fields-together")
      ? undefined
      : wanted.find((s) => s.view !== undefined && s.fields !== undefined);
    if (bothPresent) {
      return reject(
        this.defects.has("misclassify-view-and-fields-refusal") ? "invalid_request" : "invalid_authorization_details",
        `stream '${bothPresent.name}' names both view and fields, which are mutually exclusive`
      );
    }

    // Clause 6.8-7: `["*"]` requests all permitted fields; `*` MUST then be the
    // only element. Its own check and defect: a server that validates names
    // against the snapshot would otherwise refuse `*` beside a name as an
    // undeclared field for the wrong reason, so the defect must also stop that
    // fallback from catching it (see `firstUndeclaredReason`).
    const starBeside = this.defects.has("accept-star-beside-fields")
      ? undefined
      : wanted.find((s) => s.fields?.includes("*") && s.fields.length > 1);
    if (starBeside) {
      return reject(
        "invalid_authorization_details",
        `stream '${starBeside.name}' lists '*' beside other fields; '*' must be the only element`
      );
    }

    // Clause 6.8-12: each stream request MUST carry either `fields` or `view`.
    // There is no implicit "all fields" default.
    const bare = this.defects.has("accept-stream-without-fields-or-view")
      ? undefined
      : wanted.find((s) => s.fields === undefined && s.view === undefined);
    if (bare) {
      return reject(
        "invalid_authorization_details",
        `stream '${bare.name}' carries neither fields nor view; there is no implicit all-fields default`
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

    const badTimeRangeReason = this.firstBadTimeRangeReason(wanted, request.timeRange);
    if (badTimeRangeReason) {
      return reject("invalid_authorization_details", badTimeRangeReason);
    }

    const purposeReason = this.purposeRefusalReason(request.purposeCode);
    if (purposeReason) {
      return {
        ...reject("invalid_authorization_details", purposeReason),
        refusalReason: this.defects.has("reject-unregistered-purpose") ? "registry-membership" : "local-policy",
      };
    }

    return { status: 201, body: '{"session_id":"as_reference"}' };
  }

  /**
   * Why this purpose_code is refused, or undefined.
   *
   * AS-6 is a MUST NOT: an unregistered purpose_code is not grounds for refusal
   * on its own. `reject-unregistered-purpose` models a server treating the
   * registry as an allowlist and says so. `reject-purpose-by-local-policy` is
   * the conformant counterpart (the AS "MAY reject a purpose_code based on
   * local policy"); its prose deliberately mentions the registry to prove the
   * oracle does not infer cause from text.
   */
  private purposeRefusalReason(purposeCode: string | undefined): string | undefined {
    if (purposeCode === undefined || purposeCode.startsWith("https://pdpp.dev/purpose/")) {
      return;
    }
    if (this.defects.has("reject-unregistered-purpose")) {
      return `purpose_code '${purposeCode}' is not registered`;
    }
    return this.defects.has("reject-purpose-by-local-policy")
      ? "Local policy rejects this purpose; registry membership is not the reason."
      : undefined;
  }

  /** RFC 7009 client revocation. This target takes the token as a query parameter; the hook hides that. */
  async revokeToken(
    token: string,
    hint?: "access_token" | "refresh_token"
  ): Promise<{ readonly status: number } | null> {
    const response = await fetch(
      `${this.server.revocationEndpoint}?token=${encodeURIComponent(token)}${hint ? `&token_type_hint=${hint}` : ""}`,
      { method: "POST" }
    );
    return { status: response.status };
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

  /** The fixtures belong to the seeded subject; the foreign subject's store is empty. */
  async foreignSubjectRecordIds(_stream: string): Promise<readonly string[] | null> {
    return [];
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
   * Resolve an offered URL-hosted client identity (clauses 6.1-2, 6.1-4).
   *
   * The configured trusted-host list uses exact hostname matching. This keeps
   * the reference target's behavior aligned with the clause's stated boundary.
   *
   * The suite serves the document over real HTTP (`documentUrl`), so this
   * performs a genuine outbound fetch rather than being handed a body. That is
   * what makes the malformed case mean anything: a document the AS never
   * retrieved cannot be a document it wrongly accepted.
   *
   * Loopback is permitted here and ONLY here, because the suite's document
   * server is necessarily on loopback. The explicit exception keeps this from
   * looking like a missing SSRF guard.
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

    // The hostname gate runs before any network call.
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

  /** Retire a changes_since token, so presenting it is past retention (4.3-2). */
  async expireSyncCursor(_stream: string, token: string): Promise<boolean> {
    return this.server.expireSyncCursor(token);
  }

  /** Write one field of a seeded record, stamping a new version (8.9-13, 8.9-14). */
  async writeRecordField(stream: string, recordId: string, field: string, value: unknown): Promise<boolean> {
    return this.server.writeField(stream, recordId, field, value);
  }

  /**
   * A grant over one `mutable_state` stream that lists two instance handles
   * (Core Section 7 `instance_ids`), with the records the target holds under
   * them. See `MultiInstanceFixture` for the shape the cases depend on.
   */
  async issueMultiInstanceGrant(): Promise<MultiInstanceFixture | null> {
    const seeded = this.server.provisionMultiInstanceStream();
    const fields = ["id", "label", seeded.cursorField];
    const issued = this.server.issueGrant([{ name: seeded.stream, fields, instanceIds: seeded.instanceIds }]);
    if (!issued || "deniedReason" in issued) {
      return null;
    }
    return {
      stream: seeded.stream,
      cursorField: seeded.cursorField,
      instanceIds: seeded.instanceIds,
      records: seeded.records,
      grant: {
        accessToken: issued.accessToken,
        grantId: issued.grantId,
        streams: [{ name: seeded.stream, fields }],
      },
    };
  }

  async issueRefreshableGrant(request: GrantRequest): Promise<RefreshableGrant | null> {
    const issued = await this.issueGrant(request);
    if (!issued) {
      return null;
    }
    const refreshToken = this.server.issueRefreshToken(issued.grantId);
    if (!refreshToken) {
      return null;
    }
    const wrap = (accessToken: string, token: string): RefreshableGrant => ({
      accessToken,
      refreshToken: token,
      refresh: async (presented) => {
        const next = this.server.redeemRefreshToken(presented);
        return next
          ? wrap(next.accessToken, next.refreshToken)
          : { refused: true, status: 400, errorCode: "invalid_grant" };
      },
    });
    return wrap(issued.accessToken, refreshToken);
  }

  /**
   * A seeded blob, the grant that reads it, and the blobs the negative cases
   * need: one in a stream the grant does not list, one referenced only through
   * a field the grant's projection excludes, and one whose record lies outside
   * the consent window of the windowed grant.
   *
   * `rawBytes` is the adapter's own record of what it stored, never read back
   * from the endpoint under test.
   */
  async blobFixture(): Promise<BlobFixture | null> {
    const blobs = this.server.provisionBlobStreams();
    const readable = ["id", "title", "taken_at", "blob_ref"];
    const grantRequest: GrantRequest = { streams: [{ name: blobs.stream, fields: readable }] };
    return {
      blobId: blobs.ids.blob,
      mimeType: blobs.mimeType,
      rawBytes: new Uint8Array(blobs.bytes),
      grantRequest,
      outOfGrantBlobId: blobs.ids.outOfGrant,
      projectionExcluded: { blobId: blobs.ids.outsideProjection, grantRequest },
      windowExcluded: {
        blobId: blobs.ids.outsideWindow,
        grantRequest: { ...grantRequest, timeConstraint: blobs.window },
      },
    };
  }

  async expiredGrantToken(): Promise<string | null> {
    const issued = this.server.issueGrant(
      this.fixtures.map((f) => ({ name: f.name, fields: [...f.fields] })),
      { expired: true }
    );
    return issued && "accessToken" in issued ? issued.accessToken : null;
  }
}

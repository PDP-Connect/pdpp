// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Declaration validity: whether an offered source declaration is internally
// coherent, asked of a document whose authority is already accepted.
//
// SEPARATE FROM declaration-trust.ts, and the split is the spec's. Section 5's
// trust clauses (5.8-*) ask WHOSE document this is — did an onboarding put this
// authority in place, does a provider_native source.id match the accepted
// resource, is this a second answer under a key already settled. The clauses
// here ask whether the document SAYS anything coherent: do its key and cursor
// fields exist, does its consent boundary exist, does its embedded schema
// meta-validate. A server can pass
// every trust clause and fail all three of these, because they are checked at
// different points for different reasons.
//
//   5.2-2  "`primary_key` and `cursor_field` MUST reference fields declared
//          here." ("here" = the stream's embedded schema)
//   5.2-3  `consent_time_field` "MUST reference a field declared in the schema."
//   5.2-5  "If `$schema` is present, it MUST equal
//          `https://json-schema.org/draft/2020-12/schema`. [...] The AS MUST
//          meta-validate each embedded stream schema before accepting the
//          declaration. Embedded `$ref` and `$dynamicRef` values MUST be local
//          fragment references."
//
// WHY THESE ARE NOT OBSERVABLE FROM A GRANT. All three are properties of a
// document, and a target only ever shows the suite declarations it has already
// accepted. An AS that validates nothing looks identical to one that validates
// carefully, because every declaration it happens to hold is well-formed. So
// each case here offers a document that MUST be refused and pairs it with a
// positive control differing in exactly the one property under test — a server
// that refuses everything fails rather than passes.
//
// WHY THE CONTROL IS NOT OPTIONAL. Three of these four clauses have no Section 9
// conformance item behind them, so a refusal is the only signal there is. A
// case that reported `pass` on any refusal would credit a target that rejects
// all declarations, which is not conformance — it is an AS that onboards
// nothing.

import type {
  DeclarationOutcome,
  SourceDeclarationStream,
  SourceDeclarationSubmission,
  TargetAdapter,
} from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_HOOK =
  "The adapter has no submitDeclaration hook, so what this AS accepts as a source declaration cannot be observed. Closing this needs a target that can be offered a candidate declaration without approving anything.";

/** The dialect clause 5.2-5 fixes. */
const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function outcomeEvidence(label: string, outcome: DeclarationOutcome): Evidence {
  return {
    request: { method: "POST", url: label, headers: {} },
    response: {
      status: outcome.status ?? (outcome.accepted ? 200 : 400),
      headers: {},
      body:
        typeof outcome.body === "string"
          ? outcome.body
          : JSON.stringify(outcome.body ?? { accepted: outcome.accepted, retained: outcome.retainedContent }),
    },
  };
}

/**
 * A well-formed embedded stream schema over `fields`, in the dialect Core fixes.
 *
 * Every case's control carries one, so a refusal can never be attributed to the
 * target simply not accepting embedded schemas.
 */
function schemaFor(fields: readonly string[], formats: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: Object.fromEntries(
      fields.map((field) => [
        field,
        formats[field] === undefined ? { type: "string" } : { type: "string", format: formats[field] },
      ])
    ),
    additionalProperties: false,
  };
}

/**
 * A declaration that should be accepted: accepted authority, coherent schema,
 * key and cursor fields the schema declares.
 *
 * Each case mutates exactly one property of this and submits both.
 */
function validDeclaration(streamName: string, fields: readonly string[], version: string): SourceDeclarationSubmission {
  const [first] = fields;
  return {
    declarationVersion: version,
    source: { kind: "connector", id: "https://registry.pdpp.dev/connectors/conformance" },
    streams: [
      {
        name: streamName,
        fields: [...fields],
        // The consent boundary must be an eligible type (clause 5.4-3), or the
        // control itself would be a declaration a conforming AS has to refuse.
        schema: schemaFor(fields, first === undefined ? {} : { [first]: "date-time" }),
        ...(first === undefined ? {} : { primaryKey: [first], cursorField: first, consentTimeField: first }),
      },
    ],
  };
}

/**
 * Submit the control and confirm it is accepted.
 *
 * Without this, a target that refuses every declaration satisfies all five
 * negatives below and reports fully conformant while onboarding nothing.
 */
async function acceptedControl(
  adapter: TargetAdapter,
  declaration: SourceDeclarationSubmission
): Promise<{ readonly outcome: DeclarationOutcome } | { readonly reason: string }> {
  const outcome = await adapter.submitDeclaration?.(declaration);
  if (!outcome) {
    return { reason: NO_HOOK };
  }
  if (!outcome.accepted) {
    return {
      reason: `The positive control was refused (${outcome.errorCode ?? outcome.status ?? "no code"}), so this target refuses even a well-formed declaration under its own accepted authority and the negatives below cannot distinguish correct validation from blanket refusal.`,
    };
  }
  return { outcome };
}

/**
 * A case that changes one stream member of an accepted declaration to a value
 * the AS must refuse, paired with an accepted control that differs only in
 * that member.
 */
function memberValueCase(spec: {
  readonly assertion: string;
  readonly caseId: string;
  readonly control: (stream: SourceDeclarationStream) => SourceDeclarationStream;
  readonly idPrefix: string;
  readonly label: string;
  readonly negative: (stream: SourceDeclarationStream) => SourceDeclarationStream;
  readonly requirementId: string;
  readonly violation: string;
}): ConformanceCase {
  return {
    caseId: spec.caseId,
    requirementId: spec.requirementId,
    assertion: spec.assertion,
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const version = `${spec.idPrefix}-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream.");
      }
      const control = await acceptedControl(adapter, { ...base, streams: [spec.control(stream)] });
      if ("reason" in control) {
        return skip(control.reason);
      }
      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        streams: [spec.negative(stream)],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: member set to a defined value (control)", control.outcome),
        outcomeEvidence(`declaration: ${spec.label}`, outcome),
      ];
      return outcome.accepted ? fail(spec.violation, evidence) : pass(evidence);
    },
  };
}

/** `schema` with the definition of property `name` replaced. */
function replaceProperty(schema: Record<string, unknown>, name: string, definition: unknown): Record<string, unknown> {
  return { ...schema, properties: { ...(schema.properties as Record<string, unknown>), [name]: definition } };
}

/**
 * A case for one obligation of clause 5.2-5 that bad embedded stream schemas
 * violate: the control submits the same declaration with a valid local schema,
 * and each negative must be refused.
 */
function embeddedSchemaCase(spec: {
  readonly caseId: string;
  readonly assertion: string;
  readonly negatives: (
    base: Record<string, unknown>,
    other: string
  ) => readonly { readonly label: string; readonly schema: unknown }[];
  readonly violation: string;
}): ConformanceCase {
  return {
    caseId: spec.caseId,
    requirementId: "AS-16",
    assertion: spec.assertion,
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const version = `embedded-schema-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream.");
      }
      const control = await acceptedControl(adapter, base);
      if ("reason" in control) {
        return skip(control.reason);
      }
      // The negatives alter ONE property of the control's own schema, never the
      // consent field: that one is held to its own eligibility rules (5.4-3), so
      // changing it would be refused for a different clause.
      const other = seeded.fields.find((field) => field !== stream.consentTimeField);
      const baseSchema = stream.schema as Record<string, unknown> | undefined;
      if (!(other && baseSchema)) {
        return skip("The baseline declaration has no second field and embedded schema to alter.");
      }
      const evidence = [outcomeEvidence("declaration: valid embedded schema (control)", control.outcome)];
      for (const [index, negative] of spec.negatives(baseSchema, other).entries()) {
        // biome-ignore lint/performance/noAwaitInLoops: each submission is a separate, ordered declaration to one AS.
        const outcome = await adapter.submitDeclaration?.({
          ...base,
          declarationVersion: `${version}-negative-${index}`,
          streams: [{ ...stream, schema: negative.schema }],
        });
        if (!outcome) {
          return skip(NO_HOOK);
        }
        evidence.push(outcomeEvidence(`declaration: ${negative.label}`, outcome));
        if (outcome.accepted) {
          return fail(`A declaration with ${negative.label} ${spec.violation}`, evidence);
        }
      }
      return pass(evidence);
    },
  };
}

export const DECLARATION_VALIDITY_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 5.2-2 ---
  {
    caseId: "AS-16/key-field-not-declared-in-schema-refused",
    requirementId: "AS-16",
    assertion:
      "A declaration whose cursor_field names a field its stream schema does not declare is refused, while the same declaration naming a declared field is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const [firstField] = seeded.fields;
      if (firstField === undefined) {
        return skip(`Stream '${seeded.name}' declares no fields, so no key reference can be built.`);
      }
      const version = `key-ref-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream.");
      }

      const control = await acceptedControl(adapter, base);
      if ("reason" in control) {
        return skip(control.reason);
      }

      // Identical to the control except that cursor_field names a field the
      // schema does not carry. The schema itself is untouched and valid, so a
      // refusal can only come from the cross-reference check.
      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        streams: [{ ...stream, cursorField: "field_the_schema_does_not_declare" }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence(`declaration: cursor_field '${firstField}' (control)`, control.outcome),
        outcomeEvidence("declaration: cursor_field names an undeclared field", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          "A declaration whose cursor_field names 'field_the_schema_does_not_declare' — a field its own stream schema does not declare — was accepted. Core Section 5: \"`primary_key` and `cursor_field` MUST reference fields declared here\". Retaining it means the record ordering the declaration promises is defined over a field that does not exist, which no resource server can honour; the contradiction surfaces at read time, long after the owner consented to the document.",
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 5.2-3 ---
  // Its own case, not a second assertion inside 5.2-2's. The two clauses are
  // separate sentences about separate fields, and a server can validate the
  // sync-mechanics references while leaving the consent boundary unchecked.
  // That is the more dangerous of the two: `consent_time_field` is the field a
  // `time_range` grant is evaluated against, so an undeclared one means a
  // time-bounded consent filters on nothing.
  {
    caseId: "AS-16/consent-time-field-not-declared-in-schema-refused",
    requirementId: "AS-16",
    assertion:
      "A declaration whose consent_time_field names a field its stream schema does not declare is refused, while the same declaration naming a declared field is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const [firstField] = seeded.fields;
      if (firstField === undefined) {
        return skip(`Stream '${seeded.name}' declares no fields, so no consent boundary can be named.`);
      }
      const version = `consent-time-ref-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream.");
      }

      const control = await acceptedControl(adapter, base);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        streams: [{ ...stream, consentTimeField: "consent_field_the_schema_does_not_declare" }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence(`declaration: consent_time_field '${firstField}' (control)`, control.outcome),
        outcomeEvidence("declaration: consent_time_field names an undeclared field", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          'A declaration whose consent_time_field names \'consent_field_the_schema_does_not_declare\' — a field its own stream schema does not declare — was accepted. Core Section 5 requires consent_time_field to "reference a field declared in the schema". This is the field a time_range grant is evaluated against, so retaining a declaration that names a nonexistent one means an owner who consents to "the last six months" has their boundary applied to nothing: either every record passes the filter or none does, and which one is an implementation accident.',
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 5.2-5 ---
  // The clause carries several obligations; this case exercises the one with
  // teeth and the one an implementer is least likely to reach for: a `$ref`
  // pointing at a remote document. "A declaration MUST NOT make consent
  // interpretation depend on a mutable remote schema" is the reason the whole
  // clause exists — a schema the AS never retained can change after consent
  // without anyone editing the declaration, so what the owner agreed to is
  // rewritten by a third party.
  {
    caseId: "AS-16/embedded-schema-remote-reference-refused",
    requirementId: "AS-16",
    assertion:
      "A declaration whose embedded stream schema references a remote document is refused, while the same declaration with a purely local schema is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const version = `embedded-schema-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream.");
      }

      const control = await acceptedControl(adapter, base);
      if ("reason" in control) {
        return skip(control.reason);
      }

      // The schema is otherwise identical and still declares the right dialect;
      // only one property's definition is replaced by a remote reference. A
      // server refusing this must be looking at the reference specifically.
      const [firstField] = seeded.fields;
      const remoteRefSchema = {
        $schema: SCHEMA_DIALECT,
        type: "object",
        properties: {
          ...Object.fromEntries(seeded.fields.map((field) => [field, { type: "string" }])),
          ...(firstField === undefined ? {} : { [firstField]: { $ref: "https://schemas.example/mutable/field.json" } }),
        },
        additionalProperties: false,
      };
      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        streams: [{ ...stream, schema: remoteRefSchema }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: purely local embedded schema (control)", control.outcome),
        outcomeEvidence("declaration: embedded schema with a remote $ref", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          'A declaration whose embedded stream schema resolves a field through `$ref: https://schemas.example/mutable/field.json` was accepted. Core Section 5: "Embedded `$ref` and `$dynamicRef` values MUST be local fragment references. A declaration MUST NOT make consent interpretation depend on a mutable remote schema." Retaining it means the meaning of the data the owner consented to is held at a URL the AS never fetched, never froze, and does not control — a third party can change what the consent covers without the declaration changing at all.',
          evidence
        );
      }
      return pass(evidence);
    },
  },
  embeddedSchemaCase({
    caseId: "AS-16/embedded-schema-remote-dynamic-reference-refused",
    assertion:
      "A declaration whose embedded stream schema carries a remote `$dynamicRef` or a `$ref` to a relative document is refused, while a schema with only local fragment references is accepted.",
    negatives: (base, other) => [
      {
        label: "a `$dynamicRef` to a remote document",
        schema: replaceProperty(base, other, { $dynamicRef: "https://schemas.example/mutable/meta#field" }),
      },
      { label: "a `$ref` to a relative document", schema: replaceProperty(base, other, { $ref: "field.json" }) },
    ],
    violation:
      'was accepted. Core Section 5: "Embedded `$ref` and `$dynamicRef` values MUST be local fragment references." A reference to another document makes consent interpretation depend on a schema the AS neither retained nor froze.',
  }),
  embeddedSchemaCase({
    caseId: "AS-16/embedded-schema-wrong-dialect-refused",
    assertion:
      "A declaration whose embedded stream schema states a `$schema` dialect other than 2020-12 is refused, while the same schema stating 2020-12 is accepted.",
    negatives: (base) => [
      {
        label: "`$schema: http://json-schema.org/draft-07/schema#`",
        schema: { ...base, $schema: "http://json-schema.org/draft-07/schema#" },
      },
    ],
    violation:
      'was accepted. Core Section 5: "If `$schema` is present, it MUST equal `https://json-schema.org/draft/2020-12/schema`." Accepting another dialect lets the same schema text mean different things to different validators, so what the owner consented to depends on which one reads it.',
  }),
  embeddedSchemaCase({
    caseId: "AS-16/embedded-schema-failing-metaschema-refused",
    assertion:
      "A declaration whose embedded stream schema does not meta-validate (an unknown `type`, a non-object `properties`, a non-array `required`, a negative `minLength`) is refused, while the same schema with valid keywords is accepted.",
    negatives: (base, other) => [
      {
        label: "a property whose `type` is not a JSON Schema type",
        schema: replaceProperty(base, other, { type: "pdpp_conformance_not_a_type" }),
      },
      { label: "a `properties` that is not an object", schema: { ...base, properties: [other] } },
      { label: "a `required` that is not an array", schema: { ...base, required: other } },
      {
        label: "a property with a negative `minLength`",
        schema: replaceProperty(base, other, { type: "string", minLength: -1 }),
      },
    ],
    violation:
      'was accepted. Core Section 5: "The AS MUST meta-validate each embedded stream schema before accepting the declaration." A schema that fails the metaschema has no defined meaning, so no consent can be interpreted against it.',
  }),
  // ------------------------------------------------- 4.2-1, 6.6-2, 5.2-6 ---
  // Three "unrecognized or malformed member value" refusals that share a shape:
  // the control sets the member to a value Core defines, the negative to one it
  // does not. Each has its own case and defect because a server can validate
  // one member and wave through the others.
  memberValueCase({
    caseId: "AS-22/unrecognized-stream-semantics-refused",
    requirementId: "AS-22",
    assertion:
      "A declaration whose stream states an unrecognized `semantics` value is refused, while the same declaration stating `append_only` is accepted.",
    idPrefix: "semantics",
    control: (stream) => ({ ...stream, semantics: "append_only" }),
    negative: (stream) => ({ ...stream, semantics: "event_log_v2" }),
    label: "streams[].semantics 'event_log_v2'",
    violation:
      'A declaration whose stream states `semantics: event_log_v2` was accepted. Core Section 4: "An authorization server MUST reject a declaration containing an unrecognized `streams[].semantics` value." Accepting it means a resource server later has to choose a write and sync behaviour for a stream type it cannot interpret, and guessing `append_only` or `mutable_state` applies the wrong one to the owner\'s data.',
  }),
  {
    caseId: "AS-22/unrecognized-source-kind-refused",
    requirementId: "AS-22",
    assertion:
      "A declaration stating an unrecognized `source.kind` is refused, while the same declaration stating `connector` is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const version = `source-kind-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const control = await acceptedControl(adapter, base);
      if ("reason" in control) {
        return skip(control.reason);
      }
      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        source: { ...base.source, kind: "vendor_native" },
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: source.kind 'connector' (control)", control.outcome),
        outcomeEvidence("declaration: source.kind 'vendor_native'", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          'A declaration stating `source.kind: vendor_native` was accepted. Core Section 6: "An authorization server MUST reject a declaration containing an unrecognized `source.kind`." The provenance class is recorded in consent evidence and every issued grant, so accepting a class no client can interpret frees each consumer to read it as whichever known class suits it.',
          evidence
        );
      }
      return pass(evidence);
    },
  },
  memberValueCase({
    caseId: "AS-27/non-boolean-consent-time-content-may-exceed-refused",
    requirementId: "AS-27",
    assertion:
      "A declaration whose stream states a non-boolean `consent_time_content_may_exceed` is refused, while the same declaration stating a boolean is accepted.",
    idPrefix: "may-exceed",
    control: (stream) => ({ ...stream, consentTimeContentMayExceed: true }),
    negative: (stream) => ({ ...stream, consentTimeContentMayExceed: "yes" }),
    label: "consent_time_content_may_exceed 'yes'",
    violation:
      'A declaration whose stream states `consent_time_content_may_exceed: "yes"` was accepted. Core Section 5: "The AS MUST reject a non-boolean value." The member decides whether the owner is told that matched records can hold data from outside the consented window, and a truthy string that one component reads as true and another as absent changes what the owner is shown.',
  }),

  // --------------------------------------------- 5.2-3, 5.4-3, 5.4-4 ---
  // The eligible forms are controls in the same case: a server that refuses
  // `date`, or a nullable `date-time`, is over-refusing something Core says is
  // allowed, and the negatives would otherwise credit a server that refuses
  // every consent_time_field it is offered.
  {
    caseId: "AS-27/ineligible-consent-time-field-refused",
    requirementId: "AS-27",
    assertion:
      "A declaration naming a consent_time_field that is nested, not a string, or not format date/date-time is refused, while eligible date, date-time and nullable date-time fields are accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const [first] = seeded.fields;
      if (first === undefined) {
        return skip(`Stream '${seeded.name}' declares no fields, so no consent boundary can be named.`);
      }
      const version = `consent-time-type-${Date.now()}`;
      const withProperty = (property: Record<string, unknown>, field = first): SourceDeclarationSubmission => {
        const base = validDeclaration(seeded.name, seeded.fields, version);
        const [stream] = base.streams;
        const schema = schemaFor(seeded.fields, { [first]: "date-time" }) as { properties: Record<string, unknown> };
        return {
          ...base,
          streams: [
            {
              ...(stream as SourceDeclarationStream),
              consentTimeField: field,
              schema: { ...schema, properties: { ...schema.properties, [first]: property } },
            },
          ],
        };
      };
      const control = await acceptedControl(adapter, withProperty({ type: "string", format: "date-time" }));
      if ("reason" in control) {
        return skip(control.reason);
      }
      const evidence = [outcomeEvidence("declaration: string/date-time consent_time_field (control)", control.outcome)];

      const eligible: readonly [string, Record<string, unknown>][] = [
        ["string/date", { type: "string", format: "date" }],
        ["nullable string/date-time", { type: ["string", "null"], format: "date-time" }],
      ];
      let n = 0;
      for (const [label, property] of eligible) {
        n += 1;
        // biome-ignore lint/performance/noAwaitInLoops: each submission is judged before the next so a refusal names its variant.
        const outcome = await adapter.submitDeclaration?.({
          ...withProperty(property),
          declarationVersion: `${version}-eligible-${n}`,
        });
        if (!outcome) {
          return skip(NO_HOOK);
        }
        evidence.push(outcomeEvidence(`declaration: ${label} consent_time_field (eligible)`, outcome));
        if (!outcome.accepted) {
          return fail(
            `A declaration whose consent_time_field is an eligible ${label} field was refused (${outcome.errorCode ?? outcome.status ?? "no code"}). Core Section 5: a consent_time_field MUST be a top-level field whose schema declares format date or date-time, and the schema MAY allow null; refusing an eligible type leaves a stream with that field unable to offer time-range selection.`,
            evidence
          );
        }
      }

      const ineligible: readonly [string, Record<string, unknown>, string?][] = [
        ["an epoch integer", { type: "integer" }],
        ["a string with no format", { type: "string" }],
        ["a string with format time", { type: "string", format: "time" }],
        ["a nested field", { type: "string", format: "date-time" }, "meta.created"],
      ];
      for (const [label, property, field] of ineligible) {
        n += 1;
        const submission = withProperty(property, field);
        const [stream] = submission.streams;
        const nested =
          field === undefined
            ? submission
            : {
                ...submission,
                streams: [
                  {
                    ...(stream as SourceDeclarationStream),
                    fields: [...seeded.fields, "meta"],
                    schema: {
                      ...(schemaFor(seeded.fields, { [first]: "date-time" }) as {
                        properties: Record<string, unknown>;
                      }),
                      properties: {
                        ...(
                          schemaFor(seeded.fields, { [first]: "date-time" }) as { properties: Record<string, unknown> }
                        ).properties,
                        meta: { type: "object", properties: { created: property } },
                      },
                    },
                  },
                ],
              };
        // biome-ignore lint/performance/noAwaitInLoops: each submission is judged before the next so a refusal names its variant.
        const outcome = await adapter.submitDeclaration?.({
          ...nested,
          declarationVersion: `${version}-ineligible-${n}`,
        });
        if (!outcome) {
          return skip(NO_HOOK);
        }
        evidence.push(outcomeEvidence(`declaration: consent_time_field is ${label}`, outcome));
        if (outcome.accepted) {
          return fail(
            `A declaration whose consent_time_field is ${label} was accepted. Core Section 5: a consent_time_field MUST be a top-level field whose schema declares format date or date-time, and "the AS MUST reject a declaration that names an ineligible consent_time_field". Accepting one means a time_range grant compares bounds against values with no defined order, so the owner's window is applied to nothing reliable.`,
            evidence
          );
        }
      }
      return pass(evidence);
    },
  },
];

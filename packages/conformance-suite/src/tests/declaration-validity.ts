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
// meta-validate, is its blob media type a media type at all. A server can pass
// every trust clause and fail all four of these, because they are checked at
// different points for different reasons.
//
//   4.8-1  "`mime_type` MUST be a valid IANA media type."
//   5.2-2  "`primary_key` and `cursor_field` MUST reference fields declared
//          here." ("here" = the stream's embedded schema)
//   5.2-3  `consent_time_field` "MUST reference a field declared in the schema."
//   5.2-5  "If `$schema` is present, it MUST equal
//          `https://json-schema.org/draft/2020-12/schema`. [...] The AS MUST
//          meta-validate each embedded stream schema before accepting the
//          declaration. Embedded `$ref` and `$dynamicRef` values MUST be local
//          fragment references."
//
// WHY THESE ARE NOT OBSERVABLE FROM A GRANT. All four are properties of a
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

import type { DeclarationOutcome, SourceDeclarationSubmission, TargetAdapter } from "../harness/adapter.ts";
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
function schemaFor(fields: readonly string[]): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
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
        schema: schemaFor(fields),
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

export const DECLARATION_VALIDITY_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 4.8-1 ---
  // The clause names IANA, but the oracle deliberately offers a value that is
  // not a media type in ANY registry — no `/`, no registered top-level type.
  // Offering a well-formed-but-unregistered subtype instead would test the
  // target's registry freshness rather than the clause: IANA adds subtypes
  // without a spec revision, so a conforming AS may accept one this suite has
  // never heard of.
  {
    caseId: "AS-16/blob-ref-invalid-mime-type-refused",
    requirementId: "AS-16",
    assertion:
      "A declaration whose blob_ref field declares a mime_type that is not a valid IANA media type is refused, while the same declaration with a valid media type is accepted.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const version = `blob-mime-${Date.now()}`;
      const base = validDeclaration(seeded.name, seeded.fields, version);
      const [stream] = base.streams;
      if (!stream) {
        return skip("The baseline declaration carries no stream to attach a blob_ref to.");
      }

      // The control carries a blob_ref too. A control with none would leave a
      // refusal attributable to the target not supporting blob_ref at all.
      const control = await acceptedControl(adapter, {
        ...base,
        streams: [{ ...stream, blobFields: [{ name: "attachment", mimeType: "image/jpeg" }] }],
      });
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitDeclaration?.({
        ...base,
        declarationVersion: `${version}-negative`,
        streams: [{ ...stream, blobFields: [{ name: "attachment", mimeType: "not a media type" }] }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: blob_ref mime_type image/jpeg (control)", control.outcome),
        outcomeEvidence("declaration: blob_ref mime_type 'not a media type'", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          "A declaration whose blob_ref field 'attachment' declares mime_type 'not a media type' was accepted. Core Section 4: \"`mime_type` MUST be a valid IANA media type\". The value is what every consumer uses to decide how to interpret fetched bytes, so retaining one no registry defines means each client guesses differently — and the guess is frozen into the document the owner's consent is written against.",
          evidence
        );
      }
      return pass(evidence);
    },
  },

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
];

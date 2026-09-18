// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Declaration trust: what an authorization server may accept as a source
// declaration, and what it must refuse.
//
// A source declaration is the document the owner's consent is written against.
// It says which streams exist, what fields they carry, and what the data means.
// If a client can choose that document, it can choose what the owner appears to
// be agreeing to — so Core Section 5 puts three MUSTs around acceptance:
//
//   5.8-1  "An authorization server accepts a source declaration only through
//          explicit owner or operator onboarding, an installed catalog, an
//          accepted registry entry, or explicit local provisioning. A client
//          MUST NOT introduce a new source authority or declaration URI during
//          authorization."
//   5.8-2  for a `provider_native` source, `source.id` MUST equal the
//          protected-resource identifier the AS already accepted, and a
//          mismatch MUST be rejected before consent or grant issuance.
//   5.8-4  different parsed content under an accepted (authority, source.id,
//          declaration_version) key is equivocation: the AS MUST reject it,
//          MUST retain the previously accepted content, and MUST NOT infer
//          ordering or freshness from `declaration_version`.
//
// None of this is observable from a grant. Without a submission hook the suite
// can only use declarations a target already holds, and a server that accepts
// anything is indistinguishable from one that validated carefully — every
// request it sees happens to be legitimate. So each case here offers a document
// that MUST be refused, and pairs it with a positive control that differs only
// in the one property under test, so a server refusing everything fails rather
// than passes.

import type { DeclarationOutcome, SourceDeclarationSubmission, TargetAdapter } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_HOOK =
  "The adapter has no submitDeclaration hook, so what this AS accepts as a source declaration cannot be observed. Closing this needs a target that can be offered a declaration without approving anything.";

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

/** A declaration the target should accept, used as every case's control. */
function baselineDeclaration(
  streamName: string,
  fields: readonly string[],
  version: string
): SourceDeclarationSubmission {
  return {
    declarationVersion: version,
    source: { kind: "connector", id: "https://registry.pdpp.dev/connectors/conformance" },
    streams: [{ name: streamName, fields: [...fields] }],
  };
}

/**
 * Submit the control and confirm it is accepted.
 *
 * Without this, a target that refuses every declaration satisfies all three
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

export const DECLARATION_TRUST_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 5.8-1 ---
  {
    caseId: "AS-16/unonboarded-source-authority-refused",
    requirementId: "AS-16",
    assertion:
      "A source declaration arriving under an authority the AS never onboarded is refused, so a client cannot introduce a source authority during authorization.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const control = await acceptedControl(
        adapter,
        baselineDeclaration(seeded.name, seeded.fields, "conformance-5.8-1-control")
      );
      if ("reason" in control) {
        return skip(control.reason);
      }

      // Identical to the control except for the authority: a URL the requester
      // chose, which no onboarding ever put in place.
      const outcome = await adapter.submitDeclaration?.({
        ...baselineDeclaration(seeded.name, seeded.fields, "conformance-5.8-1-negative"),
        authority: "https://attacker.example/self-asserted",
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: accepted authority (control)", control.outcome),
        outcomeEvidence("declaration: authority never onboarded", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          "A source declaration naming an authority this AS never onboarded was accepted. Core Section 5: an AS accepts a declaration only through explicit owner or operator onboarding, an installed catalog, an accepted registry entry, or explicit local provisioning, and a client MUST NOT introduce a new source authority during authorization. A server that takes the authority from the request lets the requester decide who speaks for the source — and therefore what the owner's consent is written against.",
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 5.8-2 ---
  {
    caseId: "AS-16/provider-native-source-id-mismatch-refused",
    requirementId: "AS-16",
    assertion:
      "A provider_native declaration whose source.id is not the accepted protected-resource identifier is refused before consent.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      const control = await acceptedControl(
        adapter,
        baselineDeclaration(seeded.name, seeded.fields, "conformance-5.8-2-control")
      );
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitDeclaration?.({
        declarationVersion: "conformance-5.8-2-negative",
        source: { kind: "provider_native", id: "https://not-the-accepted-resource.example/pdpp" },
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: accepted connector source (control)", control.outcome),
        outcomeEvidence("declaration: provider_native source.id mismatch", outcome),
      ];
      if (outcome.accepted) {
        return fail(
          "A provider_native declaration whose source.id is not the protected-resource identifier this AS already accepted was accepted. Core Section 5: for a provider_native source, source.id MUST be identical to the accepted protected-resource identifier, and the AS MUST reject any mismatch before consent or grant issuance. That binding is what ties the declaration to the resource server that will actually serve it: broken, the owner consents against a description of one surface while the grant reaches another.",
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 5.8-4 ---
  // Equivocation. Two obligations in one sentence, and the second is the one a
  // server is most likely to miss: refusing the new document is not enough if
  // the retained copy was already overwritten.
  {
    caseId: "AS-16/declaration-equivocation-refused-and-prior-content-retained",
    requirementId: "AS-16",
    assertion:
      "Different content under an already-accepted (authority, source.id, declaration_version) key is refused, and the previously accepted content is retained.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a declaration from.");
      }
      if (seeded.fields.length < 2) {
        return skip(
          `Stream '${seeded.name}' declares fewer than two fields, so a second document that differs in content cannot be built from it.`
        );
      }

      const version = "conformance-5.8-4-key";
      const first = baselineDeclaration(seeded.name, seeded.fields, version);
      const control = await acceptedControl(adapter, first);
      if ("reason" in control) {
        return skip(control.reason);
      }

      // The SAME key, different content: one field dropped. Core assigns
      // `declaration_version` no ordering meaning, so reusing the accepted
      // version is not an update — it is two different answers to one question.
      const narrowed = seeded.fields.slice(0, seeded.fields.length - 1);
      const second = await adapter.submitDeclaration?.({
        ...first,
        streams: [{ name: seeded.name, fields: [...narrowed] }],
      });
      if (!second) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("declaration: first document accepted under the key", control.outcome),
        outcomeEvidence("declaration: different content under the same key", second),
      ];

      if (second.accepted) {
        return fail(
          `A second declaration with different content was accepted under the same (authority, source.id, declaration_version) key '${version}'. Core Section 5: different parsed content under an accepted key is equivocation — the AS MUST reject it and MUST NOT infer ordering or freshness from declaration_version. Accepting means the document the owner's consent was written against can be changed without the owner ever seeing the change.`,
          evidence
        );
      }

      // The retention half. A server can refuse correctly and still have
      // clobbered what it held, which loses the content the owner consented
      // against just as surely as accepting would have.
      if (second.retainedContent === undefined) {
        return skip(
          "The refusal was correct, but this target does not report what it retains for the key, so the second half of the clause — that the previously accepted content survives — is unobserved. The suite will not assume retention from a refusal."
        );
      }
      const retainedFields = second.retainedContent.find((s) => s.name === seeded.name)?.fields ?? [];
      const lost = seeded.fields.filter((f) => !retainedFields.includes(f));
      if (lost.length > 0) {
        return fail(
          `The equivocating declaration was refused, but the retained content for the key no longer carries ${lost.join(", ")}. Core Section 5 requires the AS to reject the new content AND retain the previously accepted content. A server that refuses the document but has already overwritten what it held has lost the description the owner's consent was written against — the refusal is then only cosmetic.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

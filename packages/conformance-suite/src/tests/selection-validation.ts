// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Selection-time validation: what the authorization server REFUSES, and how it
// classifies the refusal.
//
// These requirements are invisible to every case that works from an issued
// grant, because an accepted request says nothing about what an unacceptable one
// would have done. A server that validates nothing produces a perfectly good
// grant for the requests these cases send — one naming a stream the declaration
// never declared, one naming both `streams` and `selection_preset`, one naming
// neither. The grant looks fine. It authorizes access the owner was never shown.
//
// So each case here sends a request that MUST be refused and asserts both the
// refusal and its classification. Classification is not decoration: Core maps
// these failures to RFC 9396 `invalid_authorization_details`, and a client that
// cannot distinguish "your request was malformed" from "the server is broken"
// cannot correct itself. Each is paired with a positive control — a request that
// differs only in the one property under test and MUST be accepted — so a server
// that refuses everything fails rather than passes.

import type { SelectionOutcome, TargetAdapter } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_HOOK =
  "The adapter has no submitSelection hook, so selection-time validation cannot be observed. Closing this needs an adapter that can submit a selection request without approving it.";

/** Core Section 6 maps selection validation failures to this RFC 9396 code. */
const SELECTION_ERROR = "invalid_authorization_details";

/**
 * Evidence for the report. `SelectionOutcome` is the adapter's summary rather
 * than a raw HTTP exchange, so the case records what it actually judged.
 */
function outcomeEvidence(label: string, outcome: SelectionOutcome): Evidence {
  return {
    request: { method: "POST", url: label, headers: {} },
    response: {
      status: outcome.status,
      headers: {},
      body: typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? null),
    },
  };
}

/**
 * A selection request the server must accept, for use as a positive control.
 *
 * Every negative case pairs with this: without it, a server that refuses all
 * selection requests — including valid ones — satisfies each refusal assertion
 * and reports as fully conformant while being entirely unusable.
 */
async function positiveControl(
  adapter: TargetAdapter,
  streamName: string
): Promise<{ readonly ok: true } | { readonly reason: string }> {
  const accepted = await adapter.submitSelection?.({ streams: [{ name: streamName }] });
  if (!accepted) {
    return { reason: NO_HOOK };
  }
  if (accepted.status >= 400) {
    return {
      reason: `The positive control was refused (${accepted.status}), so this target refuses even a valid selection request and the negative cases below cannot distinguish correct validation from blanket refusal.`,
    };
  }
  return { ok: true };
}

export const SELECTION_VALIDATION_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- AS-2 ---
  // Section 9 AS item 2: validate the selection request against the ONE retained
  // SourceDeclaration snapshot — rejecting unknown streams, unsupported
  // parameters, and unrecognized presets.
  //
  // The defect this catches is a server that takes the client's word for what a
  // source offers. It would issue a grant for a stream the declaration never
  // declared, and the owner would approve a review screen describing data that
  // does not exist in the form shown.
  {
    caseId: "AS-2/undeclared-stream-refused",
    requirementId: "AS-2",
    assertion:
      "A selection request naming a stream absent from the retained declaration is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so there is no declaration to validate against.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        streams: [{ name: "pdpp_conformance_undeclared_stream" }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: undeclared stream", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection request naming an undeclared stream was accepted (${outcome.status}). Section 9 AS item 2 requires validation against the retained SourceDeclaration snapshot: a server that accepts an undeclared stream issues a grant for data the declaration never described.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}. Core Section 6 maps a Source validation failure to that RFC 9396 code, and a client cannot correct a request it cannot classify.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  {
    caseId: "AS-2/undeclared-field-refused",
    requirementId: "AS-2",
    assertion:
      "A selection request naming a field absent from the declared stream schema is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so there is no declared schema to exceed.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        streams: [{ name: seeded.name, fields: [...seeded.fields, "pdpp_conformance_undeclared_field"] }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: undeclared field", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection request naming an undeclared field was accepted (${outcome.status}). The grant would then carry a field the declaration does not define, which no resource server can honestly serve.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  {
    caseId: "AS-2/unrecognized-preset-refused",
    requirementId: "AS-2",
    assertion:
      "A selection request naming a preset the retained declaration does not define is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so the positive control cannot be established.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        selectionPreset: "pdpp_conformance_unrecognized_preset",
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: unrecognized preset", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection request naming an undefined preset was accepted (${outcome.status}). A preset expands into concrete stream terms at issuance, so accepting an unknown one means issuing a grant whose scope the declaration never specified.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- AS-5 ---
  // Section 9 AS item 5, and Core Section 6: "Exactly one is required. Source
  // validation fails if both or neither are present."
  //
  // Both legs matter and they fail differently. A server that ignores the
  // both-present case has to pick a winner silently, and the owner reviews one
  // scope while the client believes it asked for another. A server that ignores
  // the neither-present case issues a grant with no selection at all.
  {
    caseId: "AS-5/both-streams-and-preset-refused",
    requirementId: "AS-5",
    assertion:
      "A selection request carrying both streams and selection_preset is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build the both-present request from.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        streams: [{ name: seeded.name }],
        selectionPreset: "pdpp_conformance_any_preset",
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: both streams and preset", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection request carrying both streams and selection_preset was accepted (${outcome.status}). Core Section 6 requires exactly one: a server that accepts both silently chooses which one governs, so the scope the owner reviews need not be the scope the client requested.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  {
    caseId: "AS-5/neither-streams-nor-preset-refused",
    requirementId: "AS-5",
    assertion:
      "A selection request carrying neither streams nor selection_preset is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so the positive control cannot be established.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({});
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: neither streams nor preset", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection request naming no streams and no preset was accepted (${outcome.status}). There is nothing for the owner to review and nothing for the grant to authorize.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- AS-6 ---
  // Section 9 AS item 6 is a MUST NOT, which makes it the inverse of every other
  // case here: the defect is over-refusal, not under-refusal.
  //
  // An AS that rejects any purpose_code missing from the PDPP registry turns the
  // registry into an allowlist and makes the protocol closed — a new purpose
  // could never be used before the registry caught up. The owner, not the
  // registry, decides whether a stated purpose is acceptable.
  {
    caseId: "AS-6/unregistered-purpose-not-rejected",
    requirementId: "AS-6",
    assertion: "A purpose_code absent from the PDPP registry is not rejected for that reason alone.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to request under an unregistered purpose.");
      }
      // The control isolates the variable: if a plain request is refused, a
      // refusal here says nothing about purpose handling.
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        streams: [{ name: seeded.name }],
        purposeCode: "https://pdpp-conformance.invalid/purpose/not-in-any-registry",
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: unregistered purpose_code", outcome)];
      if (outcome.status >= 400) {
        return fail(
          `A selection request was refused (${outcome.status}, "${outcome.errorCode ?? "no error code"}") when the only thing distinguishing it from the accepted control was an unregistered purpose_code. Section 9 AS item 6 states the AS MUST NOT reject a purpose_code solely because it is absent from the PDPP registry: doing so makes the registry an allowlist and the protocol closed to any purpose it has not yet enumerated.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ---------------------------------------------------------------- AS-17 ---
  // Section 9 AS item 17. The same requirement the RS carries (RS-11), on the
  // authorization server. Worth testing separately because they are different
  // code paths in every deployment the suite has seen, and the AS is the one a
  // client meets first: a client that cannot negotiate a version at the AS never
  // reaches the resource server to discover the mismatch there.
  {
    caseId: "AS-17/unsupported-version-rejected",
    requirementId: "AS-17",
    assertion: "An unsupported PDPP-Version on a selection request returns 400 unsupported_version.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a selection request from.");
      }
      const control = await positiveControl(adapter, seeded.name);
      if ("reason" in control) {
        return skip(control.reason);
      }

      const outcome = await adapter.submitSelection?.({
        streams: [{ name: seeded.name }],
        pdppVersion: "1999-01-01",
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("selection: unsupported PDPP-Version", outcome)];
      if (outcome.status !== 400) {
        return fail(
          `A selection request declaring PDPP-Version 1999-01-01 returned ${outcome.status} rather than 400. Section 9 AS item 17 requires the AS to refuse a version it does not implement: proceeding instead means the client and server disagree about the contract while both believe they agree.`,
          evidence
        );
      }
      if (outcome.errorCode !== "unsupported_version") {
        return fail(
          `The request was refused with 400, but the error code was "${outcome.errorCode ?? "absent"}" rather than unsupported_version. Core's error table names that code specifically so a client can distinguish a version mismatch — which it can retry differently — from a malformed request, which it cannot.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// v0.2 explicit authorization minima, at selection time.
//
// THESE CASES MEASURE AGAINST AN UNADOPTED PROPOSAL. Every clause below is from
// vana-com/pdpp PR #1, not from the adopted v0.1 spec, and a target that fails
// one is not non-conformant with anything anyone has agreed to. They exist
// because the program decided to build to the v0.2 draft; a report carrying
// them must name the revision, which `--spec-version 0.2` makes it do.
//
// WHY MINIMA NEED THEIR OWN CASES. v0.1's request has one axis: the client asks
// for fields and the AS resolves at or below them. v0.2 adds a second, opposite
// axis — `minimum` is the floor beneath that ceiling, the point below which the
// stream stops being worth retaining. Those two bounds make each other
// meaningful, and every failure mode here is a server that implements one and
// not the other:
//
//   - a server that validates the ceiling and ignores the floor issues a grant
//     the client cannot use, having promised it could;
//   - a server that accepts an unvalidated floor cannot enforce one, so the
//     client's guarantee is fictional and nothing says so;
//   - a server that reads a floor on a v0.1 request has silently changed which
//     revision it is speaking, and the client has no way to find out.
//
// All three produce a 201 and a plausible grant. None is visible to any case
// that works from an issued grant, which is why these are selection-time cases
// asserting a REFUSAL and its classification.
//
// EVERY NEGATIVE IS PAIRED WITH A POSITIVE CONTROL that differs in exactly the
// property under test. Without it, a server that refuses every v0.2 request —
// including by not implementing v0.2 at all — satisfies each refusal assertion
// and reports as conformant while being unable to do the thing.

import type { SelectionOutcome, SelectionRequest, TargetAdapter } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_HOOK =
  "The adapter has no submitSelection hook, so selection-time validation cannot be observed. Closing this needs an adapter that can submit a selection request without approving it.";

/**
 * PR #1 maps a malformed `minimum` to this RFC 9396 code.
 *
 * Note it is NOT `access_denied`. PR #1 keeps the two apart deliberately and
 * the distinction is the client's only route to recovery: this code means "your
 * request is malformed, fix it and resend", while `access_denied` means "the
 * owner's choices cannot meet your floor", which no resend will change.
 */
const SELECTION_ERROR = "invalid_authorization_details";

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
 * A well-formed v0.2 request the server must accept, for use as a control.
 *
 * Carries a `minimum` rather than omitting one. A control without a minimum
 * would be accepted by a server that rejects EVERY minimum it sees, and each
 * negative below would then pass against a target that has no minima support
 * at all — the precise false result these cases exist to avoid.
 */
async function v02Control(
  adapter: TargetAdapter,
  stream: { readonly name: string; readonly fields: readonly string[] }
): Promise<{ readonly ok: true } | { readonly reason: string }> {
  const [floor] = stream.fields;
  if (floor === undefined) {
    return { reason: "The seeded stream declares no fields, so no minimum can be expressed over it." };
  }
  const accepted = await adapter.submitSelection?.({
    specVersion: "0.2",
    streams: [{ name: stream.name, fields: [...stream.fields], necessity: "required", minimum: { fields: [floor] } }],
  });
  if (!accepted) {
    return { reason: NO_HOOK };
  }
  if (accepted.status >= 400) {
    return {
      reason: `This target refused a well-formed v0.2 selection request carrying a minimum (${accepted.status}${accepted.errorCode ? `, ${accepted.errorCode}` : ""}). It does not implement the v0.2 detail type, so a refusal below would be evidence of that rather than of the clause under test.`,
    };
  }
  return { ok: true };
}

/** Assert a v0.2 request was refused, and classified the way PR #1 requires. */
async function expectRefused(
  adapter: TargetAdapter,
  label: string,
  request: SelectionRequest,
  whyItMatters: string
): Promise<ReturnType<typeof pass> | null> {
  const outcome = await adapter.submitSelection?.(request);
  if (!outcome) {
    return skip(NO_HOOK);
  }
  const evidence = [outcomeEvidence(label, outcome)];
  if (outcome.status < 400) {
    return fail(`The request was accepted (${outcome.status}). ${whyItMatters}`, evidence);
  }
  if (outcome.errorCode !== SELECTION_ERROR) {
    return fail(
      `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}. PR #1 maps a malformed minimum to that code specifically, and a client that cannot tell "resend this correctly" from "the owner said no" has no way to recover.`,
      evidence
    );
  }
  return pass(evidence);
}

export const SELECTION_MINIMA_V02_CASES: readonly ConformanceCase[] = [
  {
    caseId: "AS-11/v0.2-empty-minimum-refused",
    requirementId: "AS-11",
    assertion:
      "A v0.2 selection request carrying an empty `minimum` object is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so no minimum can be expressed over one.");
      }
      const control = await v02Control(adapter, seeded);
      if ("reason" in control) {
        return skip(control.reason);
      }
      return (
        (await expectRefused(
          adapter,
          "v0.2 selection: empty minimum",
          {
            specVersion: "0.2",
            streams: [{ name: seeded.name, fields: [...seeded.fields], minimum: {} }],
          },
          "An empty minimum asserts a floor with no content. Accepting it lets a client claim a guaranteed baseline that constrains nothing, and the owner's review shows a floor that is not there."
        )) ?? skip(NO_HOOK)
      );
    },
  },

  {
    caseId: "AS-11/v0.2-minimum-field-outside-request-refused",
    requirementId: "AS-11",
    assertion:
      "A v0.2 `minimum.fields` naming a field the same request does not ask for is refused as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so no minimum can be expressed over one.");
      }
      const [first] = seeded.fields;
      if (first === undefined) {
        return skip("The seeded stream declares no fields, so no request ceiling exists to fall outside of.");
      }
      const control = await v02Control(adapter, seeded);
      if ("reason" in control) {
        return skip(control.reason);
      }
      return (
        (await expectRefused(
          adapter,
          "v0.2 selection: minimum field outside the request",
          {
            specVersion: "0.2",
            // The ceiling is one field; the floor names a second. The floor is
            // therefore unsatisfiable by construction, and the contradiction is
            // inside the single request rather than between the request and
            // anything the owner later does.
            streams: [
              {
                name: seeded.name,
                fields: [first],
                minimum: { fields: [first, "pdpp_conformance_unrequested_field"] },
              },
            ],
          },
          "A floor outside the ceiling can never be satisfied, so the request is unsatisfiable as written. A server that accepts it must resolve one of the two bounds by ignoring it, and whichever it drops, some party's understanding of the grant is wrong."
        )) ?? skip(NO_HOOK)
      );
    },
  },

  {
    caseId: "AS-11/v0.2-inverted-minimum-window-refused",
    requirementId: "AS-11",
    assertion:
      "A v0.2 `minimum.time_range` whose `since` is not before its `until` is refused as invalid_authorization_details.",
    appliesWhen: (_adapter, streams) => streams.some((s) => s.consentTimeField !== undefined),
    async run({ adapter, streams }) {
      const seeded = streams.find((s) => s.consentTimeField !== undefined);
      if (!seeded) {
        return skip("No seeded stream declares a consent_time_field, so a minimum window cannot apply to one.");
      }
      const control = await v02Control(adapter, seeded);
      if ("reason" in control) {
        return skip(control.reason);
      }
      return (
        (await expectRefused(
          adapter,
          "v0.2 selection: inverted minimum window",
          {
            specVersion: "0.2",
            streams: [
              {
                name: seeded.name,
                fields: [...seeded.fields],
                minimum: { timeRange: { since: "2026-06-01T00:00:00Z", until: "2026-01-01T00:00:00Z" } },
              },
            ],
          },
          "An inverted window describes an empty interval. A server that accepts it has either normalized the bounds — silently authorizing a window the client never asked for — or stored a floor no record can satisfy, which turns every later resolution into a refusal the client cannot explain."
        )) ?? skip(NO_HOOK)
      );
    },
  },

  {
    caseId: "AS-11/v0.2-minimum-on-v0.1-request-refused",
    requirementId: "AS-11",
    assertion: "A `minimum` carried on a v0.1 selection request is refused rather than silently ignored.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so no minimum can be expressed over one.");
      }
      const [floor] = seeded.fields;
      if (floor === undefined) {
        return skip("The seeded stream declares no fields, so no minimum can be expressed over it.");
      }

      // The control here is the V0.1 one, not the v0.2 one: this case is about
      // a v0.1 request, and it must establish that this target accepts an
      // ordinary v0.1 request before reading a refusal as being about the
      // `minimum` member rather than about the request as a whole.
      const control = await adapter.submitSelection?.({ streams: [{ name: seeded.name }] });
      if (!control) {
        return skip(NO_HOOK);
      }
      if (control.status >= 400) {
        return skip(
          `The v0.1 positive control was refused (${control.status}), so this target refuses even an ordinary v0.1 selection request and a refusal below could not be attributed to the minimum.`
        );
      }

      const outcome = await adapter.submitSelection?.({
        // No `specVersion`: this is a v0.1 request by construction, carrying a
        // member v0.1 does not define. Everything else about it is valid, so a
        // refusal can only be about the member.
        streams: [{ name: seeded.name, fields: [...seeded.fields], minimum: { fields: [floor] } }],
      });
      if (!outcome) {
        return skip(NO_HOOK);
      }
      const evidence = [outcomeEvidence("v0.1 selection carrying a v0.2 minimum", outcome)];
      if (outcome.status < 400) {
        return fail(
          `A v0.1 selection request carrying a v0.2 \`minimum\` was accepted (${outcome.status}). The member is not part of v0.1, so the server has either honoured a floor under a revision that does not define one — speaking v0.2 while the client believes it is speaking v0.1 — or dropped it, leaving the client with a guarantee it thinks it has and does not. Neither is visible in the issued grant, which is why this must be refused at selection time.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

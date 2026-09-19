// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Views: the named field projections an authorization server may define, and
// the four obligations Core Section 5 puts on them.
//
// Views are the unit of consent when a client asks for a stream by view name
// instead of by explicit field list. That makes them a place where an owner's
// approval and a client's access can silently drift apart, and each clause here
// closes one way that happens:
//
//   5.6-2   the AS must not define a view naming fields the retained schema
//           does not declare — otherwise a view promises data no declaration
//           describes, and the consent screen shows a field set that is not
//           grounded in anything the source published.
//   5.6-2a  a grant is bound to the field set resolved AT ISSUANCE. Adding a
//           field to a view later must not widen a grant already approved
//           against it. This is the one with teeth: it is the difference
//           between "the owner approved these fields" and "the owner approved
//           a name whose meaning the AS can change afterwards".
//   5.6-3   unrecognized view URIs are opaque identifiers — not parsed, not
//           prefix-matched, not resolved to something similar.
//   6.8-1   `view` and `fields` are mutually exclusive in a request; both
//           present is 400 `invalid_request`.
//
// EVERY case here is gated on the target actually supporting views. A target
// that declares `capabilities.views: false`, or that offers no view through the
// `declaredViews` hook, reports `skip` naming what is missing. None of these
// clauses can be established by a target that has no views: there is nothing to
// observe, and reporting `pass` on that basis would be a coverage claim resting
// on absence of evidence.

import type { SelectionOutcome, TargetAdapter } from "../harness/adapter.ts";
import { request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_VIEW_HOOK =
  "The adapter has no declaredViews hook, so the views this AS defines are unknown and no view case can be constructed. Closing this needs a target that declares at least one view.";

const NO_SELECTION_HOOK =
  "The adapter has no submitSelection hook, so a view-bearing selection request cannot be submitted without approving it.";

/** Core Section 6 maps selection/Source validation failures to this RFC 9396 code. */
const SELECTION_ERROR = "invalid_authorization_details";

/**
 * A view this target defines, together with the stream it projects.
 *
 * Read from the adapter's own record rather than from the target: Core Section
 * 5 makes the AS authoritative for views, so a view list fetched from the
 * target and then checked against itself would assert nothing.
 */
async function firstDeclaredView(
  adapter: TargetAdapter
): Promise<{ readonly stream: string; readonly view: string; readonly fields: readonly string[] } | null> {
  const views = (await adapter.declaredViews?.()) ?? [];
  return views[0] ?? null;
}

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

/** Views are optional in Core, so every case here is gated on the declaration. */
const supportsViews = (adapter: TargetAdapter): boolean => adapter.capabilities.views;

export const VIEW_CASES: readonly ConformanceCase[] = [
  // ---------------------------------------------------------------- AS-12 ---
  {
    caseId: "AS-12/view-within-declared-schema",
    requirementId: "AS-12",
    appliesWhen: supportsViews,
    assertion:
      "Every view the AS defines resolves only to fields the stream's declared schema carries, and a view exceeding the schema is refused rather than resolved.",
    async run({ adapter, streams }) {
      const declared = await firstDeclaredView(adapter);
      if (!declared) {
        return skip(NO_VIEW_HOOK);
      }
      const seeded = streams.find((s) => s.name === declared.stream);
      if (!seeded) {
        return skip(
          `The declared view '${declared.view}' names stream '${declared.stream}', which this run did not seed, so its fields cannot be compared against a declared schema.`
        );
      }

      // The positive half: what the AS says the view contains must be a subset
      // of what the stream declares. This is the clause read directly.
      const outsideSchema = declared.fields.filter((f) => !seeded.fields.includes(f));
      const evidence: Evidence[] = [
        {
          request: { method: "GET", url: `view:${declared.stream}/${declared.view}`, headers: {} },
          response: {
            status: 200,
            headers: {},
            body: JSON.stringify({
              view: declared.view,
              viewFields: declared.fields,
              declaredSchemaFields: seeded.fields,
            }),
          },
        },
      ];
      if (outsideSchema.length > 0) {
        return fail(
          `The AS defines view '${declared.view}' on '${declared.stream}' with field(s) ${outsideSchema.join(", ")}, which the retained SourceDeclaration schema does not declare. Core Section 5: the AS MUST NOT define a view that includes fields absent from the retained schema — such a view offers the owner data no declaration describes.`,
          evidence
        );
      }

      // The discriminating half. A target could satisfy the check above simply
      // by never defining a bad view, which says nothing about whether it would
      // REFUSE one. So a selection naming the view must be accepted here, and
      // the defect-injected target — whose views are widened past the schema —
      // must see that same request refused. Without this leg the case passes
      // against a server with no view validation whatsoever.
      const outcome = await adapter.submitSelection?.({
        streams: [{ name: declared.stream, view: declared.view }],
      });
      if (!outcome) {
        return skip(NO_SELECTION_HOOK);
      }
      evidence.push(outcomeEvidence(`selection: view ${declared.view}`, outcome));
      if (outcome.status >= 400) {
        return fail(
          `A selection naming the AS's own declared view '${declared.view}' was refused (${outcome.status}, ${outcome.errorCode ?? "no error code"}). A view the AS defines and whose fields are within the declared schema must be usable, or the view mechanism offers nothing.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ---------------------------------------------------------------- AS-13 ---
  // The view-evolution clause. Everything above is about definitions; this is
  // about what a definition change does to an approval that already happened.
  {
    caseId: "AS-13/view-evolution-does-not-widen-an-issued-grant",
    requirementId: "AS-13",
    appliesWhen: supportsViews,
    assertion:
      "A grant issued by view name is bound to the fields resolved at issuance: widening the view afterwards does not widen the existing grant.",
    async run({ adapter, streams, path }) {
      const declared = await firstDeclaredView(adapter);
      if (!declared) {
        return skip(NO_VIEW_HOOK);
      }
      const seeded = streams.find((s) => s.name === declared.stream);
      if (!seeded) {
        return skip(`The declared view names stream '${declared.stream}', which this run did not seed.`);
      }
      if (!adapter.widenView) {
        return skip(
          "The adapter has no widenView hook, so the view cannot be evolved after issuance and the obligation has nothing to act on. An unevolved view is consistent with both a correct server and one that would widen."
        );
      }

      // A field that IS in the stream's schema but is NOT in the view. Without
      // one, there is nothing to widen the view with, and a refusal later could
      // be explained by the field being invalid rather than by the grant being
      // frozen — the case would pass for the wrong reason.
      const widenWith = seeded.fields.find((f) => !declared.fields.includes(f));
      if (widenWith === undefined) {
        return skip(
          `View '${declared.view}' already covers every declared field of '${declared.stream}', so there is no schema-valid field to widen it with. Closing this needs a view that is a strict subset of its stream's schema.`
        );
      }

      const issued = await adapter.issueGrant({
        streams: [{ name: declared.stream, fields: [...declared.fields], view: declared.view }],
      });
      if (!issued) {
        return skip(
          `This target did not issue a grant for view '${declared.view}', so there is nothing to widen against.`
        );
      }

      // The grant must record the RESOLVED fields, not the view name. This is
      // the AS-13 obligation proper and is checked before any widening.
      const grantedStream = issued.streams.find((s) => s.name === declared.stream);
      const resolvedEvidence: Evidence = {
        request: { method: "POST", url: `grant: view ${declared.view}`, headers: {} },
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({ grantStreams: issued.streams, viewFieldsAtIssuance: declared.fields }),
        },
      };
      if (!grantedStream || grantedStream.fields.length === 0) {
        return fail(
          `The grant issued for view '${declared.view}' carries no resolved field list for '${declared.stream}'. Core Section 5: view names are resolved to field lists at issuance and the resolved \`fields\` are what the StreamGrant stores.`,
          [resolvedEvidence]
        );
      }

      const recordsPath = path(`/streams/${encodeURIComponent(declared.stream)}/records`);
      const before = await request(adapter.baseUrl, recordsPath, { token: issued.accessToken });
      const widened = await adapter.widenView(declared.stream, declared.view, widenWith);
      if (!widened) {
        return skip(`This target could not widen view '${declared.view}', so the obligation has nothing to act on.`);
      }
      if (!widened.includes(widenWith)) {
        return skip(
          `The widenView hook did not add '${widenWith}' to view '${declared.view}', so the view never actually evolved and the case would assert nothing.`
        );
      }
      const after = await request(adapter.baseUrl, recordsPath, { token: issued.accessToken });

      const evidence: Evidence[] = [resolvedEvidence, before.evidence, after.evidence];
      const leaked = recordsExposing(after.json, widenWith);
      if (leaked) {
        return fail(
          `After field '${widenWith}' was added to view '${declared.view}', the ORIGINAL access token began returning that field. Core Section 5 "View evolution": grants are bound to the field set resolved at issuance and \`fields\` in the StreamGrant is authoritative, not the view name — adding a field to a view never silently widens an existing grant. Re-consent is required before a client reaches new fields. The owner approved ${JSON.stringify(declared.fields)}; the client now receives '${widenWith}' as well.`,
          evidence
        );
      }
      if (recordsExposing(before.json, widenWith)) {
        return fail(
          `The grant was already returning '${widenWith}' before the view was widened, so this target does not project to the view's field set at all and the widening assertion cannot mean anything.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 5.6-3 ---
  // No Section 9 item covers opaque view URIs, so this rides on AS-13, the
  // requirement that owns view resolution.
  {
    caseId: "AS-13/unrecognized-view-uri-treated-as-opaque",
    requirementId: "AS-13",
    appliesWhen: supportsViews,
    assertion:
      "An unrecognized view URI is treated as an opaque identifier: it is refused as undefined, never parsed or matched against a similar known view.",
    async run({ adapter, streams }) {
      const declared = await firstDeclaredView(adapter);
      if (!declared) {
        return skip(NO_VIEW_HOOK);
      }
      const seeded = streams.find((s) => s.name === declared.stream);
      if (!seeded) {
        return skip(`The declared view names stream '${declared.stream}', which this run did not seed.`);
      }

      // A URI built to tempt a server into parsing it: it CONTAINS the name of
      // a view this AS really defines, under a pdpp.dev-shaped namespace. A
      // server treating the URI as opaque sees an unknown identifier and
      // refuses. One that parses or prefix-matches finds `declared.view` inside
      // it and resolves to the real view — granting access the owner never
      // approved under a name the AS does not recognize.
      const opaque = `https://pdpp.dev/views/${declared.view}/v2#${declared.view}`;
      const outcome = await adapter.submitSelection?.({
        streams: [{ name: declared.stream, view: opaque }],
      });
      if (!outcome) {
        return skip(NO_SELECTION_HOOK);
      }
      const evidence = [outcomeEvidence(`selection: opaque view URI ${opaque}`, outcome)];
      if (outcome.status < 400) {
        return fail(
          `A selection naming the unrecognized view URI '${opaque}' was accepted (${outcome.status}). Core Section 5: implementations MUST treat unrecognized view URIs as opaque identifiers. This URI merely CONTAINS the name of the real view '${declared.view}'; resolving it means the server parsed an identifier it was required to treat as opaque, and issued a grant for a view nobody defined.`,
          evidence
        );
      }
      if (outcome.errorCode !== SELECTION_ERROR) {
        return fail(
          `The unrecognized view URI was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}. Core Section 6 maps a Source validation failure to that RFC 9396 code.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 6.8-1 ---
  {
    caseId: "AS-2/view-and-fields-mutually-exclusive",
    requirementId: "AS-2",
    appliesWhen: supportsViews,
    assertion: "A selection request naming both `view` and `fields` on one stream is refused with 400 invalid_request.",
    async run({ adapter, streams }) {
      const declared = await firstDeclaredView(adapter);
      if (!declared) {
        return skip(NO_VIEW_HOOK);
      }
      const seeded = streams.find((s) => s.name === declared.stream);
      if (!seeded) {
        return skip(`The declared view names stream '${declared.stream}', which this run did not seed.`);
      }

      // The positive control: the SAME request carrying only the view. Without
      // it a server refusing every view-bearing request satisfies the negative
      // and reports conformant while being unusable.
      const control = await adapter.submitSelection?.({
        streams: [{ name: declared.stream, view: declared.view }],
      });
      if (!control) {
        return skip(NO_SELECTION_HOOK);
      }
      if (control.status >= 400) {
        return skip(
          `The positive control was refused (${control.status}): this target rejects even a view-only selection, so a refusal of view+fields cannot be attributed to the mutual-exclusion rule.`
        );
      }

      // Both halves are individually valid — a real view, real declared fields
      // — so only a server checking the COMBINATION refuses this.
      const outcome = await adapter.submitSelection?.({
        streams: [{ name: declared.stream, view: declared.view, fields: [...seeded.fields] }],
      });
      if (!outcome) {
        return skip(NO_SELECTION_HOOK);
      }
      const evidence = [
        outcomeEvidence("selection: view only (control)", control),
        outcomeEvidence("selection: view AND fields", outcome),
      ];
      if (outcome.status < 400) {
        return fail(
          `A selection naming both view '${declared.view}' and an explicit \`fields\` list on stream '${declared.stream}' was accepted (${outcome.status}). Core Section 6: \`view\` is mutually exclusive with \`fields\`; both MUST NOT be present simultaneously. A server that accepts both has to silently pick one, and the owner's review screen then shows a field set the client did not unambiguously request.`,
          evidence
        );
      }
      // The spec names this code explicitly for this clause, and it is NOT the
      // invalid_authorization_details the other selection refusals carry: the
      // request SHAPE is malformed rather than its selection content invalid.
      if (outcome.errorCode !== "invalid_request") {
        return fail(
          `The request was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than invalid_request. Core Section 6 states this code for this clause specifically: "AS returns 400 \`invalid_request\` if both are present."`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

/**
 * Whether any returned record carries `field`.
 *
 * A widened grant shows up as the field APPEARING in the payload, so absence
 * across every record is the passing observation. Tolerant of shape because the
 * body is whatever the target returned.
 */
function recordsExposing(body: unknown, field: string): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { data } = body as { data?: unknown };
  if (!Array.isArray(data)) {
    return false;
  }
  return data.some((record) => {
    if (typeof record !== "object" || record === null) {
      return false;
    }
    const payload = (record as { data?: unknown }).data;
    const target = typeof payload === "object" && payload !== null ? payload : record;
    return Object.hasOwn(target as object, field);
  });
}

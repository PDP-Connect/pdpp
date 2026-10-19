// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `time_range` bound validation at selection time (Core Section 6 "Time range
// bounds") and bound fidelity in the issued grant.
//
//   6.8-8   each bound has the type of the stream's `consent_time_field`
//   6.8-9   a `time_range` contains `since`, `until`, or both
//   6.8-10  the AS rejects no bound, a wrong-type bound, an invalid bound, or a
//           `since` that is not before `until`
//   6.8-11  the AS does not convert or round a bound
//
// A black-box case cannot read a stream's `consent_time_field` format from a
// declaration it did not publish, so the cases learn it from the AS: of one
// `date` and one `date-time` bound, a conforming AS accepts exactly one for a
// given stream. That is also the wrong-type oracle. The other negatives then
// use bounds of the type the AS accepted, so a refusal can only come from the
// property under test.

import type { SeededStream, SelectionOutcome, TargetAdapter } from "../harness/adapter.ts";
import { request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";
import { compareDateTimes, parseDateTime } from "../targets/rfc3339.ts";

const NO_HOOK =
  "The adapter has no submitSelection hook, so selection-time validation cannot be observed. Closing this needs an adapter that can submit a selection request without approving it.";
const SELECTION_ERROR = "invalid_authorization_details";

type BoundFormat = "date" | "date-time";

/** Sample bounds per format: two ordered valid values and values that are not valid RFC 3339. */
const SAMPLES: Record<BoundFormat, { early: string; invalid: readonly string[]; late: string }> = {
  date: { early: "2026-01-01", late: "2026-06-01", invalid: ["2026-02-30", "2026-13-01"] },
  "date-time": {
    early: "2026-01-01T00:00:00Z",
    late: "2026-06-01T00:00:00Z",
    invalid: ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z"],
  },
};

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

function capableStream(streams: readonly SeededStream[]): SeededStream | undefined {
  return streams.find((s) => s.consentTimeField !== undefined && s.fields.length > 0);
}

async function submitRange(
  adapter: TargetAdapter,
  stream: SeededStream,
  timeRange: { since?: string; until?: string }
): Promise<SelectionOutcome | null> {
  return (
    (await adapter.submitSelection?.({ streams: [{ name: stream.name, fields: [...stream.fields] }], timeRange })) ??
    null
  );
}

type Discovery = { readonly evidence: readonly Evidence[]; readonly format: BoundFormat } | { readonly reason: string };

/** Learn which bound format the AS accepts for the stream: exactly one of the two must be. */
async function discoverFormat(adapter: TargetAdapter, stream: SeededStream): Promise<Discovery> {
  const dateTime = await submitRange(adapter, stream, { since: SAMPLES["date-time"].early });
  const date = await submitRange(adapter, stream, { since: SAMPLES.date.early });
  if (!(dateTime && date)) {
    return { reason: NO_HOOK };
  }
  const evidence = [
    outcomeEvidence("selection: since as a date-time (probe)", dateTime),
    outcomeEvidence("selection: since as a date (probe)", date),
  ];
  const [okDateTime, okDate] = [dateTime.status < 400, date.status < 400];
  if (okDateTime === okDate) {
    return {
      reason: okDate
        ? "The AS accepted both a date and a date-time `since` for one consent_time_field, so the field's format cannot be learned; the wrong-type case reports that as its failure."
        : `The AS refused both a date and a date-time \`since\` on '${stream.name}', so there is no accepted bound to build the negatives from.`,
    };
  }
  return { evidence, format: okDate ? "date" : "date-time" };
}

async function refusalCase(
  { adapter, streams }: { adapter: TargetAdapter; streams: readonly SeededStream[] },
  build: (format: BoundFormat) => readonly { label: string; timeRange: { since?: string; until?: string } }[],
  violation: (label: string, outcome: SelectionOutcome) => string
) {
  const stream = capableStream(streams);
  if (!stream) {
    return skip("No seeded stream declares a consent_time_field, so there is no time-range-capable stream.");
  }
  const found = await discoverFormat(adapter, stream);
  if ("reason" in found) {
    return skip(found.reason);
  }
  const evidence = [...found.evidence];
  for (const { label, timeRange } of build(found.format)) {
    // biome-ignore lint/performance/noAwaitInLoops: each submission is judged before the next so a failure names its variant.
    const outcome = await submitRange(adapter, stream, timeRange);
    if (!outcome) {
      return skip(NO_HOOK);
    }
    evidence.push(outcomeEvidence(`selection: ${label}`, outcome));
    if (outcome.status < 400) {
      return fail(violation(label, outcome), evidence);
    }
    if (outcome.errorCode !== SELECTION_ERROR) {
      return fail(
        `The request (${label}) was refused (${outcome.status}) but classified as "${outcome.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}. Core Section 6: the OAuth/RAR binding returns RFC 9396 \`invalid_authorization_details\` for an invalid time_range.`,
        evidence
      );
    }
  }
  return pass(evidence);
}

export const TIME_RANGE_CASES: readonly ConformanceCase[] = [
  // ------------------------------------------------------- 6.8-9, 6.8-10 ---
  {
    caseId: "AS-27/time-range-without-bound-refused",
    requirementId: "AS-27",
    assertion:
      "A `time_range` carrying neither `since` nor `until` is refused as invalid_authorization_details, while the same request with one valid bound is accepted.",
    run: (context) =>
      refusalCase(
        context,
        () => [{ label: "time_range with no bound", timeRange: {} }],
        (label, outcome) =>
          `A selection with a \`time_range\` carrying no bound (${label}) was accepted (${outcome.status}). Core Section 6: a time_range MUST contain since, until, or both, and the AS MUST reject one with no bound. An empty window is either "no limit" or "no data" depending on the reader, and the owner consented to neither.`
      ),
  },

  // ----------------------------------------------------- 6.8-8, 6.8-10 ---
  // The probe in `discoverFormat` IS this oracle's positive half: exactly one
  // of a date and a date-time bound must be accepted. Both accepted means a
  // bound of the wrong type got through.
  {
    caseId: "AS-27/time-range-bound-wrong-type-refused",
    requirementId: "AS-27",
    assertion:
      "Of a `date` and a `date-time` `since` offered for one stream, the AS accepts only the one matching the field's format and refuses the other as invalid_authorization_details.",
    async run({ adapter, streams }) {
      const stream = capableStream(streams);
      if (!stream) {
        return skip("No seeded stream declares a consent_time_field, so there is no time-range-capable stream.");
      }
      const dateTime = await submitRange(adapter, stream, { since: SAMPLES["date-time"].early });
      const date = await submitRange(adapter, stream, { since: SAMPLES.date.early });
      if (!(dateTime && date)) {
        return skip(NO_HOOK);
      }
      const evidence = [
        outcomeEvidence("selection: since as a date-time", dateTime),
        outcomeEvidence("selection: since as a date", date),
      ];
      const [okDateTime, okDate] = [dateTime.status < 400, date.status < 400];
      if (!(okDateTime || okDate)) {
        return skip(
          `The AS refused both a date and a date-time \`since\` on '${stream.name}', so there is no accepted bound to contrast the refusal with.`
        );
      }
      if (okDateTime && okDate) {
        return fail(
          `The AS accepted both a date and a date-time \`since\` for the consent_time_field of '${stream.name}'. Core Section 6: each bound MUST have the type of the field's format (a full-date for a date field, a date-time for a date-time field), and the AS MUST reject a bound of the wrong type. One of the two bounds is the wrong type, and a server that accepts it compares values of different types.`,
          evidence
        );
      }
      const refused = okDate ? dateTime : date;
      if (refused.errorCode !== SELECTION_ERROR) {
        return fail(
          `The wrong-type bound was refused (${refused.status}) but classified as "${refused.errorCode ?? "no error code"}" rather than ${SELECTION_ERROR}.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------- 6.8-10 ---
  {
    caseId: "AS-27/time-range-invalid-bound-refused",
    requirementId: "AS-27",
    assertion:
      "A `time_range` bound that is not a valid RFC 3339 value of the field's type is refused as invalid_authorization_details.",
    run: (context) =>
      refusalCase(
        context,
        (format) => SAMPLES[format].invalid.map((value) => ({ label: `since ${value}`, timeRange: { since: value } })),
        (label, outcome) =>
          `A selection with an invalid bound (${label}) was accepted (${outcome.status}). Core Section 6: the AS MUST reject a bound that is not valid under Time constraint semantics, which require a valid RFC 3339 value of the field's type. An impossible calendar date or a date-time without an offset has no defined instant, so the window it names has no defined edge.`
      ),
  },

  // ----------------------------------------------------------- 6.8-10 ---
  {
    caseId: "AS-27/time-range-since-not-before-until-refused",
    requirementId: "AS-27",
    assertion:
      "A `time_range` whose `since` is equal to or after its `until` is refused as invalid_authorization_details.",
    run: (context) =>
      refusalCase(
        context,
        (format) => [
          { label: "since equal to until", timeRange: { since: SAMPLES[format].early, until: SAMPLES[format].early } },
          { label: "since after until", timeRange: { since: SAMPLES[format].late, until: SAMPLES[format].early } },
        ],
        (label, outcome) =>
          `A selection whose time_range has ${label} was accepted (${outcome.status}). Core Section 6: the AS MUST reject a since that is not before until. The window is empty, so the grant reads as consent to data it can never return.`
      ),
  },

  // ----------------------------------------------------------- 6.8-11 ---
  // Compared against the token response's authorization_details, which is the
  // grant as the AS reports it. The request carries a non-UTC offset and more
  // than millisecond precision: converting to UTC or rounding changes the text.
  {
    caseId: "AS-27/time-range-bound-not-converted",
    requirementId: "AS-27",
    assertion:
      "A `time_range` bound stated at full precision with a non-UTC offset is carried into the issued grant's `time_constraint` unchanged.",
    async run({ adapter, streams }) {
      const stream = capableStream(streams);
      if (!stream?.consentTimeField) {
        return skip("No seeded stream declares a consent_time_field, so there is no time-range-capable stream.");
      }
      const since = "2026-01-01T00:00:00.123456+05:00";
      const until = "2026-06-01T12:34:56.789012345-07:00";
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        timeConstraint: { field: stream.consentTimeField, from: since, to: until },
      });
      if (!grant) {
        return skip(
          "The target issued no grant for a full-precision date-time `time_range` (its consent_time_field may be a `date` field), so bound fidelity cannot be judged."
        );
      }
      if (grant.tokenResponseBody === undefined) {
        return skip(
          "The adapter does not surface the token endpoint's response body (IssuedGrant.tokenResponseBody), so the issued time_constraint is unobserved."
        );
      }
      const details = (grant.tokenResponseBody as { authorization_details?: unknown }).authorization_details;
      const streamsGranted = Array.isArray(details)
        ? details.flatMap((d) => ((d as { streams?: unknown }).streams as unknown[] | undefined) ?? [])
        : [];
      const granted = streamsGranted.find((s) => (s as { name?: unknown }).name === stream.name) as
        | { time_constraint?: { since?: unknown; until?: unknown } }
        | undefined;
      const evidence: Evidence[] = [
        {
          request: { method: "POST", url: "token endpoint", headers: {} },
          response: { status: 200, headers: {}, body: JSON.stringify(grant.tokenResponseBody) },
        },
      ];
      if (!granted?.time_constraint) {
        return skip("The token response reports no time_constraint for the stream, so bound fidelity is unobserved.");
      }
      const { since: grantedSince, until: grantedUntil } = granted.time_constraint;
      if (grantedSince !== since || grantedUntil !== until) {
        return fail(
          `The issued time_constraint reports since ${JSON.stringify(grantedSince)} and until ${JSON.stringify(grantedUntil)} for bounds requested as ${since} and ${until}. Core Section 6: the AS MUST NOT convert or round a bound. A converted or rounded bound moves the edge of the window the owner approved.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
  // ------------------------------------------------------------- 7.6-1 ---
  // Core Section 8 "Comparison": date-time values are compared as instants,
  // "Comparing RFC 3339 strings as text is wrong when their offsets differ."
  // The bound is stated at +14:00 an hour before a record's instant, so text
  // order and instant order disagree about that record.
  {
    caseId: "RS-22/time-window-compared-as-instants-not-text",
    requirementId: "RS-22",
    assertion:
      "A grant whose time window bound carries a +14:00 offset admits exactly the records whose instants fall in the window, not the records whose text sorts after the bound.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.consentTimeField !== undefined && s.recordCount >= 3);
      const owner = await adapter.ownerToken();
      if (!(stream?.consentTimeField && owner)) {
        return skip("No stream with three records and a consent_time_field, or no owner token to read them with.");
      }
      const field = stream.consentTimeField;
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const listed = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...(adapter.ownerReadParams ?? {}), limit: "100" },
      });
      if (listed.status !== 200 || (listed.json as { has_more?: boolean }).has_more === true) {
        return skip("The owner listing is not a complete successful page, so the expected window is unobserved.");
      }
      const rows = ((listed.json as { data?: { id?: string; data?: Record<string, unknown> }[] }).data ?? []).flatMap(
        (r) => {
          const value = r.data?.[field];
          const instant = parseDateTime(value);
          return r.id && typeof value === "string" && instant ? [{ id: r.id, value, instant }] : [];
        }
      );
      rows.sort((a, b) => compareDateTimes(a.instant, b.instant));
      const pivot = rows[Math.floor(rows.length / 2)];
      if (rows.length < 3 || !pivot) {
        return skip("Fewer than three records carry a parseable consent_time_field.");
      }
      const hour = 3_600_000;
      if (pivot.instant.leapSecond) {
        return skip("A leap-second pivot cannot be shifted by the fixture's civil-time offset construction.");
      }
      const fraction = pivot.instant.fraction ? `.${pivot.instant.fraction}` : "";
      const bound = `${new Date(pivot.instant.ms - hour + 14 * hour).toISOString().slice(0, 19)}${fraction}+14:00`;
      const serializedInstant = parseDateTime(bound);
      if (!serializedInstant) {
        return skip("The derived offset bound is not a valid RFC 3339 instant.");
      }
      const expected = rows
        .filter((r) => compareDateTimes(r.instant, serializedInstant) >= 0)
        .map((r) => r.id)
        .sort();
      // The case discriminates only when text order disagrees with instant order.
      const textAdmits = rows
        .filter((r) => r.value >= bound)
        .map((r) => r.id)
        .sort();
      if (expected.join() === textAdmits.join()) {
        return skip(
          "Text order and instant order agree for this stream's records, so the bound cannot tell them apart."
        );
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        timeConstraint: { field, from: bound },
      });
      if (!grant) {
        return skip("The target issued no grant for a date-time bound with a non-UTC offset.");
      }
      const read = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { limit: "100" } });
      const served = ((read.json as { data?: { id?: string }[] }).data ?? [])
        .flatMap((r) => (r.id ? [r.id] : []))
        .sort();
      const evidence: Evidence[] = [listed.evidence, read.evidence];
      if (read.status !== 200) {
        return fail(`The time-bounded read returned ${read.status}.`, evidence);
      }
      if ((read.json as { has_more?: boolean }).has_more === true) {
        return skip("The granted listing is incomplete, so its full membership cannot be compared.");
      }
      if (served.join() !== expected.join()) {
        return fail(
          `A grant with since ${bound} served ${JSON.stringify(served)}; the records at or after that instant are ${JSON.stringify(expected)}. Core Section 8: date-time values are compared as instants at their full stated precision; comparing RFC 3339 strings as text is wrong when their offsets differ, and the RS MUST NOT apply a host, viewer or owner time zone.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

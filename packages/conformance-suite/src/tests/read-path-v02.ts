// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// v0.2 resource-server read path: disclosure to the APPROVED shape.
//
// THESE CASES MEASURE AGAINST AN UNADOPTED PROPOSAL, exactly as the v0.2
// selection-minima cases do. Every clause cited below is from vana-com/pdpp
// PR #1, not from the adopted v0.1 spec, and a target that fails one is not
// non-conformant with anything anyone has agreed to.
//
// WHY THE READ PATH NEEDS ITS OWN v0.2 CASES, given the suite already has
// RS-2's field-projection case. v0.1 has ONE projection: the client asks for
// fields, the AS resolves them, the RS serves that. v0.2 inserts a second,
// narrower one — the OWNER's choices at consent — and the read must be
// constructed from it rather than from what the client requested. The two
// coincide whenever the owner declines to narrow, which is every v0.1 journey
// and every v0.2 journey the existing cases drive. So RS-2's case passes
// unchanged against a server that has never implemented the owner's narrowing
// at all: its grant's `fields` ARE the requested fields, and no record can
// carry anything outside them.
//
// Every case here therefore begins by establishing a gap — a grant whose
// APPROVED field set is strictly narrower than the REQUESTED one — and reports
// `skip` when the target cannot produce one. That is not a formality. Without
// the gap, "no withheld field appeared" is a statement about a set that is
// empty, and a server with no projection logic whatsoever satisfies it.
//
// WHERE THE APPROVED SHAPE IS READ FROM. Not `IssuedGrant.streams`: the harness
// documents that field as falling back to the REQUESTED shape when a target's
// approval surface returns no grant body, which is precisely the case on the
// reference deployment this was developed against — a case judging against it
// would compare the response to the ceiling and call a correctly-narrowed read
// a pass for the wrong reason. The authority is the token endpoint's
// `authorization_details[].grant`, which RFC 9396 Section 7 requires the AS to
// return as GRANTED. `approvedProjection` below reads it and nothing else, and
// a target whose token response does not carry one reports `skip`.

import type { GrantRequest, IssuedGrant, SeededStream, TargetAdapter } from "../harness/adapter.ts";
import { errorBody, request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

interface ListBody {
  data?: { data?: Record<string, unknown>; id?: string }[];
  has_more?: boolean;
  next_cursor?: string;
  object?: string;
}

function asList(json: unknown): ListBody | undefined {
  return typeof json === "object" && json !== null ? (json as ListBody) : undefined;
}

/**
 * The field set the owner APPROVED for `stream`, from the token response.
 *
 * Returns undefined rather than falling back to the request, because every
 * fallback available here is the requested ceiling and using it would silently
 * turn each case below into a tautology. See the file header.
 */
function grantedStream(grant: IssuedGrant, stream: string): Record<string, unknown> | undefined {
  const details = (grant.tokenResponseBody as { authorization_details?: unknown } | undefined)?.authorization_details;
  if (!Array.isArray(details)) {
    return undefined;
  }
  for (const detail of details) {
    // RFC 9396 leaves the detail object's interior to the detail TYPE, and the
    // two revisions place the granted streams differently: v0.1's detail
    // carries `streams` at its top level, while v0.2 nests the whole resolved
    // artifact under `grant`. Reading both is not leniency — a case that
    // understood only one shape would report `skip` against every target
    // speaking the other and the absence would look like missing support.
    const nested = (detail as { grant?: { streams?: unknown } } | undefined)?.grant?.streams;
    const flat = (detail as { streams?: unknown } | undefined)?.streams;
    const streams = Array.isArray(nested) ? nested : flat;
    if (!Array.isArray(streams)) {
      continue;
    }
    const match = streams.find(
      (s): s is Record<string, unknown> =>
        typeof s === "object" && s !== null && (s as { name?: unknown }).name === stream
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

function approvedProjection(grant: IssuedGrant, stream: string): readonly string[] | undefined {
  const fields = grantedStream(grant, stream)?.fields;
  return Array.isArray(fields) && fields.every((f) => typeof f === "string")
    ? (fields as readonly string[])
    : undefined;
}

/**
 * The time window the owner APPROVED for `stream`, from the same authority.
 *
 * Separate from `approvedProjection` because the two narrowings are separate
 * obligations and a target can bind one without the other — a server that
 * applies the field choices and drops the temporal ones issues a grant that
 * looks narrowed and reads wide.
 */
function approvedTimeConstraint(
  grant: IssuedGrant,
  stream: string
): { readonly since?: string; readonly until?: string } | undefined {
  const constraint = grantedStream(grant, stream)?.time_constraint;
  if (typeof constraint !== "object" || constraint === null) {
    return undefined;
  }
  const { since, until } = constraint as { since?: unknown; until?: unknown };
  return {
    ...(typeof since === "string" ? { since } : {}),
    ...(typeof until === "string" ? { until } : {}),
  };
}

const NO_NARROWING =
  "This target did not issue a v0.2 grant whose approved field set is narrower than the requested one, so no field is withheld and disclosure to the approved shape is not observable on it. Closing this needs a target that accepts the owner's narrowing at consent and returns the resulting grant in its token response.";

/**
 * A v0.2 grant over `stream` in which the owner kept only `keep`.
 *
 * The REQUEST asks for every declared field and the CHOICES keep a prefix, so
 * the approved shape and the requested shape differ by construction. The
 * minimum is pinned at the stream's primary key: PR #1 requires the AS to
 * refuse a narrowing that falls below a required stream's floor, so a minimum
 * naming more than the owner keeps would make this helper's own request
 * unsatisfiable and every case downstream would skip for the wrong reason.
 */
async function narrowedGrant(
  adapter: TargetAdapter,
  stream: SeededStream,
  keep: readonly string[]
): Promise<
  | { readonly grant: IssuedGrant; readonly approved: readonly string[]; readonly withheld: readonly string[] }
  | { readonly reason: string }
> {
  const request_: GrantRequest = {
    specVersion: "0.2",
    streams: [
      {
        name: stream.name,
        fields: [...stream.fields],
        necessity: "required",
        minimum: { fields: [...stream.primaryKey] },
      },
    ],
    ownerChoices: { fields: { [stream.name]: [...keep] } },
  };
  const grant = await adapter.issueGrant(request_);
  if (!grant) {
    return {
      reason: `This target refused a v0.2 grant carrying the owner's narrowing over "${stream.name}". It does not implement the v0.2 consent path, so nothing below would be evidence about the read path.`,
    };
  }
  const approved = approvedProjection(grant, stream.name);
  if (!approved) {
    return {
      reason: `This target's token response carried no \`authorization_details[].grant.streams\` entry for "${stream.name}", so the approved projection cannot be read from the authority RFC 9396 Section 7 names. ${NO_NARROWING}`,
    };
  }
  const withheld = stream.fields.filter((field) => !approved.includes(field));
  if (withheld.length === 0) {
    return { reason: NO_NARROWING };
  }
  return { grant, approved, withheld };
}

/** The stream these cases narrow, and the fields the owner keeps on it. */
function narrowable(
  streams: readonly SeededStream[]
): { readonly keep: readonly string[]; readonly stream: SeededStream } | undefined {
  for (const stream of streams) {
    // The primary key stays in every narrowing: a record whose key is withheld
    // has no identity, and PR #1's disclosure rules are about the members
    // AROUND the key, not about removing it. One field beyond the key is the
    // smallest narrowing that still leaves something to withhold.
    const keep = [
      ...new Set([...stream.primaryKey, ...stream.fields.filter((f) => !stream.primaryKey.includes(f)).slice(0, 1)]),
    ];
    if (keep.length < stream.fields.length && keep.length > 0) {
      return { stream, keep };
    }
  }
  return undefined;
}

/**
 * A stream and narrowing that withholds at least one SCHEMA-REQUIRED member.
 *
 * Deliberately not `narrowable`'s choice: that one keeps the first non-key
 * field, which on a realistic fixture is exactly the field the schema marks
 * required — leaving the `v0.2/4-1` case a narrowing with nothing required to
 * re-add. The keep set here is the primary key plus the non-required members,
 * so every required member outside the key is withheld.
 */
function withRequiredFieldToWithhold(
  streams: readonly SeededStream[]
): { readonly keep: readonly string[]; readonly stream: SeededStream } | undefined {
  for (const stream of streams) {
    const required = stream.expectedOwnerMetadata?.schemaRequired ?? [];
    const requiredOutsideKey = required.filter((field) => !stream.primaryKey.includes(field));
    if (requiredOutsideKey.length === 0) {
      continue;
    }
    const keep = [...new Set([...stream.primaryKey, ...stream.fields.filter((f) => !requiredOutsideKey.includes(f))])];
    if (keep.length > 0 && keep.length < stream.fields.length) {
      return { stream, keep };
    }
  }
  return undefined;
}

function recordsPath(path: (suffix: string) => string, stream: string): string {
  return path(`/streams/${encodeURIComponent(stream)}/records`);
}

/** Every top-level `data` member name any record on the page carried. */
function disclosedMembers(json: unknown): Set<string> {
  const members = new Set<string>();
  for (const record of asList(json)?.data ?? []) {
    for (const member of Object.keys(record.data ?? {})) {
      members.add(member);
    }
  }
  return members;
}

export const READ_PATH_V02_CASES: readonly ConformanceCase[] = [
  // ------------------------------------------------ v0.2/4-2, v0.2/4-3 ---
  // "The RS MUST construct disclosed `data` from only the top-level members
  // permitted by the grant and the request-time field selection", and "MUST
  // NOT insert nulls or fabricated values for withheld members."
  //
  // Two clauses, one case, because they are two halves of one observation and
  // splitting them would mean issuing the same grant and reading the same page
  // twice to assert on the same bytes. They are also the pair that catches the
  // most common shape of this defect: a server that narrows the VALUES but
  // keeps the SHAPE, emitting `"genres": null` so the record still validates
  // against the stream schema. That server withholds nothing — a null is a
  // statement about the field, and the client cannot tell it from a record
  // whose genres really are absent.
  {
    caseId: "RS-2/v0.2-disclosure-limited-to-the-approved-shape",
    requirementId: "RS-2",
    assertion:
      "Under a v0.2 grant the owner narrowed, records disclose only the approved members, with withheld members absent rather than nulled.",
    async run({ adapter, streams, path }) {
      const target = narrowable(streams);
      if (!target) {
        return skip(
          "No seeded stream has a field outside its primary key to withhold, so no narrowing is expressible."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, approved, withheld } = arranged;

      const response = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(
          `A v0.2 grant the owner narrowed to ${approved.join(", ")} did not permit reading "${target.stream.name}": got ${response.status}. A narrowing the authorization server accepted must still yield a readable grant, or the owner's choice has silently revoked the stream.`,
          [response.evidence]
        );
      }
      const records = asList(response.json)?.data ?? [];
      if (records.length === 0) {
        return skip(
          "The read returned no records, so no disclosed `data` object exists to judge. Closing this needs the stream seeded with at least one record inside the approved projection."
        );
      }

      const disclosed = disclosedMembers(response.json);
      const leaked = withheld.filter((field) => disclosed.has(field));
      if (leaked.length > 0) {
        // Distinguish the two failure modes in the message, because they call
        // for different fixes: a null is a projection applied to values only,
        // a real value is no projection at all.
        const nulled = leaked.filter((field) =>
          records.some((record) => record.data !== undefined && field in record.data && record.data[field] === null)
        );
        const detail =
          nulled.length === leaked.length
            ? `Withheld members were present as nulls: ${leaked.join(", ")}. PR #1 \`v0.2/4-3\`: the RS "MUST NOT insert nulls or fabricated values for withheld members". A null is a disclosure — it tells the client the owner's approved shape, and a record shaped like the full one cannot be distinguished from one whose values are genuinely absent.`
            : `Members outside the owner's approved projection appeared in disclosed \`data\`: ${leaked.join(", ")}. The owner approved ${approved.join(", ")} out of the requested ${target.stream.fields.join(", ")}. PR #1 \`v0.2/4-2\`: the RS "MUST construct disclosed \`data\` from only the top-level members permitted by the grant and the request-time field selection".`;
        return fail(detail, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },

  // ------------------------------------------------------------ v0.2/4-1 ---
  // "The RS MUST NOT add a field to a response merely because the schema
  // requires it."
  //
  // Its own case rather than a clause cited on the one above, because the
  // server it catches is a DIFFERENT server. The case above catches one that
  // never projects; this one catches one that projects correctly and then
  // re-adds whatever the stream schema marks `required`, to keep the record
  // validating. That server passes the case above for every optional field and
  // fails only on the required ones — so a case that did not single out the
  // schema-required members would report it as conformant on most streams.
  //
  // The narrowing is chosen to WITHHOLD a schema-required member, which is the
  // whole precondition: a narrowing that keeps every required field leaves the
  // defect nothing to re-add, and the case would pass against the server it
  // exists to catch. `schemaRequired` is the ADAPTER's record of what it
  // declared, never read back from the target — asking the metadata endpoint
  // which members are required and then checking the response against that
  // answer would let a target that under-declares its schema pass by declaring
  // nothing required.
  {
    caseId: "RS-2/v0.2-schema-required-field-not-re-added",
    requirementId: "RS-2",
    assertion: "A member the owner withheld stays withheld even when the stream schema marks it required.",
    async run({ adapter, streams, path }) {
      const target = withRequiredFieldToWithhold(streams);
      if (!target) {
        return skip(
          "No seeded stream declares a schema-required member outside its primary key, so a narrowing that withholds one cannot be expressed and a server that re-adds required members would be indistinguishable from a correct one."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, approved, withheld } = arranged;
      const declaredRequired = target.stream.expectedOwnerMetadata?.schemaRequired ?? [];
      const withheldButRequired = withheld.filter((field) => declaredRequired.includes(field));
      if (withheldButRequired.length === 0) {
        return skip(
          `The target resolved the narrowing without withholding any schema-required member (approved ${approved.join(", ")}), so nothing here would distinguish a server that re-adds required members from one that does not.`
        );
      }

      const response = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
        query: { fields: approved.join(",") },
      });
      if (response.status !== 200) {
        return fail(
          `A request naming exactly the approved fields (${approved.join(", ")}) was refused with ${response.status}. A field selection equal to the grant's own projection is the narrowest legal read there is; refusing it means no client can read this grant at all.`,
          [response.evidence]
        );
      }
      if ((asList(response.json)?.data ?? []).length === 0) {
        return skip("The read returned no records, so no disclosed `data` object exists to judge.");
      }
      const reAdded = withheld.filter((field) => disclosedMembers(response.json).has(field));
      if (reAdded.length > 0) {
        const bySchema = reAdded.filter((field) => withheldButRequired.includes(field));
        return fail(
          `The response re-added members the grant does not permit: ${reAdded.join(", ")}. The request named exactly ${approved.join(", ")}, so nothing in the grant or the field selection justifies them.${
            bySchema.length > 0
              ? ` Of these, ${bySchema.join(", ")} are declared schema-required, which is the justification PR #1 \`v0.2/4-1\` names and forbids: the RS "MUST NOT add a field to a response merely because the schema requires it".`
              : ` PR #1 \`v0.2/4-1\`: the RS "MUST NOT add a field to a response merely because the schema requires it".`
          }`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // ------------------------------------------------- v0.2/4-8, v0.2/8.4-4 ---
  // "It MUST NOT repair the projection by disclosing unauthorized fields", and
  // the v0.2 base surface names `fields` as a durable client-token parameter.
  //
  // The negative and its positive control in one case, because they are the
  // same request differing in one field name and separating them would leave
  // each half provable by a server that answers every read the same way. A
  // server that 400s all `fields=` values passes the negative alone; one that
  // serves all of them passes the positive alone.
  {
    caseId: "RS-2/v0.2-field-selection-outside-the-projection-refused",
    requirementId: "RS-2",
    assertion:
      "A `fields` selection naming a withheld member is refused, while the same read naming only approved members succeeds.",
    async run({ adapter, streams, path }) {
      const target = narrowable(streams);
      if (!target) {
        return skip(
          "No seeded stream has a field outside its primary key to withhold, so no narrowing is expressible."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, approved, withheld } = arranged;
      const [denied] = withheld;
      if (denied === undefined) {
        return skip(NO_NARROWING);
      }

      const control = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
        query: { fields: approved.join(",") },
      });
      if (control.status !== 200) {
        return fail(
          `The positive control failed: a \`fields\` selection naming exactly the approved members (${approved.join(", ")}) was refused with ${control.status}. Without it, the refusal below would be evidence that this target rejects every \`fields\` parameter rather than evidence about the projection.`,
          [control.evidence]
        );
      }

      const response = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
        query: { fields: [...approved, denied].join(",") },
      });
      const evidence: Evidence[] = [control.evidence, response.evidence];
      if (response.status === 200) {
        // Two ways to be wrong here and both are failures, but they are not the
        // same failure: serving the withheld member is the disclosure the
        // clause forbids, and dropping it silently leaves the client believing
        // it received a field it did not.
        const disclosed = disclosedMembers(response.json);
        return fail(
          disclosed.has(denied)
            ? `The projection was "repaired" by disclosing it: a \`fields\` selection naming the withheld member "${denied}" was served, and "${denied}" appeared in the records. PR #1 \`v0.2/4-8\`: the RS "MUST NOT repair the projection by disclosing unauthorized fields".`
            : `A \`fields\` selection naming the withheld member "${denied}" was served with 200 and "${denied}" silently dropped. The client asked for a member it cannot have and was told the read succeeded, so it has no way to learn the field is outside its grant.`,
          evidence
        );
      }
      if (response.status !== 400) {
        return fail(
          `Expected 400 for a \`fields\` selection naming the withheld member "${denied}", got ${response.status}.`,
          evidence
        );
      }
      const error = errorBody(response);
      if (error?.code !== "invalid_request") {
        return fail(
          `The selection was refused (400) but classified as "${error?.code ?? "no structured error"}" rather than invalid_request. A client cannot tell "narrow your field list and retry" from a denial it should not retry.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ------------------------------------------ v0.2/8.4-1, 8.4-2, 8.4-3, 8.4-5 ---
  // The v0.2 client-token base surface is `limit`, `cursor`, `order`, `fields`,
  // `changes_since` and blob fetch (`v0.2/8.4-4`); filters, expansions and
  // expansion limits are outside it and MUST be rejected.
  //
  // The suite already has RS-9 cases for the same parameters under v0.1, and
  // this case is NOT a duplicate of them: it sends them against a grant the
  // owner NARROWED. The defect it catches that the v0.1 cases cannot is a
  // server which validates query parameters against the grant's REQUESTED
  // field set — such a server rejects `filter[withheld_field]` under a v0.1
  // grant (the field is outside the grant entirely) and ACCEPTS it under a v0.2
  // narrowing (the field is inside the request, merely outside what the owner
  // approved). That is a predicate evaluated over data the owner declined to
  // disclose, and its result leaks that data one bit at a time.
  {
    caseId: "RS-9/v0.2-predicate-over-a-withheld-member-refused",
    requirementId: "RS-9",
    assertion:
      "Filters and expansions naming a member the owner withheld are rejected with 400 invalid_request under a v0.2 grant.",
    async run({ adapter, streams, path }) {
      const target = narrowable(streams);
      if (!target) {
        return skip(
          "No seeded stream has a field outside its primary key to withhold, so no narrowing is expressible."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, withheld } = arranged;
      const [denied] = withheld;
      if (denied === undefined) {
        return skip(NO_NARROWING);
      }

      const probes: readonly {
        readonly clause: string;
        readonly label: string;
        readonly query: Record<string, string>;
      }[] = [
        { clause: "v0.2/8.4-1", label: `filter[${denied}]`, query: { [`filter[${denied}]`]: "any-value" } },
        { clause: "v0.2/8.4-5", label: "expand[]", query: { "expand[]": denied } },
        { clause: "v0.2/8.4-5", label: `expand_limit[${denied}]`, query: { [`expand_limit[${denied}]`]: "5" } },
      ];

      const evidence: Evidence[] = [];
      const wrong: string[] = [];
      for (const probe of probes) {
        // biome-ignore lint/performance/noAwaitInLoops: each probe is a separate authorization decision against shared target state.
        const response = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
          token: grant.accessToken,
          query: probe.query,
        });
        evidence.push(response.evidence);
        if (response.status !== 400) {
          wrong.push(`${probe.label} answered ${response.status} rather than 400 (${probe.clause})`);
          continue;
        }
        const code = errorBody(response)?.code;
        if (code !== "invalid_request") {
          wrong.push(
            `${probe.label} answered 400 "${code ?? "no structured error"}" rather than invalid_request (${probe.clause})`
          );
        }
      }
      if (wrong.length > 0) {
        return fail(
          `Query shapes outside the v0.2 client-token base surface were not refused as PR #1 requires: ${wrong.join("; ")}. Each names "${denied}", which the owner withheld from this grant — a server that evaluates a predicate over it discloses the member's values one comparison at a time, whatever the response body shows.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------- v0.2/8.4-4 ---
  // `limit` and `cursor` are in the durable base surface, so a narrowed grant
  // must be pageable — and every page must carry the same projection.
  //
  // The second half is the point. A server that applies the owner's narrowing
  // on the first page and re-resolves the grant from its stored REQUESTED
  // shape when resuming from a cursor discloses everything the owner withheld,
  // to any client patient enough to ask for page two. Nothing on page one shows
  // it, which is why the projection cases above cannot catch it.
  {
    caseId: "RS-2/v0.2-projection-survives-the-cursor",
    requirementId: "RS-2",
    assertion: "A page resumed from a cursor discloses the same approved members as the first page, and no more.",
    async run({ adapter, streams, path }) {
      const target = narrowable(streams);
      if (!target) {
        return skip(
          "No seeded stream has a field outside its primary key to withhold, so no narrowing is expressible."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, approved, withheld } = arranged;

      const first = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
        query: { limit: "1" },
      });
      if (first.status !== 200) {
        return fail(`The first page of a narrowed v0.2 grant was refused with ${first.status}.`, [first.evidence]);
      }
      const cursor = asList(first.json)?.next_cursor;
      if (!cursor) {
        return skip(
          "The stream returned no `next_cursor` at limit=1, so there is no second page to resume. Closing this needs the stream seeded with at least two records inside the approved projection."
        );
      }

      const second = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
        query: { limit: "1", cursor },
      });
      const evidence = [first.evidence, second.evidence];
      if (second.status !== 200) {
        return fail(
          `Resuming a narrowed v0.2 grant from its own \`next_cursor\` was refused with ${second.status}. \`cursor\` is named in the v0.2 durable base surface (\`v0.2/8.4-4\`), so a grant that pages once must page again.`,
          evidence
        );
      }
      const leaked = withheld.filter((field) => disclosedMembers(second.json).has(field));
      if (leaked.length > 0) {
        return fail(
          `The resumed page disclosed members the first page withheld: ${leaked.join(", ")}. The owner approved ${approved.join(", ")}. A projection applied only to the first page is not a projection — every record after it carries the data the owner declined.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------- v0.2/4-2 ---
  // An authorized read that matches nothing is an empty page, not an error.
  //
  // Filed here rather than with the pagination cases because under v0.2 the
  // emptiness is the OWNER's doing: they narrowed the window to one that
  // contains no records. The distinction a client depends on is between "you
  // may not see this" and "there is nothing here", and a server that answers
  // the second with 403 or 404 has told the client its grant is broken. The
  // reverse leak matters too and is why the case asserts the shape rather than
  // only the status: a body that names the excluded records, or reports a count
  // of them, discloses exactly what the window excluded.
  {
    caseId: "RS-2/v0.2-owner-narrowed-window-reads-empty",
    requirementId: "RS-2",
    assertion:
      "A read under an owner-narrowed time window that contains no records returns an empty page, not a refusal.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.consentTimeField !== undefined) ?? streams[0];
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (stream.consentTimeField === undefined) {
        return skip(
          `No seeded stream declares a \`consent_time_field\`, so an owner cannot narrow one to a time window and this case's precondition cannot be arranged.`
        );
      }
      // A window closed entirely in the past. Deliberately not "the future":
      // a server comparing against `now` rather than against the record's
      // consent-time field would return an empty page for a future window
      // whether or not it applied the owner's narrowing at all.
      const empty = { since: "1990-01-01T00:00:00Z", until: "1990-12-31T00:00:00Z" };
      const grant = await adapter.issueGrant({
        specVersion: "0.2",
        streams: [
          {
            name: stream.name,
            fields: [...stream.fields],
            necessity: "required",
            minimum: { fields: [...stream.primaryKey] },
          },
        ],
        // The REQUESTED window is wide open, so the empty read below is the
        // owner's narrowing and not the client's own bound. A request already
        // scoped to the empty window would read empty against a server that
        // discards owner choices entirely.
        timeConstraint: { field: stream.consentTimeField, from: "1900-01-01T00:00:00Z", to: "2999-12-31T00:00:00Z" },
        ownerChoices: { timeRange: { [stream.name]: empty } },
      });
      if (!grant) {
        return skip(
          `This target refused a v0.2 grant whose owner narrowed "${stream.name}" to a time window. It does not implement the v0.2 owner-narrowing path, so an empty read here would say nothing about this clause.`
        );
      }
      // The precondition, established before anything is judged: the grant the
      // target ISSUED must carry the owner's window. A target that accepts the
      // choices and discards them issues a grant over the wide requested window,
      // and every record it then returns is correct for that grant — reporting
      // it as "the narrowing was not applied" would be a finding against a
      // target that never claimed to implement the narrowing at all.
      const window = approvedTimeConstraint(grant, stream.name);
      if (window?.since !== empty.since || window.until !== empty.until) {
        return skip(
          `This target issued the grant without the owner's time window (approved ${window ? `${window.since ?? "unbounded"} to ${window.until ?? "unbounded"}` : "no time_constraint"}, owner chose ${empty.since} to ${empty.until}), so the read below would be judged against a window the grant does not carry. Closing this needs a target that binds the owner's temporal choice into the issued grant.`
        );
      }

      const response = await request(adapter.baseUrl, recordsPath(path, stream.name), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(
          `A read under an owner-narrowed window containing no records answered ${response.status} rather than an empty 200 page. "Your grant does not permit this" and "this window is empty" are different facts, and a client told the first will stop retrying a grant that is working exactly as the owner set it.`,
          [response.evidence]
        );
      }
      const body = asList(response.json);
      const records = body?.data ?? [];
      if (records.length > 0) {
        return fail(
          `The owner's narrowed window was not applied: ${records.length} record(s) were disclosed under a window (${empty.since} to ${empty.until}) that the seeded data falls outside. The owner's temporal choice is part of the approved shape, not a hint.`,
          [response.evidence]
        );
      }
      if (body?.has_more === true) {
        return fail(
          "The empty page reports `has_more: true`, which tells the client records exist beyond the window the owner approved. That is a disclosure about excluded data, made by a response that disclosed none of it.",
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------- v0.2/ext-7-2 ---
  // "The implementation MUST fail closed whenever required authority, binding,
  // status, projection, or complete result context is absent or ambiguous."
  //
  // Revocation is the case of that clause a black-box run can actually reach:
  // after the grant is revoked the required authority is gone, and the read
  // must stop. The suite covers revocation under v0.1 already; what this adds
  // is that a v0.2 grant carrying an owner-narrowed projection is revoked as a
  // whole. The failure this catches is a server that stores the narrowing
  // separately from the grant and, on revocation, drops the grant while a
  // cached projection keeps answering — which reads as a working, narrower
  // grant rather than as a revoked one.
  {
    caseId: "RS-2/v0.2-narrowed-grant-denied-after-revocation",
    requirementId: "RS-2",
    assertion: "A v0.2 grant the owner narrowed stops serving reads once it is revoked.",
    async run({ adapter, streams, path }) {
      const target = narrowable(streams);
      if (!target) {
        return skip(
          "No seeded stream has a field outside its primary key to withhold, so no narrowing is expressible."
        );
      }
      const arranged = await narrowedGrant(adapter, target.stream, target.keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant } = arranged;

      const before = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
      });
      if (before.status !== 200) {
        return fail(
          `The positive control failed: the narrowed grant did not read before revocation (${before.status}). Without it, the denial below would be evidence the grant never worked rather than evidence revocation took effect.`,
          [before.evidence]
        );
      }

      await adapter.revokeGrant(grant.grantId);

      const after = await request(adapter.baseUrl, recordsPath(path, target.stream.name), {
        token: grant.accessToken,
      });
      const evidence = [before.evidence, after.evidence];
      if (after.status < 400) {
        return fail(
          `A revoked v0.2 grant kept serving records (${after.status}). PR #1 \`v0.2/ext-7-2\`: the implementation "MUST fail closed whenever required authority, binding, status, projection, or complete result context is absent or ambiguous". After revocation the authority is absent.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ------------------------------------------------------------ v0.2/4-7 ---
  // "An RS unable to serve a requested projection without changing the meaning
  // of the disclosed data MUST refuse that read with HTTP 403
  // `disclosure_unavailable`."
  //
  // THIS CASE IS EXPECTED TO FAIL AGAINST EVERY TARGET THE SUITE CURRENTLY
  // REACHES, and it is registered anyway. `disclosure_unavailable` is a code
  // PR #1 introduces and the adopted v0.1 spec does not contain; a v0.1 server
  // has no reason to emit it and no v0.1 case can ask for it. Recording the
  // clause as untested would hide that the code has no implementation
  // anywhere, which is the finding.
  //
  // WHAT MAKES A PROJECTION UNSERVABLE is deployment-specific — PR #1's example
  // is a stored blob whose meaning depends on a field the owner withheld — so
  // the suite cannot manufacture one from outside. The probe it CAN make is the
  // honest one: ask for the approved projection on a stream whose records carry
  // a `blob_ref`, and require that the target either serves it or refuses with
  // this code. A target that does neither has not implemented the clause, and
  // the case says so rather than passing on the 200.
  {
    caseId: "RS-2/v0.2-unservable-projection-refused-as-disclosure-unavailable",
    requirementId: "RS-2",
    assertion:
      "A read the target cannot project without changing the data's meaning is refused with 403 disclosure_unavailable rather than served or misclassified.",
    async run({ adapter, streams, path }) {
      // The blob-bearing stream is where the clause's own example lives: a
      // `blob_ref` is a pointer whose meaning depends on the members around it,
      // so withholding one of those is the realistic way a projection becomes
      // unservable. A stream without one cannot produce the condition at all.
      const stream = streams.find((s) => s.fields.some((f) => f.includes("blob")));
      if (!stream) {
        return skip(
          "No seeded stream carries a `blob_ref` member, so a projection whose meaning depends on a withheld field cannot be arranged from outside the target."
        );
      }
      const blobField = stream.fields.find((f) => f.includes("blob"));
      const keep = [...new Set([...stream.primaryKey, ...(blobField ? [blobField] : [])])];
      if (keep.length === stream.fields.length) {
        return skip("Narrowing to the key plus the blob reference left nothing withheld.");
      }
      const arranged = await narrowedGrant(adapter, stream, keep);
      if ("reason" in arranged) {
        return skip(arranged.reason);
      }
      const { grant, approved, withheld } = arranged;

      const response = await request(adapter.baseUrl, recordsPath(path, stream.name), {
        token: grant.accessToken,
      });
      if (response.status === 200) {
        // Serving it is CORRECT whenever the target can project without
        // changing meaning, which is the common case. The case passes here
        // rather than failing: the clause binds only an RS that is UNABLE, and
        // reporting a capable server as non-conformant would be a false finding.
        const leaked = withheld.filter((field) => disclosedMembers(response.json).has(field));
        if (leaked.length > 0) {
          return fail(
            `The target served a projection it could not honour, disclosing ${leaked.join(", ")}. PR #1 \`v0.2/4-7\` requires 403 \`disclosure_unavailable\` for a read it cannot project, and \`v0.2/4-8\` forbids repairing the projection by disclosing unauthorized fields — this response did the second instead of the first.`,
            [response.evidence]
          );
        }
        return pass([response.evidence]);
      }
      if (response.status !== 403) {
        return fail(
          `A projection over a blob-bearing record was refused with ${response.status}. PR #1 \`v0.2/4-7\` names exactly one refusal for a projection the RS cannot serve: 403 \`disclosure_unavailable\`. Any other status tells the client to retry, re-authorize, or give up — three different actions, and this response does not say which.`,
          [response.evidence]
        );
      }
      const code = errorBody(response)?.code;
      if (code !== "disclosure_unavailable") {
        return fail(
          `The read was refused with 403 but classified as "${code ?? "no structured error"}" rather than disclosure_unavailable. The owner approved ${approved.join(", ")}, so this is not an authorization failure the client can fix by asking for less — and \`access_denied\` tells it that it is.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },
];

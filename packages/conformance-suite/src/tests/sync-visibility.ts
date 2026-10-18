// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Incremental sync: what a session may reveal, and what binds a token.
//
//   4.3-6   a record that leaves the grant's window produces a tombstone
//   4.3-9   token equality or ordering does not signal an invisible change
//   4.3-11  a record never visible produces no tombstone
//   4.3-16  a non-terminal page carries no `next_changes_since`
//   8.9-11  a page cursor is bound to its whole query context
//   8.9-17  a page cursor or `changes_since` token under another grant,
//           subject, scope or query context is `invalid_cursor`
//   8.9-18  a record deleted after page 1 is not served on a later page
//
// Several cases delete records, which is destructive and cumulative on a shared
// target. They run after the other deleting cases (see suite.ts), each deletes
// the fewest records it can, and each skips when the stream is too small to
// leave a live record behind.

import { changesSinceBootstrapOf, type TargetAdapter } from "../harness/adapter.ts";
import { errorBody, type PdppResponse, request } from "../harness/http.ts";
import { type CaseVerdict, type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

interface ListBody {
  data?: { id?: string; data?: Record<string, unknown>; deleted?: boolean }[];
  has_more?: boolean;
  next_changes_since?: string;
  next_cursor?: string;
}

type Context = Parameters<ConformanceCase["run"]>[0];
type Seeded = Context["streams"][number];

const MAX_HOPS = 50;

function asList(json: unknown): ListBody {
  return typeof json === "object" && json !== null ? (json as ListBody) : {};
}

function mutableStream(streams: readonly Seeded[], minRecords: number): Seeded | undefined {
  return [...streams].reverse().find((s) => s.semantics === "mutable_state" && s.recordCount >= minRecords);
}

/** Page through a session one record at a time, returning every page and the ids each delivered. */
async function walkSession(
  adapter: TargetAdapter,
  recordsPath: string,
  token: string,
  query: Record<string, string>,
  evidence: Evidence[]
): Promise<{ pages: ListBody[] } | { failure: string }> {
  const pages: ListBody[] = [];
  let cursor: string | undefined;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential.
    const response: PdppResponse = await request(adapter.baseUrl, recordsPath, {
      token,
      query: cursor === undefined ? { ...query, limit: "1" } : { limit: "1", cursor },
    });
    evidence.push(response.evidence);
    if (response.status !== 200) {
      return { failure: `Page ${hop + 1} of the session returned ${response.status}.` };
    }
    const body = asList(response.json);
    pages.push(body);
    if (body.has_more !== true || body.next_cursor === undefined) {
      return { pages };
    }
    cursor = body.next_cursor;
  }
  return { failure: `The session did not end within ${MAX_HOPS} pages.` };
}

function idsOf(pages: readonly ListBody[], includeTombstones = false): string[] {
  return pages.flatMap((page) =>
    (page.data ?? []).filter((r) => includeTombstones || r.deleted !== true).flatMap((r) => (r.id ? [r.id] : []))
  );
}

async function ownerDelete(adapter: TargetAdapter, path: string, owner: string, query: Record<string, string>) {
  return await request(adapter.baseUrl, path, { token: owner, method: "DELETE", query });
}

function invalidCursorFault(label: string, response: PdppResponse): string | undefined {
  if (response.status === 400 && errorBody(response)?.code === "invalid_cursor") {
    return undefined;
  }
  return `${label}: expected 400 invalid_cursor, got ${response.status}${errorBody(response)?.code ? ` ${errorBody(response)?.code}` : ""}.`;
}

const SESSION_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 4.3-16 ---
  {
    caseId: "RS-8/non-terminal-page-omits-next-changes-since",
    requirementId: "RS-8",
    assertion:
      "A page of a paginated changes_since session that has more pages carries no next_changes_since; the token appears only on the terminal page.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.semantics === "mutable_state" && s.recordCount >= 2);
      if (!stream) {
        return skip("The adapter seeded no mutable_state stream with two records, so no session paginates.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip(`The target issued no grant over '${stream.name}'.`);
      }
      const evidence: Evidence[] = [];
      const walked = await walkSession(
        adapter,
        path(`/streams/${encodeURIComponent(stream.name)}/records`),
        grant.accessToken,
        { changes_since: changesSinceBootstrapOf(adapter) },
        evidence
      );
      if ("failure" in walked) {
        return fail(walked.failure, evidence);
      }
      const nonTerminal = walked.pages.filter((page) => page.has_more === true);
      if (nonTerminal.length === 0) {
        return skip("The session ended on its first page, so no non-terminal page exists to inspect.");
      }
      if (nonTerminal.some((page) => page.next_changes_since !== undefined)) {
        return fail(
          "A page with `has_more: true` carried `next_changes_since`. Core Section 4: only the terminal page of a session carries the token, because the resource server never issues a token for pages it has not delivered. A client that stores the token from an early page resumes past records it never received.",
          evidence
        );
      }
      const terminal = walked.pages.at(-1);
      if (typeof terminal?.next_changes_since !== "string") {
        return skip("The terminal page carried no next_changes_since; RS-8/terminal-page-carries-next-changes-since owns that.");
      }
      return pass(evidence);
    },
  },

  // ------------------------------------------------------- 8.9-11, 8.9-17 ---
  {
    caseId: "RS-6/page-cursor-rejected-under-another-context",
    requirementId: "RS-6",
    assertion:
      "A page cursor replayed under a different `fields` selection, another grant, or an owner token is rejected as 400 invalid_cursor, while the unchanged replay is served.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.recordCount >= 2 && s.fields.length >= 2);
      if (!stream) {
        return skip("No seeded stream has two records and two fields, so the cursor cannot be replayed under a changed selection.");
      }
      const owner = await adapter.ownerToken();
      const [grant, other] = [
        await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] }),
        await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] }),
      ];
      if (!(grant && other)) {
        return skip(`The target did not issue two grants over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const first = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { limit: "1" } });
      const cursor = asList(first.json).next_cursor;
      if (first.status !== 200 || asList(first.json).has_more !== true || cursor === undefined) {
        return skip("The first page was not followed by a cursor, so there is nothing to replay.");
      }
      const evidence = [first.evidence];
      const narrowed = stream.fields.find((f) => f !== "id") ?? stream.fields[0] ?? "";
      const control = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { limit: "1", cursor } });
      evidence.push(control.evidence);
      if (control.status !== 200) {
        return skip(`The cursor was refused under the context that minted it (${control.status}), so a refusal elsewhere cannot be attributed to the context.`);
      }
      const variants: [string, PdppResponse][] = [
        [
          "a different `fields` selection",
          await request(adapter.baseUrl, recordsPath, {
            token: grant.accessToken,
            query: { limit: "1", cursor, fields: narrowed },
          }),
        ],
        [
          "another grant",
          await request(adapter.baseUrl, recordsPath, { token: other.accessToken, query: { limit: "1", cursor } }),
        ],
      ];
      if (owner) {
        variants.push([
          "an owner token",
          await request(adapter.baseUrl, recordsPath, {
            token: owner,
            query: { ...(adapter.ownerReadParams ?? {}), limit: "1", cursor },
          }),
        ]);
      }
      for (const [label, response] of variants) {
        evidence.push(response.evidence);
        const fault = invalidCursorFault(`A page cursor replayed under ${label}`, response);
        if (fault) {
          return fail(
            `${fault} Core Section 8: a page cursor is bound to the query context that produced it (grant or owner scope, stream, \`fields\`, \`view\`, \`expand[]\`, \`order\`, every \`filter[...]\`), and the RS MUST reject it under another as invalid_cursor. Serving it pages a different result set from a stranger's offset.`,
            evidence
          );
        }
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 8.9-17 ---
  {
    caseId: "RS-21/changes-since-token-rejected-under-another-context",
    requirementId: "RS-21",
    assertion:
      "A next_changes_since token replayed under another grant or an owner token is rejected as 400 invalid_cursor, while the unchanged replay is served.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.semantics === "mutable_state");
      if (!stream) {
        return skip("The adapter seeded no mutable_state stream.");
      }
      const owner = await adapter.ownerToken();
      const [grant, other] = [
        await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] }),
        await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] }),
      ];
      if (!(grant && other)) {
        return skip(`The target did not issue two grants over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const opened = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: changesSinceBootstrapOf(adapter) },
      });
      const body = asList(opened.json);
      if (opened.status !== 200 || body.has_more === true || typeof body.next_changes_since !== "string") {
        return skip("The opening session did not end on a terminal page carrying next_changes_since.");
      }
      const token = body.next_changes_since;
      const evidence = [opened.evidence];
      const control = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { changes_since: token } });
      evidence.push(control.evidence);
      if (control.status !== 200) {
        return skip(`The token was refused under the context that minted it (${control.status}).`);
      }
      const variants: [string, PdppResponse][] = [
        [
          "another grant",
          await request(adapter.baseUrl, recordsPath, { token: other.accessToken, query: { changes_since: token } }),
        ],
      ];
      if (owner) {
        variants.push([
          "an owner token",
          await request(adapter.baseUrl, recordsPath, {
            token: owner,
            query: { ...(adapter.ownerReadParams ?? {}), changes_since: token },
          }),
        ]);
      }
      for (const [label, response] of variants) {
        evidence.push(response.evidence);
        const fault = invalidCursorFault(`A changes_since token replayed under ${label}`, response);
        if (fault) {
          return fail(
            `${fault} Core Section 8: a changes_since token is bound to the grant (for an owner token, the subject and effective owner scope) and its query context, and the RS MUST reject it under another grant, subject, scope or query context as invalid_cursor. Honouring it hands one principal a delta computed against another's horizon.`,
            evidence
          );
        }
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 4.3-9 ---
  {
    caseId: "RS-21/token-does-not-reveal-writes-the-grant-cannot-see",
    requirementId: "RS-21",
    assertion:
      "The next_changes_since a session ends on is the same before and after a write confined to fields outside the grant's projection.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.semantics === "mutable_state");
      if (!stream) {
        return skip("The adapter seeded no mutable_state stream.");
      }
      if (!adapter.writeRecordField) {
        return skip("The adapter has no writeRecordField hook, so no write can be confined to a hidden field.");
      }
      const writable = stream.fields.filter((f) => !stream.primaryKey.includes(f));
      const [inProjection, hidden] = [writable[0], writable.at(-1)];
      if (!(inProjection && hidden) || inProjection === hidden) {
        return skip(`Stream '${stream.name}' declares fewer than two non-key fields, so no grant can exclude one.`);
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [inProjection] }] });
      if (!grant) {
        return skip(`The target issued no narrowed grant over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const read = (changesSince: string) =>
        request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { changes_since: changesSince } });
      const opened = await read(changesSinceBootstrapOf(adapter));
      const openedBody = asList(opened.json);
      if (opened.status !== 200 || openedBody.has_more === true || typeof openedBody.next_changes_since !== "string") {
        return skip("The opening session did not end on a terminal page carrying next_changes_since.");
      }
      const subject = openedBody.data?.find((r) => typeof r.id === "string" && r.deleted !== true);
      if (!subject?.id) {
        return skip("The opening session returned no live record to modify.");
      }
      const base = openedBody.next_changes_since;
      const evidence = [opened.evidence];

      // Two identical sessions with no write between them. If their tokens
      // differ, token equality is not deterministic here and says nothing.
      const [first, second] = [await read(base), await read(base)];
      evidence.push(first.evidence, second.evidence);
      const [t1, t2] = [asList(first.json).next_changes_since, asList(second.json).next_changes_since];
      if (typeof t1 !== "string" || t1 !== t2) {
        return skip("Two identical sessions ended on different tokens, so token equality cannot be compared across a write.");
      }

      const wrote = await adapter.writeRecordField(stream.name, subject.id, hidden, `pdpp-conformance-hidden-${Date.now()}`);
      if (!wrote) {
        return skip(`The target could not write field '${hidden}' of record '${subject.id}'.`);
      }
      const after = await read(base);
      evidence.push(after.evidence);
      const t3 = asList(after.json).next_changes_since;
      if (t3 !== t1) {
        return fail(
          `A session that returned nothing the grant can see ended on a different next_changes_since after a write to '${hidden}', a field this grant does not carry (before ${JSON.stringify(t1)}, after ${JSON.stringify(t3)}), although two sessions with no write between them ended on the same token. Core Section 4: token equality or ordering MUST NOT signal a change that is not visible to the grant. A client that compares tokens learns when data it may not read changed.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 8.9-18 ---
  {
    caseId: "RS-7/record-deleted-after-page-1-not-served-on-a-later-page",
    requirementId: "RS-7",
    assertion:
      "A record deleted after page 1 of a paginated changes_since session is not served on a later page of that session.",
    async run({ adapter, streams, path }) {
      const stream = mutableStream(streams, 3);
      const owner = await adapter.ownerToken();
      if (!(stream && owner)) {
        return skip("No mutable_state stream with three records and an owner token to delete with.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip(`The target issued no grant over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const ownerQuery = { ...(adapter.ownerReadParams ?? {}) };
      const query = { changes_since: changesSinceBootstrapOf(adapter) };
      const evidence: Evidence[] = [];

      // First learn the session's order, so the record deleted is one that
      // genuinely sits on a later page.
      const survey = await walkSession(adapter, recordsPath, grant.accessToken, query, evidence);
      if ("failure" in survey) {
        return fail(survey.failure, evidence);
      }
      const order = idsOf(survey.pages);
      if (order.length < 3) {
        return skip(`The session delivers ${order.length} live record(s); three are needed to delete one from a later page.`);
      }
      const victim = order.at(-1) as string;

      const page1 = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { ...query, limit: "1" } });
      evidence.push(page1.evidence);
      const body1 = asList(page1.json);
      if (page1.status !== 200 || body1.has_more !== true || body1.next_cursor === undefined) {
        return skip("The session did not paginate on a second read.");
      }
      const deleted = await ownerDelete(
        adapter,
        path(`/streams/${encodeURIComponent(stream.name)}/records/${encodeURIComponent(victim)}`),
        owner,
        ownerQuery
      );
      evidence.push(deleted.evidence);
      if (deleted.status !== 200 && deleted.status !== 204) {
        return skip(`Deleting record '${victim}' returned ${deleted.status}.`);
      }
      const rest: ListBody[] = [];
      let cursor: string | undefined = body1.next_cursor;
      for (let hop = 0; hop < MAX_HOPS && cursor !== undefined; hop += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential.
        const next = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken, query: { limit: "1", cursor } });
        evidence.push(next.evidence);
        if (next.status !== 200) {
          return fail(`Following next_cursor after the deletion returned ${next.status}.`, evidence);
        }
        const nextBody = asList(next.json);
        rest.push(nextBody);
        cursor = nextBody.has_more === true ? nextBody.next_cursor : undefined;
      }
      const served = idsOf(rest);
      if (served.includes(victim)) {
        return fail(
          `Record '${victim}' was deleted after page 1 and was still served as a live record on a later page of the same session. Core Section 4: the resource server MUST NOT serve a record on a later page if the record was deleted after page 1; the next session emits its tombstone.`,
          evidence
        );
      }
      const expectedBetween = order.slice(1, -1);
      if (!expectedBetween.every((id) => served.includes(id))) {
        return skip("The records between page 1 and the deleted one were not all delivered, so the session did not page as expected.");
      }
      return pass(evidence);
    },
  },
];

type WindowArrangement = {
  readonly cutoff: string;
  readonly field: string;
  readonly inside: readonly string[];
  readonly outside: readonly string[];
  readonly ownerQuery: Record<string, string>;
  readonly recordsPath: string;
  readonly stream: Seeded;
};

/**
 * Split a stream's records into those inside and outside a time window by
 * reading the owner's view, or return why the case must skip.
 */
async function arrangeWindow(context: Context): Promise<WindowArrangement | CaseVerdict> {
  const { adapter, streams, path } = context;
  const stream = streams.find((s) => s.semantics === "mutable_state" && s.consentTimeField !== undefined);
  const owner = await adapter.ownerToken();
  if (!(stream?.consentTimeField && owner)) {
    return skip("No mutable_state stream declares a consent_time_field, or the target issues no owner token.");
  }
  const ownerQuery = { ...(adapter.ownerReadParams ?? {}) };
  const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
  const listed = await request(adapter.baseUrl, recordsPath, { token: owner, query: { ...ownerQuery, limit: "100" } });
  const rows = (asList(listed.json).data ?? []).flatMap((r) => {
    const value = r.data?.[stream.consentTimeField as string];
    return r.id && typeof value === "string" && !Number.isNaN(Date.parse(value)) ? [{ id: r.id, value }] : [];
  });
  rows.sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  if (rows.length < 4) {
    return skip(`Only ${rows.length} record(s) of '${stream.name}' carry a parseable ${stream.consentTimeField}; four are needed to build a window with records in and out.`);
  }
  const cut = Math.floor(rows.length / 2);
  const cutoff = (rows[cut] as { value: string }).value;
  return {
    cutoff,
    field: stream.consentTimeField,
    inside: rows.slice(cut).map((r) => r.id),
    outside: rows.slice(0, cut).map((r) => r.id),
    ownerQuery,
    recordsPath,
    stream,
  };
}

const WINDOW_CASES: readonly ConformanceCase[] = [
    // ---------------------------------------------------------------- 4.3-11 ---
    {
      caseId: "RS-7/never-visible-record-produces-no-tombstone",
      requirementId: "RS-7",
      assertion:
        "Deleting a record that lies outside a grant's time window produces no tombstone in that grant's next session, while deleting one inside the window does.",
      async run(context) {
        const arranged = await arrangeWindow(context);
        if (!("cutoff" in arranged)) {
          return arranged;
        }
        const { adapter, path } = context;
        const owner = (await adapter.ownerToken()) as string;
        if (arranged.outside.length < 1 || arranged.inside.length < 2) {
          return skip("The window leaves too few records on one side to delete one from each and keep a live record.");
        }
        const grant = await adapter.issueGrant({
          streams: [{ name: arranged.stream.name, fields: [...arranged.stream.fields] }],
          timeConstraint: { field: arranged.field, from: arranged.cutoff },
        });
        if (!grant) {
          return skip("The target issued no time-bounded grant, so a window cannot be arranged.");
        }
        const read = (changesSince: string) =>
          request(adapter.baseUrl, arranged.recordsPath, { token: grant.accessToken, query: { changes_since: changesSince } });
        const opened = await read(changesSinceBootstrapOf(adapter));
        const openedBody = asList(opened.json);
        if (opened.status !== 200 || openedBody.has_more === true || typeof openedBody.next_changes_since !== "string") {
          return skip("The opening session did not end on a terminal page carrying next_changes_since.");
        }
        const evidence = [opened.evidence];
        const visible = idsOf([openedBody]);
        if (visible.some((id) => arranged.outside.includes(id))) {
          return skip("The grant's window did not exclude the records outside it, so 'never visible' cannot be arranged.");
        }
        const [outsideId, insideId] = [arranged.outside[0] as string, arranged.inside.find((id) => visible.includes(id))];
        if (insideId === undefined) {
          return skip("The grant's first session delivered no record inside the window to delete as a control.");
        }
        for (const id of [outsideId, insideId]) {
          // biome-ignore lint/performance/noAwaitInLoops: each deletion is confirmed before the next.
          const deleted = await ownerDelete(
            adapter,
            path(`/streams/${encodeURIComponent(arranged.stream.name)}/records/${encodeURIComponent(id)}`),
            owner,
            arranged.ownerQuery
          );
          evidence.push(deleted.evidence);
          if (deleted.status !== 200 && deleted.status !== 204) {
            return skip(`Deleting record '${id}' returned ${deleted.status}.`);
          }
        }
        const next = await read(openedBody.next_changes_since);
        evidence.push(next.evidence);
        const tombstones = (asList(next.json).data ?? []).filter((r) => r.deleted === true).map((r) => r.id);
        if (!tombstones.includes(insideId)) {
          return skip(`Deleting record '${insideId}', which was inside the window, produced no tombstone, so the session cannot be judged on an invisible deletion.`);
        }
        if (tombstones.includes(outsideId)) {
          return fail(
            `A tombstone was emitted for record '${outsideId}', which was never inside this grant's time window. Core Section 4: the resource server MUST NOT emit a tombstone for a record that was never visible under the query context. It tells the client a record it could not see existed and was removed.`,
            evidence
          );
        }
        return pass(evidence);
      },
    },

    // ----------------------------------------------------------------- 4.3-6 ---
    {
      caseId: "RS-7/record-leaving-time-window-surfaces-as-a-tombstone",
      requirementId: "RS-7",
      assertion:
        "A record that is rewritten so its consent_time_field falls outside the grant's window produces a tombstone in that grant's next session.",
      async run(context) {
        const arranged = await arrangeWindow(context);
        if (!("cutoff" in arranged)) {
          return arranged;
        }
        const { adapter } = context;
        if (!adapter.writeRecordField) {
          return skip("The adapter has no writeRecordField hook, so a record cannot be moved out of the window.");
        }
        const grant = await adapter.issueGrant({
          streams: [{ name: arranged.stream.name, fields: [...arranged.stream.fields] }],
          timeConstraint: { field: arranged.field, from: arranged.cutoff },
        });
        if (!grant) {
          return skip("The target issued no time-bounded grant, so a window cannot be arranged.");
        }
        const read = (changesSince: string) =>
          request(adapter.baseUrl, arranged.recordsPath, { token: grant.accessToken, query: { changes_since: changesSince } });
        const opened = await read(changesSinceBootstrapOf(adapter));
        const openedBody = asList(opened.json);
        if (opened.status !== 200 || openedBody.has_more === true || typeof openedBody.next_changes_since !== "string") {
          return skip("The opening session did not end on a terminal page carrying next_changes_since.");
        }
        const evidence = [opened.evidence];
        const mover = idsOf([openedBody]).find((id) => arranged.inside.includes(id));
        if (mover === undefined) {
          return skip("The grant's first session delivered no record inside the window to move.");
        }
        const earlier = /^\d{4}-\d{2}-\d{2}$/.test(arranged.cutoff) ? "2000-01-01" : "2000-01-01T00:00:00Z";
        const wrote = await adapter.writeRecordField(arranged.stream.name, mover, arranged.field, earlier);
        if (!wrote) {
          return skip(`The target could not write field '${arranged.field}' of record '${mover}'.`);
        }
        const next = await read(openedBody.next_changes_since);
        evidence.push(next.evidence);
        if (next.status !== 200) {
          return fail(`The next session returned ${next.status}.`, evidence);
        }
        const tombstoned = (asList(next.json).data ?? []).some((r) => r.deleted === true && r.id === mover);
        if (!tombstoned) {
          return fail(
            `Record '${mover}' was visible to this grant at the first horizon and, after its ${arranged.field} was rewritten to ${earlier}, not visible at the second, but the session emitted no tombstone for it. Core Section 4: the resource server MUST emit a tombstone for each record visible at h0 and not visible at h1, including a record moved out of the time window. Without it the client keeps a copy the grant no longer covers.`,
            evidence
          );
        }
        return pass(evidence);
      },
    },
];

export const SYNC_VISIBILITY_CASES: readonly ConformanceCase[] = [...SESSION_CASES, ...WINDOW_CASES];

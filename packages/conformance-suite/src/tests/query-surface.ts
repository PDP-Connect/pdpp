// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Query-surface conformance cases: pagination, cursors, incremental sync, single
// record reads, and the non-fatal warning channel.
//
// These cover the half of Section 8 that the grant-enforcement oracles do not
// touch. Enforcement asks "may this caller see this?"; these ask "when the answer
// is yes, does the response obey the contract a client was written against?" Both
// matter, and the second is where an interoperability defect hides: a server can
// enforce every grant perfectly and still hand a client a shape it cannot page
// through or resume from.
//
// Every case here is gated on capability the target actually advertises, either
// through `TargetCapabilities` or through what its stream metadata declares. A
// requirement is never reported against a target that does not claim the feature.

import { errorBody, request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

interface ListBody {
  data?: { id?: string; data?: Record<string, unknown>; deleted?: boolean }[];
  has_more?: boolean;
  meta?: { warnings?: { code?: string }[] };
  next_changes_since?: string;
  next_cursor?: string;
  object?: string;
}

function asList(json: unknown): ListBody | undefined {
  return typeof json === "object" && json !== null ? (json as ListBody) : undefined;
}

/** Obtain a grant over the whole stream, or a reason the case must skip. */
async function grantForFirstStream(
  adapter: Parameters<ConformanceCase["run"]>[0]["adapter"],
  streams: Parameters<ConformanceCase["run"]>[0]["streams"]
) {
  const [stream] = streams;
  if (!stream) {
    return { skip: "The adapter seeded no streams." as const };
  }
  const grant = await adapter.issueGrant({
    streams: [{ name: stream.name, fields: [...stream.fields] }],
  });
  if (!grant) {
    return { skip: "The target could not issue a grant for a seeded stream." as const };
  }
  return { grant, stream };
}

export const QUERY_SURFACE_CASES: readonly ConformanceCase[] = [
  // --------------------------------------------------------------- RS-10 ---
  // Section 8 "List records": a limit above the maximum is the canonical
  // non-fatal case. The RS returns the bounded page AND a `limit_clamped`
  // warning — not an error, and not a silent truncation. Silent truncation is
  // the defect worth catching: a client asking for 500 and receiving 100 with no
  // signal concludes the stream ended.
  {
    caseId: "RS-10/oversized-limit-clamped-with-warning",
    requirementId: "RS-10",
    assertion:
      "A limit above the maximum returns a bounded page with a limit_clamped warning, not an error and not a silent truncation.",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(got.stream.name)}/records`), {
        token: got.grant.accessToken,
        query: { limit: "500" },
      });
      if (response.status !== 200) {
        return fail(
          `Expected 200 with a clamped page for limit=500, got ${response.status}. Section 8 makes an oversized limit non-fatal: "the RS returns the bounded page and a limit_clamped warning rather than silently dropping the excess or returning an error".`,
          [response.evidence]
        );
      }
      const body = asList(response.json);
      const records = body?.data ?? [];
      if (records.length > 100) {
        return fail(`A request for limit=500 returned ${records.length} records. Section 8 caps a page at 100.`, [
          response.evidence,
        ]);
      }
      const warnings = body?.meta?.warnings ?? [];
      if (!warnings.some((w) => w.code === "limit_clamped")) {
        return fail(
          `The page was bounded but carried no limit_clamped warning (meta.warnings: ${JSON.stringify(warnings)}). Without it a client cannot distinguish a clamped page from the end of the stream.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-6 ----
  // Section 8 error table: a malformed or unrecognized cursor is 400
  // `invalid_cursor`. A 500 here is not a cosmetic difference — 5xx tells a
  // client the server is broken and the request should be retried unchanged,
  // which will fail identically forever, where 400 tells it to restart
  // pagination without the cursor.
  {
    caseId: "RS-6/malformed-cursor-rejected",
    requirementId: "RS-6",
    assertion: "A malformed pagination cursor is rejected with 400 invalid_cursor.",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(got.stream.name)}/records`), {
        token: got.grant.accessToken,
        // Not a token this server could have minted, and not valid base64url
        // of any cursor shape.
        query: { cursor: "pdpp-conformance-not-a-cursor" },
      });
      if (response.status === 200) {
        return fail(
          "A malformed cursor was accepted and a page served. Section 8 defines invalid_cursor (400) for a cursor that is malformed or unrecognized; silently ignoring it can return the wrong page.",
          [response.evidence]
        );
      }
      if (response.status >= 500) {
        return fail(
          `A malformed cursor produced ${response.status}. Section 8's error table maps it to 400 invalid_cursor. A 5xx tells a client the server failed and the request should be retried unchanged, which will fail identically; a 400 tells it to restart pagination without the cursor.`,
          [response.evidence]
        );
      }
      if (response.status !== 400) {
        return fail(`Expected 400 for a malformed cursor, got ${response.status}.`, [response.evidence]);
      }
      const error = errorBody(response);
      if (error?.code !== "invalid_cursor") {
        return fail(`Expected error code invalid_cursor, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-8 ---
  // Section 9 RS item 8: the terminal page of every `changes_since` response
  // carries `next_changes_since`. Without it a client has no way to resume and
  // must full-resync every session, which is the cost incremental sync exists to
  // avoid.
  {
    caseId: "RS-8/terminal-page-carries-next-changes-since",
    requirementId: "RS-8",
    appliesWhen: (adapter) => adapter.capabilities.incrementalSync,
    assertion:
      "The terminal page of a changes_since response carries next_changes_since so the next session can resume.",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const response = await request(
        adapter.baseUrl,
        path(`/streams/${encodeURIComponent(got.stream.name)}/records`),
        // An empty cursor opens a fresh sync session from the beginning.
        { token: got.grant.accessToken, query: { changes_since: "" } }
      );
      if (response.status !== 200) {
        return fail(`The target declares incremental sync, but a changes_since request returned ${response.status}.`, [
          response.evidence,
        ]);
      }
      const body = asList(response.json);
      if (body?.has_more === true) {
        return skip(
          "The first page was not terminal, and this case does not page to the end; the requirement is about the terminal page specifically."
        );
      }
      if (typeof body?.next_changes_since !== "string" || body.next_changes_since.length === 0) {
        return fail(
          "The terminal page of a changes_since response carried no next_changes_since. Section 9 RS item 8 requires it on every terminal page; without it a client cannot resume and must full-resync each session.",
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- CL-3 ---
  // Section 9 Client item 3 tells a CLIENT that cursor and changes_since are
  // distinct token spaces. The server-side obligation this case checks is the
  // one that makes that rule enforceable: a server that accepts a page cursor
  // where a sync cursor belongs silently returns the wrong records, and the
  // client's mistake never surfaces.
  {
    caseId: "RS-6/cursor-not-accepted-as-changes-since",
    requirementId: "RS-6",
    appliesWhen: (adapter) => adapter.capabilities.incrementalSync,
    assertion:
      "A page cursor presented as changes_since is rejected rather than silently accepted (distinct token spaces).",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(got.stream.name)}/records`);

      // Obtain a real page cursor, if the stream is long enough to produce one.
      const first = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { limit: "1" },
      });
      const pageCursor = asList(first.json)?.next_cursor;
      if (typeof pageCursor !== "string" || pageCursor.length === 0) {
        return skip(
          "The seeded stream is too short to produce a page cursor, so the two token spaces cannot be confused in this run."
        );
      }

      const response = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { changes_since: pageCursor },
      });
      if (response.status === 200) {
        return fail(
          "A page cursor was accepted as a changes_since value. Section 8 makes them distinct token spaces; accepting one for the other returns records selected by the wrong criterion while looking successful, so the client never learns it made the mistake Section 9 Client item 3 forbids.",
          [first.evidence, response.evidence]
        );
      }
      if (response.status !== 400 && response.status !== 410) {
        return fail(
          `Expected 400 (or 410 cursor_expired) for a page cursor used as changes_since, got ${response.status}.`,
          [first.evidence, response.evidence]
        );
      }
      return pass([first.evidence, response.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-1 ---
  // Section 8 "Get a single record". Listed under RS-1 because item 1 is the
  // requirement to implement the endpoint set; this case checks the member that
  // the list-records cases never reach.
  {
    caseId: "RS-1/single-record-read",
    requirementId: "RS-1",
    assertion:
      "GET /streams/{stream}/records/{id} returns the record a list response advertised, and 404 for an unknown id.",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const base = path(`/streams/${encodeURIComponent(got.stream.name)}/records`);

      const list = await request(adapter.baseUrl, base, {
        token: got.grant.accessToken,
        query: { limit: "1" },
      });
      const [record] = asList(list.json)?.data ?? [];
      if (!record?.id) {
        return skip("The seeded stream returned no record to fetch by id.");
      }

      const single = await request(adapter.baseUrl, `${base}/${encodeURIComponent(record.id)}`, {
        token: got.grant.accessToken,
      });
      if (single.status !== 200) {
        return fail(
          `A record the list endpoint returned (id ${record.id}) could not be fetched individually: got ${single.status}.`,
          [list.evidence, single.evidence]
        );
      }

      // An unknown id must be 404, not 200 with an empty body and not 500.
      const missing = await request(adapter.baseUrl, `${base}/pdpp-conformance-no-such-record`, {
        token: got.grant.accessToken,
      });
      if (missing.status !== 404) {
        return fail(
          `An unknown record id returned ${missing.status}; Section 8's error table maps a missing record to 404 not_found.`,
          [single.evidence, missing.evidence]
        );
      }
      return pass([list.evidence, single.evidence, missing.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-2 ---
  // Time-constraint enforcement, the one grant dimension the existing RS-2 cases
  // do not exercise. A grant frozen to a window must not return records outside
  // it, and the RS may not re-derive the window from anything current.
  {
    caseId: "RS-2/time-constraint-enforced",
    requirementId: "RS-2",
    assertion: "Records outside a grant's frozen time_constraint are not returned.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!stream.cursorField) {
        return skip("The seeded stream declares no cursor field to bound a time constraint against.");
      }

      // A window that ends before any plausible seeded record. If the server
      // honours it, the page is empty; if it ignores the constraint, records
      // appear that consent never covered.
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        timeConstraint: { field: stream.cursorField, to: "1971-01-01T00:00:00Z" },
      });
      if (!grant) {
        return skip(
          "The target could not issue a time-constrained grant, so frozen-window enforcement is not demonstrable."
        );
      }

      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`A time-constrained grant did not permit reading its stream: got ${response.status}.`, [
          response.evidence,
        ]);
      }
      const records = asList(response.json)?.data ?? [];
      if (records.length > 0) {
        return fail(
          `Overbroad access: a grant whose time_constraint ends 1971-01-01 returned ${records.length} record(s). Section 8 requires the RS to enforce the grant's frozen time_constraint, and the seeded records post-date that bound.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // ----------------------------------------------------------------- RS-7 ---
  // Section 9 RS item 7 and Core Section 4 "Tombstones": when a record is deleted
  // from a `mutable_state` stream, an incremental sync whose cursor predates the
  // deletion MUST carry a tombstone for it.
  //
  // This is the requirement that makes incremental sync safe to build on. Without
  // it, deletion is invisible to a syncing client: the record simply stops
  // appearing in changes, so a client that mirrors the stream keeps serving data
  // the owner deleted, indefinitely and with no way to notice. "Absent from the
  // next page" and "deleted" are indistinguishable without an explicit signal.
  //
  // The oracle is the full round trip — sync to a terminal page, delete, resume
  // from the stored token — because only that ordering proves the tombstone is
  // reported to a cursor that predates the deletion.
  {
    caseId: "RS-7/deletion-surfaces-as-a-tombstone",
    requirementId: "RS-7",
    appliesWhen: (adapter) => adapter.capabilities.incrementalSync,
    assertion: "A record deleted after a sync cursor was issued appears as a tombstone when that cursor resumes.",
    async run({ adapter, streams, path }) {
      // Owner token: deletion is an owner operation, and the sync leg must run
      // as the same principal so the two cursors share a scope.
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target issues no owner token, so no record can be deleted to observe.");
      }
      // Deliberately the LAST seeded stream: the earlier ones are used by cases
      // that assert exact record counts, and deleting from those would couple
      // this case's side effects to their oracles.
      const stream = streams.at(-1);
      if (!stream || stream.recordCount < 1) {
        return skip("No seeded stream with a record to delete.");
      }
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      // 1. Open a sync session and take the resume token from its terminal page.
      const opened = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, changes_since: "" },
      });
      if (opened.status !== 200) {
        return fail(`The target declares incremental sync, but opening a session returned ${opened.status}.`, [
          opened.evidence,
        ]);
      }
      const openedBody = asList(opened.json);
      if (openedBody?.has_more === true) {
        return skip(
          "The first sync page was not terminal, and this case does not page to the end; the resume token is only defined on the terminal page."
        );
      }
      const resumeToken = openedBody?.next_changes_since;
      if (typeof resumeToken !== "string" || resumeToken.length === 0) {
        return skip(
          "The terminal page carried no next_changes_since, so there is no cursor to resume from. RS-8 covers that requirement directly."
        );
      }
      const victim = openedBody?.data?.find((record) => typeof record.id === "string" && !record.deleted);
      if (!victim?.id) {
        return skip("The sync session returned no live record to delete.");
      }

      // 2. Delete it.
      const deleted = await request(
        adapter.baseUrl,
        path(`/streams/${encodeURIComponent(stream.name)}/records/${encodeURIComponent(victim.id)}`),
        { token: owner, method: "DELETE", query: ownerQuery }
      );
      if (deleted.status !== 200 && deleted.status !== 204) {
        return skip(
          `Deleting a record returned ${deleted.status}, so this deployment does not expose the deletion this requirement is about.`
        );
      }

      // 3. Resume from the cursor that predates the deletion.
      const resumed = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, changes_since: resumeToken },
      });
      if (resumed.status !== 200) {
        return fail(`Resuming a sync from a valid next_changes_since returned ${resumed.status}.`, [resumed.evidence]);
      }
      const tombstone = asList(resumed.json)?.data?.find((record) => record.id === victim.id);
      if (!tombstone) {
        return fail(
          `The record "${victim.id}" was deleted after the cursor was issued, but resuming that cursor did not report it at all. Section 9 RS item 7 requires a tombstone: without one, deletion is invisible to a syncing client, which keeps serving data the owner deleted because "absent from this page" and "deleted" look identical.`,
          [deleted.evidence, resumed.evidence]
        );
      }
      if (tombstone.deleted !== true) {
        return fail(
          `The deleted record "${victim.id}" reappeared in the incremental sync without deleted: true, so a client reads it as a live record rather than a removal.`,
          [resumed.evidence]
        );
      }
      // Core Section 4: a tombstone carries no `data`. Returning the record's
      // contents alongside the deletion marker leaks exactly what deletion was
      // meant to withdraw.
      if (tombstone.data !== undefined) {
        return fail(
          `The tombstone for "${victim.id}" carried a data field. Core Section 4 specifies no data on tombstones: a deletion notice that still contains the record hands back the content the owner deleted.`,
          [resumed.evidence]
        );
      }
      return pass([deleted.evidence, resumed.evidence]);
    },
  },
];

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
import type { Evidence } from "../report/result.ts";

interface ListBody {
  data?: { id?: string; data?: Record<string, unknown>; deleted?: boolean }[];
  has_more?: boolean;
  meta?: { warnings?: { code?: string }[] };
  next_changes_since?: string;
  next_cursor?: string;
  object?: string;
}

/**
 * Page budget for draining a sync session.
 *
 * A bound rather than "until has_more is false" because a target whose cursor
 * does not advance would otherwise hang the suite. Generous enough that no
 * honest fixture reaches it.
 */
const MAX_SYNC_HOPS = 50;

function asList(json: unknown): ListBody | undefined {
  return typeof json === "object" && json !== null ? (json as ListBody) : undefined;
}

/**
 * Follow a sync session's `next_cursor` to its terminal page, collecting the
 * record ids the later pages delivered and the resume token the session ends
 * on.
 *
 * Extracted from the 8.9-14 case so that case reads as its three steps — open,
 * write, drain — rather than interleaving pagination bookkeeping with the
 * assertion. `evidence` is appended in place because every page fetched is part
 * of the record, including the ones that prove nothing.
 */
async function drainSyncSession(options: {
  adapter: Parameters<ConformanceCase["run"]>[0]["adapter"];
  recordsPath: string;
  token: string;
  cursor: string;
  evidence: Evidence[];
}): Promise<{ redelivered: Set<string>; terminalToken?: string } | { fail: string }> {
  const { adapter, recordsPath, token, evidence } = options;
  const redelivered = new Set<string>();
  let cursor: string | undefined = options.cursor;
  let terminalToken: string | undefined;

  for (let hop = 0; hop < MAX_SYNC_HOPS && cursor !== undefined; hop += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential.
    const next = await request(adapter.baseUrl, recordsPath, {
      token,
      query: { changes_since: "", limit: "1", cursor },
    });
    evidence.push(next.evidence);
    if (next.status !== 200) {
      return { fail: `Following next_cursor within a changes_since session returned ${next.status}.` };
    }
    const body = asList(next.json);
    for (const record of body?.data ?? []) {
      if (record.id !== undefined) {
        redelivered.add(record.id);
      }
    }
    cursor = body?.has_more === true ? body.next_cursor : undefined;
    terminalToken = body?.next_changes_since ?? terminalToken;
  }
  return terminalToken === undefined ? { redelivered } : { redelivered, terminalToken };
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

/**
 * Whether the seeded inventory contains a `mutable_state` stream.
 *
 * RS-7's own MUST binds whenever such a stream is served (Core Section 4 and
 * Section 9 RS item 7), independent of whether the target also declares the
 * `incrementalSync` capability flag. A target that seeds mutable-state data
 * but leaves that flag false still owes the behavior; gating on the flag
 * would let a false declaration hide it as `unsupported` instead of
 * reporting the missing evidence or failure the run actually found.
 */
function hasMutableStateStream(streams: Parameters<ConformanceCase["run"]>[0]["streams"]): boolean {
  return streams.some((s) => s.semantics === "mutable_state");
}

/**
 * Obtain a grant over a `mutable_state` stream specifically, or a reason the
 * case must skip. Incremental-sync cases must not fall back to an arbitrary
 * first stream when the inventory is mixed: an append-only stream can never
 * exhibit RS-7's tombstone or RS-8's terminal-page behavior, so picking one
 * would silently make the case vacuous instead of exercising the requirement.
 */
async function grantForMutableStream(
  adapter: Parameters<ConformanceCase["run"]>[0]["adapter"],
  streams: Parameters<ConformanceCase["run"]>[0]["streams"]
) {
  const stream = streams.find((s) => s.semantics === "mutable_state");
  if (!stream) {
    return { skip: "The adapter seeded no mutable_state stream." as const };
  }
  const grant = await adapter.issueGrant({
    streams: [{ name: stream.name, fields: [...stream.fields] }],
  });
  if (!grant) {
    return { skip: "The target could not issue a grant for the mutable_state stream." as const };
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

  // ----------------------------------------------------------------- 8.9-13 ---
  // Core Section 8: "Eligibility for `changes_since` MUST be computed on the
  // grant-authorized projection, not on the unprojected record. Returning a
  // record whose authorized projection is unchanged is a protocol violation
  // because it leaks that hidden fields changed."
  //
  // The leak is not a field value — the returned record carries only authorized
  // fields, so a case comparing the payload against the projection sees nothing
  // wrong. What leaks is the FACT that something the client may not read has
  // changed, which it learns from the record's mere presence in the delta.
  // Repeated over time that is a side channel on the hidden fields' edit
  // history: who changed, and when, without ever being allowed to see what.
  {
    caseId: "RS-7/sync-eligibility-computed-on-the-authorized-projection",
    requirementId: "RS-7",
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion:
      "A change confined to fields outside the grant's projection does not surface the record in that grant's changes_since delta, while a change inside the projection does.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.semantics === "mutable_state");
      if (!stream) {
        return skip("The adapter seeded no mutable_state stream.");
      }
      if (!adapter.writeRecordField) {
        return skip(
          "The adapter has no writeRecordField hook, so no change can be confined to a single field and the projection/unprojected distinction this clause turns on cannot be constructed."
        );
      }
      // A narrowed grant: at least one field in, at least one field out. With
      // the whole schema granted there is no such thing as an out-of-projection
      // change, and the case would be vacuous.
      //
      // Both fields must be outside the primary key. A write to a key field is
      // not an update to the record — it identifies a different one — so using
      // one as the positive control asks the target to do something incoherent
      // and reads the resulting no-op as a missing delta.
      const writable = stream.fields.filter((f) => !stream.primaryKey.includes(f));
      const [inProjection, outOfProjection] = [writable[0], writable.at(-1)];
      if (!(inProjection && outOfProjection) || inProjection === outOfProjection) {
        return skip(
          `Stream '${stream.name}' declares fewer than two non-primary-key fields, so no grant can both include and exclude one and the clause has nothing to act on.`
        );
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [inProjection] }] });
      if (!grant) {
        return skip(`The target issued no narrowed grant over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      const opened = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: "" },
      });
      if (opened.status !== 200) {
        return fail(`Opening a changes_since session on a mutable_state stream returned ${opened.status}.`, [
          opened.evidence,
        ]);
      }
      const openedBody = asList(opened.json);
      if (openedBody?.has_more === true) {
        return skip("The opening sync page was not terminal, and this case does not page to the end.");
      }
      const resumeToken = openedBody?.next_changes_since;
      if (typeof resumeToken !== "string" || resumeToken.length === 0) {
        return skip("The terminal page carried no next_changes_since, so no delta can be taken. RS-8 covers that.");
      }
      const subject = openedBody?.data?.find((record) => typeof record.id === "string" && !record.deleted);
      if (!subject?.id) {
        return skip("The opening sync session returned no live record to modify.");
      }

      // Write a field the grant does NOT cover. Nothing the client is entitled
      // to see has changed, so the record must not appear.
      const wroteHidden = await adapter.writeRecordField(
        stream.name,
        subject.id,
        outOfProjection,
        `pdpp-conformance-hidden-${Date.now()}`
      );
      if (!wroteHidden) {
        return skip(`The target could not write field '${outOfProjection}' of record '${subject.id}'.`);
      }
      const afterHidden = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: resumeToken },
      });
      const evidence = [opened.evidence, afterHidden.evidence];
      const hiddenSurfaced = asList(afterHidden.json)?.data?.some((record) => record.id === subject.id);
      if (hiddenSurfaced) {
        return fail(
          `Record '${subject.id}' appeared in the changes_since delta after a write to '${outOfProjection}', a field this grant does not authorize. Core Section 8: eligibility MUST be computed on the grant-authorized projection, not the unprojected record — "returning a record whose authorized projection is unchanged is a protocol violation because it leaks that hidden fields changed". The client is not shown the value, but it is told that something it may not read changed, and when.`,
          evidence
        );
      }

      // The positive control, and it is essential: a target that returned an
      // empty delta for every request would satisfy the assertion above while
      // implementing no incremental sync at all. A change INSIDE the projection
      // must surface the record.
      const wroteVisible = await adapter.writeRecordField(
        stream.name,
        subject.id,
        inProjection,
        `pdpp-conformance-visible-${Date.now()}`
      );
      if (!wroteVisible) {
        return skip(`The target could not write field '${inProjection}', so there is no positive control.`);
      }
      const afterVisible = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: resumeToken },
      });
      evidence.push(afterVisible.evidence);
      const visibleSurfaced = asList(afterVisible.json)?.data?.some((record) => record.id === subject.id);
      if (!visibleSurfaced) {
        return skip(
          `A change to '${inProjection}', which this grant DOES authorize, also failed to surface record '${subject.id}'. This target returns an empty delta either way, so its silence after the hidden write is not evidence that eligibility is projection-aware.`
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 8.9-14 ---
  // Session anchoring. Core Section 8: "If a `changes_since` response is
  // paginated, all pages in that session MUST be anchored to the same session
  // horizon selected on the first page. New writes arriving after page 1 MUST
  // NOT appear in later pages of that same session; they surface in the next
  // session via the terminal-page `next_changes_since`."
  //
  // The damage from getting this wrong is not a duplicate record — it is a
  // record that is never delivered at all. A write arriving mid-session shows
  // up in a later page of that session, and the terminal page then hands back a
  // horizon at or past it, so the next session skips it too. The client's copy
  // is silently wrong and nothing reports the gap.
  {
    caseId: "RS-7/paginated-sync-session-anchored-to-one-horizon",
    requirementId: "RS-7",
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion:
      "A write arriving after page 1 of a paginated changes_since session does not appear in later pages of that session, and is delivered by the next session instead.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.semantics === "mutable_state");
      if (!stream) {
        return skip("The adapter seeded no mutable_state stream.");
      }
      if (!adapter.writeRecordField) {
        return skip(
          "The adapter has no writeRecordField hook, so no write can be made to arrive mid-session and the anchoring rule has nothing to act on."
        );
      }
      if (stream.recordCount < 2) {
        return skip(
          `Stream '${stream.name}' seeds ${stream.recordCount} record(s); a session must paginate for this clause to bind, which needs at least two.`
        );
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip(`The target issued no grant over '${stream.name}'.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const field = stream.fields.find((f) => f !== "id") ?? stream.fields[0];
      if (!field) {
        return skip(`Stream '${stream.name}' declares no writable field.`);
      }

      // Page 1 of a sync session, deliberately short so the session paginates.
      const page1 = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: "", limit: "1" },
      });
      if (page1.status !== 200) {
        return fail(`Opening a paginated changes_since session returned ${page1.status}.`, [page1.evidence]);
      }
      const page1Body = asList(page1.json);
      const nextCursor = page1Body?.next_cursor;
      if (page1Body?.has_more !== true || typeof nextCursor !== "string" || nextCursor.length === 0) {
        return skip(
          "The opening sync page was already terminal, so this session never paginates and the anchoring rule does not bind it."
        );
      }
      const onPage1 = new Set((page1Body.data ?? []).map((record) => record.id));

      // Drain the session to its terminal page, recording every record it
      // delivered and the resume token it ends on. The mid-session write goes
      // in BEFORE the last hop, so it is genuinely "after page 1".
      //
      // A single record is written, and the assertion is about where it is
      // allowed to appear: not in this session (its horizon predates the
      // write), and necessarily in the NEXT one (opened from the terminal
      // token). Checking only the first half would pass a server that dropped
      // the write entirely, which is the more damaging failure.
      // The write goes in HERE — after page 1 was served and before any later
      // page is fetched — which is exactly "arriving after page 1". Placing it
      // before the drain loop rather than inside keeps the loop a plain
      // pagination walk.
      //
      // The subject is a record page 1 already delivered, so the only way it
      // can appear again within this session is a re-read clock.
      const [writtenRecordId] = [...onPage1];
      if (writtenRecordId === undefined) {
        return skip("The opening sync page returned no identifiable record to write to.");
      }
      const wrote = await adapter.writeRecordField(
        stream.name,
        writtenRecordId,
        field,
        `pdpp-conformance-midsession-${Date.now()}`
      );
      if (!wrote) {
        return skip(`The target could not write field '${field}' of record '${writtenRecordId}'.`);
      }

      const evidence = [page1.evidence];
      const drained = await drainSyncSession({
        adapter,
        recordsPath,
        token: grant.accessToken,
        cursor: nextCursor,
        evidence,
      });
      if ("fail" in drained) {
        return fail(drained.fail, evidence);
      }
      if (drained.redelivered.has(writtenRecordId)) {
        return fail(
          `Record '${writtenRecordId}' was delivered on page 1 and then delivered AGAIN in a later page of the same changes_since session, after a write that arrived mid-session. Core Section 8: all pages in a session MUST be anchored to the horizon selected on the first page, and new writes "MUST NOT appear in later pages of that same session; they surface in the next session via the terminal-page next_changes_since". A server re-reading the clock per page also returns a terminal horizon past that write, so the next session skips it — the client never receives it and nothing reports the gap.`,
          evidence
        );
      }
      const { terminalToken } = drained;
      if (typeof terminalToken !== "string" || terminalToken.length === 0) {
        return skip("The session's terminal page carried no next_changes_since, so the next session cannot be opened.");
      }

      // The other half: the write must be delivered by the NEXT session. A
      // server that simply lost it would satisfy the assertion above while
      // leaving the client's copy permanently stale.
      const nextSession = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { changes_since: terminalToken },
      });
      evidence.push(nextSession.evidence);
      if (nextSession.status !== 200) {
        return fail(`Opening the next changes_since session returned ${nextSession.status}.`, evidence);
      }
      const surfacedNext = (asList(nextSession.json)?.data ?? []).some((record) => record.id === writtenRecordId);
      if (!surfacedNext) {
        return fail(
          `The mid-session write to record '${writtenRecordId}' was correctly withheld from later pages of its own session, but the NEXT session — opened with the terminal page's next_changes_since — did not deliver it either. Core Section 8 says such writes "surface in the next session via the terminal-page next_changes_since". Withholding it from both means the client never receives the change and has no way to discover it is missing.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ------------------------------------------------------------------ 4.5-1 ---
  // Compound primary-key encoding. Core Section 4: "The canonical string form
  // of a compound key is the minified JSON array of key values (e.g.,
  // `["user_123","2026-04-01"]`). Each primary-key component MUST be serialized
  // as a string in the canonical encoding. Non-string primary-key field values
  // (e.g., integers, dates) MUST be converted to their string representation
  // before encoding."
  //
  // The stringification half is the one servers get wrong, and it is invisible
  // until two implementations meet: a server emitting `["session_a",1]` and one
  // emitting `["session_a","1"]` disagree about the identity of the same
  // record. Since this id is what `resources[]` entries and URL path parameters
  // are built from, the disagreement propagates into authorization — a grant
  // naming one form does not match a record keyed the other.
  //
  // The expected form is DERIVED from the record's own field values against the
  // stream's declared `primary_key`, never compared against an id the suite
  // wrote down: the latter would test the fixture's bookkeeping rather than the
  // target's encoder.
  {
    caseId: "RS-1/compound-primary-key-canonically-encoded",
    requirementId: "RS-1",
    appliesWhen: (_adapter, streams) => streams.length === 0 || streams.some((s) => s.primaryKey.length > 1),
    assertion:
      "A record whose stream declares a compound primary key is identified by the minified JSON array of its key components, each serialized as a string.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.primaryKey.length > 1);
      if (!stream) {
        return skip(
          "No seeded stream declares a compound primary key, so the array encoding this clause governs has nothing to act on."
        );
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip(`The target issued no grant over '${stream.name}'.`);
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`Reading '${stream.name}' returned ${response.status}.`, [response.evidence]);
      }
      const records = asList(response.json)?.data ?? [];
      const [record] = records;
      if (!record?.data) {
        return skip(`The read of '${stream.name}' returned no record carrying data to derive a key from.`);
      }

      // Derived from what the record actually carries, so this checks the
      // target's encoder rather than the suite's expectation of it.
      const components = stream.primaryKey.map((field) => record.data?.[field]);
      if (components.some((value) => value === undefined)) {
        return skip(
          `The returned record does not carry every declared primary-key field (${stream.primaryKey.join(", ")}), so its canonical key cannot be derived from it.`
        );
      }
      const expected = JSON.stringify(components.map((value) => String(value)));
      if (record.id === expected) {
        return pass([response.evidence]);
      }
      // Distinguish the two failure shapes, because they have different causes
      // and a reader fixing one needs to know which.
      const unstringified = JSON.stringify(components);
      if (record.id === unstringified) {
        return fail(
          `Record id ${JSON.stringify(record.id)} encodes its compound key without stringifying every component; Core requires ${expected}. "Non-string primary-key field values (e.g., integers, dates) MUST be converted to their string representation before encoding." Two servers disagreeing on this disagree about the identity of the same record, and since \`resources[]\` entries and URL path parameters are built from this string the disagreement reaches authorization: a grant naming one form does not match a record keyed the other.`,
          [response.evidence]
        );
      }
      return fail(
        `Record id ${JSON.stringify(record.id)} is not the canonical encoding of its declared compound primary key (${stream.primaryKey.join(", ")}); Core requires the minified JSON array ${expected}.`,
        [response.evidence]
      );
    },
  },

  // ------------------------------------------------------------------ 4.3-2 ---
  // Core Section 4 "Cursor expiry": expiring historical version data is a MAY,
  // but a server that DOES expire a cursor "MUST return HTTP 410 Gone with
  // error code `cursor_expired`", and the client "MUST perform a full re-sync".
  //
  // The status code is the whole obligation, and it is load-bearing. A 400
  // reads as a malformed request and invites a retry with a corrected token —
  // which cannot exist, because the token was never malformed, only old. Only
  // the 410 tells the client the one thing it can act on: the baseline is
  // unrecoverable, start over. A client that never learns this silently stops
  // syncing and keeps serving data that drifts further from the source.
  {
    caseId: "RS-7/expired-sync-cursor-reported-as-gone",
    requirementId: "RS-7",
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion:
      "An expired changes_since cursor is answered with 410 cursor_expired, while a live cursor from the same session still resumes.",
    async run({ adapter, streams, path }) {
      const got = await grantForMutableStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      if (!adapter.expireSyncCursor) {
        return skip(
          "The adapter has no expireSyncCursor hook, so no cursor can be aged. Sleeping out a real retention period is not a test, and faking the clock tests the fake — so the target has to be asked to retire a token it issued."
        );
      }
      const recordsPath = path(`/streams/${encodeURIComponent(got.stream.name)}/records`);

      // Advance the stream before opening the session this case will expire.
      //
      // Cases share one target by design (see runCases), so this one must not
      // retire a cursor another case is still holding. A sync token names a
      // position in the stream's history, and two sessions opened with nothing
      // in between name the SAME position — so expiring "this case's token"
      // would expire the identical token any later case obtains. Found exactly
      // that way: the tombstone case began failing with "Resuming a sync from a
      // valid next_changes_since returned 410".
      //
      // Writing first moves the position, so the token opened below is this
      // case's alone. A target that cannot write reports skip rather than
      // damaging the rest of the run.
      const writable = got.stream.fields.find((f) => !got.stream.primaryKey.includes(f));
      if (!(adapter.writeRecordField && writable)) {
        return skip(
          "This case needs writeRecordField and a non-primary-key field, so it can open a sync session at a position no other case shares. Without that, expiring its cursor would retire the identical token a later case obtains, and this case would corrupt the run rather than test it."
        );
      }
      const opening = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { changes_since: "" },
      });
      const seed = asList(opening.json)?.data?.find((r) => typeof r.id === "string" && !r.deleted)?.id;
      if (seed === undefined) {
        return skip("The opening sync session returned no record to advance the stream with.");
      }
      const advanced = await adapter.writeRecordField(
        got.stream.name,
        seed,
        writable,
        `pdpp-conformance-expiry-${Date.now()}`
      );
      if (!advanced) {
        return skip(`The target could not write field '${writable}', so this case cannot isolate its own cursor.`);
      }

      const opened = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { changes_since: "" },
      });
      if (opened.status !== 200) {
        return fail(`Opening a changes_since session returned ${opened.status}.`, [opened.evidence]);
      }
      const openedBody = asList(opened.json);
      if (openedBody?.has_more === true) {
        return skip("The opening sync page was not terminal, and this case does not page to the end.");
      }
      const resumeToken = openedBody?.next_changes_since;
      if (typeof resumeToken !== "string" || resumeToken.length === 0) {
        return skip(
          "The terminal page carried no next_changes_since, so there is no cursor to expire. RS-8 covers that."
        );
      }

      // The positive control FIRST, while the token is still live. Without it,
      // a target that refused every changes_since request would satisfy the
      // negative below while implementing no resumption at all.
      const live = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { changes_since: resumeToken },
      });
      if (live.status !== 200) {
        return skip(
          `Resuming with a freshly issued cursor returned ${live.status}, so this target does not resume sessions at all and a later refusal could not be attributed to expiry.`
        );
      }

      const expired = await adapter.expireSyncCursor(got.stream.name, resumeToken);
      if (!expired) {
        return skip(
          "This deployment does not expire sync cursors. Core makes expiry a MAY, so declining to retire historical version data is conforming and there is no obligation to observe."
        );
      }
      const response = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { changes_since: resumeToken },
      });
      const evidence = [opened.evidence, live.evidence, response.evidence];

      if (response.status === 200) {
        return fail(
          "A cursor the target reported as expired was still served a delta. A client resuming from a cursor the server can no longer honour receives an incomplete change set and has no way to detect the gap.",
          evidence
        );
      }
      if (response.status !== 410) {
        return fail(
          `An expired changes_since cursor was answered with ${response.status} rather than 410. Core Section 4: "If a client's cursor has expired, the resource server MUST return HTTP 410 Gone with error code cursor_expired." Any other status reads as a client error and invites a retry with a corrected token, which cannot exist — the token was never malformed, only old. Only the 410 tells the client to discard its baseline and full re-sync.`,
          evidence
        );
      }
      const error = errorBody(response);
      if (error?.code !== "cursor_expired") {
        return fail(
          `The expired cursor was answered 410 but classified as "${error?.code ?? "no structured error"}" rather than cursor_expired. Clients branch on the code, not the status alone.`,
          evidence
        );
      }

      // Leave the stream past the position that was just retired.
      //
      // A sync token names a position in the stream's history, so a later case
      // opening a session while the stream sits where it does now would be
      // handed the very token this case expired — and would see a 410 it has no
      // way to explain. Advancing once restores a usable position for everyone
      // after us. Cases share one target by design (runCases), and a case that
      // retires a cursor owes the run this cleanup.
      await adapter.writeRecordField(got.stream.name, seed, writable, `pdpp-conformance-expiry-done-${Date.now()}`);
      return pass(evidence);
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
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion:
      "The terminal page of a changes_since response carries next_changes_since so the next session can resume.",
    async run({ adapter, streams, path }) {
      const got = await grantForMutableStream(adapter, streams);
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
        return fail(
          `The seeded inventory serves a mutable_state stream, which obliges changes_since support (RS-7), but a changes_since request returned ${response.status}.`,
          [response.evidence]
        );
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

  // ---------------------------------------------------------------- RS-6 ---
  // Section 8 "Stable sort" (clause 8.9-11): "Page cursors are direction-bound:
  // a client MUST follow a `next_cursor` with the same `order` value that
  // produced it. ... Resource servers MUST reject order-mismatched page cursors
  // as `invalid_cursor`."
  //
  // Distinct from RS-6/malformed-cursor-rejected, which sends a string no
  // server could have minted. This cursor is entirely valid — the server issued
  // it moments earlier — and only the direction it is replayed under is wrong.
  // A server that validates cursor SYNTAX passes that case and fails this one.
  //
  // The defect is silent and it corrupts the client's data, not its error
  // handling. A cursor encodes a position in `(cursor_field, primary_key)`
  // order; reading it under the opposite direction walks away from the records
  // between that position and the end the client already consumed. Those
  // records are never returned and never reported missing, so a client that
  // flips `order` mid-pagination — the exact mistake this clause exists to make
  // impossible — silently syncs a partial stream and has no way to detect it.
  {
    caseId: "RS-6/order-mismatched-cursor-rejected",
    requirementId: "RS-6",
    assertion:
      "A valid page cursor replayed with the opposite order value is rejected with 400 invalid_cursor, while the same cursor under its original order still pages.",
    async run({ adapter, streams, path }) {
      const got = await grantForFirstStream(adapter, streams);
      if ("skip" in got) {
        return skip(got.skip);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(got.stream.name)}/records`);

      // Page once under an EXPLICIT order, so the direction the cursor was
      // produced under is a fact of the request rather than a server default
      // this case would be assuming.
      const first = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { limit: "1", order: "desc" },
      });
      if (first.status !== 200) {
        return fail(`Paging a granted stream with order=desc returned ${first.status}.`, [first.evidence]);
      }
      const cursor = asList(first.json)?.next_cursor;
      if (typeof cursor !== "string" || cursor.length === 0) {
        return skip(
          "The seeded stream is too short to produce a page cursor, so there is no valid cursor to replay under the opposite order."
        );
      }

      // Positive control FIRST: the same cursor under the order that produced
      // it must still page. Without this, a server that rejects every cursor —
      // or every request carrying `order` — satisfies the assertion below while
      // being unable to paginate at all.
      const sameOrder = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { limit: "1", order: "desc", cursor },
      });
      if (sameOrder.status !== 200) {
        return fail(
          `A cursor replayed under the same order value that produced it was refused (${sameOrder.status}). Section 8 binds a cursor to its direction, not against it: following next_cursor with an unchanged order is the ordinary pagination path.`,
          [first.evidence, sameOrder.evidence]
        );
      }

      const flipped = await request(adapter.baseUrl, recordsPath, {
        token: got.grant.accessToken,
        query: { limit: "1", order: "asc", cursor },
      });
      if (flipped.status === 200) {
        return fail(
          "A page cursor produced under order=desc was accepted when replayed with order=asc. Section 8 requires resource servers to reject order-mismatched page cursors as invalid_cursor: a cursor encodes a position in the (cursor_field, primary_key) ordering, so reading it under the opposite direction skips every record between that position and the end the client already consumed — silently, with has_more and next_cursor still looking well-formed.",
          [first.evidence, flipped.evidence]
        );
      }
      if (flipped.status !== 400) {
        return fail(
          `Expected 400 invalid_cursor for an order-mismatched cursor, got ${flipped.status}. A 5xx tells a client the server failed and the request should be retried unchanged; a 400 invalid_cursor tells it to restart pagination without the cursor, which is the recovery Section 8 specifies.`,
          [first.evidence, flipped.evidence]
        );
      }
      const error = errorBody(flipped);
      if (error?.code !== "invalid_cursor") {
        return fail(
          `The order-mismatched cursor was refused with 400 but classified as "${error?.code ?? "no structured error"}" rather than invalid_cursor. Section 8 names that code as the signal to restart pagination; a client cannot recover from a refusal it cannot classify.`,
          [first.evidence, flipped.evidence]
        );
      }
      return pass([first.evidence, sameOrder.evidence, flipped.evidence]);
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
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion:
      "A page cursor presented as changes_since is rejected rather than silently accepted (distinct token spaces).",
    async run({ adapter, streams, path }) {
      const got = await grantForMutableStream(adapter, streams);
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
    appliesWhen: (_adapter, streams) => streams.length === 0 || hasMutableStateStream(streams),
    assertion: "A record deleted after a sync cursor was issued appears as a tombstone when that cursor resumes.",
    async run({ adapter, streams, path }) {
      // Owner token: deletion is an owner operation, and the sync leg must run
      // as the same principal so the two cursors share a scope.
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target issues no owner token, so no record can be deleted to observe.");
      }
      // Deliberately the LAST seeded mutable_state stream, not an arbitrary
      // last stream: an append-only stream can never exhibit a tombstone, and
      // among multiple mutable_state streams this keeps the earlier ones free
      // for cases that assert exact record counts, so this case's deletion
      // side effect does not couple to their oracles.
      const stream = [...streams].reverse().find((s) => s.semantics === "mutable_state");
      if (!stream || stream.recordCount < 1) {
        return skip("No seeded mutable_state stream with a record to delete.");
      }
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      // 1. Open a sync session and take the resume token from its terminal page.
      const opened = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, changes_since: "" },
      });
      if (opened.status !== 200) {
        return fail(
          `The seeded inventory serves a mutable_state stream, which obliges changes_since support (RS-7), but opening a sync session returned ${opened.status}.`,
          [opened.evidence]
        );
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// List-records cases for a grant that lists SEVERAL instance handles for one
// stream (Core Section 7, StreamGrant `instance_ids`: "Multiple handles
// authorize fan-in only when explicitly listed").
//
// Section 8 serves those instances as ONE collection, so everything it says
// about a list read -- `limit` is records per page, records are sorted by
// `(cursor_field, primary_key)`, `next_cursor` continues the walk,
// `changes_since` works on a `mutable_state` stream -- has to hold across the
// instances, not per instance. A single-instance grant cannot show any of it
// failing, and a reference implementation shipped each of the four defects
// below while passing every single-instance case. The `issueMultiInstanceGrant`
// adapter hook supplies the fixture; a target without it reports `skip` naming
// the hook.

import type { MultiInstanceFixture, TargetAdapter } from "../harness/adapter.ts";
import { request } from "../harness/http.ts";
import { type CaseVerdict, type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

interface ListBody {
  data?: { id?: string }[];
  has_more?: boolean;
  next_changes_since?: string;
  next_cursor?: string;
}

/** Generous bound on pages walked; the 140-record fixture needs at most 5 at limit=30. */
const MAX_PAGES = 100;

const NO_HOOK_SKIP =
  "The adapter has no issueMultiInstanceGrant hook, so no grant listing two instance handles for one stream can be arranged. The target is not judged on fan-in behaviour it was never asked to show.";

type Run = Parameters<ConformanceCase["run"]>[0];

async function arrange(adapter: TargetAdapter): Promise<MultiInstanceFixture | CaseVerdict> {
  if (!adapter.issueMultiInstanceGrant) {
    return skip(NO_HOOK_SKIP);
  }
  const fixture = await adapter.issueMultiInstanceGrant();
  if (!fixture) {
    return skip("The target could not issue a grant listing two instance handles for one stream.");
  }
  if (fixture.instanceIds.length < 2 || fixture.records.length <= 100) {
    return skip(
      "The adapter's multi-instance fixture lists fewer than two instances or no more than 100 records, which cannot show a limit, order or cursor defect."
    );
  }
  return fixture;
}

interface Walk {
  readonly evidence: Evidence[];
  readonly pages: { readonly ids: readonly string[]; readonly hasMore: boolean; readonly nextCursor?: string }[];
  /** Set when a page reported has_more without a usable next_cursor, or a page failed. */
  readonly stoppedAt?: {
    readonly page: number;
    readonly reason: "no-next-cursor" | "status";
    readonly status?: number;
  };
  readonly terminal?: ListBody;
}

/**
 * Walk every page of one read, following `next_cursor`, until `has_more` is not true.
 *
 * `firstPageOnly` holds parameters that open a session (`changes_since`). Core
 * Section 8: pass `changes_since` on the first request, then follow
 * `next_cursor` for later pages within that session -- so they are sent once.
 */
async function walk(
  run: Run,
  fixture: MultiInstanceFixture,
  query: Record<string, string>,
  firstPageOnly: Record<string, string> = {}
): Promise<Walk> {
  const { adapter, path } = run;
  const recordsPath = path(`/streams/${encodeURIComponent(fixture.stream)}/records`);
  const evidence: Evidence[] = [];
  const pages: Walk["pages"][number][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential.
    const response = await request(adapter.baseUrl, recordsPath, {
      token: fixture.grant.accessToken,
      query: { ...query, ...(cursor === undefined ? firstPageOnly : { cursor }) },
    });
    evidence.push(response.evidence);
    if (response.status !== 200) {
      return { evidence, pages, stoppedAt: { page, reason: "status", status: response.status } };
    }
    const body = (response.json ?? {}) as ListBody;
    const hasMore = body.has_more === true;
    pages.push({
      ids: (body.data ?? []).map((record) => record.id ?? ""),
      hasMore,
      ...(body.next_cursor === undefined ? {} : { nextCursor: body.next_cursor }),
    });
    if (!hasMore) {
      return { evidence, pages, terminal: body };
    }
    if (typeof body.next_cursor !== "string" || body.next_cursor.length === 0) {
      return { evidence, pages, stoppedAt: { page, reason: "no-next-cursor" } };
    }
    cursor = body.next_cursor;
  }
  return { evidence, pages, stoppedAt: { page: MAX_PAGES, reason: "no-next-cursor" } };
}

const NO_NEXT_CURSOR_SKIP =
  "A page reported has_more without a next_cursor, so the walk cannot continue; RS-1/list-has-more-carries-next-cursor-across-instances owns that failure.";

/** Expected order per Section 8: cursor ascending, primary key ascending, absent cursors last. */
function expectedAscending(fixture: MultiInstanceFixture): string[] {
  return [...fixture.records]
    .sort((a, b) => {
      if (a.cursor === null || b.cursor === null) {
        if (a.cursor === b.cursor) {
          return a.id.localeCompare(b.id);
        }
        return a.cursor === null ? 1 : -1;
      }
      return a.cursor.localeCompare(b.cursor) || a.id.localeCompare(b.id);
    })
    .map((record) => record.id);
}

export const MULTI_INSTANCE_CASES: readonly ConformanceCase[] = [
  // Core Section 8 `limit`: "Records per page. Default 25, max 100." The
  // defect applies the limit to each instance and concatenates, so limit=100
  // over two instances returns up to 200 rows and a client sizing buffers from
  // the limit it sent is overrun.
  {
    caseId: "RS-1/list-page-size-bounded-by-limit-across-instances",
    requirementId: "RS-1",
    assertion:
      "With a grant listing two instances of one stream, no page exceeds limit, and walking every page returns each record exactly once.",
    async run(run) {
      const fixture = await arrange(run.adapter);
      if ("outcome" in fixture) {
        return fixture;
      }
      const evidence: Evidence[] = [];
      for (const limit of [100, 30]) {
        // biome-ignore lint/performance/noAwaitInLoops: two walks, kept sequential so evidence stays ordered.
        const result = await walk(run, fixture, { limit: String(limit), order: "asc" });
        evidence.push(...result.evidence);
        const oversized = result.pages.findIndex((page) => page.ids.length > limit);
        if (oversized >= 0) {
          return fail(
            `With limit=${limit}, page ${oversized + 1} held ${result.pages[oversized]?.ids.length} records. Core Section 8: limit is "Records per page"; applying it per instance and concatenating lets a page exceed it.`,
            evidence
          );
        }
        if (result.stoppedAt?.reason === "status") {
          return fail(`A page of the limit=${limit} walk returned ${result.stoppedAt.status}.`, evidence);
        }
        if (result.stoppedAt) {
          return skip(NO_NEXT_CURSOR_SKIP);
        }
        const seen = result.pages.flatMap((page) => page.ids);
        const expected = new Set(fixture.records.map((record) => record.id));
        const duplicates = seen.filter((id, index) => seen.indexOf(id) !== index);
        const missing = [...expected].filter((id) => !seen.includes(id));
        if (duplicates.length > 0 || missing.length > 0 || seen.length !== expected.size) {
          return fail(
            `Walking every page at limit=${limit} returned ${seen.length} rows for ${expected.size} records (${duplicates.length} repeated, ${missing.length} missing). Each record must appear exactly once.`,
            evidence
          );
        }
      }
      return pass(evidence);
    },
  },

  // Core Section 8 stable sort: "Records are sorted by `(cursor_field,
  // primary_key)` for cursor safety. Null or absent `cursor_field` values sort
  // after present values." One collection, so the order is across instances:
  // the defect emits instance A's sorted run then instance B's.
  //
  // `order=asc` is requested explicitly. What `order=desc` does to the
  // primary-key tiebreak and to absent values is not stated, so it is not
  // asserted.
  {
    caseId: "RS-1/list-sort-order-across-instances",
    requirementId: "RS-1",
    assertion:
      "With a grant listing two instances, records come back in (cursor_field, primary_key) order across the instances, absent cursor values last.",
    async run(run) {
      const fixture = await arrange(run.adapter);
      if ("outcome" in fixture) {
        return fixture;
      }
      const result = await walk(run, fixture, { limit: "100", order: "asc" });
      if (result.stoppedAt?.reason === "status") {
        return fail(`A page of the walk returned ${result.stoppedAt.status}.`, result.evidence);
      }
      if (result.stoppedAt) {
        return skip(NO_NEXT_CURSOR_SKIP);
      }
      const seen = result.pages.flatMap((page) => page.ids);
      const expected = expectedAscending(fixture);
      const firstWrong = expected.findIndex((id, index) => seen[index] !== id);
      if (firstWrong >= 0 || seen.length !== expected.length) {
        return fail(
          `Rows are not in (${fixture.cursorField}, primary key) order across instances: row ${firstWrong + 1} is "${seen[firstWrong]}", expected "${expected[firstWrong]}" (${seen.length} rows seen, ${expected.length} expected).`,
          result.evidence
        );
      }
      return pass(result.evidence);
    },
  },

  // Core Section 8 pagination: a page with more records after it is followed
  // with `next_cursor`. The defect reports `has_more: true` and mints no cursor,
  // stranding the client on page one. Core states the link between `has_more`
  // and `next_cursor` through its example and the "follow `next_cursor`" text
  // rather than with an RFC 2119 keyword; the case asserts the invariant a
  // pager cannot work without.
  {
    caseId: "RS-1/list-has-more-carries-next-cursor-across-instances",
    requirementId: "RS-1",
    assertion:
      "With a grant listing two instances, every page that reports has_more: true carries a next_cursor that resumes the walk.",
    async run(run) {
      const fixture = await arrange(run.adapter);
      if ("outcome" in fixture) {
        return fixture;
      }
      const result = await walk(run, fixture, { limit: "30", order: "asc" });
      if (result.stoppedAt?.reason === "status") {
        return fail(`A page of the walk returned ${result.stoppedAt.status}.`, result.evidence);
      }
      if (result.stoppedAt) {
        return fail(
          `Page ${result.stoppedAt.page + 1} reported has_more: true with no next_cursor, so a client cannot continue past it although ${fixture.records.length} records span the grant's instances.`,
          result.evidence
        );
      }
      const total = result.pages.reduce((sum, page) => sum + page.ids.length, 0);
      if (total !== fixture.records.length) {
        return fail(
          `Following next_cursor to the end returned ${total} rows for ${fixture.records.length} records.`,
          result.evidence
        );
      }
      return pass(result.evidence);
    },
  },

  // Section 9 RS item 7 + Section 8: `changes_since` is supported for
  // `mutable_state` streams, and the terminal page carries
  // `next_changes_since`. Nothing in Core exempts a grant that lists several
  // instances; the defect answered it with 400.
  {
    caseId: "RS-7/changes-since-accepted-on-multi-instance-grant",
    requirementId: "RS-7",
    appliesWhen: (adapter) => adapter.capabilities.incrementalSync,
    assertion:
      "changes_since on a mutable_state grant listing two instances is accepted, and the terminal page carries next_changes_since.",
    async run(run) {
      const fixture = await arrange(run.adapter);
      if ("outcome" in fixture) {
        return fixture;
      }
      const result = await walk(
        run,
        fixture,
        { limit: "100" },
        { changes_since: run.adapter.changesSinceBootstrap ?? "" }
      );
      if (result.stoppedAt?.reason === "status") {
        return fail(
          `changes_since on a grant listing ${fixture.instanceIds.length} instances of a mutable_state stream returned ${result.stoppedAt.status}. Section 9 RS item 7 obliges changes_since for mutable_state streams, with no exemption for multi-instance grants.`,
          result.evidence
        );
      }
      if (result.stoppedAt) {
        return skip(NO_NEXT_CURSOR_SKIP);
      }
      const token = result.terminal?.next_changes_since;
      if (typeof token !== "string" || token.length === 0) {
        return fail(
          "The terminal page of a changes_since read on a multi-instance grant carried no next_changes_since.",
          result.evidence
        );
      }
      return pass(result.evidence);
    },
  },
];

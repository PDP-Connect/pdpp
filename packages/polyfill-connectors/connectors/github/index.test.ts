// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, before, type TestContext, test } from "node:test";
import { evaluateStreamCoherence } from "@pdpp/reference-contract/evidence";
import { closeDb, getDb, initDb } from "../../../../reference-implementation/server/db.ts";
import { drainConnectorInstanceIndexWork, ingestRecord } from "../../../../reference-implementation/server/records.ts";
import { buildPacingStateFields, readPersistedPacingInterval } from "../../src/connector-http-governor.ts";
import type { StreamScope } from "../../src/connector-runtime.ts";
import {
  __setMaxGithubListPages,
  collectGists,
  collectIssues,
  collectPullRequests,
  collectRepositories,
  collectStarred,
  collectUser,
  createGithubHttpGovernor,
  GITHUB_RETRYABLE_PATTERN,
  isoYear,
  prCreatedWindows,
  resolvePrSearchWindows,
  type StreamCtx,
} from "./index.ts";

// The connector now ships adaptive pacing on by default (the shared governor's
// default-on rate control). A per-run governor sleeps the real GCRA interval
// between requests, which would make these fetch-stubbing collector tests pay
// seconds of real wall-clock. Resolve pacing waits instantly so the suite stays
// fast and timing-deterministic; behavioral pacing is proven in
// src/connector-http-governor.test.ts, not here.
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
before(() => {
  // Fire the callback on the next microtask (async, but no real delay) so the
  // pacing `await sleep(...)` resolves immediately without re-entrant stack risk.
  // Patch `globalThis.setTimeout` in place: keep the original's identity (so its
  // full `typeof setTimeout` shape — `__promisify__` and all — is preserved) and
  // only override the call behaviour via a Proxy `apply` trap. No type assertion
  // is needed because the Proxy is the original function's type.
  globalThis.setTimeout = new Proxy(ORIGINAL_SET_TIMEOUT, {
    apply: (_target, _thisArg, callArgs: unknown[]) => {
      const [handler, , ...args] = callArgs as [TimerHandler, number?, ...unknown[]];
      if (typeof handler === "function") {
        queueMicrotask(() => (handler as (...a: unknown[]) => void)(...args));
      }
      const handle = ORIGINAL_SET_TIMEOUT(() => undefined, 0);
      clearTimeout(handle);
      return handle;
    },
  });
  initDb(":memory:");
});

after(async () => {
  await drainConnectorInstanceIndexWork();
  closeDb();
});

type GithubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetch(t: TestContext, implementation: GithubFetch): void {
  t.mock.method(globalThis, "fetch", implementation);
}

function installUserFetch(t: TestContext): void {
  mockFetch(
    t,
    async () =>
      new Response(
        JSON.stringify({
          id: 42,
          login: "octocat",
          name: "Octo Cat",
          public_repos: 10,
          public_gists: 2,
          followers: 100,
          following: 5,
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        }),
        { status: 200 }
      )
  );
}

interface CapturedSkip {
  diagnostics?: unknown;
  message: string;
  reason: string;
  recovery_hint?: unknown;
  stream: string;
}

interface CapturedCoverage {
  considered: number | undefined;
  covered: number | undefined;
  hydratedKeys: number;
  requiredKeys: number;
  stateStream: string;
  stream: string;
}

function isRetryableGithubGap(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string; retryable?: boolean }).code === "github_pagination_gap" &&
    (error as Error & { code?: string; retryable?: boolean }).retryable === true
  );
}

function makeCtx(
  requestedStreams: readonly string[],
  state: Record<string, unknown> = {},
  options: { retrySleep?: (ms: number) => void | Promise<void> } = {}
): {
  ctx: StreamCtx;
  coverages: CapturedCoverage[];
  records: Array<{ stream: string; data: Record<string, unknown> }>;
  skips: CapturedSkip[];
  states: Array<{ stream: string; cursor: unknown }>;
  progresses: Array<{ message: string; extra?: { phase?: string } }>;
} {
  const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const states: Array<{ stream: string; cursor: unknown }> = [];
  const skips: CapturedSkip[] = [];
  const coverages: CapturedCoverage[] = [];
  const progresses: Array<{ message: string; extra?: { phase?: string } }> = [];
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  const httpGovernor = createGithubHttpGovernor(options);
  return {
    ctx: {
      emit: (msg) => {
        if (msg.type === "SKIP_RESULT") {
          skips.push({
            stream: msg.stream,
            reason: msg.reason,
            message: msg.message,
            diagnostics: msg.diagnostics,
            recovery_hint: msg.recovery_hint,
          });
        } else if (msg.type === "DETAIL_COVERAGE") {
          coverages.push({
            stream: msg.stream,
            stateStream: msg.state_stream,
            requiredKeys: msg.required_keys.length,
            hydratedKeys: msg.hydrated_keys.length,
            considered: msg.considered,
            covered: msg.covered,
          });
        } else {
          states.push({ stream: msg.stream, cursor: msg.cursor });
        }
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ stream, data });
        return Promise.resolve();
      },
      httpGovernor,
      progress: (message, extra) => {
        progresses.push({ message, ...(extra?.phase === undefined ? {} : { extra: { phase: extra.phase } }) });
        return Promise.resolve();
      },
      requested,
      state,
      token: "fake-token",
    },
    coverages,
    records,
    skips,
    states,
    progresses,
  };
}

test("collectUser: user_stats-only scope emits only user_stats records and state", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, records, states } = makeCtx(["user_stats"]);
  await collectUser(ctx);

  assert.deepEqual(
    records.map((r) => r.stream),
    ["user_stats"]
  );
  assert.deepEqual(
    states.map((s) => s.stream),
    ["user_stats"]
  );
  assert.equal(records[0]?.data.user_id, "42");
  assert.equal(records[0]?.data.followers, 100);
});

test("collectUser: user-only scope emits only user entity records and state", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, records, states } = makeCtx(["user"]);
  await collectUser(ctx);

  assert.deepEqual(
    records.map((r) => r.stream),
    ["user"]
  );
  assert.deepEqual(
    states.map((s) => s.stream),
    ["user"]
  );
  assert.equal(records[0]?.data.id, "42");
  assert.equal("followers" in (records[0]?.data ?? {}), false);
});

test("collectUser: records the user cursor on ctx.userCursor as the warm-start carrier", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, states } = makeCtx(["user"]);
  await collectUser(ctx);

  // collect() re-emits this cursor at run end merged with the final learned
  // pacing interval, so it must be captured (the warm-start persistence carrier).
  assert.ok(ctx.userCursor, "the user cursor is recorded for warm-start persistence");
  assert.equal(
    ctx.userCursor,
    states.find((s) => s.stream === "user")?.cursor,
    "the recorded carrier is the same object emitted as the user STATE cursor"
  );
});

test("warm-start: pacing fields merged onto the user cursor round-trip through readPersistedPacingInterval", (t: TestContext) => {
  installUserFetch(t);
  // Simulate the collect-end persist: the user cursor + the learned pacing fields.
  const now = 2_000_000;
  const persistedUserCursor = {
    fetched_at: "2026-06-10T00:00:00Z",
    fingerprints: { someKey: "fp" },
    ...buildPacingStateFields(
      { snapshot: () => ({ intervalMs: 480, minIntervalMs: 250, initialIntervalMs: 1000, lastBackoff: null }) },
      {
        now: () => now,
      }
    ),
  };
  // The fingerprint cursor and the pacing keys coexist (disjoint keys).
  assert.equal(persistedUserCursor.fetched_at, "2026-06-10T00:00:00Z");
  assert.ok(persistedUserCursor.fingerprints);
  // Next run reads the learned interval back off the user cursor (warm-start).
  const restored = readPersistedPacingInterval(persistedUserCursor, { now: () => now + 1000 });
  assert.equal(restored, 480, "the next run warm-starts from the interval persisted on the user cursor");
});

// ─── Starred dropped-item evidence ──────────────────────────────────────

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  // No `link` header → gh() pagination stops after this page.
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function starredEntry(id: number, withRepo: boolean): Record<string, unknown> {
  return {
    starred_at: `2026-05-${String(id).padStart(2, "0")}T00:00:00Z`,
    repo: withRepo ? { id, full_name: `owner/repo-${String(id)}`, stargazers_count: 1 } : undefined,
  };
}

test("collectStarred: entries with no repo are counted and surfaced as one bounded SKIP_RESULT", async (t: TestContext) => {
  // One valid entry, two with a missing `repo` (repo deleted/private since star).
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, false), starredEntry(3, false)]))
  );
  const { ctx, records, skips, states } = makeCtx(["starred"]);
  await collectStarred(ctx);

  // Only the one with a repo became a record.
  assert.deepEqual(
    records.map((r) => r.stream),
    ["starred"]
  );
  // Exactly one stream-level skip summary (count, not per-item flood).
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.stream, "starred");
  assert.equal(skips[0]?.reason, "starred_entry_missing_repo");
  assert.match(skips[0]?.message ?? "", /dropped 2 starred entries/);
  assert.deepEqual(skips[0]?.diagnostics, { dropped: 2, total_seen: 3 });
  // STATE still emitted so the cursor advances.
  assert.deepEqual(
    states.map((s) => s.stream),
    ["starred"]
  );
});

test("collectStarred: no drops emits no SKIP_RESULT (run looks complete only when it is)", async (t: TestContext) => {
  mockFetch(t, () => Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, true)])));
  const { ctx, records, skips } = makeCtx(["starred"]);
  await collectStarred(ctx);

  assert.equal(records.length, 2);
  assert.equal(skips.length, 0);
});

test("collectStarred: singular grammar for a single dropped entry", async (t: TestContext) => {
  mockFetch(t, () => Promise.resolve(jsonResponse([starredEntry(1, false)])));
  const { ctx, skips } = makeCtx(["starred"]);
  await collectStarred(ctx);

  assert.equal(skips.length, 1);
  assert.match(skips[0]?.message ?? "", /dropped 1 starred entry with no repo/);
});

// ─── PR detail-fetch degradation evidence ───────────────────────────────

function prSearchItem(id: number, repo: string): Record<string, unknown> {
  return {
    id,
    number: id,
    title: `PR ${String(id)}`,
    updated_at: `2026-05-${String(id).padStart(2, "0")}T00:00:00Z`,
    repository_url: `https://api.github.com/repos/${repo}`,
    user: { login: "octocat", id: 42 },
  };
}

/**
 * Routes the three request shapes collectPullRequests makes:
 *  - GET /user                        → login
 *  - GET /search/issues?...           → PR summaries
 *  - GET /repos/{owner}/{repo}/pulls/{n} → per-PR detail (may 500)
 * `failDetailForRepos` returns a non-fatal 400 for those repos' detail fetch.
 */
function installPrFetch(
  t: TestContext,
  items: Record<string, unknown>[],
  failDetailForRepos: ReadonlySet<string>
): void {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat" }));
    }
    if (url.includes("/search/issues")) {
      return Promise.resolve(jsonResponse({ total_count: items.length, items }));
    }
    const detailMatch = /\/repos\/([^/]+\/[^/]+)\/pulls\/\d+$/.exec(url);
    if (detailMatch) {
      const repo = detailMatch[1] ?? "";
      if (failDetailForRepos.has(repo)) {
        // Non-retryable provider error → counted, not thrown.
        return Promise.resolve(new Response("bad request", { status: 400 }));
      }
      return Promise.resolve(jsonResponse({ merged_at: "2026-05-10T00:00:00Z", commits: 3 }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

const REPLAY_CONNECTOR_ID = "github";
const REPLAY_STREAM = "pull_requests";

async function ingestPullRequestRecords(
  connectorInstanceId: string,
  records: Array<{ stream: string; data: Record<string, unknown> }>
): Promise<void> {
  await records.reduce(
    (previous, { stream, data }) =>
      previous
        .then(() =>
          ingestRecord(
            {
              connector_id: REPLAY_CONNECTOR_ID,
              connector_instance_id: connectorInstanceId,
            },
            {
              data,
              emitted_at: "2026-08-11T00:00:00.000Z",
              key: String(data.id),
              op: "upsert",
              stream,
            }
          )
        )
        .then(() => undefined),
    Promise.resolve()
  );
}

function readDurablePullRequestRows(connectorInstanceId: string): Array<{
  connector_instance_id: string;
  record_key: string;
  stream: string;
}> {
  return getDb()
    .prepare(
      `SELECT connector_instance_id, stream, record_key
       FROM records
       WHERE connector_id = ? AND connector_instance_id = ? AND stream = ? AND deleted = 0
       ORDER BY record_key`
    )
    .all(REPLAY_CONNECTOR_ID, connectorInstanceId, REPLAY_STREAM) as Array<{
    connector_instance_id: string;
    record_key: string;
    stream: string;
  }>;
}

test("collectPullRequests: detail-fetch failures emit one bounded degradation SKIP_RESULT, records still emitted", async (t: TestContext) => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b"), prSearchItem(3, "owner/c")];
  installPrFetch(t, items, new Set(["owner/b", "owner/c"]));
  const { ctx, records, skips } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  // All three records are still emitted (degradation, not a drop).
  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 3);
  // The two failed-detail records have null detail fields; the ok one is populated.
  const byId = new Map(records.map((r) => [r.data.id, r.data]));
  assert.equal(byId.get("1")?.commits_count, 3);
  assert.equal(byId.get("2")?.commits_count, null);
  assert.equal(byId.get("3")?.merged_at, null);
  // Exactly one stream-level summary, count only, no identifiers.
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.stream, "pull_requests");
  assert.equal(skips[0]?.reason, "pr_detail_fetch_failed");
  assert.match(skips[0]?.message ?? "", /2 of 3 pull request record\(s\) emitted without detail/);
  assert.deepEqual(skips[0]?.diagnostics, { detail_failed: 2, total_emitted: 3, total_seen: 3 });
});

test("collectPullRequests: all details fetched → no degradation SKIP_RESULT", async (t: TestContext) => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
  installPrFetch(t, items, new Set());
  const { ctx, records, skips } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 2);
  assert.equal(skips.length, 0);
});

test("collectPullRequests: degradation denominator counts emitted records, not filtered search hits", async (t: TestContext) => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b"), prSearchItem(3, "owner/c")];
  installPrFetch(t, items, new Set(["owner/b"]));
  const { ctx, records, skips } = makeCtx(["pull_requests"]);
  ctx.requested.set("pull_requests", {
    name: "pull_requests",
    time_range: { until: "2026-05-03T00:00:00Z" },
  });

  await collectPullRequests(ctx);

  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 2);
  assert.equal(skips.length, 1);
  assert.match(skips[0]?.message ?? "", /1 of 2 pull request record\(s\) emitted without detail/);
  assert.deepEqual(skips[0]?.diagnostics, { detail_failed: 1, total_emitted: 2, total_seen: 3 });
});

// ─── Search-cap windowing: pure window math ──────────────────────────────

test("isoYear: parses leading year, tolerates absent/garbage", () => {
  assert.equal(isoYear("2018-04-01T00:00:00Z"), 2018);
  assert.equal(isoYear("2018"), 2018);
  assert.equal(isoYear(null), null);
  assert.equal(isoYear(undefined), null);
  assert.equal(isoYear("not-a-date"), null);
});

test("prCreatedWindows: descending year windows inclusive of both ends", () => {
  assert.deepEqual(prCreatedWindows(2026, 2024), [
    { from: "2026-01-01", to: "2026-12-31" },
    { from: "2025-01-01", to: "2025-12-31" },
    { from: "2024-01-01", to: "2024-12-31" },
  ]);
});

test("prCreatedWindows: single year when floor equals current", () => {
  assert.deepEqual(prCreatedWindows(2026, 2026), [{ from: "2026-01-01", to: "2026-12-31" }]);
});

test("prCreatedWindows: tolerates inverted bounds (floor after current)", () => {
  // Should never happen (account predates PRs) but must not loop forever.
  assert.deepEqual(prCreatedWindows(2024, 2026), [
    { from: "2026-01-01", to: "2026-12-31" },
    { from: "2025-01-01", to: "2025-12-31" },
    { from: "2024-01-01", to: "2024-12-31" },
  ]);
});

test("resolvePrSearchWindows: incremental run (since bound) is one unwindowed query", () => {
  const windows = resolvePrSearchWindows(
    "2026-05-01T00:00:00Z",
    "2018-01-01T00:00:00Z",
    new Date("2026-06-04T00:00:00Z")
  );
  assert.deepEqual(windows, [undefined]);
});

test("resolvePrSearchWindows: full resync windows from now back to account-creation year", () => {
  const windows = resolvePrSearchWindows(null, "2024-03-10T00:00:00Z", new Date("2026-06-04T00:00:00Z"));
  assert.deepEqual(windows, [
    { from: "2026-01-01", to: "2026-12-31" },
    { from: "2025-01-01", to: "2025-12-31" },
    { from: "2024-01-01", to: "2024-12-31" },
  ]);
});

test("resolvePrSearchWindows: missing account created_at floors at current year (single window)", () => {
  const windows = resolvePrSearchWindows(null, undefined, new Date("2026-06-04T00:00:00Z"));
  assert.deepEqual(windows, [{ from: "2026-01-01", to: "2026-12-31" }]);
});

// ─── Search-cap windowing: integration through collectPullRequests ───────

interface WindowedPrFetch {
  /** Every /search/issues query path the connector issued, in order. */
  searchPaths: string[];
}

/**
 * Routes the PR fetch shapes with per-`created:`-window item partitioning.
 *  - GET /user                  → login + created_at (drives window count)
 *  - GET /search/issues?...     → items whose `created` year matches the
 *                                 window's `created:YYYY-..` qualifier, plus a
 *                                 per-window `total_count` (to trip the cap)
 *  - GET /repos/.../pulls/{n}   → minimal detail
 * Items are keyed by created-year so each window returns only its own items,
 * proving partitioning unions the full set without relying on the mock to
 * ignore the query (which would hide double-counting).
 */
function installWindowedPrFetch(
  t: TestContext,
  createdAt: string,
  itemsByYear: Record<number, Record<string, unknown>[]>,
  totalCountByYear: Record<number, number> = {}
): WindowedPrFetch {
  const handle: WindowedPrFetch = { searchPaths: [] };
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: createdAt }));
    }
    if (url.includes("/search/issues")) {
      handle.searchPaths.push(url);
      const decoded = decodeURIComponent(url);
      const yearMatch = /created:(\d{4})-/.exec(decoded);
      const year = yearMatch ? Number.parseInt(yearMatch[1] ?? "", 10) : Number.NaN;
      const items = itemsByYear[year] ?? [];
      const total = totalCountByYear[year] ?? items.length;
      return Promise.resolve(jsonResponse({ total_count: total, items }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(jsonResponse({ merged_at: "2025-01-01T00:00:00Z", commits: 1 }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return handle;
}

function prSearchItemCreated(id: number, repo: string, createdYear: number): Record<string, unknown> {
  return {
    id,
    number: id,
    title: `PR ${String(id)}`,
    created_at: `${String(createdYear)}-06-15T00:00:00Z`,
    updated_at: `${String(createdYear)}-07-01T00:00:00Z`,
    repository_url: `https://api.github.com/repos/${repo}`,
    user: { login: "octocat", id: 42 },
  };
}

test("collectPullRequests: full resync partitions by created-year and unions every window", async (t: TestContext) => {
  // Account created mid-2024 → windows 2026, 2025, 2024. A PR in each year.
  const fetchHandle = installWindowedPrFetch(t, "2024-03-01T00:00:00Z", {
    2026: [prSearchItemCreated(1, "owner/a", 2026)],
    2025: [prSearchItemCreated(2, "owner/b", 2025)],
    2024: [prSearchItemCreated(3, "owner/c", 2024)],
  });
  const { ctx, records, skips, states } = makeCtx(["pull_requests"]);

  await collectPullRequests(ctx);

  // Every PR across all three windows is emitted exactly once (no dup, no loss).
  const prIds = records.filter((r) => r.stream === "pull_requests").map((r) => String(r.data.id));
  assert.deepEqual(
    prIds.sort((a, b) => {
      if (a < b) {
        return -1;
      }
      return a > b ? 1 : 0;
    }),
    ["1", "2", "3"]
  );
  // Three distinct created: windows were queried, newest first.
  assert.equal(fetchHandle.searchPaths.length, 3);
  assert.match(decodeURIComponent(fetchHandle.searchPaths[0] ?? ""), /created:2026-01-01\.\.2026-12-31/);
  assert.match(decodeURIComponent(fetchHandle.searchPaths[2] ?? ""), /created:2024-01-01\.\.2024-12-31/);
  // No cap tripped → no cap SKIP_RESULT; cursor advances to the newest update.
  assert.equal(skips.length, 0);
  assert.equal((states[0]?.cursor as { last_updated_at?: string })?.last_updated_at, "2026-07-01T00:00:00Z");
});

test("collectPullRequests: a window over the search cap fails without a checkpoint", async (t: TestContext) => {
  // Single window (account created this year) but it reports 1023 PRs > 1000.
  const fetchHandle = installWindowedPrFetch(
    t,
    "2026-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026), prSearchItemCreated(2, "owner/b", 2026)] },
    { 2026: 1023 }
  );
  const { ctx, records, skips, states } = makeCtx(["pull_requests"]);

  await assert.rejects(() => collectPullRequests(ctx), isRetryableGithubGap);

  // Records that WERE reachable are still emitted.
  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 2);
  assert.equal(fetchHandle.searchPaths.length, 1);
  // Exactly one cap-truncation gap, counts only (no PR identifiers).
  const capSkip = skips.find((s) => s.reason === "pr_search_cap_truncated");
  assert.ok(capSkip, "expected a pr_search_cap_truncated SKIP_RESULT");
  assert.equal(capSkip?.stream, "pull_requests");
  assert.match(capSkip?.message ?? "", /more than 1000 pull requests/);
  assert.deepEqual(capSkip?.diagnostics, {
    cap_truncated_windows: 1,
    result_cap: 1000,
    max_reported_total: 1023,
  });
  assert.deepEqual(capSkip?.recovery_hint, { action: "retry_by_runtime", retryable: true });
  assert.equal(states.length, 0, "a search cap gap must not advance the pull-request cursor");
});

test("collectPullRequests: windows under the cap emit no cap gap (honest only when truncated)", async (t: TestContext) => {
  installWindowedPrFetch(
    t,
    "2025-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026)], 2025: [prSearchItemCreated(2, "owner/b", 2025)] },
    { 2026: 1000, 2025: 999 }
  );
  const { ctx, skips } = makeCtx(["pull_requests"]);

  await collectPullRequests(ctx);

  // total_count exactly at the cap is reachable (the cap is ~1000 inclusive);
  // only strictly-greater trips the gap.
  assert.equal(skips.filter((s) => s.reason === "pr_search_cap_truncated").length, 0);
});

test("collectPullRequests: incremental run (cursor set) issues one unwindowed updated:>= query", async (t: TestContext) => {
  const fetchHandle = installWindowedPrFetch(t, "2018-01-01T00:00:00Z", {});
  // Route the unwindowed query (no created: qualifier) to a couple of items.
  // Both updated after the cursor so neither is filtered by the since cutoff.
  const items = [
    { ...prSearchItemCreated(1, "owner/a", 2026), updated_at: "2026-05-20T00:00:00Z" },
    { ...prSearchItemCreated(2, "owner/b", 2018), updated_at: "2026-05-10T00:00:00Z" },
  ];
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2018-01-01T00:00:00Z" }));
    }
    if (url.includes("/search/issues")) {
      fetchHandle.searchPaths.push(url);
      return Promise.resolve(jsonResponse({ total_count: items.length, items }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(jsonResponse({ merged_at: "2025-01-01T00:00:00Z", commits: 1 }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { ctx, records } = makeCtx(["pull_requests"], {
    pull_requests: { last_updated_at: "2026-05-01T00:00:00Z" },
  });

  await collectPullRequests(ctx);

  // One query only, carrying updated:>= and no created: window.
  assert.equal(fetchHandle.searchPaths.length, 1);
  const decoded = decodeURIComponent(fetchHandle.searchPaths[0] ?? "");
  assert.match(decoded, /updated:>=2026-05-01/);
  assert.doesNotMatch(decoded, /created:/);
  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 2);
});

// ─── List-stream `considered` declaration (OpenSpec task 4.1) ─────────────
//
// Each list collector declares an objective `considered` denominator for the
// Collection Report: a list-level DETAIL_COVERAGE with EMPTY required/hydrated
// keys carrying the count of items the run enumerated from the source. The count
// is measured at the pagination site (totalSeen / fetched), never aliased to the
// emitted count, so `collected < considered` reads a real `partial` and a stream
// that cannot know its inventory (PR search-cap truncation) declares nothing.

function repoItem(id: number, pushedAt: string): Record<string, unknown> {
  return {
    id,
    name: `repo-${String(id)}`,
    full_name: `octocat/repo-${String(id)}`,
    pushed_at: pushedAt,
    private: false,
  };
}

function issueItem(id: number, updatedAt: string): Record<string, unknown> {
  return {
    id,
    number: id,
    title: `Issue ${String(id)}`,
    state: "open",
    updated_at: updatedAt,
    repository_url: "https://api.github.com/repos/octocat/repo-1",
    user: { login: "octocat", id: 42 },
  };
}

function gistItem(id: number, updatedAt: string): Record<string, unknown> {
  return {
    id: `gist-${String(id)}`,
    description: `Gist ${String(id)}`,
    public: true,
    updated_at: updatedAt,
    created_at: updatedAt,
    files: {},
  };
}

test("collectRepositories: declares considered = repositories enumerated (complete when all emitted)", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([repoItem(1, "2026-06-01T00:00:00Z"), repoItem(2, "2026-05-01T00:00:00Z")]))
  );
  const { ctx, records, coverages } = makeCtx(["repositories"]);
  await collectRepositories(ctx);

  assert.equal(records.filter((r) => r.stream === "repositories").length, 2);
  const cov = coverages.find((c) => c.stream === "repositories");
  assert.ok(cov, "expected a repositories considered declaration");
  assert.equal(cov?.stateStream, "repositories");
  assert.equal(cov?.requiredKeys, 0);
  assert.equal(cov?.hydratedKeys, 0);
  // Both repos enumerated and emitted → considered equals collected → complete.
  assert.equal(cov?.considered, 2);
});

test("collectRepositories: cursor-stop page counts toward considered (enumerated, not collected)", async (t: TestContext) => {
  // Page has a new repo then one at/older than the cursor → stop after the first.
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([repoItem(1, "2026-06-01T00:00:00Z"), repoItem(2, "2026-01-01T00:00:00Z")]))
  );
  const { ctx, records, coverages } = makeCtx(["repositories"], {
    repositories: { last_pushed_at: "2026-03-01T00:00:00Z" },
  });
  await collectRepositories(ctx);

  // Only the newer repo is collected; the older one stopped the walk.
  assert.equal(records.filter((r) => r.stream === "repositories").length, 1);
  const cov = coverages.find((c) => c.stream === "repositories");
  // The run enumerated both items on the page before stopping → considered counts
  // the page it saw. collected(1) < considered(2) → an honest partial.
  assert.equal(cov?.considered, 2);
});

test("collectStarred: dropped malformed entries make considered exceed collected (honest partial)", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, false), starredEntry(3, true)]))
  );
  const { ctx, records, coverages } = makeCtx(["starred"]);
  await collectStarred(ctx);

  // Two emitted, one dropped (no repo) — but all three were considered.
  assert.equal(records.filter((r) => r.stream === "starred").length, 2);
  const cov = coverages.find((c) => c.stream === "starred");
  assert.equal(cov?.considered, 3);
});

test("collectIssues: until-filtered issues are considered-not-collected (considered > collected)", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(
      jsonResponse([
        issueItem(1, "2026-06-01T00:00:00Z"),
        issueItem(2, "2026-06-10T00:00:00Z"),
        issueItem(3, "2026-05-01T00:00:00Z"),
      ])
    )
  );
  const { ctx, records, coverages } = makeCtx(["issues"]);
  // until cutoff excludes the two issues updated at/after it; they were still
  // fetched and weighed → considered counts them, collected does not.
  ctx.requested.set("issues", { name: "issues", time_range: { until: "2026-06-05T00:00:00Z" } });
  await collectIssues(ctx);

  assert.equal(records.filter((r) => r.stream === "issues").length, 2);
  const cov = coverages.find((c) => c.stream === "issues");
  assert.equal(cov?.considered, 3);
});

test("collectGists: declares considered = gists enumerated", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([gistItem(1, "2026-06-01T00:00:00Z"), gistItem(2, "2026-05-20T00:00:00Z")]))
  );
  const { ctx, records, coverages } = makeCtx(["gists"]);
  await collectGists(ctx);

  assert.equal(records.filter((r) => r.stream === "gists").length, 2);
  const cov = coverages.find((c) => c.stream === "gists");
  assert.equal(cov?.considered, 2);
});

test("collectPullRequests: declares considered = search hits drained when no window is cap-truncated", async (t: TestContext) => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
  installPrFetch(t, items, new Set());
  const { ctx, coverages } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  const cov = coverages.find((c) => c.stream === "pull_requests");
  assert.ok(cov, "expected a pull_requests considered declaration");
  assert.equal(cov?.considered, 2);
});

test("collectPullRequests: a cap-truncated window declares NO considered (inventory unknowable)", async (t: TestContext) => {
  // 1023 reported > 1000 cap → the full inventory cannot be enumerated, so the
  // run must leave considered unknown and rely on its terminal-gap SKIP_RESULT.
  installWindowedPrFetch(
    t,
    "2026-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026), prSearchItemCreated(2, "owner/b", 2026)] },
    { 2026: 1023 }
  );
  const { ctx, coverages, skips } = makeCtx(["pull_requests"]);
  await assert.rejects(() => collectPullRequests(ctx), isRetryableGithubGap);

  assert.equal(
    coverages.filter((c) => c.stream === "pull_requests").length,
    0,
    "cap-truncated run must not declare a considered denominator"
  );
  // The incompleteness is still surfaced — just by the terminal gap, not a count.
  assert.ok(skips.some((s) => s.reason === "pr_search_cap_truncated"));
});

test("declareListConsidered: never aliases considered to the emitted count", async (t: TestContext) => {
  // A repositories page where every item is collected still declares considered
  // from the enumerated page size, not by reading back the emit counter. Proven
  // by an empty page: zero enumerated → considered 0, never omitted-as-unknown.
  mockFetch(t, () => Promise.resolve(jsonResponse([])));
  const { ctx, records, coverages } = makeCtx(["repositories"]);
  await collectRepositories(ctx);

  assert.equal(records.filter((r) => r.stream === "repositories").length, 0);
  const cov = coverages.find((c) => c.stream === "repositories");
  assert.ok(cov, "an empty enumeration still declares considered: 0 (a fact, not unknown)");
  assert.equal(cov?.considered, 0);
});

// ─── Honest `covered` evidence at the enumeration site ─────────────────────
//
// Live UAT evidence (run_1786417047230) showed repositories/starred/pull_requests
// declaring `considered` with no `covered`, and `user` (the one manifest
// `required: true` stream) declaring neither — landing on the coherence
// contract's `checkpoint_only` rejection rather than a proven `complete`. These
// tests assert the positive `covered` evidence every stream now measures at its
// own enumeration site (never aliased to `collected`), and prove the fix against
// the real `evaluateStreamCoherence` oracle from `@pdpp/reference-contract`, not
// a reimplementation of its rules.

test("collectUser: FIX proof — user declares singleton_presence coverage so the coherence contract proves it, not checkpoint_only", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, coverages } = makeCtx(["user"]);
  await collectUser(ctx);

  const cov = coverages.find((c) => c.stream === "user");
  assert.ok(
    cov,
    "user must declare DETAIL_COVERAGE — a required singleton_presence stream cannot rely on a bare checkpoint"
  );
  assert.equal(cov?.considered, 1);
  assert.equal(cov?.covered, 1);

  // End-to-end proof against the real oracle: a steady-state run (fingerprint
  // unchanged, zero records emitted) with this coverage declaration and a
  // committed checkpoint now reads `proven` via `enumeration_boundary`, never
  // `checkpoint_only`.
  const verdict = evaluateStreamCoherence(
    {
      checkpoint: "committed",
      collected: 0,
      considered: cov?.considered ?? null,
      covered: cov?.covered ?? null,
      pending_detail_gaps: 0,
      skipped: null,
    },
    { coverage_strategy: "singleton_presence" }
  );
  assert.deepEqual(verdict, { proven: true, reason: "enumeration_boundary" });
});

test("collectUser: BEFORE-FIX regression guard — a considered-less declaration reads checkpoint_only under the real oracle", () => {
  // Documents the exact live-evidence bug this change closes: a committed
  // checkpoint with no considered/covered measurement is never proof, no matter
  // how the manifest strategy reads.
  const verdict = evaluateStreamCoherence(
    { checkpoint: "committed", collected: 0, considered: null, covered: null, pending_detail_gaps: 0, skipped: null },
    { coverage_strategy: "singleton_presence" }
  );
  assert.deepEqual(verdict, { proven: false, reason: "checkpoint_only" });
});

test("collectUser: user_stats also declares singleton_presence coverage", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, coverages } = makeCtx(["user_stats"]);
  await collectUser(ctx);

  const cov = coverages.find((c) => c.stream === "user_stats");
  assert.ok(cov);
  assert.equal(cov?.considered, 1);
  assert.equal(cov?.covered, 1);
});

test("collectUser: no coverage declared for a stream that was not requested", async (t: TestContext) => {
  installUserFetch(t);
  const { ctx, coverages } = makeCtx(["user"]);
  await collectUser(ctx);

  assert.equal(
    coverages.find((c) => c.stream === "user_stats"),
    undefined,
    "user_stats coverage must not be declared when user_stats was not in scope"
  );
});

test("collectRepositories: zero-changed steady state declares covered === considered (proves complete, not partial)", async (t: TestContext) => {
  // Every repo on the page is already at/older than the cursor: the FIRST item
  // triggers the stop, so evaluated = considered = covered = 1 even though
  // collected = 0. This is the honest positive proof of a real no-op run.
  mockFetch(t, () => Promise.resolve(jsonResponse([repoItem(1, "2026-01-01T00:00:00Z")])));
  const { ctx, records, coverages } = makeCtx(["repositories"], {
    repositories: { last_pushed_at: "2026-03-01T00:00:00Z" },
  });
  await collectRepositories(ctx);

  assert.equal(records.filter((r) => r.stream === "repositories").length, 0);
  const cov = coverages.find((c) => c.stream === "repositories");
  assert.equal(cov?.considered, 1);
  assert.equal(cov?.covered, 1);

  const verdict = evaluateStreamCoherence(
    {
      checkpoint: "committed",
      collected: 0,
      considered: cov?.considered ?? null,
      covered: cov?.covered ?? null,
      pending_detail_gaps: 0,
      skipped: null,
    },
    { coverage_strategy: "full_inventory" }
  );
  assert.deepEqual(verdict, { proven: true, reason: "enumeration_boundary" });
});

test("collectRepositories: FIX proof — a page tail past the cursor stop is never counted toward considered", async (t: TestContext) => {
  // Three items on one page: item 1 is new, item 2 matches the cursor (stop),
  // item 3 sits after the match and is never visited by the loop. Before the
  // fix, `considered` used the raw page length (3); the honest count is only
  // the 2 items the loop actually walked (item1 emitted, item2 confirmed the
  // stop) — item3 was never inspected, so counting it would be a fabricated
  // boundary claim, not a measured one.
  mockFetch(t, () =>
    Promise.resolve(
      jsonResponse([
        repoItem(1, "2026-06-01T00:00:00Z"),
        repoItem(2, "2026-01-01T00:00:00Z"),
        repoItem(3, "2025-01-01T00:00:00Z"),
      ])
    )
  );
  const { ctx, records, coverages } = makeCtx(["repositories"], {
    repositories: { last_pushed_at: "2026-03-01T00:00:00Z" },
  });
  await collectRepositories(ctx);

  assert.equal(records.filter((r) => r.stream === "repositories").length, 1);
  const cov = coverages.find((c) => c.stream === "repositories");
  assert.equal(
    cov?.considered,
    2,
    "considered must count only the 2 items the loop actually walked, not the raw page size of 3"
  );
  assert.equal(cov?.covered, 2, "both evaluated items were accounted for: one emitted, one the confirming stop match");
});

test("collectStarred: covered excludes dropped entries so a drop reads an honest partial under the real oracle", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, false), starredEntry(3, true)]))
  );
  const { ctx, coverages } = makeCtx(["starred"]);
  await collectStarred(ctx);

  const cov = coverages.find((c) => c.stream === "starred");
  assert.equal(cov?.considered, 3);
  assert.equal(cov?.covered, 2, "the dropped entry (no repo object) was evaluated but never accounted for");

  const verdict = evaluateStreamCoherence(
    {
      checkpoint: "committed",
      collected: 2,
      considered: cov?.considered ?? null,
      covered: cov?.covered ?? null,
      pending_detail_gaps: 0,
      skipped: null,
    },
    { coverage_strategy: "full_inventory" }
  );
  assert.deepEqual(
    verdict,
    { proven: false, reason: "boundary_shortfall" },
    "an explicit covered < considered must always read a real shortfall, never waved through by a closed checkpoint"
  );
});

test("collectStarred: zero drops → covered === considered (steady state proves complete)", async (t: TestContext) => {
  mockFetch(t, () => Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, true)])));
  const { ctx, coverages } = makeCtx(["starred"]);
  await collectStarred(ctx);

  const cov = coverages.find((c) => c.stream === "starred");
  assert.equal(cov?.considered, 2);
  assert.equal(cov?.covered, 2);
});

test("collectIssues: considered > collected (until-filtered) but fully covered — proves complete, not partial", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(
      jsonResponse([
        issueItem(1, "2026-06-01T00:00:00Z"),
        issueItem(2, "2026-06-10T00:00:00Z"),
        issueItem(3, "2026-05-01T00:00:00Z"),
      ])
    )
  );
  const { ctx, records, coverages } = makeCtx(["issues"]);
  ctx.requested.set("issues", { name: "issues", time_range: { until: "2026-06-05T00:00:00Z" } });
  await collectIssues(ctx);

  assert.equal(records.filter((r) => r.stream === "issues").length, 2);
  const cov = coverages.find((c) => c.stream === "issues");
  assert.equal(cov?.considered, 3, "considered > collected: the until filter excluded one in-window issue");
  assert.equal(
    cov?.covered,
    3,
    "every considered issue was accounted for — emitted, or deliberately excluded by until"
  );

  const verdict = evaluateStreamCoherence(
    {
      checkpoint: "committed",
      collected: 2,
      considered: cov?.considered ?? null,
      covered: cov?.covered ?? null,
      pending_detail_gaps: 0,
      skipped: null,
    },
    { coverage_strategy: "checkpoint_window" }
  );
  assert.deepEqual(
    verdict,
    { proven: true, reason: "enumeration_boundary" },
    "considered > collected must still prove complete when covered accounts for the full boundary"
  );
});

test("collectGists: covered equals considered (every fetched gist is accounted for)", async (t: TestContext) => {
  mockFetch(t, () =>
    Promise.resolve(jsonResponse([gistItem(1, "2026-06-01T00:00:00Z"), gistItem(2, "2026-05-20T00:00:00Z")]))
  );
  const { ctx, coverages } = makeCtx(["gists"]);
  await collectGists(ctx);

  const cov = coverages.find((c) => c.stream === "gists");
  assert.equal(cov?.considered, 2);
  assert.equal(cov?.covered, 2);
});

test("collectPullRequests: covered equals considered when no detail fetch fails (degraded records still count as accounted for)", async (t: TestContext) => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
  installPrFetch(t, items, new Set(["owner/b"]));
  const { ctx, coverages } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  const cov = coverages.find((c) => c.stream === "pull_requests");
  assert.equal(cov?.considered, 2);
  assert.equal(
    cov?.covered,
    2,
    "a detail-fetch failure degrades the record but the PR itself is still emitted and accounted for"
  );
});

test("collectPullRequests: provider/list failure counterweight — a cap-truncated window still declares no covered (unknowable, not falsely proven)", async (t: TestContext) => {
  installWindowedPrFetch(
    t,
    "2026-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026), prSearchItemCreated(2, "owner/b", 2026)] },
    { 2026: 1023 }
  );
  const { ctx, coverages } = makeCtx(["pull_requests"]);
  await assert.rejects(() => collectPullRequests(ctx), isRetryableGithubGap);

  assert.equal(
    coverages.filter((c) => c.stream === "pull_requests").length,
    0,
    "a cap-truncated window must declare neither considered nor covered — the boundary is unknowable, not zero"
  );
});

// ─── Pagination guard mutation coverage ───────────────────────────────────

function installRepeatingNextFetch(t: TestContext, stream: string): { calls: () => number } {
  let callCount = 0;
  mockFetch(t, (input: string | URL | Request) => {
    callCount += 1;
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    const next = `<${url}>; rel="next"`;
    if (stream === "pull_requests") {
      return Promise.resolve(jsonResponse({ total_count: 0, items: [] }, { headers: { link: next } }));
    }
    return Promise.resolve(jsonResponse([], { headers: { link: next } }));
  });
  return { calls: () => callCount };
}

const githubListCollectors: Array<{
  collect: (ctx: StreamCtx) => Promise<void>;
  name: string;
  stream: string;
}> = [
  { collect: collectRepositories, name: "repositories", stream: "repositories" },
  { collect: collectStarred, name: "starred", stream: "starred" },
  { collect: collectIssues, name: "issues", stream: "issues" },
  { collect: collectPullRequests, name: "pull requests", stream: "pull_requests" },
  { collect: collectGists, name: "gists", stream: "gists" },
];

for (const { collect, name, stream } of githubListCollectors) {
  test(`GitHub ${name}: repeated next link fails with retryable gap and no checkpoint`, async (t: TestContext) => {
    const handle = installRepeatingNextFetch(t, stream);
    const { ctx, coverages, skips, states } = makeCtx([stream]);

    await assert.rejects(() => collect(ctx), isRetryableGithubGap);
    assert.equal(handle.calls(), stream === "pull_requests" ? 2 : 1, "the repeated link must not be fetched twice");
    assert.equal(states.length, 0, "a repeated next link must not advance state");
    assert.equal(coverages.length, 0, "a repeated next link must not declare complete coverage");
    assert.equal(skips.length, 1);
    assert.equal(skips[0]?.reason, "github_pagination_repeated_next");
    assert.deepEqual(skips[0]?.recovery_hint, { action: "retry_by_runtime", retryable: true });
  });
}

for (const { collect, name, stream: entryStream } of githubListCollectors.filter(
  ({ stream }) => stream !== "pull_requests"
)) {
  test(`GitHub ${name}: object list envelope fails closed without coverage or state`, async (t: TestContext) => {
    mockFetch(t, () => Promise.resolve(jsonResponse({ items: [] })));
    const { ctx, coverages, records, states } = makeCtx([entryStream]);

    await assert.rejects(
      () => collect(ctx),
      (error: unknown) =>
        error instanceof Error && (error as Error & { code?: string }).code === "github_malformed_response"
    );
    assert.equal(records.length, 0, "a malformed first page is a pre-first-item zero-record failure");
    assert.equal(coverages.length, 0, `${entryStream} malformed envelope must not emit coverage`);
    assert.equal(states.length, 0, `${entryStream} malformed envelope must not advance state`);
  });

  test(`GitHub ${name}: valid prefix survives a later malformed page without coverage or state`, async (t: TestContext) => {
    const firstPage = {
      repositories: [repoItem(1, "2026-06-01T00:00:00Z")],
      starred: [starredEntry(1, true)],
      issues: [issueItem(1, "2026-06-01T00:00:00Z")],
      gists: [gistItem(1, "2026-06-01T00:00:00Z")],
    }[entryStream] as Record<string, unknown>[];
    let first = true;
    mockFetch(t, (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (first) {
        first = false;
        const next = `${url}${url.includes("?") ? "&" : "?"}page=2`;
        return Promise.resolve(jsonResponse(firstPage, { headers: { link: `<${next}>; rel="next"` } }));
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    const { ctx, coverages, records, states } = makeCtx([entryStream]);

    await assert.rejects(
      () => collect(ctx),
      (error: unknown) =>
        error instanceof Error && (error as Error & { code?: string }).code === "github_malformed_response"
    );
    assert.equal(records.length, 1, "the valid first-page prefix is retained");
    assert.equal(records[0]?.stream, entryStream);
    assert.equal(coverages.length, 0, "later malformed page withholds coverage");
    assert.equal(states.length, 0, "later malformed page withholds STATE");
  });
}

test("GitHub repositories: fresh next links stop at the bounded page cap with a retryable gap", async (t: TestContext) => {
  __setMaxGithubListPages(2);
  let calls = 0;
  mockFetch(t, (input: string | URL | Request) => {
    calls += 1;
    const current = new URL(typeof input === "string" ? input : input.toString());
    const next = new URL(current);
    next.searchParams.set("page", String(Number(current.searchParams.get("page") ?? "1") + 1));
    return Promise.resolve(jsonResponse([], { headers: { link: `<${next.href}>; rel="next"` } }));
  });
  const { ctx, coverages, skips, states } = makeCtx(["repositories"]);

  try {
    await assert.rejects(() => collectRepositories(ctx), isRetryableGithubGap);
  } finally {
    __setMaxGithubListPages(200);
  }

  assert.equal(calls, 2, "the cap must prevent the third page request");
  assert.equal(states.length, 0, "a page cap gap must not advance state");
  assert.equal(coverages.length, 0, "a page cap gap must not declare complete coverage");
  assert.equal(skips[0]?.reason, "github_pagination_cap_exceeded");
  assert.deepEqual(skips[0]?.recovery_hint, { action: "retry_by_runtime", retryable: true });
});

test("GitHub retryability: exhausted transient 503 text remains retryable", () => {
  assert.match("HTTP request got retryable status 503 after retry budget was exhausted", GITHUB_RETRYABLE_PATTERN);
  assert.match("HTTP request got retryable status 502 after retry budget was exhausted", GITHUB_RETRYABLE_PATTERN);
  assert.match("HTTP request got retryable status 504 after retry budget was exhausted", GITHUB_RETRYABLE_PATTERN);
  assert.match(
    "github_malformed_response: GitHub pull-request search returned a malformed 200 response",
    GITHUB_RETRYABLE_PATTERN
  );
});

test("collectPullRequests: malformed search 200 fails closed without 0/0 coverage or state", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }), {
          status: 200,
        })
      );
    }
    return Promise.resolve(jsonResponse({ total_count: 0 }));
  });
  const { ctx, coverages, states } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string; retryable?: boolean }).code === "github_malformed_response" &&
      (error as Error & { code?: string; retryable?: boolean }).retryable === true
  );
  assert.equal(coverages.length, 0, "malformed search must not emit a fabricated 0/0 denominator");
  assert.equal(states.length, 0, "malformed search must not advance the PR cursor");
});

test("collectPullRequests: positive total_count with empty items fails closed", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    return Promise.resolve(jsonResponse({ total_count: 1, items: [] }));
  });
  const { ctx, coverages, states, records } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === "github_malformed_response"
  );
  assert.equal(records.length, 0, "an impossible empty page must not emit a degraded PR record");
  assert.equal(coverages.length, 0, "an impossible empty page must not emit 0/0 coverage");
  assert.equal(states.length, 0, "an impossible empty page must not advance the PR cursor");
});

test("collectPullRequests: invalid JSON search 200 also fails closed without state", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    return Promise.resolve(new Response("<html>bad gateway</html>", { status: 200 }));
  });
  const { ctx, coverages, states } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === "github_malformed_response"
  );
  assert.equal(coverages.length, 0);
  assert.equal(states.length, 0);
});

test("collectPullRequests: shared Retry-After retry recovers a transient search 429", async (t: TestContext) => {
  const sleeps: number[] = [];
  let searchCalls = 0;
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    if (url.includes("/search/issues")) {
      searchCalls += 1;
      return Promise.resolve(
        searchCalls === 1
          ? jsonResponse({}, { status: 429, headers: { "Retry-After": "2" } })
          : jsonResponse({ total_count: 0, items: [] })
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { ctx, states } = makeCtx(
    ["pull_requests"],
    {},
    {
      retrySleep: (ms) => {
        sleeps.push(ms);
      },
    }
  );

  await collectPullRequests(ctx);
  assert.equal(searchCalls, 2, "Retry-After must trigger one bounded real retry");
  assert.equal(sleeps.filter((ms) => ms === 2000).length, 1, "GitHub request seam must honor Retry-After exactly once");
  assert.equal(states.length, 1, "state is emitted only after the retried search completes");
});

for (const failure of ["429", "transport"] as const) {
  test(`collectPullRequests: ${failure} on a later detail retains only the valid prefix and withholds completion`, async (t: TestContext) => {
    const connectorInstanceId = `cin_github_api_green_replay_${failure}`;
    const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
    let detailCalls = 0;
    mockFetch(t, (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/user")) {
        return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
      }
      if (url.includes("/search/issues")) {
        return Promise.resolve(jsonResponse({ total_count: 2, items }));
      }
      if (/\/repos\/owner\/a\/pulls\/1$/.test(url)) {
        return Promise.resolve(jsonResponse({ merged_at: "2026-05-10T00:00:00Z", commits: 3 }));
      }
      if (/\/repos\/owner\/b\/pulls\/2$/.test(url)) {
        detailCalls += 1;
        return failure === "429"
          ? Promise.resolve(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
          : Promise.reject(new Error("fetch failed", { cause: new Error("socket reset ECONNRESET") }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { ctx, coverages, records, states } = makeCtx(["pull_requests"]);

    await assert.rejects(() => collectPullRequests(ctx));
    assert.ok(detailCalls > 1, "the bounded request retry policy may retry the fatal detail");
    assert.deepEqual(
      records.map((record) => record.data.id),
      ["1"]
    );
    assert.equal(coverages.length, 0, "fatal later detail failure withholds coverage");
    assert.equal(states.length, 0, "fatal later detail failure withholds STATE");

    // Persist the retained prefix first. The replay uses the same durable
    // connector instance, so the storage oracle can distinguish an upsert
    // from a capture that merely echoed one matching id.
    await ingestPullRequestRecords(connectorInstanceId, records);
    assert.deepEqual(
      readDurablePullRequestRows(connectorInstanceId).map((row) => row.record_key),
      ["1"],
      "the fatal run's retained prefix is durably present before replay"
    );

    installPrFetch(t, items, new Set());
    const replay = makeCtx(["pull_requests"]);
    await collectPullRequests(replay.ctx);
    assert.deepEqual(
      replay.records.map((record) => record.data.id),
      ["1", "2"],
      "successful replay emits the complete source key set"
    );
    assert.equal(new Set(replay.records.map((record) => record.data.id)).size, 2);
    assert.deepEqual(replay.coverages, [
      {
        considered: 2,
        covered: 2,
        hydratedKeys: 0,
        requiredKeys: 0,
        stateStream: REPLAY_STREAM,
        stream: REPLAY_STREAM,
      },
    ]);
    assert.deepEqual(
      replay.states,
      [{ cursor: { last_updated_at: "2026-05-02T00:00:00Z" }, stream: REPLAY_STREAM }],
      "successful replay emits STATE only after the complete collection"
    );

    await ingestPullRequestRecords(connectorInstanceId, replay.records);
    const durableRows = readDurablePullRequestRows(connectorInstanceId);
    assert.deepEqual(
      durableRows.map((row) => row.record_key),
      ["1", "2"],
      "same-instance durable upsert leaves one logical row per replay key"
    );
    assert.equal(new Set(durableRows.map((row) => row.record_key)).size, 2);
    assert.ok(durableRows.every((row) => row.connector_instance_id === connectorInstanceId));
    assert.ok(durableRows.every((row) => row.stream === REPLAY_STREAM));
  });
}

test("collectPullRequests: exhausted transient detail 503 bubbles instead of degrading to a checkpoint", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    if (url.includes("/search/issues")) {
      return Promise.resolve(jsonResponse({ total_count: 1, items: [prSearchItem(1, "owner/a")] }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(new Response("temporary", { status: 503 }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { ctx, states } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) => error instanceof Error && GITHUB_RETRYABLE_PATTERN.test(error.message)
  );
  assert.equal(states.length, 0, "an exhausted transient detail failure must not advance state");
});

for (const status of [502, 504]) {
  test(`collectPullRequests: exhausted transient detail ${status} bubbles as incomplete`, async (t: TestContext) => {
    mockFetch(t, (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/user")) {
        return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
      }
      if (url.includes("/search/issues")) {
        return Promise.resolve(jsonResponse({ total_count: 1, items: [prSearchItem(1, "owner/a")] }));
      }
      if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
        return Promise.resolve(new Response("temporary", { status }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { ctx, states } = makeCtx(["pull_requests"]);

    await assert.rejects(
      () => collectPullRequests(ctx),
      (error: unknown) => error instanceof Error && GITHUB_RETRYABLE_PATTERN.test(error.message)
    );
    assert.equal(states.length, 0, `${status} detail failure must not advance state`);
  });
}

test("collectPullRequests: PR-detail 429 is terminal without progress, coverage, records, or state", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    if (url.includes("/search/issues")) {
      return Promise.resolve(jsonResponse({ total_count: 1, items: [prSearchItem(1, "owner/a")] }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { ctx, coverages, records, states, progresses } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) => error instanceof Error && error.message === "github_rate_limited"
  );
  assert.equal(records.length, 0);
  assert.equal(coverages.length, 0);
  assert.equal(states.length, 0);
  assert.equal(progresses.filter(({ extra }) => extra?.phase === "page").length, 0);
});

test("collectPullRequests: PR-detail transport failure is terminal without progress, coverage, records, or state", async (t: TestContext) => {
  mockFetch(t, (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/user")) {
      return Promise.resolve(jsonResponse({ id: 42, login: "octocat", created_at: "2026-01-01T00:00:00Z" }));
    }
    if (url.includes("/search/issues")) {
      return Promise.resolve(jsonResponse({ total_count: 1, items: [prSearchItem(1, "owner/a")] }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) {
      return Promise.reject(new Error("fetch failed", { cause: new Error("socket reset ECONNRESET") }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const { ctx, coverages, records, states, progresses } = makeCtx(["pull_requests"]);

  await assert.rejects(
    () => collectPullRequests(ctx),
    (error: unknown) => error instanceof Error && /fetch failed|ECONNRESET/i.test(error.message)
  );
  assert.equal(records.length, 0);
  assert.equal(coverages.length, 0);
  assert.equal(states.length, 0);
  assert.equal(progresses.filter(({ extra }) => extra?.phase === "page").length, 0);
});

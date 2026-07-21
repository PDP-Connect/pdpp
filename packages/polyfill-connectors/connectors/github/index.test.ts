// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { buildPacingStateFields, readPersistedPacingInterval } from "../../src/connector-http-governor.ts";
import type { StreamScope } from "../../src/connector-runtime.ts";
import {
  collectGists,
  collectIssues,
  collectPullRequests,
  collectRepositories,
  collectStarred,
  collectUser,
  isoYear,
  prCreatedWindows,
  resolvePrSearchWindows,
  type StreamCtx,
} from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

// The connector now ships adaptive pacing on by default (the shared governor's
// default-on rate control). Its module-scoped governor sleeps the real GCRA
// interval between requests, which would make these fetch-stubbing collector
// tests pay seconds of real wall-clock. Resolve pacing waits instantly so the
// suite stays fast and timing-deterministic; behavioral pacing is proven in
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
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function installUserFetch(): void {
  globalThis.fetch = async () =>
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
    );
}

interface CapturedSkip {
  diagnostics?: unknown;
  message: string;
  reason: string;
  stream: string;
}

interface CapturedCoverage {
  considered: number | undefined;
  hydratedKeys: number;
  requiredKeys: number;
  stateStream: string;
  stream: string;
}

function makeCtx(
  requestedStreams: readonly string[],
  state: Record<string, unknown> = {}
): {
  ctx: StreamCtx;
  coverages: CapturedCoverage[];
  records: Array<{ stream: string; data: Record<string, unknown> }>;
  skips: CapturedSkip[];
  states: Array<{ stream: string; cursor: unknown }>;
} {
  const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const states: Array<{ stream: string; cursor: unknown }> = [];
  const skips: CapturedSkip[] = [];
  const coverages: CapturedCoverage[] = [];
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  return {
    ctx: {
      emit: (msg) => {
        if (msg.type === "SKIP_RESULT") {
          skips.push({ stream: msg.stream, reason: msg.reason, message: msg.message, diagnostics: msg.diagnostics });
        } else if (msg.type === "DETAIL_COVERAGE") {
          coverages.push({
            stream: msg.stream,
            stateStream: msg.state_stream,
            requiredKeys: msg.required_keys.length,
            hydratedKeys: msg.hydrated_keys.length,
            considered: msg.considered,
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
      progress: () => Promise.resolve(),
      requested,
      state,
      token: "fake-token",
    },
    coverages,
    records,
    skips,
    states,
  };
}

test("collectUser: user_stats-only scope emits only user_stats records and state", async () => {
  installUserFetch();
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

test("collectUser: user-only scope emits only user entity records and state", async () => {
  installUserFetch();
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

test("collectUser: records the user cursor on ctx.userCursor as the warm-start carrier", async () => {
  installUserFetch();
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

test("warm-start: pacing fields merged onto the user cursor round-trip through readPersistedPacingInterval", () => {
  installUserFetch();
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

function jsonResponse(body: unknown): Response {
  // No `link` header → gh() pagination stops after this page.
  return new Response(JSON.stringify(body), { status: 200 });
}

function starredEntry(id: number, withRepo: boolean): Record<string, unknown> {
  return {
    starred_at: `2026-05-${String(id).padStart(2, "0")}T00:00:00Z`,
    repo: withRepo ? { id, full_name: `owner/repo-${String(id)}`, stargazers_count: 1 } : undefined,
  };
}

test("collectStarred: entries with no repo are counted and surfaced as one bounded SKIP_RESULT", async () => {
  // One valid entry, two with a missing `repo` (repo deleted/private since star).
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, false), starredEntry(3, false)]));
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

test("collectStarred: no drops emits no SKIP_RESULT (run looks complete only when it is)", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, true)]));
  const { ctx, records, skips } = makeCtx(["starred"]);
  await collectStarred(ctx);

  assert.equal(records.length, 2);
  assert.equal(skips.length, 0);
});

test("collectStarred: singular grammar for a single dropped entry", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse([starredEntry(1, false)]));
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
 * `failDetailForRepos` returns a non-fatal 500 for those repos' detail fetch.
 */
function installPrFetch(items: Record<string, unknown>[], failDetailForRepos: ReadonlySet<string>): void {
  globalThis.fetch = (input: string | URL | Request) => {
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
        // Non-fatal server error (not rate_limited / auth_failed) → counted, not thrown.
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      return Promise.resolve(jsonResponse({ merged_at: "2026-05-10T00:00:00Z", commits: 3 }));
    }
    return Promise.resolve(jsonResponse({}));
  };
}

test("collectPullRequests: detail-fetch failures emit one bounded degradation SKIP_RESULT, records still emitted", async () => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b"), prSearchItem(3, "owner/c")];
  installPrFetch(items, new Set(["owner/b", "owner/c"]));
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

test("collectPullRequests: all details fetched → no degradation SKIP_RESULT", async () => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
  installPrFetch(items, new Set());
  const { ctx, records, skips } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  assert.equal(records.filter((r) => r.stream === "pull_requests").length, 2);
  assert.equal(skips.length, 0);
});

test("collectPullRequests: degradation denominator counts emitted records, not filtered search hits", async () => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b"), prSearchItem(3, "owner/c")];
  installPrFetch(items, new Set(["owner/b"]));
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
  createdAt: string,
  itemsByYear: Record<number, Record<string, unknown>[]>,
  totalCountByYear: Record<number, number> = {}
): WindowedPrFetch {
  const handle: WindowedPrFetch = { searchPaths: [] };
  globalThis.fetch = (input: string | URL | Request) => {
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
  };
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

test("collectPullRequests: full resync partitions by created-year and unions every window", async () => {
  // Account created mid-2024 → windows 2026, 2025, 2024. A PR in each year.
  const fetchHandle = installWindowedPrFetch("2024-03-01T00:00:00Z", {
    2026: [prSearchItemCreated(1, "owner/a", 2026)],
    2025: [prSearchItemCreated(2, "owner/b", 2025)],
    2024: [prSearchItemCreated(3, "owner/c", 2024)],
  });
  const { ctx, records, skips, states } = makeCtx(["pull_requests"]);

  await collectPullRequests(ctx);

  // Every PR across all three windows is emitted exactly once (no dup, no loss).
  const prIds = records.filter((r) => r.stream === "pull_requests").map((r) => r.data.id);
  assert.deepEqual(prIds.sort(), ["1", "2", "3"]);
  // Three distinct created: windows were queried, newest first.
  assert.equal(fetchHandle.searchPaths.length, 3);
  assert.match(decodeURIComponent(fetchHandle.searchPaths[0] ?? ""), /created:2026-01-01\.\.2026-12-31/);
  assert.match(decodeURIComponent(fetchHandle.searchPaths[2] ?? ""), /created:2024-01-01\.\.2024-12-31/);
  // No cap tripped → no cap SKIP_RESULT; cursor advances to the newest update.
  assert.equal(skips.length, 0);
  assert.equal((states[0]?.cursor as { last_updated_at?: string })?.last_updated_at, "2026-07-01T00:00:00Z");
});

test("collectPullRequests: a window over the search cap emits one terminal-gap SKIP_RESULT", async () => {
  // Single window (account created this year) but it reports 1023 PRs > 1000.
  const fetchHandle = installWindowedPrFetch(
    "2026-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026), prSearchItemCreated(2, "owner/b", 2026)] },
    { 2026: 1023 }
  );
  const { ctx, records, skips } = makeCtx(["pull_requests"]);

  await collectPullRequests(ctx);

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
});

test("collectPullRequests: windows under the cap emit no cap gap (honest only when truncated)", async () => {
  installWindowedPrFetch(
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

test("collectPullRequests: incremental run (cursor set) issues one unwindowed updated:>= query", async () => {
  const fetchHandle = installWindowedPrFetch("2018-01-01T00:00:00Z", {});
  // Route the unwindowed query (no created: qualifier) to a couple of items.
  // Both updated after the cursor so neither is filtered by the since cutoff.
  const items = [
    { ...prSearchItemCreated(1, "owner/a", 2026), updated_at: "2026-05-20T00:00:00Z" },
    { ...prSearchItemCreated(2, "owner/b", 2018), updated_at: "2026-05-10T00:00:00Z" },
  ];
  globalThis.fetch = (input: string | URL | Request) => {
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
  };
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

test("collectRepositories: declares considered = repositories enumerated (complete when all emitted)", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse([repoItem(1, "2026-06-01T00:00:00Z"), repoItem(2, "2026-05-01T00:00:00Z")]));
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

test("collectRepositories: cursor-stop page counts toward considered (enumerated, not collected)", async () => {
  // Page has a new repo then one at/older than the cursor → stop after the first.
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse([repoItem(1, "2026-06-01T00:00:00Z"), repoItem(2, "2026-01-01T00:00:00Z")]));
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

test("collectStarred: dropped malformed entries make considered exceed collected (honest partial)", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse([starredEntry(1, true), starredEntry(2, false), starredEntry(3, true)]));
  const { ctx, records, coverages } = makeCtx(["starred"]);
  await collectStarred(ctx);

  // Two emitted, one dropped (no repo) — but all three were considered.
  assert.equal(records.filter((r) => r.stream === "starred").length, 2);
  const cov = coverages.find((c) => c.stream === "starred");
  assert.equal(cov?.considered, 3);
});

test("collectIssues: until-filtered issues are considered-not-collected (considered > collected)", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse([
        issueItem(1, "2026-06-01T00:00:00Z"),
        issueItem(2, "2026-06-10T00:00:00Z"),
        issueItem(3, "2026-05-01T00:00:00Z"),
      ])
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

test("collectGists: declares considered = gists enumerated", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse([gistItem(1, "2026-06-01T00:00:00Z"), gistItem(2, "2026-05-20T00:00:00Z")]));
  const { ctx, records, coverages } = makeCtx(["gists"]);
  await collectGists(ctx);

  assert.equal(records.filter((r) => r.stream === "gists").length, 2);
  const cov = coverages.find((c) => c.stream === "gists");
  assert.equal(cov?.considered, 2);
});

test("collectPullRequests: declares considered = search hits drained when no window is cap-truncated", async () => {
  const items = [prSearchItem(1, "owner/a"), prSearchItem(2, "owner/b")];
  installPrFetch(items, new Set());
  const { ctx, coverages } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  const cov = coverages.find((c) => c.stream === "pull_requests");
  assert.ok(cov, "expected a pull_requests considered declaration");
  assert.equal(cov?.considered, 2);
});

test("collectPullRequests: a cap-truncated window declares NO considered (inventory unknowable)", async () => {
  // 1023 reported > 1000 cap → the full inventory cannot be enumerated, so the
  // run must leave considered unknown and rely on its terminal-gap SKIP_RESULT.
  installWindowedPrFetch(
    "2026-01-01T00:00:00Z",
    { 2026: [prSearchItemCreated(1, "owner/a", 2026), prSearchItemCreated(2, "owner/b", 2026)] },
    { 2026: 1023 }
  );
  const { ctx, coverages, skips } = makeCtx(["pull_requests"]);
  await collectPullRequests(ctx);

  assert.equal(
    coverages.filter((c) => c.stream === "pull_requests").length,
    0,
    "cap-truncated run must not declare a considered denominator"
  );
  // The incompleteness is still surfaced — just by the terminal gap, not a count.
  assert.ok(skips.some((s) => s.reason === "pr_search_cap_truncated"));
});

test("declareListConsidered: never aliases considered to the emitted count", async () => {
  // A repositories page where every item is collected still declares considered
  // from the enumerated page size, not by reading back the emit counter. Proven
  // by an empty page: zero enumerated → considered 0, never omitted-as-unknown.
  globalThis.fetch = () => Promise.resolve(jsonResponse([]));
  const { ctx, records, coverages } = makeCtx(["repositories"]);
  await collectRepositories(ctx);

  assert.equal(records.filter((r) => r.stream === "repositories").length, 0);
  const cov = coverages.find((c) => c.stream === "repositories");
  assert.ok(cov, "an empty enumeration still declares considered: 0 (a fact, not unknown)");
  assert.equal(cov?.considered, 0);
});

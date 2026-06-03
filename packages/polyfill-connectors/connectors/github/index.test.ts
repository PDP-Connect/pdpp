import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import { collectPullRequests, collectStarred, collectUser, type StreamCtx } from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

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

function makeCtx(
  requestedStreams: readonly string[],
  state: Record<string, unknown> = {}
): {
  ctx: StreamCtx;
  records: Array<{ stream: string; data: Record<string, unknown> }>;
  skips: CapturedSkip[];
  states: Array<{ stream: string; cursor: unknown }>;
} {
  const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const states: Array<{ stream: string; cursor: unknown }> = [];
  const skips: CapturedSkip[] = [];
  const requested = new Map<string, StreamScope>(requestedStreams.map((name) => [name, { name }]));
  return {
    ctx: {
      emit: (msg) => {
        if (msg.type === "SKIP_RESULT") {
          skips.push({ stream: msg.stream, reason: msg.reason, message: msg.message, diagnostics: msg.diagnostics });
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

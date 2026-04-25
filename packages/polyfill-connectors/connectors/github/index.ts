#!/usr/bin/env node
/**
 * PDPP GitHub Connector (v0.2.0)
 *
 * Auth: Personal Access Token via GITHUB_PERSONAL_ACCESS_TOKEN env var.
 * Create at https://github.com/settings/tokens (fine-grained or classic).
 * Minimum scopes: read:user, public_repo (for public), repo (for private),
 *   gist (for gists).
 *
 * Streams: user, repositories, starred, issues, pull_requests, gists.
 * Incremental:
 *   - repositories via `since` + updated_at (by pushed_at)
 *   - starred via starred_at
 *   - issues via `since` + updated_at
 *   - pull_requests via updated_at (search ordered desc)
 *   - gists via `since` + updated_at
 *
 * Rate limit: 5000 req/hr (authenticated). We paginate 100 per page.
 * On 403+x-ratelimit-remaining=0 the `gh()` helper throws `github_rate_limited`,
 * which main() surfaces as a retryable DONE failure (see catch at bottom).
 */

import { nowIso, runConnector } from "../../src/connector-runtime.ts";
import {
  API_BASE as BASE,
  gistRecord,
  isAtOrAfterUntil,
  isBeforeSince,
  issueRecord,
  laterIso,
  parseNextLink,
  pullRequestRecord,
  repoFullFromUrl,
  repoRecord,
  starredRecord,
  userRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  GhFetchOptions,
  GhResult,
  GitHubGist,
  GitHubIssue,
  GitHubPullDetail,
  GitHubRepo,
  GitHubSearchResponse,
  GitHubStarredEntry,
  GitHubUser,
} from "./types.ts";

const USER_AGENT = "pdpp-connector-github/0.1";

async function gh<T>(
  path: string,
  token: string,
  { accept = "application/vnd.github+json" }: GhFetchOptions = {}
): Promise<GhResult<T>> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
  if (res.status === 401) {
    throw new Error("github_auth_failed");
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("github_rate_limited");
  }
  if (!res.ok) {
    const body = await res.text().catch((): string => "");
    throw new Error(`github_http_${String(res.status)}: ${body.slice(0, 200)}`);
  }
  const link = res.headers.get("link");
  const data = (await res.json()) as T;
  const nextUrl = parseNextLink(link);
  return { data, nextUrl };
}

// ─── Stream collectors ──────────────────────────────────────────────────

interface StreamCtx {
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>;
  progress: (message: string, extra?: { count?: number; stream?: string; total?: number }) => Promise<void>;
  requested: Map<string, { time_range?: { since?: string; until?: string } }>;
  state: Record<string, unknown>;
  token: string;
}

async function collectUser(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching user profile", { stream: "user" });
  const { data: u } = await gh<GitHubUser>("/user", ctx.token);
  await ctx.emitRecord("user", userRecord(u));
  await ctx.emit({
    type: "STATE",
    stream: "user",
    cursor: { fetched_at: nowIso() },
  });
}

interface ReposPageResult {
  latest: string | null | undefined;
  stop: boolean;
}

async function emitRepositoriesPage(
  ctx: StreamCtx,
  items: GitHubRepo[],
  priorPushed: string | undefined,
  latestIn: string | null | undefined
): Promise<ReposPageResult> {
  let latest = latestIn;
  for (const r of items) {
    if (priorPushed && r.pushed_at && r.pushed_at <= priorPushed) {
      return { latest, stop: true };
    }
    await ctx.emitRecord("repositories", repoRecord(r));
    latest = laterIso(latest, r.pushed_at);
  }
  return { latest, stop: false };
}

async function collectRepositories(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching repositories", { stream: "repositories" });
  let path: string | null = "/user/repos?per_page=100&sort=pushed&direction=desc";
  const repoState = ctx.state.repositories as { last_pushed_at?: string } | undefined;
  const priorPushed = repoState?.last_pushed_at;
  let latestPushed: string | null | undefined = priorPushed;
  let stop = false;
  while (path && !stop) {
    const page: GhResult<GitHubRepo[]> = await gh<GitHubRepo[]>(path, ctx.token);
    const result = await emitRepositoriesPage(ctx, page.data, priorPushed, latestPushed);
    latestPushed = result.latest;
    stop = result.stop;
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "repositories",
    cursor: { last_pushed_at: latestPushed || priorPushed || null },
  });
}

interface StarredPageResult {
  latest: string | null | undefined;
  stop: boolean;
}

async function emitStarredPage(
  ctx: StreamCtx,
  entries: GitHubStarredEntry[],
  priorStarred: string | undefined,
  latestIn: string | null | undefined
): Promise<StarredPageResult> {
  let latest = latestIn;
  for (const entry of entries) {
    const starredAt = entry.starred_at || null;
    if (priorStarred && starredAt && starredAt <= priorStarred) {
      return { latest, stop: true };
    }
    const rec = starredRecord(entry);
    if (!rec) {
      continue;
    }
    await ctx.emitRecord("starred", rec);
    latest = laterIso(latest, starredAt);
  }
  return { latest, stop: false };
}

async function collectStarred(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching starred repositories", { stream: "starred" });
  const starredState = ctx.state.starred as { last_starred_at?: string } | undefined;
  const priorStarred = starredState?.last_starred_at;
  let latestStarred: string | null | undefined = priorStarred;
  let path: string | null = "/user/starred?per_page=100&sort=created&direction=desc";
  let stop = false;
  while (path && !stop) {
    // Use star:timestamp media type to get starred_at
    const page: GhResult<GitHubStarredEntry[]> = await gh<GitHubStarredEntry[]>(path, ctx.token, {
      accept: "application/vnd.github.star+json",
    });
    const result = await emitStarredPage(ctx, page.data, priorStarred, latestStarred);
    latestStarred = result.latest;
    stop = result.stop;
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "starred",
    cursor: { last_starred_at: latestStarred || priorStarred || null },
  });
}

async function emitIssuesPage(
  ctx: StreamCtx,
  items: GitHubIssue[],
  until: string | null,
  latestIn: string | null | undefined
): Promise<string | null | undefined> {
  let latest = latestIn;
  for (const it of items) {
    if (isAtOrAfterUntil(it.updated_at, until)) {
      continue;
    }
    await ctx.emitRecord("issues", issueRecord(it));
    latest = laterIso(latest, it.updated_at);
  }
  return latest;
}

async function collectIssues(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching issues", { stream: "issues" });
  const req = ctx.requested.get("issues");
  const issuesState = ctx.state.issues as { last_updated_at?: string } | undefined;
  const priorUpdated = issuesState?.last_updated_at;
  // Prefer explicit scope time_range.since over stored cursor (narrower wins).
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated: string | null | undefined = priorUpdated;
  const qs = ["filter=all", "state=all", "per_page=100", "sort=updated", "direction=desc"];
  if (sinceParam) {
    qs.push(`since=${encodeURIComponent(sinceParam)}`);
  }
  let path: string | null = `/issues?${qs.join("&")}`;
  while (path) {
    const page: GhResult<GitHubIssue[]> = await gh<GitHubIssue[]>(path, ctx.token);
    latestUpdated = await emitIssuesPage(ctx, page.data, until, latestUpdated);
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "issues",
    cursor: { last_updated_at: latestUpdated || priorUpdated || null },
  });
}

// PULL_REQUESTS
// Uses /search/issues?q=type:pr+author:{user}. NOTE: this only returns PRs
// authored by the user. PRs where the user is a reviewer (but not author)
// are NOT included — that requires a separate `reviewer:{user}` query and
// dedup, which we leave for a follow-up. This path is simpler than walking
// every repo's /pulls endpoint and captures the main authoring signal.
//
// Search returns summary records; for per-PR detail (merged_at, commits,
// additions, deletions, changed_files, requested_reviewers) we fetch
// /repos/{owner}/{repo}/pulls/{number}. That's 1 extra request per PR.
const PR_ERROR_BUBBLE_PATTERN = /rate_limited|auth_failed/;

async function fetchPullDetail(
  repoFull: string | null,
  number: number | undefined,
  token: string
): Promise<GitHubPullDetail | null> {
  if (!(repoFull && number != null)) {
    return null;
  }
  try {
    const r = await gh<GitHubPullDetail>(`/repos/${repoFull}/pulls/${String(number)}`, token);
    return r.data;
  } catch (e) {
    // Non-fatal: emit what we have from search. Rate-limit errors
    // bubble up from gh() and abort the whole run (retryable).
    const msg = e instanceof Error ? e.message : String(e);
    if (PR_ERROR_BUBBLE_PATTERN.test(msg)) {
      throw e;
    }
    return null;
  }
}

function buildPrSearchPath(login: string, sinceParam: string | null): string {
  const qParts = ["type:pr", `author:${login}`];
  if (sinceParam) {
    // Search API date-precision; strict `since` still applied per-item.
    qParts.push(`updated:>=${sinceParam.slice(0, 10)}`);
  }
  const q = encodeURIComponent(qParts.join(" "));
  return `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`;
}

interface PrPageResult {
  latest: string | null | undefined;
  stop: boolean;
}

async function emitPullRequestItem(
  ctx: StreamCtx,
  it: GitHubIssue,
  latestIn: string | null | undefined
): Promise<string | null | undefined> {
  const repoFull = repoFullFromUrl(it.repository_url);
  // Fetch PR detail for fields not in search summary.
  const detail = await fetchPullDetail(repoFull, it.number, ctx.token);
  await ctx.emitRecord("pull_requests", pullRequestRecord(it, detail, repoFull));
  return laterIso(latestIn, it.updated_at);
}

async function emitPullRequestPage(
  ctx: StreamCtx,
  items: GitHubIssue[],
  sinceParam: string | null,
  until: string | null,
  latestIn: string | null | undefined
): Promise<PrPageResult> {
  let latest = latestIn;
  for (const it of items) {
    if (isBeforeSince(it.updated_at, sinceParam)) {
      return { latest, stop: true };
    }
    if (isAtOrAfterUntil(it.updated_at, until)) {
      continue;
    }
    latest = await emitPullRequestItem(ctx, it, latest);
  }
  return { latest, stop: false };
}

async function collectPullRequests(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching pull requests", { stream: "pull_requests" });
  const req = ctx.requested.get("pull_requests");
  const prState = ctx.state.pull_requests as { last_updated_at?: string } | undefined;
  const priorUpdated = prState?.last_updated_at;
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated: string | null | undefined = priorUpdated;

  // Need the login to build the search query.
  const { data: me } = await gh<GitHubUser>("/user", ctx.token);
  let path: string | null = buildPrSearchPath(me.login, sinceParam);
  let stop = false;
  let fetchedCount = 0;
  while (path && !stop) {
    const page: GhResult<GitHubSearchResponse> = await gh<GitHubSearchResponse>(path, ctx.token);
    const items = page.data.items || [];
    const result = await emitPullRequestPage(ctx, items, sinceParam, until, latestUpdated);
    latestUpdated = result.latest;
    stop = result.stop;
    fetchedCount += items.length;
    await ctx.progress(`Fetched pull request page (${items.length} item(s))`, {
      stream: "pull_requests",
      count: Math.min(fetchedCount, page.data.total_count ?? fetchedCount),
      ...(page.data.total_count === undefined ? {} : { total: page.data.total_count }),
    });
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "pull_requests",
    cursor: { last_updated_at: latestUpdated || priorUpdated || null },
  });
}

async function emitGistsPage(
  ctx: StreamCtx,
  items: GitHubGist[],
  until: string | null,
  latestIn: string | null | undefined
): Promise<string | null | undefined> {
  let latest = latestIn;
  for (const g of items) {
    if (isAtOrAfterUntil(g.updated_at, until)) {
      continue;
    }
    await ctx.emitRecord("gists", gistRecord(g));
    latest = laterIso(latest, g.updated_at);
  }
  return latest;
}

async function collectGists(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching gists", { stream: "gists" });
  const req = ctx.requested.get("gists");
  const gistState = ctx.state.gists as { last_updated_at?: string } | undefined;
  const priorUpdated = gistState?.last_updated_at;
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated: string | null | undefined = priorUpdated;
  const qs = ["per_page=100"];
  if (sinceParam) {
    qs.push(`since=${encodeURIComponent(sinceParam)}`);
  }
  let path: string | null = `/gists?${qs.join("&")}`;
  while (path) {
    const page: GhResult<GitHubGist[]> = await gh<GitHubGist[]>(path, ctx.token);
    latestUpdated = await emitGistsPage(ctx, page.data, until, latestUpdated);
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "gists",
    cursor: { last_updated_at: latestUpdated || priorUpdated || null },
  });
}

runConnector({
  name: "github",
  retryablePattern: /rate_limited|ECONN|fetch failed/,
  validateRecord,
  // GITHUB_TOKEN is the universal GitHub-CI env var; accept it as a fallback.
  auth: {
    kind: "env",
    required: [["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]],
  },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      throw new Error("github_auth_failed");
    }
    const ctx: StreamCtx = {
      token,
      state,
      requested,
      emit,
      emitRecord,
      progress,
    };

    if (requested.has("user")) {
      await collectUser(ctx);
    }
    if (requested.has("repositories")) {
      await collectRepositories(ctx);
    }
    if (requested.has("starred")) {
      await collectStarred(ctx);
    }
    if (requested.has("issues")) {
      await collectIssues(ctx);
    }
    if (requested.has("pull_requests")) {
      await collectPullRequests(ctx);
    }
    if (requested.has("gists")) {
      await collectGists(ctx);
    }
  },
});

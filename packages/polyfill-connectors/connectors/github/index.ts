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

const BASE = "https://api.github.com";
const USER_AGENT = "pdpp-connector-github/0.1";
const NEXT_LINK_PATTERN = /<([^>]+)>; rel="next"/;

interface GhResult<T> {
  data: T;
  nextUrl: string | null;
}

interface GhFetchOptions {
  accept?: string;
}

interface GitHubUser {
  avatar_url?: string | null;
  bio?: string | null;
  blog?: string | null;
  company?: string | null;
  created_at?: string | null;
  email?: string | null;
  followers?: number | null;
  following?: number | null;
  id: number;
  location?: string | null;
  login: string;
  name?: string | null;
  public_gists?: number | null;
  public_repos?: number | null;
  twitter_username?: string | null;
  updated_at?: string | null;
}

interface GitHubRepo {
  archived: boolean;
  created_at?: string | null;
  default_branch?: string | null;
  description?: string | null;
  disabled: boolean;
  fork: boolean;
  forks_count?: number | null;
  full_name: string;
  homepage?: string | null;
  html_url?: string | null;
  id: number;
  language?: string | null;
  license?: { key?: string | null } | null;
  name: string;
  open_issues_count?: number | null;
  owner?: { login?: string };
  private: boolean;
  pushed_at?: string | null;
  size?: number | null;
  stargazers_count?: number | null;
  topics?: string[];
  updated_at?: string | null;
  watchers_count?: number | null;
}

interface GitHubStarredEntry {
  repo?: GitHubRepo;
  starred_at?: string | null;
}

interface GitHubLabelObj {
  name?: string;
}

interface GitHubIssue {
  assignees?: Array<{ login?: string }>;
  body?: string | null;
  closed_at?: string | null;
  comments?: number | null;
  created_at?: string | null;
  draft?: boolean;
  html_url?: string | null;
  id: number;
  labels?: Array<string | GitHubLabelObj>;
  milestone?: { title?: string | null } | null;
  number?: number;
  pull_request?: { html_url?: string | null } | null;
  reactions?: { total_count?: number | null };
  repository?: { full_name?: string; id?: number } | null;
  repository_url?: string;
  state?: string | null;
  state_reason?: string | null;
  title?: string | null;
  updated_at?: string | null;
  user?: { login?: string; id?: number };
}

interface GitHubSearchResponse {
  items?: GitHubIssue[];
}

interface GitHubPullDetail {
  additions?: number | null;
  base?: { ref?: string; repo?: { id?: number } };
  changed_files?: number | null;
  commits?: number | null;
  deletions?: number | null;
  draft?: boolean;
  head?: { ref?: string };
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  requested_reviewers?: Array<{ login?: string }>;
  review_comments?: number | null;
}

interface GitHubGistFile {
  filename?: string | null;
  language?: string | null;
  raw_url?: string | null;
  size?: number;
}

interface GitHubGist {
  comments?: number | null;
  created_at?: string | null;
  description?: string | null;
  files?: Record<string, GitHubGistFile>;
  html_url?: string | null;
  id: string;
  public: boolean;
  updated_at?: string | null;
}

function parseNextLink(link: string | null): string | null {
  if (!link) {
    return null;
  }
  const m = NEXT_LINK_PATTERN.exec(link);
  return m?.[1] ? m[1].replace(BASE, "") : null;
}

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

function userRecord(u: GitHubUser): Record<string, unknown> {
  return {
    id: String(u.id),
    login: u.login,
    name: u.name ?? null,
    email: u.email ?? null,
    bio: u.bio ?? null,
    company: u.company ?? null,
    location: u.location ?? null,
    blog: u.blog ?? null,
    twitter_username: u.twitter_username ?? null,
    public_repos: u.public_repos ?? null,
    public_gists: u.public_gists ?? null,
    followers: u.followers ?? null,
    following: u.following ?? null,
    created_at: u.created_at ?? null,
    updated_at: u.updated_at ?? null,
    avatar_url: u.avatar_url ?? null,
  };
}

function repoRecord(r: GitHubRepo): Record<string, unknown> {
  return {
    id: String(r.id),
    name: r.name,
    full_name: r.full_name,
    owner_login: r.owner?.login ?? null,
    description: r.description ?? null,
    private: r.private,
    fork: r.fork,
    archived: r.archived,
    disabled: r.disabled,
    default_branch: r.default_branch ?? null,
    language: r.language ?? null,
    topics: r.topics ?? [],
    stargazers_count: r.stargazers_count ?? null,
    forks_count: r.forks_count ?? null,
    open_issues_count: r.open_issues_count ?? null,
    watchers_count: r.watchers_count ?? null,
    size_kb: r.size ?? null,
    license_key: r.license?.key ?? null,
    html_url: r.html_url ?? null,
    homepage: r.homepage ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    pushed_at: r.pushed_at ?? null,
  };
}

function labelNames(labels: Array<string | GitHubLabelObj> | undefined): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") {
      out.push(l);
    } else if (l?.name) {
      out.push(l.name);
    }
  }
  return out;
}

function assigneeNames(assignees: Array<{ login?: string }> | undefined): string[] {
  if (!Array.isArray(assignees)) {
    return [];
  }
  const out: string[] = [];
  for (const a of assignees) {
    if (a.login) {
      out.push(a.login);
    }
  }
  return out;
}

function issueRecord(it: GitHubIssue): Record<string, unknown> {
  const body = typeof it.body === "string" ? it.body.slice(0, 20_000) : null;
  return {
    id: String(it.id),
    number: it.number ?? null,
    title: it.title ?? null,
    body,
    state: it.state ?? null,
    state_reason: it.state_reason ?? null,
    user_login: it.user?.login ?? null,
    user_id: it.user?.id == null ? null : String(it.user.id),
    assignees: assigneeNames(it.assignees),
    labels: labelNames(it.labels),
    milestone_title: it.milestone?.title ?? null,
    repository_full_name:
      it.repository?.full_name ?? (it.repository_url ? it.repository_url.replace(`${BASE}/repos/`, "") : null),
    repository_id: it.repository?.id == null ? null : String(it.repository.id),
    html_url: it.html_url ?? null,
    comments: it.comments ?? null,
    reactions_total_count: it.reactions?.total_count ?? null,
    created_at: it.created_at ?? null,
    updated_at: it.updated_at ?? null,
    closed_at: it.closed_at ?? null,
    is_pull_request: Boolean(it.pull_request),
    pull_request_url: it.pull_request?.html_url ?? null,
    draft: it.pull_request ? Boolean(it.draft) : null,
  };
}

function pullRequestRecord(
  it: GitHubIssue,
  detail: GitHubPullDetail | null,
  repoFull: string | null
): Record<string, unknown> {
  const body = typeof it.body === "string" ? it.body.slice(0, 20_000) : null;
  const reviewerLogins: string[] = Array.isArray(detail?.requested_reviewers)
    ? detail.requested_reviewers.map((r) => r.login).filter((l): l is string => Boolean(l))
    : [];
  return {
    id: String(it.id),
    number: it.number ?? null,
    title: it.title ?? null,
    body,
    state: it.state ?? null,
    state_reason: it.state_reason ?? null,
    user_login: it.user?.login ?? null,
    user_id: it.user?.id == null ? null : String(it.user.id),
    assignees: assigneeNames(it.assignees),
    labels: labelNames(it.labels),
    milestone_title: it.milestone?.title ?? null,
    repository_full_name: repoFull,
    repository_id: detail?.base?.repo?.id == null ? null : String(detail.base.repo.id),
    html_url: it.html_url ?? null,
    comments: it.comments ?? null,
    reactions_total_count: it.reactions?.total_count ?? null,
    created_at: it.created_at ?? null,
    updated_at: it.updated_at ?? null,
    closed_at: it.closed_at ?? null,
    draft: Boolean(it.draft ?? detail?.draft),
    merged_at: detail?.merged_at ?? null,
    merged_by_login: detail?.merged_by?.login ?? null,
    commits_count: detail?.commits ?? null,
    additions: detail?.additions ?? null,
    deletions: detail?.deletions ?? null,
    changed_files: detail?.changed_files ?? null,
    base_ref: detail?.base?.ref ?? null,
    head_ref: detail?.head?.ref ?? null,
    requested_reviewers: reviewerLogins,
    review_comments_count: detail?.review_comments ?? null,
  };
}

function gistRecord(g: GitHubGist): Record<string, unknown> {
  const fileEntries = g.files && typeof g.files === "object" ? Object.values(g.files) : [];
  const capped = fileEntries.slice(0, 10);
  const files = capped.map((f) => ({
    filename: f.filename ?? null,
    language: f.language ?? null,
    size: typeof f.size === "number" ? f.size : null,
    raw_url: f.raw_url ?? null,
  }));
  return {
    id: String(g.id),
    description: g.description ?? null,
    public: Boolean(g.public),
    html_url: g.html_url ?? null,
    files,
    files_truncated: fileEntries.length > 10,
    files_total_count: fileEntries.length,
    comments_count: g.comments ?? null,
    created_at: g.created_at ?? null,
    updated_at: g.updated_at ?? null,
  };
}

// ─── Stream collectors ──────────────────────────────────────────────────

interface StreamCtx {
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>;
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
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

async function collectRepositories(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching repositories", { stream: "repositories" });
  let path: string | null = "/user/repos?per_page=100&sort=pushed&direction=desc";
  const repoState = ctx.state.repositories as { last_pushed_at?: string } | undefined;
  const priorPushed = repoState?.last_pushed_at;
  let latestPushed = priorPushed;
  let stop = false;
  while (path && !stop) {
    const page: GhResult<GitHubRepo[]> = await gh<GitHubRepo[]>(path, ctx.token);
    for (const r of page.data) {
      if (priorPushed && r.pushed_at && r.pushed_at <= priorPushed) {
        stop = true;
        break;
      }
      await ctx.emitRecord("repositories", repoRecord(r));
      if (r.pushed_at && (!latestPushed || r.pushed_at > latestPushed)) {
        latestPushed = r.pushed_at;
      }
    }
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "repositories",
    cursor: { last_pushed_at: latestPushed || priorPushed || null },
  });
}

async function collectStarred(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching starred repositories", { stream: "starred" });
  const starredState = ctx.state.starred as { last_starred_at?: string } | undefined;
  const priorStarred = starredState?.last_starred_at;
  let latestStarred = priorStarred;
  let path: string | null = "/user/starred?per_page=100&sort=created&direction=desc";
  let stop = false;
  while (path && !stop) {
    // Use star:timestamp media type to get starred_at
    const page: GhResult<GitHubStarredEntry[]> = await gh<GitHubStarredEntry[]>(path, ctx.token, {
      accept: "application/vnd.github.star+json",
    });
    for (const entry of page.data) {
      const repo = entry.repo;
      const starredAt = entry.starred_at || null;
      if (priorStarred && starredAt && starredAt <= priorStarred) {
        stop = true;
        break;
      }
      if (!repo) {
        continue;
      }
      await ctx.emitRecord("starred", {
        id: String(repo.id),
        full_name: repo.full_name,
        description: repo.description ?? null,
        language: repo.language ?? null,
        stargazers_count: repo.stargazers_count ?? null,
        html_url: repo.html_url ?? null,
        starred_at: starredAt,
      });
      if (starredAt && (!latestStarred || starredAt > latestStarred)) {
        latestStarred = starredAt;
      }
    }
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "starred",
    cursor: { last_starred_at: latestStarred || priorStarred || null },
  });
}

async function collectIssues(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching issues", { stream: "issues" });
  const req = ctx.requested.get("issues");
  const issuesState = ctx.state.issues as { last_updated_at?: string } | undefined;
  const priorUpdated = issuesState?.last_updated_at;
  // Prefer explicit scope time_range.since over stored cursor (narrower wins).
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated = priorUpdated;
  const qs = ["filter=all", "state=all", "per_page=100", "sort=updated", "direction=desc"];
  if (sinceParam) {
    qs.push(`since=${encodeURIComponent(sinceParam)}`);
  }
  let path: string | null = `/issues?${qs.join("&")}`;
  while (path) {
    const page: GhResult<GitHubIssue[]> = await gh<GitHubIssue[]>(path, ctx.token);
    for (const it of page.data) {
      if (until && it.updated_at && it.updated_at >= until) {
        continue;
      }
      await ctx.emitRecord("issues", issueRecord(it));
      if (it.updated_at && (!latestUpdated || it.updated_at > latestUpdated)) {
        latestUpdated = it.updated_at;
      }
    }
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

async function collectPullRequests(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching pull requests", { stream: "pull_requests" });
  const req = ctx.requested.get("pull_requests");
  const prState = ctx.state.pull_requests as { last_updated_at?: string } | undefined;
  const priorUpdated = prState?.last_updated_at;
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated = priorUpdated;

  // Need the login to build the search query.
  const { data: me } = await gh<GitHubUser>("/user", ctx.token);
  const login = me.login;
  // Search API: updated:>=YYYY-MM-DD narrows to new work. Date-precision only;
  // we apply strict `since` filter in code as well.
  const qParts = ["type:pr", `author:${login}`];
  if (sinceParam) {
    qParts.push(`updated:>=${sinceParam.slice(0, 10)}`);
  }
  const q = encodeURIComponent(qParts.join(" "));
  let path: string | null = `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`;
  let stop = false;
  while (path && !stop) {
    const page: GhResult<GitHubSearchResponse> = await gh<GitHubSearchResponse>(path, ctx.token);
    const items = page.data.items || [];
    for (const it of items) {
      if (sinceParam && it.updated_at && it.updated_at < sinceParam) {
        stop = true;
        break;
      }
      if (until && it.updated_at && it.updated_at >= until) {
        continue;
      }
      // Parse owner/repo from repository_url "https://api.github.com/repos/owner/repo"
      const repoFull = it.repository_url ? it.repository_url.replace(`${BASE}/repos/`, "") : null;
      // Fetch PR detail for fields not in search summary.
      const detail = await fetchPullDetail(repoFull, it.number, ctx.token);
      await ctx.emitRecord("pull_requests", pullRequestRecord(it, detail, repoFull));
      if (it.updated_at && (!latestUpdated || it.updated_at > latestUpdated)) {
        latestUpdated = it.updated_at;
      }
    }
    path = page.nextUrl;
  }
  await ctx.emit({
    type: "STATE",
    stream: "pull_requests",
    cursor: { last_updated_at: latestUpdated || priorUpdated || null },
  });
}

async function collectGists(ctx: StreamCtx): Promise<void> {
  await ctx.progress("Fetching gists", { stream: "gists" });
  const req = ctx.requested.get("gists");
  const gistState = ctx.state.gists as { last_updated_at?: string } | undefined;
  const priorUpdated = gistState?.last_updated_at;
  const sinceParam = req?.time_range?.since || priorUpdated || null;
  const until = req?.time_range?.until || null;
  let latestUpdated = priorUpdated;
  const qs = ["per_page=100"];
  if (sinceParam) {
    qs.push(`since=${encodeURIComponent(sinceParam)}`);
  }
  let path: string | null = `/gists?${qs.join("&")}`;
  while (path) {
    const page: GhResult<GitHubGist[]> = await gh<GitHubGist[]>(path, ctx.token);
    for (const g of page.data) {
      if (until && g.updated_at && g.updated_at >= until) {
        continue;
      }
      await ctx.emitRecord("gists", gistRecord(g));
      if (g.updated_at && (!latestUpdated || g.updated_at > latestUpdated)) {
        latestUpdated = g.updated_at;
      }
    }
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  API_BASE,
  assigneeNames,
  gistRecord,
  isAtOrAfterUntil,
  isBeforeSince,
  issueRecord,
  labelNames,
  laterIso,
  parseNextLink,
  pullRequestRecord,
  repoFullFromUrl,
  repoRecord,
  reviewerLogins,
  starredRecord,
  truncateBody,
  userRecord,
} from "./parsers.ts";
import type { GitHubGist, GitHubIssue, GitHubPullDetail, GitHubRepo, GitHubUser } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRUBBED_FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "github", "scrubbed", "pilot-real-shape", "api");

function readScrubbedUserFixture(): GitHubUser {
  const parsed = JSON.parse(readFileSync(join(SCRUBBED_FIXTURE_DIR, "user.json"), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("expected GitHub user fixture object");
  }
  const candidate = parsed as Partial<GitHubUser>;
  if (typeof candidate.id !== "number" || typeof candidate.login !== "string") {
    throw new Error("expected GitHub user fixture id and login");
  }
  return {
    ...candidate,
    id: candidate.id,
    login: candidate.login,
  };
}

const REPO_FIXTURE: GitHubRepo = {
  id: 1001,
  name: "hello",
  full_name: "octocat/hello",
  owner: { login: "octocat" },
  description: "a demo",
  private: false,
  fork: false,
  archived: false,
  disabled: false,
  default_branch: "main",
  language: "TypeScript",
  topics: ["demo", "test"],
  stargazers_count: 3,
  forks_count: 1,
  open_issues_count: 0,
  watchers_count: 3,
  size: 128,
  license: { key: "mit" },
  html_url: "https://github.com/octocat/hello",
  homepage: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2026-04-01T12:00:00Z",
  pushed_at: "2026-04-22T10:00:00Z",
};

const ISSUE_FIXTURE: GitHubIssue = {
  id: 555,
  number: 17,
  title: "Something broke",
  body: "Repro: ...",
  state: "open",
  state_reason: null,
  user: { login: "octocat", id: 42 },
  assignees: [{ login: "octocat" }, { login: "other" }, {}],
  labels: ["bug", { name: "triage" }, {}],
  milestone: { title: "v1" },
  repository_url: "https://api.github.com/repos/octocat/hello",
  html_url: "https://github.com/octocat/hello/issues/17",
  comments: 2,
  reactions: { total_count: 5 },
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-15T00:00:00Z",
  closed_at: null,
  pull_request: null,
  draft: false,
};

const PR_FIXTURE: GitHubIssue = {
  id: 999,
  number: 42,
  title: "Add feature",
  body: "Long body",
  state: "open",
  user: { login: "octocat", id: 42 },
  assignees: [],
  labels: [],
  repository_url: "https://api.github.com/repos/octocat/hello",
  html_url: "https://github.com/octocat/hello/pull/42",
  comments: 3,
  reactions: { total_count: 1 },
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-20T00:00:00Z",
  closed_at: null,
  pull_request: { html_url: "https://github.com/octocat/hello/pull/42" },
  draft: true,
};

const PR_DETAIL_FIXTURE: GitHubPullDetail = {
  draft: false,
  merged_at: "2026-04-21T00:00:00Z",
  merged_by: { login: "merger" },
  commits: 4,
  additions: 120,
  deletions: 30,
  changed_files: 7,
  base: { ref: "main", repo: { id: 1001 } },
  head: { ref: "feature" },
  requested_reviewers: [{ login: "rev1" }, { login: "rev2" }, {}],
  review_comments: 2,
};

const GIST_FIXTURE: GitHubGist = {
  id: "abc123",
  description: "a gist",
  public: true,
  html_url: "https://gist.github.com/abc123",
  files: {
    "a.md": { filename: "a.md", language: "Markdown", size: 42, raw_url: "https://example.com/a.md" },
    "b.ts": { filename: "b.ts", language: "TypeScript", size: 128, raw_url: "https://example.com/b.ts" },
  },
  comments: 0,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

// ─── parseNextLink ───────────────────────────────────────────────────────

test("parseNextLink: null header → null", () => {
  assert.equal(parseNextLink(null), null);
});

test("parseNextLink: extracts next URL and strips API base", () => {
  const link = `<${API_BASE}/user/repos?page=2>; rel="next", <${API_BASE}/user/repos?page=5>; rel="last"`;
  assert.equal(parseNextLink(link), "/user/repos?page=2");
});

test("parseNextLink: no rel=next → null", () => {
  const link = `<${API_BASE}/user/repos?page=5>; rel="last"`;
  assert.equal(parseNextLink(link), null);
});

// ─── labelNames / assigneeNames / reviewerLogins ─────────────────────────

test("labelNames: mixed strings and objects, skips objects without name", () => {
  assert.deepEqual(labelNames(["a", { name: "b" }, {}]), ["a", "b"]);
});

test("labelNames: undefined → []", () => {
  assert.deepEqual(labelNames(undefined), []);
});

test("assigneeNames: keeps only entries with login", () => {
  assert.deepEqual(assigneeNames([{ login: "a" }, {}, { login: "b" }]), ["a", "b"]);
});

test("assigneeNames: undefined → []", () => {
  assert.deepEqual(assigneeNames(undefined), []);
});

test("reviewerLogins: extracts logins, ignoring blanks", () => {
  const detail: GitHubPullDetail = { requested_reviewers: [{ login: "a" }, {}, { login: "b" }] };
  assert.deepEqual(reviewerLogins(detail), ["a", "b"]);
});

test("reviewerLogins: null detail → []", () => {
  assert.deepEqual(reviewerLogins(null), []);
});

// ─── repoFullFromUrl ─────────────────────────────────────────────────────

test("repoFullFromUrl: strips /repos/ prefix", () => {
  assert.equal(repoFullFromUrl(`${API_BASE}/repos/octocat/hello`), "octocat/hello");
});

test("repoFullFromUrl: null in → null out", () => {
  assert.equal(repoFullFromUrl(null), null);
});

// ─── truncateBody ────────────────────────────────────────────────────────

test("truncateBody: caps at 20_000 chars", () => {
  const long = "x".repeat(30_000);
  assert.equal(truncateBody(long)?.length, 20_000);
});

test("truncateBody: non-string → null", () => {
  assert.equal(truncateBody(null), null);
  assert.equal(truncateBody(undefined), null);
});

// ─── userRecord ──────────────────────────────────────────────────────────

test("userRecord: maps fixture fields with id stringified", () => {
  const r = userRecord(readScrubbedUserFixture());
  assert.equal(r.id, "424242");
  assert.equal(r.login, "[REDACTED_LOGIN]");
  assert.equal(r.name, "[REDACTED_NAME]");
  assert.equal(r.email, "redacted@example.com");
  assert.equal(r.public_repos, 7);
});

test("userRecord: missing optional fields → null", () => {
  const r = userRecord({ id: 1, login: "x" });
  assert.equal(r.name, null);
  assert.equal(r.email, null);
  assert.equal(r.avatar_url, null);
});

// ─── repoRecord ──────────────────────────────────────────────────────────

test("repoRecord: maps fixture + size→size_kb + license.key→license_key", () => {
  const rec = repoRecord(REPO_FIXTURE);
  assert.equal(rec.id, "1001");
  assert.equal(rec.size_kb, 128);
  assert.equal(rec.license_key, "mit");
  assert.deepEqual(rec.topics, ["demo", "test"]);
});

// ─── starredRecord ───────────────────────────────────────────────────────

test("starredRecord: returns record when repo present", () => {
  const r = starredRecord({ repo: REPO_FIXTURE, starred_at: "2026-04-22T00:00:00Z" });
  assert.ok(r);
  assert.equal(r?.id, "1001");
  assert.equal(r?.starred_at, "2026-04-22T00:00:00Z");
});

test("starredRecord: missing repo → null", () => {
  assert.equal(starredRecord({ starred_at: "2026-01-01T00:00:00Z" }), null);
});

// ─── issueRecord ─────────────────────────────────────────────────────────

test("issueRecord: maps fields, is_pull_request=false for plain issue", () => {
  const r = issueRecord(ISSUE_FIXTURE);
  assert.equal(r.id, "555");
  assert.equal(r.is_pull_request, false);
  assert.equal(r.draft, null);
  assert.deepEqual(r.labels, ["bug", "triage"]);
  assert.equal(r.repository_full_name, "octocat/hello");
});

test("issueRecord: repository_url fallback when repository object missing", () => {
  const it: GitHubIssue = { id: 1, repository_url: `${API_BASE}/repos/a/b` };
  const r = issueRecord(it);
  assert.equal(r.repository_full_name, "a/b");
});

// ─── pullRequestRecord ───────────────────────────────────────────────────

test("pullRequestRecord: combines search + detail, with null detail", () => {
  const r = pullRequestRecord(PR_FIXTURE, null, "octocat/hello");
  assert.equal(r.id, "999");
  assert.equal(r.repository_full_name, "octocat/hello");
  assert.equal(r.draft, true);
  assert.equal(r.merged_at, null);
  assert.deepEqual(r.requested_reviewers, []);
});

test("pullRequestRecord: merges detail fields when present", () => {
  const r = pullRequestRecord(PR_FIXTURE, PR_DETAIL_FIXTURE, "octocat/hello");
  assert.equal(r.merged_at, "2026-04-21T00:00:00Z");
  assert.equal(r.merged_by_login, "merger");
  assert.equal(r.commits_count, 4);
  assert.equal(r.additions, 120);
  assert.equal(r.changed_files, 7);
  assert.equal(r.base_ref, "main");
  assert.equal(r.head_ref, "feature");
  assert.deepEqual(r.requested_reviewers, ["rev1", "rev2"]);
  assert.equal(r.repository_id, "1001");
});

// ─── gistRecord ──────────────────────────────────────────────────────────

test("gistRecord: maps files and counts", () => {
  const r = gistRecord(GIST_FIXTURE);
  assert.equal(r.id, "abc123");
  assert.equal((r.files as unknown[]).length, 2);
  assert.equal(r.files_truncated, false);
  assert.equal(r.files_total_count, 2);
});

test("gistRecord: truncates at 10 files", () => {
  const files: Record<string, { filename: string; size: number }> = {};
  for (let i = 0; i < 15; i++) {
    files[`f${i}.txt`] = { filename: `f${i}.txt`, size: i };
  }
  const r = gistRecord({ id: "x", public: true, files });
  assert.equal((r.files as unknown[]).length, 10);
  assert.equal(r.files_truncated, true);
  assert.equal(r.files_total_count, 15);
});

// ─── laterIso / isBeforeSince / isAtOrAfterUntil ─────────────────────────

test("laterIso: returns the larger of two ISO strings", () => {
  assert.equal(laterIso("2026-01-01", "2026-02-01"), "2026-02-01");
  assert.equal(laterIso("2026-02-01", "2026-01-01"), "2026-02-01");
});

test("laterIso: null-tolerant", () => {
  assert.equal(laterIso(null, "2026-01-01"), "2026-01-01");
  assert.equal(laterIso("2026-01-01", null), "2026-01-01");
  assert.equal(laterIso(null, null), null);
});

test("isBeforeSince: true only when both values present and iso < since", () => {
  assert.equal(isBeforeSince("2026-01-01", "2026-02-01"), true);
  assert.equal(isBeforeSince("2026-03-01", "2026-02-01"), false);
  assert.equal(isBeforeSince(null, "2026-02-01"), false);
  assert.equal(isBeforeSince("2026-03-01", null), false);
});

test("isAtOrAfterUntil: true only when both present and iso >= until", () => {
  assert.equal(isAtOrAfterUntil("2026-02-01", "2026-02-01"), true);
  assert.equal(isAtOrAfterUntil("2026-03-01", "2026-02-01"), true);
  assert.equal(isAtOrAfterUntil("2026-01-01", "2026-02-01"), false);
  assert.equal(isAtOrAfterUntil(null, "2026-02-01"), false);
});

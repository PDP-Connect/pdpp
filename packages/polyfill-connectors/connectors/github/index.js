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

import { runConnector, nowIso } from '../../src/connector-runtime.js';

const BASE = 'https://api.github.com';

async function gh(path, token, { accept = 'application/vnd.github+json' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pdpp-connector-github/0.1',
    },
  });
  if (res.status === 401) throw new Error('github_auth_failed');
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new Error('github_rate_limited');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`github_http_${res.status}: ${body.slice(0, 200)}`);
  }
  const link = res.headers.get('link');
  const data = await res.json();
  const nextUrl = parseNextLink(link);
  return { data, nextUrl };
}

function parseNextLink(link) {
  if (!link) return null;
  const m = /<([^>]+)>; rel="next"/.exec(link);
  return m ? m[1].replace(BASE, '') : null;
}

runConnector({
  name: 'github',
  retryablePattern: /rate_limited|ECONN|fetch failed/,
  // GITHUB_TOKEN is the universal GitHub-CI env var; accept it as a fallback.
  auth: { kind: 'env', required: [['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN']] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const token = credentials.GITHUB_PERSONAL_ACCESS_TOKEN;

    // USER
    if (requested.has('user')) {
      progress('Fetching user profile', { stream: 'user' });
      const { data: u } = await gh('/user', token);
      emitRecord('user', {
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
      });
      emit({ type: 'STATE', stream: 'user', cursor: { fetched_at: nowIso() } });
    }

    // REPOSITORIES
    if (requested.has('repositories')) {
      progress('Fetching repositories', { stream: 'repositories' });
      let path = `/user/repos?per_page=100&sort=pushed&direction=desc`;
      const priorPushed = state.repositories?.last_pushed_at;
      let latestPushed = priorPushed;
      let stop = false;
      while (path && !stop) {
        const { data, nextUrl } = await gh(path, token);
        for (const r of data) {
          if (priorPushed && r.pushed_at && r.pushed_at <= priorPushed) { stop = true; break; }
          emitRecord('repositories', {
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
          });
          if (r.pushed_at && (!latestPushed || r.pushed_at > latestPushed)) latestPushed = r.pushed_at;
        }
        path = nextUrl;
      }
      emit({ type: 'STATE', stream: 'repositories', cursor: { last_pushed_at: latestPushed || priorPushed || null } });
    }

    // STARRED
    if (requested.has('starred')) {
      progress('Fetching starred repositories', { stream: 'starred' });
      const priorStarred = state.starred?.last_starred_at;
      let latestStarred = priorStarred;
      let path = `/user/starred?per_page=100&sort=created&direction=desc`;
      let stop = false;
      while (path && !stop) {
        // Use star:timestamp media type to get starred_at
        const { data, nextUrl } = await gh(path, token, { accept: 'application/vnd.github.star+json' });
        for (const entry of data) {
          const repo = entry.repo || entry;
          const starredAt = entry.starred_at || null;
          if (priorStarred && starredAt && starredAt <= priorStarred) { stop = true; break; }
          emitRecord('starred', {
            id: String(repo.id),
            full_name: repo.full_name,
            description: repo.description ?? null,
            language: repo.language ?? null,
            stargazers_count: repo.stargazers_count ?? null,
            html_url: repo.html_url ?? null,
            starred_at: starredAt,
          });
          if (starredAt && (!latestStarred || starredAt > latestStarred)) latestStarred = starredAt;
        }
        path = nextUrl;
      }
      emit({ type: 'STATE', stream: 'starred', cursor: { last_starred_at: latestStarred || priorStarred || null } });
    }

    // ISSUES (GitHub's /issues endpoint returns both issues and PRs)
    if (requested.has('issues')) {
      progress('Fetching issues', { stream: 'issues' });
      const req = requested.get('issues');
      const priorUpdated = state.issues?.last_updated_at;
      // Prefer explicit scope time_range.since over stored cursor (narrower wins).
      const sinceParam = req?.time_range?.since || priorUpdated || null;
      const until = req?.time_range?.until || null;
      let latestUpdated = priorUpdated;
      const qs = [
        'filter=all',
        'state=all',
        'per_page=100',
        'sort=updated',
        'direction=desc',
      ];
      if (sinceParam) qs.push(`since=${encodeURIComponent(sinceParam)}`);
      let path = `/issues?${qs.join('&')}`;
      while (path) {
        const { data, nextUrl } = await gh(path, token);
        for (const it of data) {
          if (until && it.updated_at && it.updated_at >= until) continue;
          const body = typeof it.body === 'string' ? it.body.slice(0, 20000) : null;
          emitRecord('issues', {
            id: String(it.id),
            number: it.number ?? null,
            title: it.title ?? null,
            body,
            state: it.state ?? null,
            state_reason: it.state_reason ?? null,
            user_login: it.user?.login ?? null,
            user_id: it.user?.id != null ? String(it.user.id) : null,
            assignees: Array.isArray(it.assignees) ? it.assignees.map((a) => a.login).filter(Boolean) : [],
            labels: Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
            milestone_title: it.milestone?.title ?? null,
            repository_full_name: it.repository?.full_name
              ?? (it.repository_url ? it.repository_url.replace(`${BASE}/repos/`, '') : null),
            repository_id: it.repository?.id != null ? String(it.repository.id) : null,
            html_url: it.html_url ?? null,
            comments: it.comments ?? null,
            reactions_total_count: it.reactions?.total_count ?? null,
            created_at: it.created_at ?? null,
            updated_at: it.updated_at ?? null,
            closed_at: it.closed_at ?? null,
            is_pull_request: Boolean(it.pull_request),
            pull_request_url: it.pull_request?.html_url ?? null,
            draft: it.pull_request ? Boolean(it.draft) : null,
          });
          if (it.updated_at && (!latestUpdated || it.updated_at > latestUpdated)) latestUpdated = it.updated_at;
        }
        path = nextUrl;
      }
      emit({ type: 'STATE', stream: 'issues', cursor: { last_updated_at: latestUpdated || priorUpdated || null } });
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
    if (requested.has('pull_requests')) {
      progress('Fetching pull requests', { stream: 'pull_requests' });
      const req = requested.get('pull_requests');
      const priorUpdated = state.pull_requests?.last_updated_at;
      const sinceParam = req?.time_range?.since || priorUpdated || null;
      const until = req?.time_range?.until || null;
      let latestUpdated = priorUpdated;

      // Need the login to build the search query.
      const { data: me } = await gh('/user', token);
      const login = me.login;
      // Search API: updated:>=YYYY-MM-DD narrows to new work. Date-precision only;
      // we apply strict `since` filter in code as well.
      const qParts = [`type:pr`, `author:${login}`];
      if (sinceParam) qParts.push(`updated:>=${sinceParam.slice(0, 10)}`);
      const q = encodeURIComponent(qParts.join(' '));
      let path = `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`;
      let stop = false;
      while (path && !stop) {
        const { data, nextUrl } = await gh(path, token);
        const items = data.items || [];
        for (const it of items) {
          if (sinceParam && it.updated_at && it.updated_at < sinceParam) { stop = true; break; }
          if (until && it.updated_at && it.updated_at >= until) continue;
          // Parse owner/repo from repository_url "https://api.github.com/repos/owner/repo"
          const repoFull = it.repository_url ? it.repository_url.replace(`${BASE}/repos/`, '') : null;
          // Fetch PR detail for fields not in search summary.
          let detail = null;
          if (repoFull) {
            try {
              const r = await gh(`/repos/${repoFull}/pulls/${it.number}`, token);
              detail = r.data;
            } catch (e) {
              // Non-fatal: emit what we have from search. Rate-limit errors
              // bubble up from gh() and abort the whole run (retryable).
              if (/rate_limited|auth_failed/.test(e.message)) throw e;
            }
          }
          const body = typeof it.body === 'string' ? it.body.slice(0, 20000) : null;
          emitRecord('pull_requests', {
            id: String(it.id),
            number: it.number ?? null,
            title: it.title ?? null,
            body,
            state: it.state ?? null,
            state_reason: it.state_reason ?? null,
            user_login: it.user?.login ?? null,
            user_id: it.user?.id != null ? String(it.user.id) : null,
            assignees: Array.isArray(it.assignees) ? it.assignees.map((a) => a.login).filter(Boolean) : [],
            labels: Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
            milestone_title: it.milestone?.title ?? null,
            repository_full_name: repoFull,
            repository_id: detail?.base?.repo?.id != null ? String(detail.base.repo.id) : null,
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
            requested_reviewers: Array.isArray(detail?.requested_reviewers)
              ? detail.requested_reviewers.map((r) => r.login).filter(Boolean) : [],
            review_comments_count: detail?.review_comments ?? null,
          });
          if (it.updated_at && (!latestUpdated || it.updated_at > latestUpdated)) latestUpdated = it.updated_at;
        }
        path = nextUrl;
      }
      emit({ type: 'STATE', stream: 'pull_requests', cursor: { last_updated_at: latestUpdated || priorUpdated || null } });
    }

    // GISTS
    if (requested.has('gists')) {
      progress('Fetching gists', { stream: 'gists' });
      const req = requested.get('gists');
      const priorUpdated = state.gists?.last_updated_at;
      const sinceParam = req?.time_range?.since || priorUpdated || null;
      const until = req?.time_range?.until || null;
      let latestUpdated = priorUpdated;
      const qs = ['per_page=100'];
      if (sinceParam) qs.push(`since=${encodeURIComponent(sinceParam)}`);
      let path = `/gists?${qs.join('&')}`;
      while (path) {
        const { data, nextUrl } = await gh(path, token);
        for (const g of data) {
          if (until && g.updated_at && g.updated_at >= until) continue;
          const fileEntries = g.files && typeof g.files === 'object' ? Object.values(g.files) : [];
          const capped = fileEntries.slice(0, 10);
          const files = capped.map((f) => ({
            filename: f.filename ?? null,
            language: f.language ?? null,
            size: typeof f.size === 'number' ? f.size : null,
            raw_url: f.raw_url ?? null,
          }));
          emitRecord('gists', {
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
          });
          if (g.updated_at && (!latestUpdated || g.updated_at > latestUpdated)) latestUpdated = g.updated_at;
        }
        path = nextUrl;
      }
      emit({ type: 'STATE', stream: 'gists', cursor: { last_updated_at: latestUpdated || priorUpdated || null } });
    }
  },
});

#!/usr/bin/env node
/**
 * PDPP GitHub Connector (v0.1.0)
 *
 * Auth: Personal Access Token via GITHUB_PERSONAL_ACCESS_TOKEN env var.
 * Create at https://github.com/settings/tokens (fine-grained or classic).
 * Minimum scopes: read:user, public_repo (for public), repo (for private).
 *
 * Streams: user, repositories, starred.
 * Incremental: repositories via `since` + updated_at; starred via starred_at.
 *
 * Rate limit: 5000 req/hr (authenticated). We paginate 100 per page.
 */

import { createInterface } from 'node:readline';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

let _interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_interactionCounter}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) {
          rl.off('line', onLine);
          resolve(parsed);
        }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

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

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  let token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        connectorName: 'GitHub',
        sendInteractionAndWait,
        nextInteractionId,
      });
      token = creds.GITHUB_PERSONAL_ACCESS_TOKEN;
    } catch (e) { return fail(e.message, false); }
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  // Per-stream resource filters
  const resFilters = new Map();
  for (const [name, req] of requested) resFilters.set(name, resourceSet(req));

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const emitRecord = (stream, data) => {
    const id = data.id;
    if (id == null) return;
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(String(id))) return;
    emit({ type: 'RECORD', stream, key: id, data, emitted_at: emittedAt });
    total++;
  };

  // USER
  if (requested.has('user')) {
    emit({ type: 'PROGRESS', stream: 'user', message: 'Fetching user profile' });
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
    emit({ type: 'PROGRESS', stream: 'repositories', message: 'Fetching repositories' });
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
    emit({ type: 'PROGRESS', stream: 'starred', message: 'Fetching starred repositories' });
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

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /rate_limited|ECONN|fetch failed/.test(msg) } });
  flushAndExit(1);
});

#!/usr/bin/env node
/**
 * PDPP Reddit Connector (v0.1.0)
 *
 * Auth: OAuth script-app credentials via REDDIT_CLIENT_ID +
 * REDDIT_CLIENT_SECRET + REDDIT_USERNAME + REDDIT_PASSWORD (install an app at
 * https://www.reddit.com/prefs/apps — type "script"). Or provide
 * REDDIT_ACCESS_TOKEN directly (shorter TTL).
 *
 * Endpoints:
 *   /user/{u}/submitted
 *   /user/{u}/comments
 *   /user/{u}/saved (requires read+history scopes)
 *
 * Rate limit: 100 OAuth req/min.
 */

import { requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { runConnector, nowIso } from '../../src/connector-runtime.js';

const isoFromUnix = (u) => u ? new Date(Number(u) * 1000).toISOString() : null;

async function getAccessToken() {
  if (process.env.REDDIT_ACCESS_TOKEN) return process.env.REDDIT_ACCESS_TOKEN;
  const clientId = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const user = process.env.REDDIT_USERNAME;
  const pass = process.env.REDDIT_PASSWORD;
  if (!clientId || !secret || !user || !pass) {
    throw new Error('reddit_creds_missing: set REDDIT_ACCESS_TOKEN, or all of REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD');
  }
  const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'pdpp-reddit-connector/0.1',
    },
    body: new URLSearchParams({ grant_type: 'password', username: user, password: pass }).toString(),
  });
  if (!res.ok) throw new Error(`reddit_token_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function redditFetch(path, token) {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pdpp-reddit-connector/0.1' },
  });
  if (res.status === 401) throw new Error('reddit_auth_failed');
  if (res.status === 429) throw new Error('reddit_rate_limited');
  if (!res.ok) throw new Error(`reddit_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Paginate a Reddit listing. Reddit listings are newest-first and use an
 * opaque `after` cursor. We support incremental sync by stopping pagination
 * once we cross the earliest `created_utc` from the prior run.
 *
 * @param {string} endpointTemplate — e.g. `/user/foo/comments`
 * @param {string} token
 * @param {number|null} sinceEpochUtc — previous run's `last_created_utc`,
 *   or null to fetch everything.
 */
async function paginate(endpointTemplate, token, sinceEpochUtc = null) {
  const all = [];
  let after = null;
  let guard = 100;
  while (guard-- > 0) {
    const path = `${endpointTemplate}?limit=100${after ? `&after=${after}` : ''}`;
    const json = await redditFetch(path, token);
    const children = json?.data?.children || [];
    if (!children.length) break;

    // Incremental stop: if we've gone past the cursor (created_utc < sinceEpoch),
    // everything remaining is older — stop paginating.
    let hitCursor = false;
    for (const c of children) {
      const created = Number(c?.data?.created_utc || 0);
      if (sinceEpochUtc && created <= sinceEpochUtc) { hitCursor = true; break; }
      all.push(c);
    }
    if (hitCursor) break;

    after = json?.data?.after;
    if (!after) break;
  }
  return all;
}

runConnector({
  name: 'reddit',
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  async collect({ state, requested, emit, emitRecord, progress, sendInteraction }) {
    // Credentials — prompt for any missing.
    const creds = await requireCredentialsOrAsk({
      required: ['REDDIT_USERNAME'],
      connectorName: 'Reddit',
      sendInteraction,
      
    });
    const user = creds.REDDIT_USERNAME;

    const token = await getAccessToken();

    if (requested.has('submitted')) {
      progress('Fetching submissions', { stream: 'submitted' });
      const sinceEpoch = state.submitted?.last_created_utc || null;
      const items = await paginate(`/user/${encodeURIComponent(user)}/submitted`, token, sinceEpoch);
      let latestEpoch = sinceEpoch || 0;
      for (const c of items) {
        const d = c.data;
        latestEpoch = Math.max(latestEpoch, Number(d.created_utc || 0));
        emitRecord('submitted', {
          id: d.name,
          subreddit: d.subreddit ?? null,
          title: d.title ?? null,
          permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
          url: d.url ?? null,
          selftext: d.selftext ?? null,
          is_self: d.is_self ?? null,
          score: d.score ?? null,
          num_comments: d.num_comments ?? null,
          upvote_ratio: d.upvote_ratio ?? null,
          created_utc: isoFromUnix(d.created_utc) || nowIso(),
        });
      }
      emit({ type: 'STATE', stream: 'submitted', cursor: { last_created_utc: latestEpoch } });
    }

    if (requested.has('comments')) {
      progress('Fetching comments', { stream: 'comments' });
      const sinceEpochC = state.comments?.last_created_utc || null;
      const items = await paginate(`/user/${encodeURIComponent(user)}/comments`, token, sinceEpochC);
      let latestEpochC = sinceEpochC || 0;
      for (const c of items) {
        const d = c.data;
        latestEpochC = Math.max(latestEpochC, Number(d.created_utc || 0));
        emitRecord('comments', {
          id: d.name,
          subreddit: d.subreddit ?? null,
          body: d.body ?? null,
          link_id: d.link_id ?? null,
          parent_id: d.parent_id ?? null,
          permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
          score: d.score ?? null,
          created_utc: isoFromUnix(d.created_utc) || nowIso(),
        });
      }
      emit({ type: 'STATE', stream: 'comments', cursor: { last_created_utc: latestEpochC } });
    }

    if (requested.has('saved')) {
      progress('Fetching saved items', { stream: 'saved' });
      const sinceEpochS = state.saved?.last_created_utc || null;
      const items = await paginate(`/user/${encodeURIComponent(user)}/saved`, token, sinceEpochS);
      let latestEpochS = sinceEpochS || 0;
      for (const c of items) {
        const d = c.data;
        latestEpochS = Math.max(latestEpochS, Number(d.created_utc || 0));
        emitRecord('saved', {
          id: d.name,
          kind: c.kind,
          subreddit: d.subreddit ?? null,
          title: d.title ?? d.link_title ?? null,
          body: d.body ?? d.selftext ?? null,
          permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
          url: d.url ?? null,
          created_utc: isoFromUnix(d.created_utc) || nowIso(),
        });
      }
      emit({ type: 'STATE', stream: 'saved', cursor: { last_created_utc: latestEpochS } });
    }
  },
});

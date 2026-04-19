#!/usr/bin/env node
/**
 * PDPP Seed Connector
 *
 * Emits deterministic fixture data for all three reference worlds (spotify, github, reddit)
 * without requiring any API keys. Use for fast local fixtures and testing.
 *
 * The runtime now passes a Collection Profile START.scope; this connector
 * infers which fixture family to emit from the requested stream names.
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function isoDate(daysAgo, hoursAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(d.getHours() - hoursAgo);
  return d.toISOString();
}

// ─── Spotify seed data ────────────────────────────────────────────────────────

const SPOTIFY_ARTISTS = [
  { id: 'spotify:artist:4Z8W4fKeB5YaZFgNFWDhN', name: 'Radiohead', genres: ['alternative rock', 'art rock', 'melancholia'], popularity: 82, followers: 7800000, source_updated_at: isoDate(10) },
  { id: 'spotify:artist:0C0XlULifJtAgn6ZNCW2eu', name: 'Aphex Twin', genres: ['electronic', 'ambient techno', 'IDM'], popularity: 71, followers: 2100000, source_updated_at: isoDate(8) },
  { id: 'spotify:artist:2YZyLoL8N0Wb9xBt1NhZWg', name: 'Kendrick Lamar', genres: ['conscious hip hop', 'rap', 'west coast rap'], popularity: 93, followers: 22000000, source_updated_at: isoDate(3) },
  { id: 'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ', name: 'The Weeknd', genres: ['canadian pop', 'pop', 'r&b'], popularity: 95, followers: 38000000, source_updated_at: isoDate(1) },
  { id: 'spotify:artist:3TVXtAsR1Inumwj472S9r4', name: 'Drake', genres: ['canadian hip hop', 'canadian pop', 'rap'], popularity: 96, followers: 73000000, source_updated_at: isoDate(2) },
  { id: 'spotify:artist:7jy3rLJdDQY21OgRLCZ9sD', name: 'Foo Fighters', genres: ['alternative metal', 'alternative rock', 'post-grunge'], popularity: 79, followers: 12000000, source_updated_at: isoDate(15) },
  { id: 'spotify:artist:4dpARuHxo51G3z768sgnrY', name: 'Adele', genres: ['british soul', 'pop', 'uk pop'], popularity: 88, followers: 42000000, source_updated_at: isoDate(5) },
  { id: 'spotify:artist:0L8ExT028jH3ddEcZwqJJ5', name: 'Taylor Swift', genres: ['pop', 'country pop'], popularity: 100, followers: 98000000, source_updated_at: isoDate(0) },
];

const SPOTIFY_SAVED_TRACKS = [
  { id: 'spotify:track:4cluDES4hQEUhmXj6TXkSo', name: 'Creep', artist_names: ['Radiohead'], album_name: 'Pablo Honey', duration_ms: 238000, popularity: 86, saved_at: isoDate(90), source_created_at: isoDate(90) },
  { id: 'spotify:track:3AhXZa8sUQht0UEdBJgpGc', name: 'Karma Police', artist_names: ['Radiohead'], album_name: 'OK Computer', duration_ms: 264000, popularity: 78, saved_at: isoDate(85), source_created_at: isoDate(85) },
  { id: 'spotify:track:2374M0fQpWi3dLnB54qaLX', name: 'Blinding Lights', artist_names: ['The Weeknd'], album_name: 'After Hours', duration_ms: 200000, popularity: 95, saved_at: isoDate(60), source_created_at: isoDate(60) },
  { id: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', name: 'Bohemian Rhapsody', artist_names: ['Queen'], album_name: 'A Night at the Opera', duration_ms: 354000, popularity: 91, saved_at: isoDate(45), source_created_at: isoDate(45) },
  { id: 'spotify:track:6rqhFgbbKwnb9MLmUQDhG6', name: 'God\'s Plan', artist_names: ['Drake'], album_name: 'Scorpion', duration_ms: 198000, popularity: 89, saved_at: isoDate(30), source_created_at: isoDate(30) },
  { id: 'spotify:track:1dGr1c8CrMLDpV6mPbImSI', name: 'HUMBLE.', artist_names: ['Kendrick Lamar'], album_name: 'DAMN.', duration_ms: 177000, popularity: 88, saved_at: isoDate(20), source_created_at: isoDate(20) },
  { id: 'spotify:track:7KXjTSCq5nL1LoYtL7XAwS', name: 'Shake It Off', artist_names: ['Taylor Swift'], album_name: '1989', duration_ms: 219000, popularity: 87, saved_at: isoDate(10), source_created_at: isoDate(10) },
  { id: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh', name: 'Someone Like You', artist_names: ['Adele'], album_name: '21', duration_ms: 285000, popularity: 82, saved_at: isoDate(5), source_created_at: isoDate(5) },
];

const SPOTIFY_RECENTLY_PLAYED = [
  { id: 'play_1', track_id: 'spotify:track:4cluDES4hQEUhmXj6TXkSo', track_name: 'Creep', artist_names: ['Radiohead'], played_at: isoDate(0, 1), duration_ms: 238000, context_type: 'album' },
  { id: 'play_2', track_id: 'spotify:track:2374M0fQpWi3dLnB54qaLX', track_name: 'Blinding Lights', artist_names: ['The Weeknd'], played_at: isoDate(0, 2), duration_ms: 200000, context_type: 'playlist' },
  { id: 'play_3', track_id: 'spotify:track:6rqhFgbbKwnb9MLmUQDhG6', track_name: 'God\'s Plan', artist_names: ['Drake'], played_at: isoDate(0, 4), duration_ms: 198000, context_type: 'radio' },
  { id: 'play_4', track_id: 'spotify:track:1dGr1c8CrMLDpV6mPbImSI', track_name: 'HUMBLE.', artist_names: ['Kendrick Lamar'], played_at: isoDate(1), duration_ms: 177000, context_type: 'album' },
  { id: 'play_5', track_id: 'spotify:track:7KXjTSCq5nL1LoYtL7XAwS', track_name: 'Shake It Off', artist_names: ['Taylor Swift'], played_at: isoDate(1, 3), duration_ms: 219000, context_type: 'playlist' },
];

// ─── GitHub seed data ─────────────────────────────────────────────────────────

const GITHUB_REPOS = [
  { id: 'gh:repo:123456', name: 'personal-site', full_name: 'seedowner/personal-site', description: 'My personal website and blog', language: 'TypeScript', stargazers_count: 12, forks_count: 2, is_private: false, is_fork: false, topics: ['blog', 'nextjs', 'tailwind'], source_created_at: isoDate(730), source_updated_at: isoDate(5) },
  { id: 'gh:repo:234567', name: 'dotfiles', full_name: 'seedowner/dotfiles', description: 'My development environment config', language: 'Shell', stargazers_count: 45, forks_count: 8, is_private: false, is_fork: false, topics: ['dotfiles', 'zsh', 'neovim'], source_created_at: isoDate(1095), source_updated_at: isoDate(2) },
  { id: 'gh:repo:345678', name: 'advent-of-code', full_name: 'seedowner/advent-of-code', description: 'AoC solutions', language: 'Python', stargazers_count: 3, forks_count: 0, is_private: false, is_fork: false, topics: ['advent-of-code', 'python'], source_created_at: isoDate(365), source_updated_at: isoDate(120) },
  { id: 'gh:repo:456789', name: 'ml-experiments', full_name: 'seedowner/ml-experiments', description: 'ML experiments and notebooks', language: 'Python', stargazers_count: 28, forks_count: 5, is_private: false, is_fork: false, topics: ['machine-learning', 'pytorch', 'transformers'], source_created_at: isoDate(500), source_updated_at: isoDate(30) },
  { id: 'gh:repo:567890', name: 'private-project', full_name: 'seedowner/private-project', description: 'Work project', language: 'Go', stargazers_count: 0, forks_count: 0, is_private: true, is_fork: false, topics: [], source_created_at: isoDate(200), source_updated_at: isoDate(1) },
];

const GITHUB_COMMITS = [
  { id: 'gh:commit:abc1', repo_full_name: 'seedowner/personal-site', sha: 'abc1def2', message: 'feat: add dark mode toggle', additions: 87, deletions: 12, source_created_at: isoDate(5) },
  { id: 'gh:commit:abc2', repo_full_name: 'seedowner/personal-site', sha: 'abc2def3', message: 'fix: mobile navigation overflow', additions: 15, deletions: 8, source_created_at: isoDate(6) },
  { id: 'gh:commit:abc3', repo_full_name: 'seedowner/dotfiles', sha: 'abc3def4', message: 'chore: update neovim plugins', additions: 43, deletions: 21, source_created_at: isoDate(2) },
  { id: 'gh:commit:abc4', repo_full_name: 'seedowner/ml-experiments', sha: 'abc4def5', message: 'feat: add attention visualization', additions: 210, deletions: 5, source_created_at: isoDate(30) },
  { id: 'gh:commit:abc5', repo_full_name: 'seedowner/private-project', sha: 'abc5def6', message: 'feat: implement auth middleware', additions: 320, deletions: 45, source_created_at: isoDate(1) },
  { id: 'gh:commit:abc6', repo_full_name: 'seedowner/dotfiles', sha: 'abc6def7', message: 'refactor: reorganize zsh aliases', additions: 67, deletions: 89, source_created_at: isoDate(10) },
  { id: 'gh:commit:abc7', repo_full_name: 'seedowner/personal-site', sha: 'abc7def8', message: 'docs: update README', additions: 45, deletions: 12, source_created_at: isoDate(15) },
  { id: 'gh:commit:abc8', repo_full_name: 'seedowner/advent-of-code', sha: 'abc8def9', message: 'solve: day 25 part 2', additions: 55, deletions: 0, source_created_at: isoDate(120) },
];

const GITHUB_STARRED = [
  { id: 'gh:starred:111', full_name: 'anthropics/claude-code', description: 'The official Claude Code CLI', language: 'TypeScript', stargazers_count: 15000, starred_at: isoDate(30) },
  { id: 'gh:starred:222', full_name: 'neovim/neovim', description: 'Vim-fork focused on extensibility and usability', language: 'Vim Script', stargazers_count: 78000, starred_at: isoDate(60) },
  { id: 'gh:starred:333', full_name: 'sindresorhus/awesome', description: 'Awesome lists about all kinds of interesting topics', language: null, stargazers_count: 320000, starred_at: isoDate(90) },
  { id: 'gh:starred:444', full_name: 'fastlane/fastlane', description: 'The easiest way to automate building and releasing your iOS and Android apps', language: 'Ruby', stargazers_count: 38000, starred_at: isoDate(180) },
];

// ─── Reddit seed data ─────────────────────────────────────────────────────────

const REDDIT_POSTS = [
  { id: 'reddit:post:abc123', title: 'I built a personal data portability protocol in 30 days', subreddit: 'programming', selftext: 'After 30 days of work, I finally have a working prototype of a personal data portability protocol. It uses OAuth 2.0 with Rich Authorization Requests (RFC 9396) and a flat relational stream model inspired by Airbyte...', url: 'https://reddit.com/r/programming/comments/abc123', score: 892, upvote_ratio: 0.97, num_comments: 145, is_self: true, source_created_at: isoDate(14) },
  { id: 'reddit:post:def456', title: 'TIL that most OAuth implementations get token revocation completely wrong', subreddit: 'netsec', selftext: '', url: 'https://example.com/oauth-revocation', score: 2341, upvote_ratio: 0.95, num_comments: 287, is_self: false, source_created_at: isoDate(30) },
  { id: 'reddit:post:ghi789', title: 'Ask HN-style: What data do you wish you could access from the platforms you use?', subreddit: 'selfhosted', selftext: 'I\'ve been thinking about this a lot. So much of our data is locked into platforms...', url: 'https://reddit.com/r/selfhosted/comments/ghi789', score: 445, upvote_ratio: 0.91, num_comments: 89, is_self: true, source_created_at: isoDate(45) },
  { id: 'reddit:post:jkl012', title: 'My homelab setup: 3 years of iteration', subreddit: 'homelab', selftext: 'Started with a Raspberry Pi, now running a full Proxmox cluster...', url: 'https://reddit.com/r/homelab/comments/jkl012', score: 1230, upvote_ratio: 0.98, num_comments: 203, is_self: true, source_created_at: isoDate(60) },
];

const REDDIT_COMMENTS = [
  { id: 'reddit:comment:c111', post_id: 'reddit:post:abc123', subreddit: 'programming', body: 'This is really interesting. I\'ve been wanting something like this for a while. Have you considered using RFC 7662 for token introspection?', score: 234, post_title: 'I built a personal data portability protocol in 30 days', source_created_at: isoDate(14) },
  { id: 'reddit:comment:c222', post_id: 'reddit:post:def456', subreddit: 'netsec', body: 'The fundamental problem is that most developers think "deleting the token" is the same as revocation. It\'s not. The server needs to actively check validity.', score: 456, post_title: 'TIL that most OAuth implementations get token revocation completely wrong', source_created_at: isoDate(30) },
  { id: 'reddit:comment:c333', post_id: 'reddit:post:ghi789', subreddit: 'selfhosted', body: 'My Spotify listening history. I\'ve been using it for 10 years and I have no way to export it in a useful format.', score: 89, post_title: 'Ask HN-style: What data do you wish you could access?', source_created_at: isoDate(45) },
  { id: 'reddit:comment:c444', post_id: 'reddit:post:jkl012', subreddit: 'homelab', body: 'How are you handling backups for the Proxmox cluster? This is always my biggest concern.', score: 123, post_title: 'My homelab setup: 3 years of iteration', source_created_at: isoDate(60) },
  { id: 'reddit:comment:c555', post_id: 'reddit:post:abc123', subreddit: 'programming', body: 'The flat relational stream model is smart. Nested objects are a nightmare for incremental sync.', score: 178, post_title: 'I built a personal data portability protocol in 30 days', source_created_at: isoDate(13) },
];

const REDDIT_SAVED = [
  { id: 'reddit:saved:s1', kind: 'post', title: 'The Architecture of Open Source Applications', subreddit: 'programming', url: 'https://aosabook.org', source_created_at: isoDate(200) },
  { id: 'reddit:saved:s2', kind: 'comment', title: 'Excellent explanation of distributed systems consensus', subreddit: 'compsci', url: null, source_created_at: isoDate(150) },
  { id: 'reddit:saved:s3', kind: 'post', title: 'Ask HN: What are good resources for learning systems programming?', subreddit: 'learnprogramming', url: null, source_created_at: isoDate(90) },
];

// ─── Protocol ─────────────────────────────────────────────────────────────────

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      try { resolve(JSON.parse(line)); }
      catch (e) { reject(e); }
    });
  });

  if (startMsg.type !== 'START') {
    emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: 'Expected START', retryable: false } });
    process.exit(1);
  }

  const requestedStreams = new Set((startMsg.scope?.streams || []).map((stream) => stream.name));
  if (!requestedStreams.size) {
    emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: 'START.scope.streams is required', retryable: false } });
    process.exit(1);
  }

  const wants = (...streamNames) => streamNames.some((streamName) => requestedStreams.has(streamName));
  const emittedAt = new Date().toISOString();

  let totalEmitted = 0;

  function emitRecord(stream, record) {
    emit({
      type: 'RECORD',
      stream,
      key: record.id,
      data: record,
      emitted_at: emittedAt,
    });
    totalEmitted++;
  }

  // Spotify
  if (wants('top_artists', 'saved_tracks', 'recently_played')) {
    emit({ type: 'PROGRESS', stream: 'top_artists', message: `Emitting ${SPOTIFY_ARTISTS.length} artists` });
    for (const artist of SPOTIFY_ARTISTS) emitRecord('top_artists', artist);
    emit({ type: 'STATE', stream: 'top_artists', cursor: { last_updated: SPOTIFY_ARTISTS[0].source_updated_at } });

    emit({ type: 'PROGRESS', stream: 'saved_tracks', message: `Emitting ${SPOTIFY_SAVED_TRACKS.length} tracks` });
    for (const track of SPOTIFY_SAVED_TRACKS) emitRecord('saved_tracks', track);
    emit({ type: 'STATE', stream: 'saved_tracks', cursor: { last_saved_at: SPOTIFY_SAVED_TRACKS[0].saved_at } });

    emit({ type: 'PROGRESS', stream: 'recently_played', message: `Emitting ${SPOTIFY_RECENTLY_PLAYED.length} plays` });
    for (const play of SPOTIFY_RECENTLY_PLAYED) emitRecord('recently_played', play);
  }

  // GitHub
  if (wants('repositories', 'commits', 'starred_repos')) {
    emit({ type: 'PROGRESS', stream: 'repositories', message: `Emitting ${GITHUB_REPOS.length} repos` });
    for (const repo of GITHUB_REPOS) emitRecord('repositories', repo);
    emit({ type: 'STATE', stream: 'repositories', cursor: { last_updated: GITHUB_REPOS[0].source_updated_at } });

    emit({ type: 'PROGRESS', stream: 'commits', message: `Emitting ${GITHUB_COMMITS.length} commits` });
    for (const commit of GITHUB_COMMITS) emitRecord('commits', commit);
    emit({ type: 'STATE', stream: 'commits', cursor: { since: GITHUB_COMMITS[0].source_created_at } });

    emit({ type: 'PROGRESS', stream: 'starred_repos', message: `Emitting ${GITHUB_STARRED.length} starred repos` });
    for (const star of GITHUB_STARRED) emitRecord('starred_repos', star);
  }

  // Reddit
  if (wants('posts', 'comments', 'saved')) {
    emit({ type: 'PROGRESS', stream: 'posts', message: `Emitting ${REDDIT_POSTS.length} posts` });
    for (const post of REDDIT_POSTS) emitRecord('posts', post);
    emit({ type: 'STATE', stream: 'posts', cursor: { after: REDDIT_POSTS[0].id } });

    emit({ type: 'PROGRESS', stream: 'comments', message: `Emitting ${REDDIT_COMMENTS.length} comments` });
    for (const comment of REDDIT_COMMENTS) emitRecord('comments', comment);
    emit({ type: 'STATE', stream: 'comments', cursor: { after: REDDIT_COMMENTS[0].id } });

    emit({ type: 'PROGRESS', stream: 'saved', message: `Emitting ${REDDIT_SAVED.length} saved items` });
    for (const saved of REDDIT_SAVED) emitRecord('saved', saved);
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
  process.exit(0);
}

main().catch(err => {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: err.message, retryable: false } });
  process.exit(1);
});

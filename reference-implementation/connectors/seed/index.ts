#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Seed Connector
 *
 * Emits deterministic fixture data for all three reference worlds (spotify, github, reddit)
 * without requiring any API keys. Use for fast local fixtures and testing.
 *
 * The runtime now passes a Collection Profile START.scope; this connector
 * infers which fixture family to emit from the requested stream names.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}
type SeedRecord = JsonObject & { id: string };
interface StartMessage {
  scope?: StartScope;
  type?: unknown;
}
interface StartScope {
  streams?: StartStream[];
}
interface StartStream {
  name?: unknown;
}

function emit(msg: JsonObject): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function isoDate(daysAgo: number, hoursAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(d.getHours() - hoursAgo);
  return d.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStartMessage(line: string): StartMessage {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    return {};
  }
  const { scope, type } = parsed;
  if (!isRecord(scope)) {
    return { type };
  }
  const { streams } = scope;
  return {
    ...(Array.isArray(streams)
      ? { scope: { streams: streams.filter(isRecord).map((stream) => ({ name: stream.name })) } }
      : {}),
    type,
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstRecord<T>(records: readonly T[], label: string): T {
  const [first] = records;
  if (first === undefined) {
    throw new Error(`Seed fixture is unexpectedly empty: ${label}`);
  }
  return first;
}

// ─── Spotify seed data ────────────────────────────────────────────────────────

const SPOTIFY_ARTISTS = [
  {
    followers: 7_800_000,
    genres: ["alternative rock", "art rock", "melancholia"],
    id: "spotify:artist:4Z8W4fKeB5YaZFgNFWDhN",
    name: "Radiohead",
    popularity: 82,
    source_updated_at: isoDate(10),
  },
  {
    followers: 2_100_000,
    genres: ["electronic", "ambient techno", "IDM"],
    id: "spotify:artist:0C0XlULifJtAgn6ZNCW2eu",
    name: "Aphex Twin",
    popularity: 71,
    source_updated_at: isoDate(8),
  },
  {
    followers: 22_000_000,
    genres: ["conscious hip hop", "rap", "west coast rap"],
    id: "spotify:artist:2YZyLoL8N0Wb9xBt1NhZWg",
    name: "Kendrick Lamar",
    popularity: 93,
    source_updated_at: isoDate(3),
  },
  {
    followers: 38_000_000,
    genres: ["canadian pop", "pop", "r&b"],
    id: "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ",
    name: "The Weeknd",
    popularity: 95,
    source_updated_at: isoDate(1),
  },
  {
    followers: 73_000_000,
    genres: ["canadian hip hop", "canadian pop", "rap"],
    id: "spotify:artist:3TVXtAsR1Inumwj472S9r4",
    name: "Drake",
    popularity: 96,
    source_updated_at: isoDate(2),
  },
  {
    followers: 12_000_000,
    genres: ["alternative metal", "alternative rock", "post-grunge"],
    id: "spotify:artist:7jy3rLJdDQY21OgRLCZ9sD",
    name: "Foo Fighters",
    popularity: 79,
    source_updated_at: isoDate(15),
  },
  {
    followers: 42_000_000,
    genres: ["british soul", "pop", "uk pop"],
    id: "spotify:artist:4dpARuHxo51G3z768sgnrY",
    name: "Adele",
    popularity: 88,
    source_updated_at: isoDate(5),
  },
  {
    followers: 98_000_000,
    genres: ["pop", "country pop"],
    id: "spotify:artist:0L8ExT028jH3ddEcZwqJJ5",
    name: "Taylor Swift",
    popularity: 100,
    source_updated_at: isoDate(0),
  },
];

const SPOTIFY_SAVED_TRACKS = [
  {
    album_name: "Pablo Honey",
    artist_names: ["Radiohead"],
    duration_ms: 238_000,
    id: "spotify:track:4cluDES4hQEUhmXj6TXkSo",
    name: "Creep",
    popularity: 86,
    saved_at: isoDate(90),
    source_created_at: isoDate(90),
  },
  {
    album_name: "OK Computer",
    artist_names: ["Radiohead"],
    duration_ms: 264_000,
    id: "spotify:track:3AhXZa8sUQht0UEdBJgpGc",
    name: "Karma Police",
    popularity: 78,
    saved_at: isoDate(85),
    source_created_at: isoDate(85),
  },
  {
    album_name: "After Hours",
    artist_names: ["The Weeknd"],
    duration_ms: 200_000,
    id: "spotify:track:2374M0fQpWi3dLnB54qaLX",
    name: "Blinding Lights",
    popularity: 95,
    saved_at: isoDate(60),
    source_created_at: isoDate(60),
  },
  {
    album_name: "A Night at the Opera",
    artist_names: ["Queen"],
    duration_ms: 354_000,
    id: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
    name: "Bohemian Rhapsody",
    popularity: 91,
    saved_at: isoDate(45),
    source_created_at: isoDate(45),
  },
  {
    album_name: "Scorpion",
    artist_names: ["Drake"],
    duration_ms: 198_000,
    id: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6",
    name: "God's Plan",
    popularity: 89,
    saved_at: isoDate(30),
    source_created_at: isoDate(30),
  },
  {
    album_name: "DAMN.",
    artist_names: ["Kendrick Lamar"],
    duration_ms: 177_000,
    id: "spotify:track:1dGr1c8CrMLDpV6mPbImSI",
    name: "HUMBLE.",
    popularity: 88,
    saved_at: isoDate(20),
    source_created_at: isoDate(20),
  },
  {
    album_name: "1989",
    artist_names: ["Taylor Swift"],
    duration_ms: 219_000,
    id: "spotify:track:7KXjTSCq5nL1LoYtL7XAwS",
    name: "Shake It Off",
    popularity: 87,
    saved_at: isoDate(10),
    source_created_at: isoDate(10),
  },
  {
    album_name: "21",
    artist_names: ["Adele"],
    duration_ms: 285_000,
    id: "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
    name: "Someone Like You",
    popularity: 82,
    saved_at: isoDate(5),
    source_created_at: isoDate(5),
  },
];

const SPOTIFY_RECENTLY_PLAYED = [
  {
    artist_names: ["Radiohead"],
    context_type: "album",
    duration_ms: 238_000,
    id: "play_1",
    played_at: isoDate(0, 1),
    track_id: "spotify:track:4cluDES4hQEUhmXj6TXkSo",
    track_name: "Creep",
  },
  {
    artist_names: ["The Weeknd"],
    context_type: "playlist",
    duration_ms: 200_000,
    id: "play_2",
    played_at: isoDate(0, 2),
    track_id: "spotify:track:2374M0fQpWi3dLnB54qaLX",
    track_name: "Blinding Lights",
  },
  {
    artist_names: ["Drake"],
    context_type: "radio",
    duration_ms: 198_000,
    id: "play_3",
    played_at: isoDate(0, 4),
    track_id: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6",
    track_name: "God's Plan",
  },
  {
    artist_names: ["Kendrick Lamar"],
    context_type: "album",
    duration_ms: 177_000,
    id: "play_4",
    played_at: isoDate(1),
    track_id: "spotify:track:1dGr1c8CrMLDpV6mPbImSI",
    track_name: "HUMBLE.",
  },
  {
    artist_names: ["Taylor Swift"],
    context_type: "playlist",
    duration_ms: 219_000,
    id: "play_5",
    played_at: isoDate(1, 3),
    track_id: "spotify:track:7KXjTSCq5nL1LoYtL7XAwS",
    track_name: "Shake It Off",
  },
];

// ─── GitHub seed data ─────────────────────────────────────────────────────────

const GITHUB_REPOS = [
  {
    description: "My personal website and blog",
    forks_count: 2,
    full_name: "seedowner/personal-site",
    id: "gh:repo:123456",
    is_fork: false,
    is_private: false,
    language: "TypeScript",
    name: "personal-site",
    source_created_at: isoDate(730),
    source_updated_at: isoDate(5),
    stargazers_count: 12,
    topics: ["blog", "nextjs", "tailwind"],
  },
  {
    description: "My development environment config",
    forks_count: 8,
    full_name: "seedowner/dotfiles",
    id: "gh:repo:234567",
    is_fork: false,
    is_private: false,
    language: "Shell",
    name: "dotfiles",
    source_created_at: isoDate(1095),
    source_updated_at: isoDate(2),
    stargazers_count: 45,
    topics: ["dotfiles", "zsh", "neovim"],
  },
  {
    description: "AoC solutions",
    forks_count: 0,
    full_name: "seedowner/advent-of-code",
    id: "gh:repo:345678",
    is_fork: false,
    is_private: false,
    language: "Python",
    name: "advent-of-code",
    source_created_at: isoDate(365),
    source_updated_at: isoDate(120),
    stargazers_count: 3,
    topics: ["advent-of-code", "python"],
  },
  {
    description: "ML experiments and notebooks",
    forks_count: 5,
    full_name: "seedowner/ml-experiments",
    id: "gh:repo:456789",
    is_fork: false,
    is_private: false,
    language: "Python",
    name: "ml-experiments",
    source_created_at: isoDate(500),
    source_updated_at: isoDate(30),
    stargazers_count: 28,
    topics: ["machine-learning", "pytorch", "transformers"],
  },
  {
    description: "Work project",
    forks_count: 0,
    full_name: "seedowner/private-project",
    id: "gh:repo:567890",
    is_fork: false,
    is_private: true,
    language: "Go",
    name: "private-project",
    source_created_at: isoDate(200),
    source_updated_at: isoDate(1),
    stargazers_count: 0,
    topics: [],
  },
];

const GITHUB_STARRED = [
  {
    description: "The official Claude Code CLI",
    full_name: "anthropics/claude-code",
    id: "gh:starred:111",
    language: "TypeScript",
    stargazers_count: 15_000,
    starred_at: isoDate(30),
  },
  {
    description: "Vim-fork focused on extensibility and usability",
    full_name: "neovim/neovim",
    id: "gh:starred:222",
    language: "Vim Script",
    stargazers_count: 78_000,
    starred_at: isoDate(60),
  },
  {
    description: "Awesome lists about all kinds of interesting topics",
    full_name: "sindresorhus/awesome",
    id: "gh:starred:333",
    language: null,
    stargazers_count: 320_000,
    starred_at: isoDate(90),
  },
  {
    description: "The easiest way to automate building and releasing your iOS and Android apps",
    full_name: "fastlane/fastlane",
    id: "gh:starred:444",
    language: "Ruby",
    stargazers_count: 38_000,
    starred_at: isoDate(180),
  },
];

// ─── Reddit seed data ─────────────────────────────────────────────────────────

const REDDIT_POSTS = [
  {
    id: "reddit:post:abc123",
    is_self: true,
    num_comments: 145,
    score: 892,
    selftext:
      "After 30 days of work, I finally have a working prototype of a personal data portability protocol. It uses OAuth 2.0 with Rich Authorization Requests (RFC 9396) and a flat relational stream model inspired by Airbyte...",
    source_created_at: isoDate(14),
    subreddit: "programming",
    title: "I built a personal data portability protocol in 30 days",
    upvote_ratio: 0.97,
    url: "https://reddit.com/r/programming/comments/abc123",
  },
  {
    id: "reddit:post:def456",
    is_self: false,
    num_comments: 287,
    score: 2341,
    selftext: "",
    source_created_at: isoDate(30),
    subreddit: "netsec",
    title: "TIL that most OAuth implementations get token revocation completely wrong",
    upvote_ratio: 0.95,
    url: "https://example.com/oauth-revocation",
  },
  {
    id: "reddit:post:ghi789",
    is_self: true,
    num_comments: 89,
    score: 445,
    selftext: "I've been thinking about this a lot. So much of our data is locked into platforms...",
    source_created_at: isoDate(45),
    subreddit: "selfhosted",
    title: "Ask HN-style: What data do you wish you could access from the platforms you use?",
    upvote_ratio: 0.91,
    url: "https://reddit.com/r/selfhosted/comments/ghi789",
  },
  {
    id: "reddit:post:jkl012",
    is_self: true,
    num_comments: 203,
    score: 1230,
    selftext: "Started with a Raspberry Pi, now running a full Proxmox cluster...",
    source_created_at: isoDate(60),
    subreddit: "homelab",
    title: "My homelab setup: 3 years of iteration",
    upvote_ratio: 0.98,
    url: "https://reddit.com/r/homelab/comments/jkl012",
  },
];

const REDDIT_COMMENTS = [
  {
    body: "This is really interesting. I've been wanting something like this for a while. Have you considered using RFC 7662 for token introspection?",
    id: "reddit:comment:c111",
    post_id: "reddit:post:abc123",
    post_title: "I built a personal data portability protocol in 30 days",
    score: 234,
    source_created_at: isoDate(14),
    subreddit: "programming",
  },
  {
    body: 'The fundamental problem is that most developers think "deleting the token" is the same as revocation. It\'s not. The server needs to actively check validity.',
    id: "reddit:comment:c222",
    post_id: "reddit:post:def456",
    post_title: "TIL that most OAuth implementations get token revocation completely wrong",
    score: 456,
    source_created_at: isoDate(30),
    subreddit: "netsec",
  },
  {
    body: "My Spotify listening history. I've been using it for 10 years and I have no way to export it in a useful format.",
    id: "reddit:comment:c333",
    post_id: "reddit:post:ghi789",
    post_title: "Ask HN-style: What data do you wish you could access?",
    score: 89,
    source_created_at: isoDate(45),
    subreddit: "selfhosted",
  },
  {
    body: "How are you handling backups for the Proxmox cluster? This is always my biggest concern.",
    id: "reddit:comment:c444",
    post_id: "reddit:post:jkl012",
    post_title: "My homelab setup: 3 years of iteration",
    score: 123,
    source_created_at: isoDate(60),
    subreddit: "homelab",
  },
  {
    body: "The flat relational stream model is smart. Nested objects are a nightmare for incremental sync.",
    id: "reddit:comment:c555",
    post_id: "reddit:post:abc123",
    post_title: "I built a personal data portability protocol in 30 days",
    score: 178,
    source_created_at: isoDate(13),
    subreddit: "programming",
  },
];

const REDDIT_SAVED = [
  {
    id: "reddit:saved:s1",
    kind: "post",
    source_created_at: isoDate(200),
    subreddit: "programming",
    title: "The Architecture of Open Source Applications",
    url: "https://aosabook.org",
  },
  {
    id: "reddit:saved:s2",
    kind: "comment",
    source_created_at: isoDate(150),
    subreddit: "compsci",
    title: "Excellent explanation of distributed systems consensus",
    url: null,
  },
  {
    id: "reddit:saved:s3",
    kind: "post",
    source_created_at: isoDate(90),
    subreddit: "learnprogramming",
    title: "Ask HN: What are good resources for learning systems programming?",
    url: null,
  },
];

// ─── Protocol ─────────────────────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((resolve, reject) => {
    rl.once("line", (line) => {
      try {
        resolve(parseStartMessage(line));
      } catch (e) {
        reject(e);
      }
    });
  });

  if (startMsg.type !== "START") {
    emit({
      error: { message: "Expected START", retryable: false },
      records_emitted: 0,
      status: "failed",
      type: "DONE",
    });
    process.exit(1);
  }

  const requestedStreams = new Set(
    (startMsg.scope?.streams ?? []).flatMap((stream) => (typeof stream.name === "string" ? [stream.name] : []))
  );
  if (!requestedStreams.size) {
    emit({
      error: { message: "START.scope.streams is required", retryable: false },
      records_emitted: 0,
      status: "failed",
      type: "DONE",
    });
    process.exit(1);
  }

  const wants = (...streamNames: string[]): boolean =>
    streamNames.some((streamName) => requestedStreams.has(streamName));
  const emittedAt = new Date().toISOString();

  let totalEmitted = 0;

  function emitRecord(stream: string, record: SeedRecord): void {
    emit({
      data: record,
      emitted_at: emittedAt,
      key: record.id,
      stream,
      type: "RECORD",
    });
    totalEmitted += 1;
  }

  // Spotify
  if (wants("top_artists", "saved_tracks", "recently_played")) {
    emit({ message: `Emitting ${SPOTIFY_ARTISTS.length} artists`, stream: "top_artists", type: "PROGRESS" });
    for (const artist of SPOTIFY_ARTISTS) {
      emitRecord("top_artists", artist);
    }
    emit({
      cursor: { last_updated: firstRecord(SPOTIFY_ARTISTS, "top_artists").source_updated_at },
      stream: "top_artists",
      type: "STATE",
    });

    emit({ message: `Emitting ${SPOTIFY_SAVED_TRACKS.length} tracks`, stream: "saved_tracks", type: "PROGRESS" });
    for (const track of SPOTIFY_SAVED_TRACKS) {
      emitRecord("saved_tracks", track);
    }
    emit({
      cursor: { last_saved_at: firstRecord(SPOTIFY_SAVED_TRACKS, "saved_tracks").saved_at },
      stream: "saved_tracks",
      type: "STATE",
    });

    emit({ message: `Emitting ${SPOTIFY_RECENTLY_PLAYED.length} plays`, stream: "recently_played", type: "PROGRESS" });
    for (const play of SPOTIFY_RECENTLY_PLAYED) {
      emitRecord("recently_played", play);
    }
  }

  // GitHub
  if (wants("repositories", "starred")) {
    emit({ message: `Emitting ${GITHUB_REPOS.length} repos`, stream: "repositories", type: "PROGRESS" });
    for (const repo of GITHUB_REPOS) {
      emitRecord("repositories", repo);
    }
    emit({
      cursor: { last_updated: firstRecord(GITHUB_REPOS, "repositories").source_updated_at },
      stream: "repositories",
      type: "STATE",
    });

    emit({ message: `Emitting ${GITHUB_STARRED.length} starred repos`, stream: "starred", type: "PROGRESS" });
    for (const star of GITHUB_STARRED) {
      emitRecord("starred", star);
    }
  }

  // Reddit
  if (wants("posts", "comments", "saved")) {
    emit({ message: `Emitting ${REDDIT_POSTS.length} posts`, stream: "posts", type: "PROGRESS" });
    for (const post of REDDIT_POSTS) {
      emitRecord("posts", post);
    }
    emit({ cursor: { after: firstRecord(REDDIT_POSTS, "posts").id }, stream: "posts", type: "STATE" });

    emit({ message: `Emitting ${REDDIT_COMMENTS.length} comments`, stream: "comments", type: "PROGRESS" });
    for (const comment of REDDIT_COMMENTS) {
      emitRecord("comments", comment);
    }
    emit({ cursor: { after: firstRecord(REDDIT_COMMENTS, "comments").id }, stream: "comments", type: "STATE" });

    emit({ message: `Emitting ${REDDIT_SAVED.length} saved items`, stream: "saved", type: "PROGRESS" });
    for (const saved of REDDIT_SAVED) {
      emitRecord("saved", saved);
    }
  }

  emit({ records_emitted: totalEmitted, status: "succeeded", type: "DONE" });
  process.exit(0);
}

main().catch((error: unknown) => {
  emit({
    error: { message: messageFromError(error), retryable: false },
    records_emitted: 0,
    status: "failed",
    type: "DONE",
  });
  process.exit(1);
});

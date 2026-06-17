import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { streamJsArchive, stripAssignmentPrefix } from "./archive-stream.ts";

const FIXTURE_DIR = new URL("./__fixtures__/archive-files/", import.meta.url);
const TWEETS_FIXTURE = new URL("data/tweets.js", FIXTURE_DIR);
const DM_FIXTURE = new URL("data/direct-messages.js", FIXTURE_DIR);
const LEGACY_FIXTURE = new URL("legacy/data/tweet.js", FIXTURE_DIR);
const EMPTY_FIXTURE = new URL("empty/data/tweets.js", FIXTURE_DIR);

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "twitter_archive", "index.ts");

function fixturePath(url: URL): string {
  return url.pathname;
}

async function collect(path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const entry of streamJsArchive(path)) {
    out.push(entry);
  }
  return out;
}

/**
 * Oracle: the previous whole-file implementation. Strip the assignment prefix
 * and trailing semicolon, then JSON.parse the whole array at once. The
 * streaming reader must emit exactly these entries in order.
 */
function wholeFileParse(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const stripped = text
    .replace(/^[^=]*=\s*/, "")
    .trim()
    .replace(/;?\s*$/, "");
  return JSON.parse(stripped) as unknown[];
}

// ─── stripAssignmentPrefix ──────────────────────────────────────────────

test("stripAssignmentPrefix: returns from the array opener onward", () => {
  assert.equal(stripAssignmentPrefix("window.YTD.tweets.part0 = [1,2]"), "[1,2]");
});

test("stripAssignmentPrefix: null until an opener appears (chunk still buffering)", () => {
  assert.equal(stripAssignmentPrefix("window.YTD.tweets.part0 = "), null);
});

// ─── streaming equivalence vs. the old whole-file parser ────────────────

test("streamJsArchive: tweets stream matches whole-file parse exactly", async () => {
  const streamed = await collect(fixturePath(TWEETS_FIXTURE));
  const oracle = wholeFileParse(fixturePath(TWEETS_FIXTURE));
  assert.deepEqual(streamed, oracle);
});

test("streamJsArchive: DM stream matches whole-file parse exactly", async () => {
  const streamed = await collect(fixturePath(DM_FIXTURE));
  const oracle = wholeFileParse(fixturePath(DM_FIXTURE));
  assert.deepEqual(streamed, oracle);
});

test("streamJsArchive: preserves escaped quotes, backslashes, newlines, brackets, unicode", async () => {
  const streamed = (await collect(fixturePath(TWEETS_FIXTURE))) as { tweet: { full_text: string } }[];
  const escaped = streamed[1]?.tweet.full_text ?? "";
  assert.match(escaped, /Escaped "quotes"/);
  assert.match(escaped, /a backslash \\/);
  assert.match(escaped, /\n/);
  assert.match(escaped, /closing-bracket \]/);
  const accented = streamed[2]?.tweet.full_text ?? "";
  assert.match(accented, /café résumé naïve/);
  assert.match(accented, /\{not real json\}/);
});

test("streamJsArchive: chunk boundaries do not corrupt elements (tiny reads, deep equality)", async () => {
  // Re-serialize the fixture into a temp file and stream it; deep-equal against
  // the whole-file parse. createReadStream chunks at highWaterMark, so multi-KB
  // bodies already exercise cross-chunk strings/objects.
  const dir = mkdtempSync(join(tmpdir(), "tw-chunk-"));
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    tweet: {
      id_str: String(i),
      full_text: `tweet ${i} with "quotes" \\ and unicode ☃ é and a ] bracket and {brace}`,
      created_at: "Wed Jun 05 13:45:22 +0000 2024",
      entities: { media: [], urls: [] },
    },
  }));
  const file = join(dir, "tweets.js");
  writeFileSync(file, `window.YTD.tweets.part0 = ${JSON.stringify(entries)};\n`);
  const streamed = await collect(file);
  assert.equal(streamed.length, 3000);
  assert.deepEqual(streamed, entries);
});

// ─── filename fallback + empty + missing + malformed ────────────────────

test("streamJsArchive: legacy flat tweet.js parses", async () => {
  const streamed = (await collect(fixturePath(LEGACY_FIXTURE))) as { id_str: string }[];
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0]?.id_str, "9999");
});

test("streamJsArchive: empty array yields zero entries without throwing", async () => {
  const streamed = await collect(fixturePath(EMPTY_FIXTURE));
  assert.deepEqual(streamed, []);
});

test("streamJsArchive: absent file yields zero entries", async () => {
  const streamed = await collect(join(tmpdir(), "definitely-missing-twitter-archive.js"));
  assert.deepEqual(streamed, []);
});

test("streamJsArchive: present-but-malformed body throws (caller reports archive_not_found)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-bad-"));
  const file = join(dir, "tweets.js");
  writeFileSync(file, "window.YTD.tweets.part0 = { not an array }");
  await assert.rejects(() => collect(file));
});

test("streamJsArchive: truncated array throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-trunc-"));
  const file = join(dir, "tweets.js");
  writeFileSync(file, 'window.YTD.tweets.part0 = [ {"a":1}, {');
  await assert.rejects(() => collect(file));
});

// ─── end-to-end protocol via subprocess harness ─────────────────────────

function recordsFor(messages: EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD" && m.stream === stream)
    .map((m) => m.data as Record<string, unknown>);
}

test("twitter_archive end-to-end: streams tweet + DM records and STATE cursors", async () => {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { TWITTER_ARCHIVE_DIR: fixturePath(FIXTURE_DIR) },
    start: {
      type: "START",
      scope: { streams: [{ name: "tweets" }, { name: "direct_messages" }] },
      state: {},
    },
  });

  const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
  assert.equal(done?.status, "succeeded", result.stderr);

  const tweets = recordsFor(result.messages, "tweets");
  // 4 entries in the fixture; the no-created_at one is skipped by the builder.
  assert.equal(tweets.length, 3);
  assert.deepEqual(
    tweets.map((t) => t.id),
    ["1001", "1002", "1003"]
  );
  assert.equal(tweets[0]?.media_count, 1);
  assert.equal(tweets[0]?.url_count, 2);
  assert.match(String(tweets[1]?.text), /Escaped "quotes"/);
  assert.equal(tweets[2]?.in_reply_to_screen_name, "alice");

  const dms = recordsFor(result.messages, "direct_messages");
  // 2 conversations, 4 messages, 1 missing createdAt → 3 emitted.
  assert.equal(dms.length, 3);
  assert.deepEqual(
    dms.map((d) => d.id),
    ["m1", "m2", "m4"]
  );
  assert.equal(dms[0]?.conversation_id, "111-222");
  assert.equal(dms[2]?.conversation_id, "333-444");

  const states = result.messages.filter((m) => m.type === "STATE");
  assert.ok(
    states.some((m) => (m as Extract<EmittedMessage, { type: "STATE" }>).stream === "tweets"),
    "expected a STATE cursor for tweets"
  );
  assert.ok(
    states.some((m) => (m as Extract<EmittedMessage, { type: "STATE" }>).stream === "direct_messages"),
    "expected a STATE cursor for direct_messages"
  );
});

test("twitter_archive end-to-end: incremental cursor skips already-emitted tweets", async () => {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { TWITTER_ARCHIVE_DIR: fixturePath(FIXTURE_DIR) },
    start: {
      type: "START",
      scope: { streams: [{ name: "tweets" }] },
      // cursor at the first tweet's created_at → only later tweets emit.
      state: { tweets: { last_created_at: "2024-06-05T13:45:22.000Z" } },
    },
  });

  const tweets = recordsFor(result.messages, "tweets");
  assert.deepEqual(
    tweets.map((t) => t.id),
    ["1002", "1003"]
  );
});

test("twitter_archive end-to-end: missing archive dir reports SKIP_RESULT, not failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-empty-dir-"));
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { TWITTER_ARCHIVE_DIR: dir },
    start: {
      type: "START",
      scope: { streams: [{ name: "tweets" }, { name: "direct_messages" }] },
      state: {},
    },
  });

  const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
  assert.equal(done?.status, "succeeded", result.stderr);
  const skips = result.messages.filter((m) => m.type === "SKIP_RESULT");
  assert.equal(skips.length, 2);
});

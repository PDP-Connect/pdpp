// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPromptRecord,
  buildRolloutOnlySessionRecord,
  buildRuleRecord,
  buildSkillRecord,
  buildThreadSessionRecord,
  epochToIso,
  extendTimestampRange,
  extractMessageText,
  isRolloutFile,
  isSkippableRulesLine,
  parseFrontmatter,
  payloadOutputPreview,
  splitRulesLines,
  type TimestampRange,
  textPreview,
} from "./parsers.ts";
import type { RolloutAggregate, ThreadRow } from "./types.ts";

// ─── textPreview ─────────────────────────────────────────────────────────

test("textPreview: non-string → null", () => {
  assert.equal(textPreview(null), null);
  assert.equal(textPreview(42), null);
});

test("textPreview: short string passthrough", () => {
  assert.equal(textPreview("hi", 10), "hi");
});

test("textPreview: long string → truncated with ellipsis", () => {
  assert.equal(textPreview("x".repeat(100), 5), `${"x".repeat(5)}…`);
});

// ─── extractMessageText ──────────────────────────────────────────────────

test("extractMessageText: no content → null", () => {
  assert.equal(extractMessageText({}), null);
});

test("extractMessageText: joins text parts with newlines, skipping empties", () => {
  const got = extractMessageText({
    content: [{ text: "hello" }, {}, { text: "world" }],
  });
  assert.equal(got, "hello\nworld");
});

test("extractMessageText: all-empty content → null", () => {
  assert.equal(extractMessageText({ content: [{}, {}] }), null);
});

// Regression: the exact on-disk shape of a Codex developer-role `message`
// item whose single `input_text` part carries an EMPTY-STRING `text`. This is
// the dominant shape in live rollouts (≈99% of developer messages observed in
// a 1.4 GB rollout were `input_text` parts with `text: ""`), and it is the
// reason live `messages` records for developer turns are retained with
// `content: null`. Empty source text → null is FAITHFUL, not a defect: the
// part exists but has no user-visible text, so there is nothing to preview.
// Pin both directions so a future refactor of extractMessageText cannot start
// emitting "" (record churn) or crash on the empty-text part.
test("extractMessageText: developer input_text part with empty text → null (live shape)", () => {
  assert.equal(
    extractMessageText({
      role: "developer",
      type: "message",
      content: [{ type: "input_text", text: "" }],
    }),
    null
  );
});

test("extractMessageText: developer input_text part with real text → joined string", () => {
  assert.equal(
    extractMessageText({
      role: "developer",
      type: "message",
      content: [{ type: "input_text", text: "do the thing" }],
    }),
    "do the thing"
  );
});

// ─── payloadOutputPreview ────────────────────────────────────────────────

test("payloadOutputPreview: string output passes through under cap", () => {
  const result = payloadOutputPreview("short");
  assert.deepEqual(result, { preview: "short", binaryReason: null });
});

test("payloadOutputPreview: object output is JSON-stringified", () => {
  const result = payloadOutputPreview({ a: 1 });
  assert.deepEqual(result, { preview: '{"a":1}', binaryReason: null });
});

// ─── epochToIso ──────────────────────────────────────────────────────────

test("epochToIso: positive epoch seconds → ISO string", () => {
  assert.equal(epochToIso(0), null); // > 0 required
  assert.equal(epochToIso(1), "1970-01-01T00:00:01.000Z");
});

test("epochToIso: null/NaN/non-number → null", () => {
  assert.equal(epochToIso(null), null);
  assert.equal(epochToIso(undefined), null);
  assert.equal(epochToIso(Number.NaN), null);
});

// ─── parseFrontmatter ────────────────────────────────────────────────────

test("parseFrontmatter: no fence → empty meta", () => {
  const got = parseFrontmatter("no fence");
  assert.deepEqual(got.meta, {});
  assert.equal(got.body, "no fence");
});

test("parseFrontmatter: simple key/value", () => {
  const text = "---\nname: foo\ndescription: bar\n---\nbody";
  const got = parseFrontmatter(text);
  assert.equal(got.meta.name, "foo");
  assert.equal(got.meta.description, "bar");
  assert.equal(got.body, "body");
});

test("parseFrontmatter: strips surrounding double and single quotes", () => {
  const text = "---\nname: \"foo\"\ntitle: 'bar'\n---\n";
  const got = parseFrontmatter(text);
  assert.equal(got.meta.name, "foo");
  assert.equal(got.meta.title, "bar");
});

test("parseFrontmatter: skips malformed lines", () => {
  const text = "---\nbadline\nname: foo\n---\n";
  assert.equal(parseFrontmatter(text).meta.name, "foo");
});

// ─── isRolloutFile / isSkippableRulesLine ────────────────────────────────

test("isRolloutFile: accepts rollout-*.jsonl", () => {
  assert.equal(isRolloutFile("rollout-2026-04-22.jsonl"), true);
});

test("isRolloutFile: rejects non-matches", () => {
  assert.equal(isRolloutFile("rollout.jsonl"), false);
  assert.equal(isRolloutFile("rollout-x.txt"), false);
  assert.equal(isRolloutFile("README.md"), false);
});

test("isSkippableRulesLine: blank and comment lines are skipped", () => {
  assert.equal(isSkippableRulesLine(""), true);
  assert.equal(isSkippableRulesLine("# comment"), true);
  assert.equal(isSkippableRulesLine("rule text"), false);
});

test("splitRulesLines: splits on CRLF and LF", () => {
  assert.deepEqual(splitRulesLines("a\nb\r\nc"), ["a", "b", "c"]);
});

// ─── buildThreadSessionRecord ────────────────────────────────────────────

function makeThreadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: "sess-1",
    rollout_path: "/rollouts/foo.jsonl",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_010,
    source: "cli",
    model_provider: "openai",
    cwd: "/repo",
    title: "my session",
    sandbox_policy: "workspace_write",
    approval_mode: "always",
    tokens_used: 42,
    has_user_event: 1,
    archived: 0,
    archived_at: null,
    git_sha: "abc",
    git_branch: "main",
    git_origin_url: "https://example.com/r.git",
    cli_version: "1.0.0",
    first_user_message: "hello",
    agent_nickname: null,
    agent_role: null,
    memory_mode: null,
    model: "gpt-5",
    reasoning_effort: "high",
    ...overrides,
  };
}

test("buildThreadSessionRecord: prefers state_5 fields, merges agg counts", () => {
  const agg: RolloutAggregate = {
    meta: { timestamp: "2026-04-22T00:00:00Z" },
    firstTs: "2026-04-22T00:00:00Z",
    lastTs: "2026-04-22T01:00:00Z",
    messageCount: 3,
    functionCallCount: 1,
    rolloutPath: "/rollouts/foo.jsonl",
  };
  const r = buildThreadSessionRecord("sess-1", makeThreadRow(), agg);
  assert.equal(r.id, "sess-1");
  assert.equal(r.cwd, "/repo");
  assert.equal(r.title, "my session");
  assert.equal(r.message_count, 3);
  assert.equal(r.function_call_count, 1);
  assert.equal(r.archived, false);
});

test("buildThreadSessionRecord: archived=true when row.archived=1", () => {
  const r = buildThreadSessionRecord("s", makeThreadRow({ archived: 1 }), undefined);
  assert.equal(r.archived, true);
});

test("buildThreadSessionRecord: falls back started_at to agg.firstTs", () => {
  const agg: RolloutAggregate = {
    meta: {},
    firstTs: "2026-01-01T00:00:00Z",
    lastTs: null,
    messageCount: 0,
    functionCallCount: 0,
    rolloutPath: "/p",
  };
  const r = buildThreadSessionRecord("s", makeThreadRow({ created_at: null, updated_at: null }), agg);
  assert.equal(r.started_at, "2026-01-01T00:00:00Z");
});

// ─── buildRolloutOnlySessionRecord ───────────────────────────────────────

test("buildRolloutOnlySessionRecord: maps meta fields, state_5-only fields null", () => {
  const agg: RolloutAggregate = {
    meta: {
      cwd: "/repo",
      originator: "cli",
      cli_version: "1.0.0",
      model_provider: "openai",
      git: { commit_hash: "abc", branch: "main", repository_url: "u" },
      timestamp: "2026-04-22T00:00:00Z",
    },
    firstTs: "2026-04-22T00:00:00Z",
    lastTs: "2026-04-22T01:00:00Z",
    messageCount: 5,
    functionCallCount: 2,
    rolloutPath: "/rollouts/foo.jsonl",
  };
  const r = buildRolloutOnlySessionRecord("s1", agg);
  assert.equal(r.cwd, "/repo");
  assert.equal(r.git_commit, "abc");
  assert.equal(r.git_branch, "main");
  assert.equal(r.repository_url, "u");
  assert.equal(r.started_at, "2026-04-22T00:00:00Z");
  assert.equal(r.message_count, 5);
  assert.equal(r.title, null);
  assert.equal(r.archived, null);
  assert.equal(r.rollout_path, "/rollouts/foo.jsonl");
});

// ─── buildRuleRecord / buildPromptRecord / buildSkillRecord ─────────────

test("buildRuleRecord: produces rules:<set>:<idx> id", () => {
  const r = buildRuleRecord({
    ruleset: "default",
    line: "some rule",
    index: 3,
    path: "/a/default.rules",
    mtime: 99,
  });
  assert.equal(r.id, "rules:default:3");
  assert.equal(r.rule_index, 3);
  assert.equal(r.mtime_epoch, 99);
  assert.equal(r.rule_text, "some rule");
});

test("buildPromptRecord: uses frontmatter name when present", () => {
  const r = buildPromptRecord({
    fileName: "hello.md",
    meta: { name: "Hi", description: "wave" },
    body: "body",
    path: "/p.md",
    mtimeMs: 2000,
  });
  assert.equal(r.id, "prompts:hello.md");
  assert.equal(r.name, "Hi");
  assert.equal(r.description, "wave");
  assert.equal(r.mtime_epoch, 2);
});

test("buildPromptRecord: falls back to basename without .md", () => {
  const r = buildPromptRecord({
    fileName: "hello.md",
    meta: {},
    body: "body",
    path: "/p.md",
    mtimeMs: 0,
  });
  assert.equal(r.name, "hello");
  assert.equal(r.description, null);
});

test("buildSkillRecord: uses dir name fallback, mtime in seconds", () => {
  const r = buildSkillRecord({
    dirName: "my-skill",
    meta: { description: "d" },
    body: "body",
    path: "/p/SKILL.md",
    mtimeMs: 5000,
  });
  assert.equal(r.id, "skills:my-skill");
  assert.equal(r.name, "my-skill");
  assert.equal(r.description, "d");
  assert.equal(r.mtime_epoch, 5);
});

// ─── extendTimestampRange ────────────────────────────────────────────────

test("extendTimestampRange: first update sets both bounds", () => {
  const r: TimestampRange = { firstTs: null, lastTs: null };
  extendTimestampRange(r, "2026-04-22T00:00:00Z");
  assert.equal(r.firstTs, "2026-04-22T00:00:00Z");
  assert.equal(r.lastTs, "2026-04-22T00:00:00Z");
});

test("extendTimestampRange: widens range for earlier and later ts", () => {
  const r: TimestampRange = { firstTs: "2026-04-22T12:00:00Z", lastTs: "2026-04-22T12:00:00Z" };
  extendTimestampRange(r, "2026-04-22T06:00:00Z");
  extendTimestampRange(r, "2026-04-22T18:00:00Z");
  assert.equal(r.firstTs, "2026-04-22T06:00:00Z");
  assert.equal(r.lastTs, "2026-04-22T18:00:00Z");
});

test("extendTimestampRange: null ts no-op", () => {
  const r: TimestampRange = { firstTs: "2026-04-22T12:00:00Z", lastTs: "2026-04-22T12:00:00Z" };
  extendTimestampRange(r, null);
  assert.equal(r.firstTs, "2026-04-22T12:00:00Z");
  assert.equal(r.lastTs, "2026-04-22T12:00:00Z");
});

// ─── Binary content tests ────────────────────────────────────────────────

test("payloadOutputPreview: binary content with U+0000 returns null preview with reason", () => {
  const result = payloadOutputPreview("ELF\x00");
  assert(result.preview === null);
  assert(result.binaryReason !== null);
  assert(result.binaryReason.includes("U+0000"));
});

test("textPreview: string with U+0000 returns null", () => {
  const result = textPreview("hello\x00world");
  assert.equal(result, null);
});

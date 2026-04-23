import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProjectDirScope,
  buildSkillRecord,
  buildSlashCommandRecord,
  extractContent,
  makeEmptySessionAccumulator,
  mergeSessionObservations,
  parseCsvEnv,
  parseFrontmatter,
  SKILL_BODY_MAX_CHARS,
  textPreview,
  truncateBody,
  widenSessionTimeRange,
} from "./parsers.ts";
import type { SessionAccumulator } from "./types.ts";

// ─── textPreview / truncateBody ──────────────────────────────────────────

test("textPreview: non-string → null", () => {
  assert.equal(textPreview(null), null);
  assert.equal(textPreview(42), null);
});

test("textPreview: short string passes through", () => {
  assert.equal(textPreview("hi"), "hi");
});

test("textPreview: too-long string is truncated with ellipsis", () => {
  const got = textPreview("x".repeat(500), 10);
  assert.equal(got, `${"x".repeat(10)}…`);
});

test("truncateBody: caps long strings, leaves short ones", () => {
  assert.equal(truncateBody("abc"), "abc");
  const big = "x".repeat(SKILL_BODY_MAX_CHARS + 10);
  assert.equal(truncateBody(big).length, SKILL_BODY_MAX_CHARS);
});

// ─── extractContent ─────────────────────────────────────────────────────

test("extractContent: null/undefined → null", () => {
  assert.equal(extractContent(null), null);
  assert.equal(extractContent(undefined), null);
});

test("extractContent: string passthrough", () => {
  assert.equal(extractContent("hello"), "hello");
});

test("extractContent: array of text parts joined with newlines", () => {
  const got = extractContent([
    { type: "text", text: "A" },
    { type: "text", text: "B" },
  ]);
  assert.equal(got, "A\nB");
});

test("extractContent: tool_use / tool_result placeholders", () => {
  const got = extractContent([{ type: "tool_use", name: "bash" }, { type: "tool_result" }]);
  assert.equal(got, "[tool_use: bash]\n[tool_result]");
});

test("extractContent: tool_use with no name labels 'unknown'", () => {
  assert.equal(extractContent([{ type: "tool_use" }]), "[tool_use: unknown]");
});

test("extractContent: plain string array element", () => {
  assert.equal(extractContent(["A", "B"]), "A\nB");
});

test("extractContent: array of only skippable items → null", () => {
  assert.equal(extractContent([{}]), null);
});

test("extractContent: object with nested content recurses", () => {
  const got = extractContent({ content: [{ type: "text", text: "hi" }] });
  assert.equal(got, "hi");
});

test("extractContent: object with text string", () => {
  assert.equal(extractContent({ text: "hi" }), "hi");
});

// ─── parseFrontmatter ────────────────────────────────────────────────────

test("parseFrontmatter: no fence → empty frontmatter, body=text", () => {
  const got = parseFrontmatter("no fence here");
  assert.deepEqual(got.frontmatter, {});
  assert.equal(got.body, "no fence here");
});

test("parseFrontmatter: simple key/value pairs", () => {
  const text = "---\nname: foo\ndescription: bar\n---\nbody here";
  const got = parseFrontmatter(text);
  assert.equal(got.frontmatter.name, "foo");
  assert.equal(got.frontmatter.description, "bar");
  assert.equal(got.body, "body here");
});

test("parseFrontmatter: strips surrounding double quotes", () => {
  const text = '---\nname: "foo bar"\n---\n';
  assert.equal(parseFrontmatter(text).frontmatter.name, "foo bar");
});

test("parseFrontmatter: strips surrounding single quotes", () => {
  const text = "---\nname: 'foo bar'\n---\n";
  assert.equal(parseFrontmatter(text).frontmatter.name, "foo bar");
});

test("parseFrontmatter: comments skipped", () => {
  const text = "---\n# a comment\nname: foo\n---\n";
  assert.equal(parseFrontmatter(text).frontmatter.name, "foo");
});

test("parseFrontmatter: folded block scalar (>) collapses whitespace", () => {
  const text = "---\ndescription: >\n  line one\n  line two\n---\nbody";
  const got = parseFrontmatter(text);
  assert.equal(got.frontmatter.description, "line one line two");
  assert.equal(got.body, "body");
});

test("parseFrontmatter: literal block scalar (|) keeps newlines", () => {
  const text = "---\ncontent: |\n  line one\n  line two\n---\n";
  assert.equal(parseFrontmatter(text).frontmatter.content, "line one\nline two");
});

test("parseFrontmatter: skips malformed key/value lines", () => {
  const text = "---\nbad line\nname: foo\n---\n";
  assert.equal(parseFrontmatter(text).frontmatter.name, "foo");
});

// ─── makeEmptySessionAccumulator / mergeSessionObservations / widenSessionTimeRange ─

test("makeEmptySessionAccumulator: nulls + zero count", () => {
  const acc = makeEmptySessionAccumulator("s1", "proj/a");
  assert.equal(acc.id, "s1");
  assert.equal(acc.project_path, "proj/a");
  assert.equal(acc.cwd, null);
  assert.equal(acc.message_count, 0);
});

test("mergeSessionObservations: only non-null fields replace", () => {
  const acc: SessionAccumulator = makeEmptySessionAccumulator("s1", "p");
  mergeSessionObservations(acc, {
    cwd: "/home",
    gitBranch: "main",
    userType: null,
    entrypoint: null,
    version: null,
  });
  assert.equal(acc.cwd, "/home");
  assert.equal(acc.git_branch, "main");
  assert.equal(acc.user_type, null);
});

test("widenSessionTimeRange: picks min started, max last", () => {
  const acc: SessionAccumulator = makeEmptySessionAccumulator("s1", "p");
  widenSessionTimeRange(acc, "2026-02-01", "2026-02-10");
  widenSessionTimeRange(acc, "2026-01-01", "2026-03-10");
  assert.equal(acc.started_at, "2026-01-01");
  assert.equal(acc.last_event_at, "2026-03-10");
});

test("widenSessionTimeRange: nulls no-op", () => {
  const acc: SessionAccumulator = makeEmptySessionAccumulator("s1", "p");
  widenSessionTimeRange(acc, null, null);
  assert.equal(acc.started_at, null);
  assert.equal(acc.last_event_at, null);
});

// ─── buildSkillRecord / buildSlashCommandRecord ──────────────────────────

test("buildSkillRecord: frontmatter name beats directory name", () => {
  const r = buildSkillRecord({
    name: "dir-name",
    frontmatter: { name: "fm-name", description: "d" },
    body: "body",
    path: "/p/SKILL.md",
    mtimeMs: 5000,
  });
  assert.equal(r.id, "skills:dir-name");
  assert.equal(r.name, "fm-name");
  assert.equal(r.description, "d");
  assert.equal(r.source, "user");
  assert.equal(r.mtime_epoch, 5);
});

test("buildSkillRecord: falls back to dir name when frontmatter lacks name", () => {
  const r = buildSkillRecord({
    name: "dir-name",
    frontmatter: {},
    body: "body",
    path: "/p/SKILL.md",
    mtimeMs: 0,
  });
  assert.equal(r.name, "dir-name");
  assert.equal(r.description, null);
});

test("buildSlashCommandRecord: nested idPath + fallback base", () => {
  const r = buildSlashCommandRecord({
    idPath: "nested/cmd",
    base: "cmd",
    frontmatter: {},
    body: "body",
    path: "/p/cmd.md",
    mtimeMs: 1000,
  });
  assert.equal(r.id, "commands:nested/cmd");
  assert.equal(r.name, "cmd");
  assert.equal(r.mtime_epoch, 1);
});

// ─── applyProjectDirScope / parseCsvEnv ──────────────────────────────────

test("applyProjectDirScope: include narrows by substring match", () => {
  const got = applyProjectDirScope(["a-pdpp", "b-vana", "c-other"], ["pdpp", "vana"], []);
  assert.deepEqual(got, ["a-pdpp", "b-vana"]);
});

test("applyProjectDirScope: exclude removes by substring match", () => {
  const got = applyProjectDirScope(["a-pdpp", "b-vana", "c-other"], [], ["vana"]);
  assert.deepEqual(got, ["a-pdpp", "c-other"]);
});

test("applyProjectDirScope: include+exclude both apply", () => {
  const got = applyProjectDirScope(["alpha", "beta", "alpha-beta"], ["alpha"], ["beta"]);
  assert.deepEqual(got, ["alpha"]);
});

test("applyProjectDirScope: empty filters → passthrough", () => {
  const got = applyProjectDirScope(["a", "b"], [], []);
  assert.deepEqual(got, ["a", "b"]);
});

test("parseCsvEnv: trims and drops empties", () => {
  assert.deepEqual(parseCsvEnv("a, b , , c"), ["a", "b", "c"]);
});

test("parseCsvEnv: undefined → []", () => {
  assert.deepEqual(parseCsvEnv(undefined), []);
});

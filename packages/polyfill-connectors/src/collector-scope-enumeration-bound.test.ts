// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Does a scoped run actually do BOUNDED WORK, or does it walk the whole corpus
// and filter the output?
//
// That distinction is the whole point of the scope contract, and it is NOT
// visible in the emitted records: a full-corpus scan whose out-of-range records
// are dropped at the emission gate produces the same record set as a genuinely
// bounded run. So it has to be proven some other way.
//
// Two complementary proofs, deliberately cheap:
//
//  1. DISCOVERY PRUNES — call each connector's own source-discovery seam and
//     assert the scoped result excludes out-of-scope paths. This is the direct
//     statement of the property, asserted before any file is opened.
//
//  2. THE RUNTIME DOES NOT BYPASS DISCOVERY — a real child process runs against
//     a corpus containing an EXCLUDED sentinel file, and the run's own protocol
//     output is searched for that file's path. A connector records every file it
//     scanned in its STATE cursor, so the path appearing there is direct
//     evidence the file was opened and read. Discovery pruning alone cannot
//     establish this, because a second code path might still open the file.
//     The sentinel is also malformed, so a parse attempt would additionally
//     surface as a complaint.
//
// Together these pin the behaviour without custom loader hooks or syscall
// interception, which would be disproportionate machinery for the claim.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverClaudeJsonlSources } from "../connectors/claude_code/index.ts";
import { walkRollouts } from "../connectors/codex/index.ts";

const CONNECTORS_DIR = join(import.meta.dirname, "..", "connectors");

/**
 * Malformed content for the excluded file. A connector that reads it records
 * the file in its STATE cursor (and may complain about the content), so either
 * signal betrays a read that the boundary should have prevented.
 */
const POISONED_SENTINEL = '{"broken json PDPP_SENTINEL_MUST_NOT_BE_READ\n';

/** The excluded file's path fragment — what a scanned-file cursor would name. */
const CLAUDE_SENTINEL_PATH = join("-home-u-code-excluded", "session.jsonl");
const CODEX_SENTINEL_PATH = join("2020", "01", "05");

const noopEmit = (): Promise<void> => Promise.resolve();

/**
 * Two Claude projects. The excluded one holds a poisoned sentinel so ANY code
 * path that opens it surfaces loudly instead of failing silently.
 */
async function seedClaudeHome(): Promise<{ claudeHome: string; projectsDir: string }> {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-home-"));
  const projectsDir = join(claudeHome, "projects");
  await mkdir(join(projectsDir, "-home-u-code-included"), { recursive: true });
  await mkdir(join(projectsDir, "-home-u-code-excluded"), { recursive: true });
  await writeFile(
    join(projectsDir, "-home-u-code-included", "session.jsonl"),
    `${JSON.stringify({
      cwd: "/home/u/code/included",
      message: { content: [{ text: "hello", type: "text" }], role: "user" },
      sessionId: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "user",
      uuid: "aaaaaaaa-1111-4111-8111-111111111111",
    })}\n`,
    "utf8"
  );
  await writeFile(join(projectsDir, "-home-u-code-excluded", "session.jsonl"), POISONED_SENTINEL, "utf8");
  return { claudeHome, projectsDir };
}

/** Codex rollouts in two calendar years; the out-of-range year is poisoned. */
async function seedCodexHome(): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-home-"));
  const oldDir = join(codexHome, "sessions", "2020", "01", "05");
  const newDir = join(codexHome, "sessions", "2026", "07", "01");
  await mkdir(oldDir, { recursive: true });
  await mkdir(newDir, { recursive: true });
  await writeFile(join(oldDir, "rollout-2020-01-05T00-00-00-sess2020.jsonl"), POISONED_SENTINEL, "utf8");
  await writeFile(
    join(newDir, "rollout-2026-07-01T00-00-00-sess2026.jsonl"),
    `${JSON.stringify({
      payload: { cwd: "/home/u/p", id: "33333333-3333-4333-8333-333333333333", timestamp: "2026-07-01T00:00:00.000Z" },
      type: "session_meta",
    })}\n`,
    "utf8"
  );
  return codexHome;
}

/** Drive a connector child over the real protocol and return everything it said. */
function runConnectorChild(input: {
  connector: "claude_code" | "codex";
  env: Record<string, string>;
  scope?: { since?: string; source_roots?: string[] };
  streams: readonly string[];
}): Promise<string> {
  const streamScope = input.streams.map((name) => ({
    name,
    ...(input.scope?.since ? { time_range: { since: input.scope.since } } : {}),
    ...(input.scope?.source_roots ? { source_roots: input.scope.source_roots } : {}),
  }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(CONNECTORS_DIR, input.connector, "index.ts")], {
      env: {
        ...process.env,
        PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        ...input.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("connector child timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    // stderr is folded in so a crash-on-sentinel is caught alongside the
    // protocol-level parse complaints that surface on stdout.
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.end(`${JSON.stringify({ scope: { streams: streamScope }, type: "START" })}\n`);
  });
}

test("claude_code discovery prunes out-of-root projects before any file is opened", async () => {
  const { projectsDir } = await seedClaudeHome();

  const unbounded = await discoverClaudeJsonlSources(projectsDir, noopEmit);
  assert.ok(
    unbounded?.some((source) => source.path.includes("-home-u-code-excluded")),
    "baseline: an unscoped discovery does return the source the bounded one must prune"
  );

  const bounded = await discoverClaudeJsonlSources(projectsDir, noopEmit, { source_roots: ["/home/u/code/included"] });
  assert.ok(
    bounded?.some((source) => source.path.includes("-home-u-code-included")),
    "the selected root must still be discovered"
  );
  assert.equal(
    bounded?.some((source) => source.path.includes("-home-u-code-excluded")),
    false,
    "an out-of-root project must never reach the scan stage — pruning is the bound on work"
  );
});

test("codex discovery prunes a whole out-of-range calendar year before listing it", async () => {
  const codexHome = await seedCodexHome();
  const sessionsDir = join(codexHome, "sessions");

  const unbounded: string[] = [];
  for await (const entry of walkRollouts(sessionsDir)) {
    unbounded.push(entry.path);
  }
  assert.ok(
    unbounded.some((path) => path.includes(join("sessions", "2020"))),
    "baseline: an unscoped walk does yield the 2020 rollout"
  );

  const bounded: string[] = [];
  for await (const entry of walkRollouts(sessionsDir, { since: "2026-01-01T00:00:00.000Z" })) {
    bounded.push(entry.path);
  }
  assert.equal(
    bounded.some((path) => path.includes(join("sessions", "2020"))),
    false,
    "a calendar year entirely before the boundary must be pruned, not walked and filtered"
  );
  assert.ok(
    bounded.some((path) => path.includes(join("sessions", "2026"))),
    "the in-range year must still be walked"
  );
});

test("claude_code: a real scoped run never reads the excluded project's poisoned file", async () => {
  const { claudeHome, projectsDir } = await seedClaudeHome();
  const env = { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir };

  // Counterweight to the discovery assertion above: proves no OTHER code path
  // opens the excluded file behind discovery's back.
  const unbounded = await runConnectorChild({ connector: "claude_code", env, streams: ["sessions", "messages"] });
  assert.ok(
    unbounded.includes(CLAUDE_SENTINEL_PATH),
    "baseline: an unscoped run DOES scan the excluded file and records it in its cursor"
  );

  const bounded = await runConnectorChild({
    connector: "claude_code",
    env,
    scope: { source_roots: ["/home/u/code/included"] },
    streams: ["sessions", "messages"],
  });
  assert.equal(
    bounded.includes(CLAUDE_SENTINEL_PATH),
    false,
    "the excluded file must appear in NO cursor or diagnostic — it was never opened"
  );
});

test("codex: a real scoped run never enumerates the pruned year", async () => {
  const codexHome = await seedCodexHome();
  const env = { CODEX_HOME: codexHome };

  // Codex reports how many rollout items its walk actually took into account.
  // That count is the enumeration itself, so it distinguishes a pruned walk
  // from a full walk whose output was filtered — the exact confusion this test
  // exists to rule out.
  const unbounded = await runConnectorChild({ connector: "codex", env, streams: ["sessions", "messages"] });
  assert.match(
    unbounded,
    /total_items=2\b/,
    "baseline: an unscoped walk enumerates BOTH rollouts, including the 2020 one"
  );

  const bounded = await runConnectorChild({
    connector: "codex",
    env,
    scope: { since: "2026-01-01T00:00:00.000Z" },
    streams: ["sessions", "messages"],
  });
  assert.match(
    bounded,
    /total_items=1\b/,
    "a whole calendar year before the boundary must be pruned from the walk, not walked and filtered"
  );
  assert.equal(
    bounded.includes(CODEX_SENTINEL_PATH),
    false,
    "the pruned year's rollout must never be opened by any code path"
  );
});

// A declared root that selects NOTHING is almost always a mistyped or
// wrongly-formatted path. Reporting it as a clean bounded pass would commit
// coverage over an empty result set — the fabricated watermark in its purest
// form, reached through the path an owner is most likely to take.
test("claude_code: a root matching zero projects surfaces an actionable skip, not a silent empty pass", async () => {
  const { claudeHome, projectsDir } = await seedClaudeHome();
  const out = await runConnectorChild({
    connector: "claude_code",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir },
    scope: { source_roots: ["/nope/this/matches/nothing"] },
    streams: ["sessions", "messages"],
  });
  assert.ok(out.includes("scope_matched_no_sources"), "a zero-match scope must be reported, never silently accepted");
  assert.ok(
    out.includes("SKIP_RESULT"),
    "it must be a SKIP_RESULT so the stream cannot reach a proven-complete verdict"
  );
});

// The natural form an owner actually types must work end to end, through the
// real connector, not just in the matcher unit test.
test("claude_code: a natural absolute owner path collects the project it names", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-natural-"));
  const projectsDir = join(claudeHome, "projects");
  await mkdir(join(projectsDir, "-home-u-code-real"), { recursive: true });
  await writeFile(
    join(projectsDir, "-home-u-code-real", "s.jsonl"),
    `${JSON.stringify({
      cwd: "/home/u/code/real",
      message: { content: [{ text: "hello", type: "text" }], role: "user" },
      sessionId: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "user",
      uuid: "aaaaaaaa-1111-4111-8111-111111111111",
    })}\n`,
    "utf8"
  );
  const out = await runConnectorChild({
    connector: "claude_code",
    env: { CLAUDE_CODE_HOME: claudeHome, CLAUDE_CODE_PROJECTS_DIR: projectsDir },
    scope: { source_roots: ["/home/u/code/real"] },
    streams: ["sessions", "messages"],
  });
  assert.equal(out.includes("scope_matched_no_sources"), false, "the natural path must match, not read as a typo");
  assert.ok(out.includes('"type":"RECORD"'), "the named project must actually be collected");
});

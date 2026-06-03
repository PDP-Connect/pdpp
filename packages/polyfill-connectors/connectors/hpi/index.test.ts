import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAPPINGS, resolveMappings } from "./index.ts";
import { validateRecord } from "./schemas.ts";

test("DEFAULT_MAPPINGS covers reddit_saved, reddit_comments, commits", () => {
  const streams = DEFAULT_MAPPINGS.map((m) => m.stream);
  assert.deepEqual(streams, ["reddit_saved", "reddit_comments", "commits"]);
  for (const m of DEFAULT_MAPPINGS) {
    assert.ok(m.hpiFunction.startsWith("my."));
  }
});

test("resolveMappings: returns defaults when HPI_STREAMS unset", () => {
  delete process.env.HPI_STREAMS;
  assert.deepEqual(resolveMappings(), DEFAULT_MAPPINGS);
});

test("resolveMappings: honors a valid HPI_STREAMS override", () => {
  process.env.HPI_STREAMS = JSON.stringify([
    { stream: "browser_history", hpiFunction: "my.browser.history", orderKey: "dt", orderType: "datetime" },
  ]);
  try {
    const m = resolveMappings();
    assert.equal(m.length, 1);
    assert.equal(m[0]?.stream, "browser_history");
    assert.equal(m[0]?.hpiFunction, "my.browser.history");
  } finally {
    delete process.env.HPI_STREAMS;
  }
});

test("resolveMappings: falls back to defaults on malformed override", () => {
  process.env.HPI_STREAMS = "{not json";
  try {
    assert.deepEqual(resolveMappings(), DEFAULT_MAPPINGS);
  } finally {
    delete process.env.HPI_STREAMS;
  }
});

test("validateRecord: accepts a well-shaped reddit_saved record (loose passthrough)", () => {
  const result = validateRecord("reddit_saved", {
    id: "t3_abc",
    subreddit: "rust",
    title: "TIL",
    created: "2026-05-01T00:00:00Z",
    extra_upstream_field: "kept",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("validateRecord: coerces numeric id to string", () => {
  const result = validateRecord("commits", { id: 12_345, sha: "deadbeef" });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("validateRecord: rejects a record with no id", () => {
  const result = validateRecord("reddit_saved", { subreddit: "rust" });
  assert.equal(result.ok, false);
});

// End-to-end: drive the connector entrypoint as the runtime would (START on
// stdin, JSONL on stdout) against a fake `hpi` that emits records for one
// configured module and errors for another (proving per-stream skip isolation).
test("connector e2e: emits records for configured module, skips a failing one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpi-conn-"));
  const fakeHpi = join(dir, "hpi");
  writeFileSync(
    fakeHpi,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      // args: query my.<fn> -o json --stream ...
      'const fn = args[1] || "";',
      'if (fn === "my.reddit.all.saved") {',
      '  process.stdout.write(JSON.stringify({ id: "t3_a", subreddit: "rust", created: "2026-05-01T00:00:00Z" }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ id: "t3_b", subreddit: "go", created: "2026-05-02T00:00:00Z" }) + "\\n");',
      "  process.exit(0);",
      "}",
      // Any other module: simulate "module not configured" -> non-zero exit.
      'process.stderr.write("ModuleNotFound: " + fn);',
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );
  chmodSync(fakeHpi, 0o755);

  const { spawn } = await import("node:child_process");
  const entry = join(import.meta.dirname, "index.ts");
  const proc = spawn(process.execPath, ["--import", "tsx/esm", entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HPI_BIN: fakeHpi,
      HPI_TIMEOUT_MS: "5000",
      // Only request reddit_saved (ok) and commits (will fail) to prove isolation.
    },
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += String(d)));
  const done = new Promise((resolve) => proc.on("close", resolve));
  proc.stdin.write(
    `${JSON.stringify({ type: "START", scope: { streams: [{ name: "reddit_saved" }, { name: "commits" }] } })}\n`
  );
  proc.stdin.end();
  await done;
  rmSync(dir, { recursive: true, force: true });

  const messages = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const records = messages.filter((m) => m.type === "RECORD");
  const skips = messages.filter((m) => m.type === "SKIP_RESULT");
  const done2 = messages.findLast((m) => m.type === "DONE");

  assert.equal(records.length, 2, `expected 2 records, got ${JSON.stringify(messages)}`);
  assert.deepEqual(records.map((r) => r.key).sort(), ["t3_a", "t3_b"]);
  assert.ok(
    skips.some((s) => s.stream === "commits" && s.reason === "hpi_query_failed"),
    "commits stream should skip with hpi_query_failed"
  );
  assert.ok(done2 && done2.status === "succeeded", "run completes succeeded despite per-stream skip");
});

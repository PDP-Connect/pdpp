import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExternalToolSpec,
  formatMissingToolError,
  parseToolRecords,
  resolveToolBin,
  runExternalTool,
} from "./external-tool-adapter.ts";

const FAKE_TOOL: ExternalToolSpec = {
  name: "faketool",
  binEnvVar: "FAKETOOL_BIN",
  defaultBin: "faketool-does-not-exist",
  installHint: "go install faketool",
  defaultTimeoutMs: 5000,
};

test("resolveToolBin: env override wins, else default", () => {
  assert.equal(resolveToolBin(FAKE_TOOL), "faketool-does-not-exist");
  process.env.FAKETOOL_BIN = "/custom/faketool";
  try {
    assert.equal(resolveToolBin(FAKE_TOOL), "/custom/faketool");
  } finally {
    delete process.env.FAKETOOL_BIN;
  }
});

test("formatMissingToolError names the binary, env var, and install hint", () => {
  const msg = formatMissingToolError(FAKE_TOOL, "faketool-does-not-exist");
  assert.ok(msg.includes("faketool-does-not-exist"));
  assert.ok(msg.includes("FAKETOOL_BIN"));
  assert.ok(msg.includes("go install faketool"));
});

test("runExternalTool: missing binary rejects with the install-hint error", async () => {
  await assert.rejects(
    () => runExternalTool(FAKE_TOOL, ["--version"]),
    (err) => err instanceof Error && err.message.includes("binary not found")
  );
});

test("runExternalTool: spawns node as a stand-in tool and captures stdout", async () => {
  // Use `node -e` as a deterministic stand-in for an external tool.
  const nodeTool: ExternalToolSpec = {
    name: "nodejs",
    binEnvVar: "NODE_TOOL_BIN",
    defaultBin: process.execPath,
    installHint: "n/a",
    defaultTimeoutMs: 5000,
  };
  const { stdout } = await runExternalTool(nodeTool, [
    "-e",
    'process.stdout.write(JSON.stringify([{id:"a"},{id:"b"}]))',
  ]);
  assert.equal(stdout, '[{"id":"a"},{"id":"b"}]');
});

test("runExternalTool: non-zero exit rejects with exit-code + stderr", async () => {
  const nodeTool: ExternalToolSpec = {
    name: "nodejs",
    binEnvVar: "NODE_TOOL_BIN",
    defaultBin: process.execPath,
    installHint: "n/a",
    defaultTimeoutMs: 5000,
  };
  await assert.rejects(
    () => runExternalTool(nodeTool, ["-e", 'process.stderr.write("boom"); process.exit(3)']),
    (err) => err instanceof Error && err.message.includes("nodejs_exit_3") && err.message.includes("boom")
  );
});

test("parseToolRecords: JSON array", () => {
  const recs = parseToolRecords('[{"id":"1"},{"id":"2"}]');
  assert.deepEqual(recs, [{ id: "1" }, { id: "2" }]);
});

test("parseToolRecords: JSONL stream with interleaved non-JSON log lines", () => {
  const recs = parseToolRecords('{"id":"1"}\n[info] fetching...\n{"id":"2"}\n');
  assert.deepEqual(recs, [{ id: "1" }, { id: "2" }]);
});

test("parseToolRecords: empty -> []", () => {
  assert.deepEqual(parseToolRecords("   "), []);
});

test("parseToolRecords: array of non-objects is filtered out", () => {
  assert.deepEqual(parseToolRecords('[1, "x", {"id":"ok"}]'), [{ id: "ok" }]);
});

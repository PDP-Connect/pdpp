import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

test("codex connector fails instead of succeeding when requested local sources are missing", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-missing-"));
  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: { streams: [{ name: "sessions" }, { name: "messages" }, { name: "rules" }] },
      type: "START",
    },
  });

  assert.notEqual(result.exitCode, 0);
  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");
  assert.match(done?.error?.message ?? "", /requested Codex local source path\(s\) are missing or unreadable/);
  assert.match(done?.error?.message ?? "", /CODEX_SESSIONS_DIR=/);
  assert.match(done?.error?.message ?? "", /CODEX_RULES_DIR=/);
});

test("codex emits coverage diagnostics for a missing source home before failing", async () => {
  // A host whose requested content sources are absent must still produce the
  // durable coverage signal: every known store classified `missing`, emitted
  // BEFORE the source-presence assert throws. Without this the run fails with
  // zero coverage evidence and the connection-health rollup is stuck at
  // `coverage_unknown` forever (the local run path writes no spine run).
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-missing-coverage-"));
  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: {
        streams: [{ name: "sessions" }, { name: "rules" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  // The run still fails honestly on the missing content sources.
  assert.notEqual(result.exitCode, 0);
  const done = result.messages.findLast((msg): msg is Extract<EmittedMessage, { type: "DONE" }> => msg.type === "DONE");
  assert.equal(done?.status, "failed");

  // …but coverage diagnostics were already emitted, classifying the absent
  // declared stores as `missing` rather than omitting the stream entirely.
  const coverage = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
      msg.type === "RECORD" && msg.stream === "coverage_diagnostics"
  );
  assert(coverage.length > 0, "expected coverage diagnostics to be emitted before the failure");
  assert(
    coverage.some((record) => record.data.status === "missing"),
    "expected at least one absent store to be reported as missing"
  );
});

test("codex inventory streams emit safe metadata and exclude auth payloads", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-inventory-"));
  await mkdir(join(codexHome, "cache"), { recursive: true });
  await writeFile(join(codexHome, "history.jsonl"), '{"prompt":"hello"}\n');
  await writeFile(join(codexHome, "session_index.jsonl"), '{"id":"session"}\n');
  await writeFile(join(codexHome, "cache", "response.json"), "cache payload");
  await writeFile(join(codexHome, "auth.json"), '{"api_key":"secret-token"}');

  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: {
        streams: [
          { name: "history" },
          { name: "session_index" },
          { name: "cache_inventory" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert(records.some((record) => record.stream === "history" && record.data.relative_path === "history.jsonl"));
  assert(
    records.some((record) => record.stream === "session_index" && record.data.relative_path === "session_index.jsonl")
  );
  assert(records.some((record) => record.stream === "cache_inventory" && record.data.relative_path === "cache"));
  assert(!records.some((record) => JSON.stringify(record).includes("secret-token")));
  assert(
    !records.some((record) => record.stream !== "coverage_diagnostics" && record.data.relative_path === "auth.json")
  );
  assert(
    records.some(
      (record) =>
        record.stream === "coverage_diagnostics" && record.data.store === "auth" && record.data.status === "excluded"
    )
  );
  const coverageState = result.messages.find(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
      msg.type === "STATE" && msg.stream === "coverage_diagnostics"
  );
  assert.equal(typeof (coverageState?.cursor as { fetched_at?: unknown } | undefined)?.fetched_at, "string");
  const stores = (coverageState?.cursor as { stores?: unknown } | undefined)?.stores;
  assert(Array.isArray(stores), "successful collection must emit the committed coverage snapshot");
  assert.equal(stores.length, 14);
  assert(!JSON.stringify(coverageState).includes("secret-token"));
  assert(!JSON.stringify(coverageState).includes("reason"));
});

test("codex memories and context_mode are diagnostics-only, not requestable streams", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-private-"));
  await mkdir(join(codexHome, "memories"), { recursive: true });
  await mkdir(join(codexHome, "context-mode"), { recursive: true });
  await writeFile(join(codexHome, "memories", "local.md"), "private memory");
  await writeFile(join(codexHome, "context-mode", "local.json"), '{"private":"secret-context-payload"}');

  const result = await runConnectorProcess({
    env: { CODEX_HOME: codexHome },
    start: {
      scope: { streams: [{ name: "memories" }, { name: "context_mode" }, { name: "coverage_diagnostics" }] },
      type: "START",
    },
  });

  assert.equal(result.exitCode, 0);
  const records = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD"
  );
  assert(!records.some((record) => record.stream === "memories" || record.stream === "context_mode"));
  assert(!records.some((record) => JSON.stringify(record).includes("private memory")));
  assert(!records.some((record) => JSON.stringify(record).includes("secret-context-payload")));
  for (const store of ["memories", "context_mode"]) {
    assert(
      records.some(
        (record) =>
          record.stream === "coverage_diagnostics" &&
          record.data.store === store &&
          record.data.stream === null &&
          record.data.status === "inventory_only"
      )
    );
  }
  assert(
    !result.messages.some(
      (msg) =>
        msg.type === "STATE" &&
        ["memories", "context_mode"].includes((msg as Extract<EmittedMessage, { type: "STATE" }>).stream)
    )
  );
});

test("codex manifest does not expose memories or context_mode as consentable streams", async () => {
  const manifestPath = join(import.meta.dirname, "../../manifests/codex.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { streams: Array<{ name: string }> };
  const streamNames = new Set(manifest.streams.map((stream) => stream.name));

  assert(!streamNames.has("memories"));
  assert(!streamNames.has("context_mode"));
});

async function runConnectorProcess(input: {
  env: NodeJS.ProcessEnv;
  start: unknown;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[]; stderr: string }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: input.env,
    start: input.start as {
      scope: {
        streams: Array<{ name: string; resources?: string[]; time_range?: { since?: string; until?: string } }>;
      };
      state?: Record<string, unknown>;
      type: "START";
    },
  });
  return { exitCode: result.code, messages: result.messages, stderr: result.stderr };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Coverage-diagnostics contract for the Google Takeout local collector.
 *
 * Local-device collectors write no spine run, so the connection-health
 * rollup derives coverage entirely from durable coverage_diagnostics
 * records (see collector-registry.test.ts's parallel invariant). This pins
 * that every known store (location_history, youtube_watch_history,
 * search_history, photos) reports an honest status against a synthetic
 * import directory.
 */

function records(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
}

function coverageFor(
  recs: Extract<EmittedMessage, { type: "RECORD" }>[],
  store: string
): Extract<EmittedMessage, { type: "RECORD" }> | undefined {
  return recs.find((r) => r.stream === "coverage_diagnostics" && r.data.store === store);
}

async function runFixtureConnector(
  importDir: string
): Promise<{ exitCode: number | null; messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/google_takeout/index.ts",
    env: { GOOGLE_TAKEOUT_DIR: importDir },
    start: {
      scope: {
        streams: [
          { name: "location_history" },
          { name: "youtube_watch_history" },
          { name: "search_history" },
          { name: "photos" },
          { name: "coverage_diagnostics" },
        ],
      },
      type: "START",
    },
  });
  return { exitCode: result.code, messages: result.messages };
}

test("google_takeout coverage diagnostics: fully-extracted export reports every store collected", async () => {
  const importDir = await mktempTakeoutDir();
  await mkdir(join(importDir, "Location History (Timeline)"), { recursive: true });
  await writeFile(join(importDir, "Location History (Timeline)", "Records.json"), JSON.stringify({ locations: [] }));
  await mkdir(join(importDir, "YouTube and YouTube Music", "history"), { recursive: true });
  await writeFile(join(importDir, "YouTube and YouTube Music", "history", "watch-history.json"), "[]");
  await mkdir(join(importDir, "My Activity", "Search"), { recursive: true });
  await writeFile(join(importDir, "My Activity", "Search", "MyActivity.json"), "[]");
  await mkdir(join(importDir, "Photos"), { recursive: true });

  const result = await runFixtureConnector(importDir);
  assert.equal(result.exitCode, 0);
  const recs = records(result.messages);

  for (const store of ["location_history", "youtube_watch_history", "search_history", "photos"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "collected", `${store} should be collected`);
  }

  const stateMessages = result.messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
      msg.type === "STATE" && msg.stream === "coverage_diagnostics"
  );
  assert.equal(stateMessages.length, 1, "coverage_diagnostics STATE must be emitted exactly once");
});

test("google_takeout coverage diagnostics: empty import directory reports every store missing, not a silent omission", async () => {
  const importDir = await mktempTakeoutDir();

  const result = await runFixtureConnector(importDir);
  assert.equal(result.exitCode, 0);
  const recs = records(result.messages);

  for (const store of ["location_history", "youtube_watch_history", "search_history", "photos"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "missing", `${store} should be missing`);
  }
});

async function mktempTakeoutDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pdpp-google-takeout-coverage-"));
}

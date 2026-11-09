// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorSnapshot } from "./app-directory.ts";
import { readConnectorSnapshot } from "./app-directory-sources.ts";

function snapshot(names: string[]): ConnectorSnapshot {
  return {
    connectors: names.map((name) => ({
      display_name: name,
      key: name.toLowerCase(),
      labels: [],
      source_path: `connectors/${name.toLowerCase()}`,
      tier: "supported" as const,
    })),
    generated_at: "2026-11-04T02:08:53.000Z",
    layer_digest: "sha256:layer",
    manifest_digest: "sha256:manifest",
    source: "ghcr.io/pdp-connect/connector-catalog",
    source_commit: "abc",
  };
}

const BUNDLED = snapshot(["Bundled"]);
const readBundled = () => Promise.resolve(BUNDLED);

test("the live catalogue wins when it loads", async () => {
  const live = snapshot(["Live"]);
  assert.deepEqual(await readConnectorSnapshot({ loadLive: () => Promise.resolve(live), readBundled }), live);
});

test("a failed live load falls back to the copy in the repo", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const result = await readConnectorSnapshot({
    loadLive: () => Promise.reject(new Error("registry down")),
    readBundled,
  });
  assert.equal(result, BUNDLED);
});

test("an empty or malformed live catalogue falls back too", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const results = await Promise.all(
    [snapshot([]), { connectors: "nope" }, null].map((bad) =>
      readConnectorSnapshot({ loadLive: () => Promise.resolve(bad), readBundled })
    )
  );
  for (const result of results) {
    assert.equal(result, BUNDLED);
  }
});

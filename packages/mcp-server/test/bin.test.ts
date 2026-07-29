// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../bin/pdpp-mcp-server.ts", import.meta.url));
const BIN_NAME = /pdpp-mcp-server/;
const MISSING_PROVIDER_URL = /Missing --provider-url/;
const REFUSING_TO_START = /Refusing to start/;

// The bin is TypeScript source pre-build; spawning it directly with plain
// `node` cannot execute a `.ts` entrypoint, so the child process needs the
// same `tsx` loader the test runner itself uses (`node --test --import tsx`).
function spawnBin(args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", binPath, ...args], { encoding: "utf8", ...options });
}

test("bin help writes to stderr, leaving stdout clean for the MCP protocol stream", () => {
  const result = spawnBin(["--help"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "", "stdout must remain empty so MCP framing is not corrupted");
  assert.match(result.stderr, BIN_NAME);
});

test("bin exits with usage code when provider URL is missing", () => {
  const result = spawnBin([], {
    env: { ...process.env, PDPP_PROVIDER_URL: "", PDPP_OWNER_TOKEN: "", PDPP_OWNER_SESSION_COOKIE: "" },
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, MISSING_PROVIDER_URL);
});

test("bin refuses to start when PDPP_OWNER_TOKEN is set in env", () => {
  const result = spawnBin(["--provider-url", "https://example.com"], {
    env: { ...process.env, PDPP_OWNER_TOKEN: "sekrit", PDPP_OWNER_SESSION_COOKIE: "" },
  });
  assert.equal(result.status, 77);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, REFUSING_TO_START);
});

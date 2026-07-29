// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { legacyAliasHint, __test as wrapperInternals } from "../cli/index.ts";

const execFile = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "cli/index.ts");
const CLI_PACKAGE_LINK_PATH = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "pdpp-reference-implementation",
  "cli/index.ts"
);

// ---- unit: legacy alias map -------------------------------------------------

test("legacyAliasHint maps each legacy operator alias to its canonical ref command", () => {
  assert.equal(legacyAliasHint("run", "timeline"), "pdpp ref run timeline");
  assert.equal(legacyAliasHint("grant", "timeline"), "pdpp ref grant timeline");
  assert.equal(legacyAliasHint("trace", "show"), "pdpp ref trace show");
  assert.equal(legacyAliasHint("run", "unrelated"), null);
  assert.equal(legacyAliasHint("connect", undefined), null);
});

test("wrapper delegates public CLI namespaces (including ref) to @pdpp/cli", () => {
  const delegated = wrapperInternals.PUBLIC_DELEGATED_COMMANDS;
  assert.ok(delegated.has("ref"), "ref must be delegated to @pdpp/cli");
  assert.ok(delegated.has("package-info"));
  assert.ok(delegated.has("connect"));
  assert.ok(delegated.has("token"));
});

// ---- integration: spawn the wrapper for help-only smoke ---------------------

test("pdpp --help mentions delegation to @pdpp/cli and ref namespace", async () => {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, "--help"]);
  assert.equal(stderr, "");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /Public commands delegated/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /@pdpp\/cli/);
  // The wrapper's own legacy aliases stay documented for now, but the canonical
  // surface is owned by @pdpp/cli.
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /pdpp run timeline/);
});

test("pdpp ref --help is served by the @pdpp/cli delegate and advertises login", async () => {
  const { stdout } = await execFile(process.execPath, [CLI_PATH, "ref", "--help"]);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref login/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref run timeline/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref grant timeline/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref trace show/);
});

test("workspace package entrypoint runs through the real CLI guard", async () => {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PACKAGE_LINK_PATH, "ref", "--help"]);
  assert.equal(stderr, "");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref login/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stdout, /ref run timeline/);
});

test('pdpp run timeline (legacy alias) emits a deprecation hint pointing at "pdpp ref run timeline"', async () => {
  // Missing --as-url ensures the command exits non-zero quickly without
  // requiring a live reference server.
  const result = await execFile(process.execPath, [CLI_PATH, "run", "timeline", "run-abc"]).catch((e) => e);

  const stderr = result.stderr || "";
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /deprecated/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /pdpp ref run timeline/);
});

test("pdpp grant timeline (legacy alias) emits a deprecation hint", async () => {
  const result = await execFile(process.execPath, [CLI_PATH, "grant", "timeline", "grant-x"]).catch((e) => e);

  const stderr = result.stderr || "";
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /deprecated/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /pdpp ref grant timeline/);
});

test("pdpp trace show (legacy alias) emits a deprecation hint", async () => {
  const result = await execFile(process.execPath, [CLI_PATH, "trace", "show", "trace-y"]).catch((e) => e);

  const stderr = result.stderr || "";
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /deprecated/);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(stderr, /pdpp ref trace show/);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the terminal-gap policy resolvers
// (server/stores/terminal-gap-classifier.js).
//
// `terminalGapProfileForConnector` resolves the connector's manifest-declared
// `capabilities.refresh_policy.max_recovery_attempts` (or null when absent /
// the manifest can't be resolved) by canonical connector-key prefix;
// `resolveTerminalGapPolicy` ALWAYS returns a real policy, falling back to the
// safe default so no connector can land on a path that silently skips
// terminalization (spec §10-A "impossible by construction"). The `?? DEFAULT`
// fallback is the load-bearing guard pinned below. Both resolvers do real I/O
// (a DB-backed manifest lookup), so these tests run against a temp SQLite DB.
//
// NOTE: the error classifiers (`classifyRecoveryError`, `isNonTransientError`,
// `isAuthFailure`) are intentionally out of scope — they are auth/forbidden
// classification code, and are proven to take no profile input at all (see
// terminal-gap-class.test.ts).

import { strict as assert } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  CHATGPT_PROVIDER_PROFILE,
  DEFAULT_TERMINAL_GAP_PROFILE,
  resolveTerminalGapPolicy,
  terminalGapProfileForConnector,
} from "../server/stores/terminal-gap-classifier.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

function loadRawManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

test(
  "terminalGapProfileForConnector returns the chatgpt manifest-declared profile for the bare key",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    assert.deepEqual(await terminalGapProfileForConnector("chatgpt"), CHATGPT_PROVIDER_PROFILE);
  })
);

test(
  "terminalGapProfileForConnector matches on the connector-key prefix",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    // Instance-scoped ids resolve to the base manifest.
    assert.deepEqual(await terminalGapProfileForConnector("chatgpt:default"), CHATGPT_PROVIDER_PROFILE);
    assert.deepEqual(await terminalGapProfileForConnector("chatgpt@v2"), CHATGPT_PROVIDER_PROFILE);
    assert.deepEqual(await terminalGapProfileForConnector("chatgpt:default@v2"), CHATGPT_PROVIDER_PROFILE);
  })
);

test(
  "terminalGapProfileForConnector returns null for unregistered / invalid ids",
  withTempDb(async () => {
    assert.equal(await terminalGapProfileForConnector("gmail"), null);
    assert.equal(await terminalGapProfileForConnector("chatgpt-lookalike"), null); // no ':'/'@' split → whole string
    assert.equal(await terminalGapProfileForConnector(""), null);
    // @ts-expect-error -- proving the runtime `typeof connectorId !== "string"` guard is real defense against untyped JS callers passing non-string values, not a type-level assertion this call site would ever legitimately make.
    assert.equal(await terminalGapProfileForConnector(null), null);
    // @ts-expect-error -- see above: proving runtime rejection of a non-string connectorId.
    assert.equal(await terminalGapProfileForConnector(42), null);
  })
);

test(
  "resolveTerminalGapPolicy returns the manifest-declared profile when registered",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    assert.deepEqual(await resolveTerminalGapPolicy("chatgpt"), CHATGPT_PROVIDER_PROFILE);
    assert.deepEqual(await resolveTerminalGapPolicy("chatgpt:default"), CHATGPT_PROVIDER_PROFILE);
    assert.equal(CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts, 3);
  })
);

test(
  "resolveTerminalGapPolicy falls back to the safe default for unregistered connectors",
  withTempDb(async () => {
    // This is the §10-A "impossible by construction" guard: NEVER null.
    assert.deepEqual(await resolveTerminalGapPolicy("gmail"), DEFAULT_TERMINAL_GAP_PROFILE);
    assert.deepEqual(await resolveTerminalGapPolicy("some-unaudited-connector"), DEFAULT_TERMINAL_GAP_PROFILE);
    assert.deepEqual(await resolveTerminalGapPolicy(""), DEFAULT_TERMINAL_GAP_PROFILE);
    // @ts-expect-error -- proving the §10-A "impossible by construction" fallback holds even for a non-string connectorId from an untyped JS caller.
    assert.deepEqual(await resolveTerminalGapPolicy(null), DEFAULT_TERMINAL_GAP_PROFILE);
    assert.equal(DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts, 5);
  })
);

test(
  "resolveTerminalGapPolicy always returns a real policy object (never null/undefined)",
  withTempDb(async () => {
    const ids: unknown[] = ["chatgpt", "gmail", "", null, undefined, "x:y@z"];
    for (const id of ids) {
      // @ts-expect-error -- proving the fallback holds for any runtime value an untyped JS caller might pass, not just `string`.
      // biome-ignore lint/performance/noAwaitInLoops: sequential id-by-id assertions over a small fixed list.
      const policy = await resolveTerminalGapPolicy(id);
      assert.ok(policy && typeof policy.maxRecoveryAttempts === "number", `policy for ${String(id)} must be real`);
    }
  })
);

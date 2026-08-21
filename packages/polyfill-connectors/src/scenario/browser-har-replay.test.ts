// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `resolveBrowserEvidence` — the recorded-browser driver's
 * pre-flight evidence gate (browser-har-replay.ts), called before any
 * browser or subprocess is spawned.
 *
 * Observable behavior under test: for a `recorded-browser` run, this
 * function must fail with ONE specific, named `BrowserReplayEvidenceError`
 * reason for each way the evidence envelope can be missing/unusable — NOT
 * degrade into the generic unmatched-request-abort cascade the module doc
 * comment describes (a HAR replayed into a cold context makes every
 * subsequent request miss the HAR for reasons that have nothing to do with
 * THIS specific missing field). The plausible defect each test guards
 * against: a future edit collapsing two of these distinct failure paths
 * into one generic message, which would turn a fast, precise diagnosis back
 * into exactly the confusing cascade this gate exists to prevent.
 *
 * Oracle: `resolveBrowserEvidence` itself, called directly (no subprocess,
 * no browser, no CLI) — this is a pure filesystem-and-shape check, so a
 * direct unit test is the smallest sufficient oracle per
 * docs/reference/testing-policy.md's "choose the smallest sufficient
 * oracle" table (pure rule/parser/projection -> deterministic direct test).
 * `writeBrowserHarReplayPreload` (the NODE_OPTIONS preload generator) is
 * NOT unit-tested here — its generated source only runs inside a spawned
 * subprocess with a real patchright browser, which is exactly the kind of
 * expensive, hard-to-isolate integration surface this package's OTHER
 * browser-driven connectors (src/browser-launch.test.ts) also do not
 * exercise with a real Chromium launch at this test tier; asserting that
 * the generated module STRING contains the expected patchright-patching/
 * routeFromHAR/setStorageState/clock-install shape would be a change-
 * detector on the template literal's exact text, not a test of observable
 * behavior — see this file's module doc for why the meaningful boundary
 * (evidence resolution) is what's covered instead.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserReplayEvidenceError, resolveBrowserEvidence } from "./browser-har-replay.ts";
import type { ScenarioRun } from "./format.ts";

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "browser-har-replay-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeHar(path: string, entryCount: number): void {
  writeFileSync(
    path,
    JSON.stringify({
      log: {
        entries: Array.from({ length: entryCount }, (_unused, i) => ({
          request: { method: "GET", url: `https://toy.example/${String(i)}` },
          response: { status: 200 },
        })),
      },
    })
  );
}

function writeStorageState(path: string): void {
  writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
}

function browserRun(overrides: {
  har_entry_count?: unknown;
  har_path?: unknown;
  storage_state_path?: unknown;
}): ScenarioRun {
  return {
    environment: {
      network: {
        driver: "recorded-browser",
        har_path: "run-0.har",
        storage_state_path: "run-0.storage-state.json",
        har_entry_count: 2,
        ...overrides,
      } as never,
    },
    start: { scope: { streams: [{ name: "widgets" }] }, state: null },
    interactions: [],
    expected: { records: {}, final_state: {} },
  };
}

function assertRejectsWithMessage(fn: () => void, expectedMessageFragment: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof BrowserReplayEvidenceError, `expected BrowserReplayEvidenceError, got ${String(err)}`);
    assert.match(err.message, expectedMessageFragment);
    return true;
  });
}

test("resolveBrowserEvidence: happy path — a well-formed HAR + storage-state pair resolves cleanly", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 2);
    writeStorageState(join(dir, "run-0.storage-state.json"));
    const evidence = resolveBrowserEvidence(dir, browserRun({}));
    assert.equal(evidence.harPath, join(dir, "run-0.har"));
    assert.equal(evidence.storageStatePath, join(dir, "run-0.storage-state.json"));
    assert.equal(evidence.harEntryCount, 2);
  });
});

test("resolveBrowserEvidence: rejects a run whose driver is not recorded-browser (defensive — bin/scenario-verify.ts only calls this after dispatching on the driver)", () => {
  withTmpDir((dir) => {
    const run: ScenarioRun = {
      environment: { network: { driver: "recorded-http" } },
      start: { scope: { streams: [] }, state: null },
      interactions: [],
      expected: { records: {}, final_state: {} },
    };
    assertRejectsWithMessage(() => resolveBrowserEvidence(dir, run), /driver === "recorded-browser"/);
  });
});

test("resolveBrowserEvidence: rejects a missing har_path with a named reason", () => {
  withTmpDir((dir) => {
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({ har_path: "" })),
      /requires run\.environment\.network\.har_path/
    );
  });
});

// This is THE most likely first failure per the coordinator's architecture
// review: a HAR without its paired session state. Its diagnosis must be
// exact, not folded into a generic "missing field" message — asserted here
// with the specific wording, distinct from the har_path case above.
test("resolveBrowserEvidence: rejects a missing storage_state_path with the EXACT named session-state reason (not a generic missing-field message)", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 2);
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({ storage_state_path: "" })),
      /browser replay requires the captured session state \(run\.environment\.network\.storage_state_path is missing or empty\)/
    );
  });
});

test("resolveBrowserEvidence: rejects a har_path that does not resolve to an existing file", () => {
  withTmpDir((dir) => {
    writeStorageState(join(dir, "run-0.storage-state.json"));
    assertRejectsWithMessage(() => resolveBrowserEvidence(dir, browserRun({})), /HAR file not found/);
  });
});

test("resolveBrowserEvidence: rejects a storage_state_path that does not resolve to an existing file, with the named session-state reason", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 2);
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({})),
      /requires the captured session state — storage_state_path .+ does not exist/
    );
  });
});

test("resolveBrowserEvidence: rejects a storage-state file that is not valid JSON", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 2);
    writeFileSync(join(dir, "run-0.storage-state.json"), "{not json");
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({})),
      /requires the captured session state — storage_state_path .+ is not valid JSON/
    );
  });
});

test("resolveBrowserEvidence: rejects a storage-state file that parses but is not an object (e.g. a JSON array)", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 2);
    writeFileSync(join(dir, "run-0.storage-state.json"), "[]");
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({})),
      /does not contain a storage-state object/
    );
  });
});

test("resolveBrowserEvidence: rejects a scenario declaring har_entry_count: 0 — vacuous, nothing to replay", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 0);
    writeStorageState(join(dir, "run-0.storage-state.json"));
    assertRejectsWithMessage(
      () => resolveBrowserEvidence(dir, browserRun({ har_entry_count: 0 })),
      /no recorded entries to replay/
    );
  });
});

test("resolveBrowserEvidence: paths are resolved relative to the scenario's own directory, not the process cwd", () => {
  withTmpDir((dir) => {
    const nested = join(dir, "nested");
    mkdirSync(nested);
    writeHar(join(nested, "run-0.har"), 1);
    writeStorageState(join(nested, "run-0.storage-state.json"));
    const evidence = resolveBrowserEvidence(nested, browserRun({}));
    assert.equal(evidence.harPath, join(nested, "run-0.har"));
  });
});

test("resolveBrowserEvidence: carries run.clock.fixed_now through unchanged when present (the clock-pin contract browser-har-replay.ts's preload reads)", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 1);
    writeStorageState(join(dir, "run-0.storage-state.json"));
    const run = { ...browserRun({}), clock: { fixed_now: "2026-01-01T00:00:00.000Z" } };
    const evidence = resolveBrowserEvidence(dir, run);
    assert.equal(evidence.fixedNowIso, "2026-01-01T00:00:00.000Z");
  });
});

test("resolveBrowserEvidence: fixedNowIso is undefined when the run carries no clock (legitimate — not every scenario pins a clock)", () => {
  withTmpDir((dir) => {
    writeHar(join(dir, "run-0.har"), 1);
    writeStorageState(join(dir, "run-0.storage-state.json"));
    const evidence = resolveBrowserEvidence(dir, browserRun({}));
    assert.equal(evidence.fixedNowIso, undefined);
  });
});

#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the @opendatalabs/remote-surface dependency-boundary check.
//
// The regression this check exists to catch: a pnpm-workspace.yaml
// `overrides` entry for this package forces BOTH apps/console and
// reference-implementation onto whichever resolution the override names,
// silently downgrading console off the registry-published range it
// declares. These fixtures exercise the lockfile shapes that must fail
// (global override present, console on the tarball, RI on the registry) and
// the shape that must pass (split resolution, no override), plus assert the
// live repository lockfile currently passes.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { findRemoteSurfaceOverlayBoundaryErrors } from "./check-remote-surface-overlay-boundary.ts";

const TARBALL_SPECIFIER =
  "file:../local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz";
const TARBALL_VERSION =
  "file:local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz";

// Real pnpm-lock.yaml files never start with `overrides:` at byte 0 — they
// are prefixed by `lockfileVersion:` and `settings:` blocks. A fixture that
// puts `overrides:` at string-start can make an unanchored-by-`m` `^overrides:`
// match "work" in tests while never matching the real file. Every fixture
// below carries this realistic prefix so a regression in the anchor is
// caught here, not just via the live-lockfile passing test.
const REALISTIC_LOCKFILE_PREFIX = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n";

function buildLockfile({
  hasGlobalOverride = false,
  consoleVersion = "1.5.1",
  riVersion = TARBALL_VERSION,
}: {
  hasGlobalOverride?: boolean;
  consoleVersion?: string;
  riVersion?: string;
} = {}): string {
  const overridesBlock = hasGlobalOverride
    ? `overrides:\n  '@pdpp/cli': workspace:*\n  '@opendatalabs/remote-surface': file:./local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz\n`
    : `overrides:\n  '@pdpp/cli': workspace:*\n`;

  return `${REALISTIC_LOCKFILE_PREFIX}${overridesBlock}
importers:

  .:
    devDependencies:
      typescript:
        specifier: ^7.0.2
        version: 7.0.2

  apps/console:
    dependencies:
      '@base-ui/react':
        specifier: ^1.6.0
        version: 1.6.0(react@19.2.8)
      '@opendatalabs/remote-surface':
        specifier: ^1.5.1
        version: ${consoleVersion}
      '@pdpp/brand':
        specifier: workspace:*
        version: link:../../packages/pdpp-brand

  reference-implementation:
    dependencies:
      pino:
        specifier: ^9.0.0
        version: 9.0.0
    optionalDependencies:
      '@opendatalabs/remote-surface':
        specifier: ${TARBALL_SPECIFIER}
        version: ${riVersion}

packages:

  '@opendatalabs/remote-surface@1.5.1':
    resolution: {integrity: sha512-fake==}
`;
}

test("dependency-boundary check passes when console resolves the registry and RI resolves the local tarball", () => {
  assert.deepEqual(findRemoteSurfaceOverlayBoundaryErrors(buildLockfile()), []);
});

test("dependency-boundary check fails when a workspace-wide overrides entry exists", () => {
  const problems = findRemoteSurfaceOverlayBoundaryErrors(buildLockfile({ hasGlobalOverride: true }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /workspace-wide overrides/);
});

test("dependency-boundary check fails when console resolves the vendored tarball instead of the registry", () => {
  const problems = findRemoteSurfaceOverlayBoundaryErrors(buildLockfile({ consoleVersion: TARBALL_VERSION }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /apps\/console must resolve .* from the registry/);
});

test("dependency-boundary check fails when reference-implementation resolves the registry instead of the vendored tarball", () => {
  const problems = findRemoteSurfaceOverlayBoundaryErrors(buildLockfile({ riVersion: "1.5.1" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /reference-implementation must resolve .* from the vendored local tarball/);
});

test("dependency-boundary check flags every regression at once when both importers are wrong under a global override", () => {
  const problems = findRemoteSurfaceOverlayBoundaryErrors(
    buildLockfile({ hasGlobalOverride: true, consoleVersion: TARBALL_VERSION, riVersion: TARBALL_VERSION })
  );
  assert.equal(problems.length, 2);
});

test("the live repository lockfile passes the dependency-boundary check", () => {
  const lockfileText = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.deepEqual(findRemoteSurfaceOverlayBoundaryErrors(lockfileText), []);
});

// Mutation test against the REAL lockfile text (not a synthetic fixture).
// Two compounding bugs previously defeated OVERRIDES_ENTRY_PATTERN:
//   1. No `m` flag, so `^overrides:` only matched string-start — the real
//      pnpm-lock.yaml always has `overrides:` preceded by
//      `lockfileVersion:`/`settings:` blocks, so it never matched at all.
//   2. Even after adding `m`, the non-greedy `[\s\S]*?` body terminated by
//      `\n\S|\n$|$` broke once `$` started matching end-of-LINE (a
//      consequence of the same `m` flag) — the capture stopped after the
//      FIRST override entry, silently dropping every subsequent line. A
//      regression appends `@opendatalabs/remote-surface` AFTER the existing
//      `@pdpp/cli`/`@pdpp/read-core` entries (exactly how `pnpm install`
//      would rewrite the block), which is the position this test uses, so it
//      would have been dropped by bug 2 alone even with bug 1 fixed.
// This test reintroduces the override at that realistic end-of-block
// position directly in the live lockfile's text and asserts it is caught,
// closing the false-negative class the synthetic (string-start,
// single-entry) fixtures above could not catch.
test("mutating the real lockfile to reintroduce a global override (appended after existing entries) is caught", () => {
  const lockfileText = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(
    lockfileText.split("\n")[0] ?? "",
    /^overrides:$/,
    "test fixture assumption violated: real pnpm-lock.yaml now starts with overrides: at byte 0, which would defeat this regression test's purpose"
  );

  const overridesBlockPattern = /^overrides:\n((?:[ \t].*\n?)*)/m;
  assert.match(
    lockfileText,
    overridesBlockPattern,
    "test fixture assumption violated: real pnpm-lock.yaml no longer has an overrides: block to mutate"
  );

  const mutated = lockfileText.replace(
    overridesBlockPattern,
    (_fullMatch, existingBlock: string) =>
      `overrides:\n${existingBlock}  '@opendatalabs/remote-surface': file:./local-artifacts/vendor/opendatalabs-remote-surface-0.3.1-rs-lease-cleanup-contract-0803.tgz\n`
  );
  assert.notEqual(mutated, lockfileText, "mutation did not apply — overrides: block not found in real lockfile");

  const problems = findRemoteSurfaceOverlayBoundaryErrors(mutated);
  assert.equal(
    problems.filter((problem) => /workspace-wide overrides/.test(problem)).length,
    1,
    `expected the reintroduced global override to be reported; got: ${JSON.stringify(problems)}`
  );
});

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

  return `${overridesBlock}
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

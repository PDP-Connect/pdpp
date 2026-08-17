// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAgentVersion,
  COLLECTOR_BUILD_INFO,
  COLLECTOR_BUILD_SOURCE_SENTINEL,
  type CollectorBuildInfo,
} from "./collector-build-info.ts";

/**
 * The committed source module is the dev/`tsx`/test identity. It must report the
 * `source` sentinel so a test run never masquerades as a published build, and so
 * the `agent_version` reported on heartbeats from an unbuilt run is honestly
 * `…+source` rather than a fabricated revision.
 */
test("the committed build info reports the source sentinel, never a fabricated revision", () => {
  assert.equal(COLLECTOR_BUILD_INFO.revision, "source");
  assert.equal(COLLECTOR_BUILD_INFO.revision, COLLECTOR_BUILD_SOURCE_SENTINEL);
  assert.equal(COLLECTOR_BUILD_INFO.builtAt, null);
  assert.equal(typeof COLLECTOR_BUILD_INFO.version, "string");
  assert.ok(COLLECTOR_BUILD_INFO.version.length > 0);
});

test("buildAgentVersion composes version+revision", () => {
  assert.equal(buildAgentVersion(COLLECTOR_BUILD_INFO), `${COLLECTOR_BUILD_INFO.version}+source`);

  const built: CollectorBuildInfo = {
    builtAt: "2026-06-05T00:00:00.000Z",
    revision: "43f63825f01a",
    version: "0.1.0-beta.3",
  };
  assert.equal(buildAgentVersion(built), "0.1.0-beta.3+43f63825f01a");
});

/**
 * The agent version is reported on the wire and surfaced to owners. It must be
 * redaction-safe by construction: a version, a single `+`, then a hex short-SHA
 * or the `source` sentinel — never a path, home directory, or secret token.
 */
test("the default agent version is redaction-safe and well-formed", () => {
  const value = buildAgentVersion();
  assert.match(value, /^[^+]+\+([0-9a-f]{7,40}|source)$/);
  assert.ok(!value.includes("/"), "must not carry a path separator");
  assert.ok(!value.includes("\\"), "must not carry a path separator");
  assert.ok(!value.toLowerCase().includes("token"), "must not carry a token");
  assert.equal(value.split("+").length, 2, "exactly one + delimiter");
});

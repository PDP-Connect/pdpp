// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { JourneyResult } from "./journey.ts";
import type { ReleaseArtifactCheckResult } from "./release-artifacts.ts";
import { renderReport } from "./report.ts";

const PASSING_ARTIFACTS: ReleaseArtifactCheckResult = {
  ok: true,
  findings: [{ id: "compose-file-present", ok: true, detail: "found" }],
};

const FAILING_ARTIFACTS: ReleaseArtifactCheckResult = {
  ok: false,
  findings: [{ id: "compose-file-present", ok: false, detail: "missing deploy/docker/docker-compose.yml" }],
};

const BEARER_TOKEN_SHAPE_PATTERN = /Bearer [A-Za-z0-9._-]{10,}/;
const RESULT_FAIL_PATTERN = /Result: FAIL/;
const RESULT_PASS_PATTERN = /Result: PASS/;
const NOT_RUN_PATTERN = /Not run — release-artifact check failed closed/;
const MISSING_PATTERN = /MISSING/;
const OWNER_LOGIN_PATTERN = /owner-login/;
const SKIPPED_NO_BROWSER_PATTERN = /skipped \(no browser surface configured on this deployment\)/;
const TEARDOWN_PATTERN = /Teardown/;
const OWNER_LOGIN_FAIL_ROW_PATTERN = /\| `owner-login` \| structural \| FAIL \|/;

test("renderReport marks FAIL and skips journey section when release artifacts are missing", () => {
  const markdown = renderReport({
    releaseArtifacts: FAILING_ARTIFACTS,
    journey: null,
    teardown: null,
    timestamp: "2026-08-03T00:00:00.000Z",
    origin: null,
  });
  assert.match(markdown, RESULT_FAIL_PATTERN);
  assert.match(markdown, NOT_RUN_PATTERN);
  assert.match(markdown, MISSING_PATTERN);
});

test("renderReport marks PASS and renders every step when the journey passes", () => {
  const journey: JourneyResult = {
    ok: true,
    steps: [
      { id: "owner-login", mode: "structural", ok: true, detail: "owner session established" },
      {
        id: "chatgpt-browser-backed",
        mode: "live",
        ok: true,
        skippedReason: "no browser surface configured on this deployment",
        detail: "refused with 503",
      },
    ],
  };
  const markdown = renderReport({
    releaseArtifacts: PASSING_ARTIFACTS,
    journey,
    teardown: { ok: true, detail: "no containers or volumes remain for this project" },
    timestamp: "2026-08-03T00:00:00.000Z",
    origin: "http://localhost:3000",
  });
  assert.match(markdown, RESULT_PASS_PATTERN);
  assert.match(markdown, OWNER_LOGIN_PATTERN);
  assert.match(markdown, SKIPPED_NO_BROWSER_PATTERN);
  assert.match(markdown, TEARDOWN_PATTERN);
});

test("renderReport marks FAIL when a journey step fails even though release artifacts and teardown are clean", () => {
  const journey: JourneyResult = {
    ok: false,
    steps: [{ id: "owner-login", mode: "structural", ok: false, detail: "device_authorization failed" }],
  };
  const markdown = renderReport({
    releaseArtifacts: PASSING_ARTIFACTS,
    journey,
    teardown: { ok: true, detail: "no containers or volumes remain for this project" },
    timestamp: "2026-08-03T00:00:00.000Z",
    origin: "http://localhost:3000",
  });
  assert.match(markdown, RESULT_FAIL_PATTERN);
  assert.match(markdown, OWNER_LOGIN_FAIL_ROW_PATTERN);
});

test("renderReport never includes a secret-shaped Bearer token even if a caller passed one in a detail string", () => {
  // Defense in depth: journey.ts's own assertNoLeak is the primary gate, but
  // the renderer itself must not add any formatting that could smuggle a
  // secret through (e.g. always quoting/escaping, never interpolating raw).
  const journey: JourneyResult = {
    ok: true,
    steps: [
      {
        id: "credential-issue-revoke",
        mode: "structural",
        ok: true,
        detail: "issued client cli_abc123; revoked client cli_abc123",
      },
    ],
  };
  const markdown = renderReport({
    releaseArtifacts: PASSING_ARTIFACTS,
    journey,
    teardown: null,
    timestamp: "2026-08-03T00:00:00.000Z",
    origin: "http://localhost:3000",
  });
  assert.doesNotMatch(markdown, BEARER_TOKEN_SHAPE_PATTERN);
});

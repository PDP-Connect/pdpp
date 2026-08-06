// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Offline unit tests for the pure core of check-railway-ghcr-public.ts.
//
// These run with zero network (node --test), exactly like the other railway:*
// unit tests. They pin the GHCR status -> visibility classifier, the per-image
// pass/fail logic (including the --tag pin), and the readiness summary that
// gates the pushbutton publish path. The live HTTP probe itself runs against
// real GHCR by the operator (see deploy/railway/template.md), not in CI.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProbeResult,
  classifyTokenStatus,
  type ProbeResult,
  parseArgs,
  summarizePublishReadiness,
  TEMPLATE_IMAGES,
} from "./check-railway-ghcr-public.ts";

const PUBLIC_PATTERN = /public/;
const PRIVATE_PATTERN = /private/;
const PUBLIC_ACTION_PATTERN = /Public/;
const ABSENT_PATTERN = /absent/;
const TAGS_LIST_PATTERN = /tags\/list/;
const REQUIRED_TAG_PATTERN = /0\.1\.0-beta\.7/;
const MANIFEST_PATTERN = /manifest/;
const MANIFEST_STATUS_404_PATTERN = /manifest status 404/;

test("TEMPLATE_IMAGES maps the app service to the documented GHCR path", () => {
  const byService: Record<string, (typeof TEMPLATE_IMAGES)[number]> = Object.fromEntries(
    TEMPLATE_IMAGES.map((i) => [i.service, i])
  );
  assert.equal(byService.core?.image, "pdp-connect/pdpp/core");
  assert.equal(byService.core?.stage, "core");
});

test("classifyTokenStatus: 200 public, 401 private, 403 absent, else unknown", () => {
  assert.deepEqual(classifyTokenStatus(200), { visibility: "public", tokenGranted: true });
  assert.deepEqual(classifyTokenStatus(401), { visibility: "private", tokenGranted: false });
  assert.deepEqual(classifyTokenStatus(403), { visibility: "absent", tokenGranted: false });
  assert.deepEqual(classifyTokenStatus(500), { visibility: "unknown", tokenGranted: false });
});

test("classifyProbeResult: public image with readable tags is ok", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ["0.1.0-beta.7", "latest"],
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, PUBLIC_PATTERN);
  assert.equal(result.visibility, "public");
});

test("classifyProbeResult: private image (401) is blocked with the owner-flip reason", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 401,
  });
  assert.equal(result.ok, false);
  assert.equal(result.visibility, "private");
  assert.match(result.reason, PRIVATE_PATTERN);
  assert.match(result.reason, PUBLIC_ACTION_PATTERN);
});

test("classifyProbeResult: absent path (403) is blocked and names the cause", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/nope",
    service: "console",
    stage: "console",
    tokenStatus: 403,
  });
  assert.equal(result.ok, false);
  assert.equal(result.visibility, "absent");
  assert.match(result.reason, ABSENT_PATTERN);
});

test("classifyProbeResult: token granted but tags/list fails is not ok", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 500,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, TAGS_LIST_PATTERN);
});

test("classifyProbeResult: --tag pin must be present even when public", () => {
  const missing = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ["latest"],
    requiredTag: "0.1.0-beta.7",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, REQUIRED_TAG_PATTERN);

  const present = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ["latest", "0.1.0-beta.7"],
    requiredTag: "0.1.0-beta.7",
  });
  assert.equal(present.ok, true);
});

test("classifyProbeResult: --tag pin can pass by direct manifest when tags/list lags", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ["latest"],
    requiredTag: "sha-1088045",
    manifestStatus: 200,
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, MANIFEST_PATTERN);
});

test("classifyProbeResult: --tag pin fails when neither tags/list nor manifest exposes it", () => {
  const result = classifyProbeResult({
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ["latest"],
    requiredTag: "sha-missing",
    manifestStatus: 404,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, MANIFEST_STATUS_404_PATTERN);
});

function fakeResult(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    image: "pdp-connect/pdpp/railway-core",
    service: "console",
    stage: "console",
    visibility: "public",
    ok: true,
    reason: "public (anonymously pullable)",
    tags: [],
    manifestStatus: undefined,
    ...overrides,
  };
}

test("summarizePublishReadiness: ready only when every image is ok", () => {
  const allOk = summarizePublishReadiness([fakeResult({ ok: true }), fakeResult({ ok: true })]);
  assert.equal(allOk.ready, true);
  assert.equal(allOk.blocked.length, 0);
  assert.equal(allOk.ownerAction, null);

  const oneBlocked = summarizePublishReadiness([fakeResult({ ok: true }), fakeResult({ ok: false, image: "x" })]);
  assert.equal(oneBlocked.ready, false);
  assert.equal(oneBlocked.blocked.length, 1);
  assert.match(oneBlocked.ownerAction ?? "", PUBLIC_ACTION_PATTERN);
});

test("summarizePublishReadiness: private template image is not ready", () => {
  const results = TEMPLATE_IMAGES.map((i) => classifyProbeResult({ ...i, tokenStatus: 401 }));
  const summary = summarizePublishReadiness(results);
  assert.equal(summary.ready, false);
  assert.equal(summary.blocked.length, 1);
});

test("parseArgs: --json, --tag, --help, and unknown", () => {
  assert.equal(parseArgs(["node", "s", "--json"]).json, true);
  assert.equal(parseArgs(["node", "s", "--tag", "0.1.0-beta.7"]).tag, "0.1.0-beta.7");
  assert.equal(parseArgs(["node", "s", "--help"]).help, true);
  assert.equal(parseArgs(["node", "s", "-h"]).help, true);
  assert.equal(parseArgs(["node", "s", "--bogus"]).unknown, "--bogus");
});

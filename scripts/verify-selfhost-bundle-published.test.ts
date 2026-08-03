#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the post-publish self-host bundle verification logic
// (parseBundlePins/findMissingPins). Hermetic — no network calls; the live
// GHCR/GitHub-Releases probes in verify-selfhost-bundle-published.ts's
// checkDigestPullable/fetchReleaseAsset are exercised by hand via
// `pnpm docker:release-bundle:verify-published -- --tag <tag>` (see
// scripts/generate-selfhost-bundle.ts and the semantic-release.yml
// publish-selfhost-bundle job, which runs this against the release it just
// created), not by this hermetic suite.

import assert from "node:assert/strict";
import test from "node:test";

import { findMissingPins, parseBundlePins } from "./verify-selfhost-bundle-published.ts";

const PINNED_COMPOSE = `services:
  reference:
    image: \${PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference@sha256:${"a".repeat(64)}}
  web:
    image: \${PDPP_WEB_IMAGE:-ghcr.io/pdp-connect/pdpp/web@sha256:${"b".repeat(64)}}
  postgres:
    image: \${PDPP_POSTGRES_IMAGE:-pgvector/pgvector:pg16}
  neko:
    image: \${PDPP_NEKO_IMAGE:-ghcr.io/pdp-connect/pdpp/neko@sha256:${"c".repeat(64)}}
`;

test("parseBundlePins extracts every digest-pinned PDPP image and ignores third-party/unpinned lines", () => {
  const pins = parseBundlePins(PINNED_COMPOSE);
  assert.equal(pins.length, 3);
  assert.deepEqual(
    pins.map((pin) => pin.image).sort(),
    ["neko", "reference", "web"]
  );
  const reference = pins.find((pin) => pin.image === "reference");
  assert.equal(reference?.envVar, "PDPP_REFERENCE_IMAGE");
  assert.equal(reference?.digest, `sha256:${"a".repeat(64)}`);
});

test("parseBundlePins finds nothing for a moving-tag (unpinned) bundle", () => {
  const movingTagCompose = `services:
  reference:
    image: \${PDPP_REFERENCE_IMAGE:-ghcr.io/pdp-connect/pdpp/reference:sha-cc07e3a}
  neko:
    image: \${PDPP_NEKO_IMAGE:-pdpp-neko-image-not-set}
`;
  assert.deepEqual(parseBundlePins(movingTagCompose), []);
});

test("findMissingPins is silent when reference/web/neko are each pinned exactly once", () => {
  const pins = parseBundlePins(PINNED_COMPOSE);
  assert.deepEqual(findMissingPins(pins), []);
});

test("findMissingPins reports every image that regressed to a moving tag", () => {
  const findings = findMissingPins([]);
  assert.equal(findings.length, 3);
  assert.ok(findings.some((finding) => finding.detail.includes("reference (PDPP_REFERENCE_IMAGE)")));
  assert.ok(findings.some((finding) => finding.detail.includes("web (PDPP_WEB_IMAGE)")));
  assert.ok(findings.some((finding) => finding.detail.includes("neko (PDPP_NEKO_IMAGE)")));
});

test("findMissingPins reports a duplicated pin as a finding too", () => {
  const pins = parseBundlePins(PINNED_COMPOSE);
  const duplicated = [...pins, pins[0] as (typeof pins)[number]];
  const findings = findMissingPins(duplicated);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /found 2/);
});

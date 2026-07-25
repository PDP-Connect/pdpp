#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hermetic guard for the dist-tag posture check (scripts/check-dist-tag-posture.ts).
//
// The live `release:dist-tag-check` script queries the npm registry, so it is
// intentionally NOT part of the offline `release:policy-check`. This suite pins
// the script's pure classification logic — `classifyDistTagPosture` — so the
// decision that protects operators from a placeholder `latest` is regression-
// tested without any network access. It mirrors the offline coverage that
// `check-package-release-policy.test.ts`
// already give their scripts.
//
// Nothing here shells out to `npm view` or reaches the registry: every case
// feeds the classifier a pre-parsed dist-tags object (the shape `npm view <pkg>
// dist-tags --json` returns) or `null` (the shape the script substitutes when
// the package is missing or the registry is unreachable).

import assert from "node:assert/strict";
import test from "node:test";

import { classifyDistTagPosture, placeholderVersion } from "./check-dist-tag-posture.ts";

const PKG = "@pdpp/cli";
const PKG_PATTERN = new RegExp(PKG.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"));

const PLACEHOLDER_PATTERN = /placeholder/;
const NPM_INSTALL_PATTERN = /npm install/;
const BETA_VERSION_PATTERN = /0\.1\.0-beta\.7/;
const NO_WHILE_BETA_PATTERN = /while "beta"/;
const NO_LATEST_PATTERN = /no "latest"/;
const NO_STABLE_TARGET_PATTERN = /no stable target/;
const LATEST_VERSION_PATTERN = /1\.2\.3/;
const NEWER_BETA_VERSION_PATTERN = /1\.3\.0-beta\.1/;
const NOT_PUBLISHED_PATTERN = /not published yet or registry unreachable/;
const NOTHING_TO_VERIFY_PATTERN = /nothing to verify/;

// --- hazard: the placeholder `latest` posture this check exists to catch ------

test("placeholder latest with a published beta is a hazard", () => {
  const result = classifyDistTagPosture(PKG, { latest: placeholderVersion, beta: "0.1.0-beta.7" });
  assert.equal(result.status, "hazard");
  assert.match(result.detail, PLACEHOLDER_PATTERN);
  // The operator-facing detail names the package, the bare-install consequence,
  // and the competing beta so the finding is self-explanatory in CI logs.
  assert.match(result.detail, PKG_PATTERN);
  assert.match(result.detail, NPM_INSTALL_PATTERN);
  assert.match(result.detail, BETA_VERSION_PATTERN);
});

test("placeholder latest with no beta is still a hazard", () => {
  // The placeholder alone is the problem; a bare install resolves to an empty
  // package whether or not a beta exists.
  const result = classifyDistTagPosture(PKG, { latest: placeholderVersion });
  assert.equal(result.status, "hazard");
  assert.match(result.detail, PLACEHOLDER_PATTERN);
  // With no beta, the detail must not fabricate a "while beta is …" clause.
  assert.doesNotMatch(result.detail, NO_WHILE_BETA_PATTERN);
});

test("the documented live posture (latest 0.0.0, beta 0.1.0-beta.7) classifies as a hazard", () => {
  // This is the exact registry state the release audit observed. The script
  // correctly fails on it live; this asserts the offline verdict matches.
  const result = classifyDistTagPosture("@pdpp/local-collector", {
    latest: "0.0.0",
    beta: "0.1.0-beta.7",
  });
  assert.equal(result.status, "hazard");
});

// --- hazard: a missing `latest` while a beta is published --------------------

test("missing latest while a beta is published is a hazard (no stable target)", () => {
  const result = classifyDistTagPosture(PKG, { beta: "0.1.0-beta.7" });
  assert.equal(result.status, "hazard");
  assert.match(result.detail, NO_LATEST_PATTERN);
  assert.match(result.detail, NO_STABLE_TARGET_PATTERN);
});

// --- ok: a real, non-placeholder `latest` ------------------------------------

test("a real latest with no beta is ok", () => {
  const result = classifyDistTagPosture(PKG, { latest: "1.2.3" });
  assert.equal(result.status, "ok");
  assert.match(result.detail, LATEST_VERSION_PATTERN);
});

test("a real latest alongside a newer beta is ok and reports both", () => {
  const result = classifyDistTagPosture(PKG, { latest: "1.2.3", beta: "1.3.0-beta.1" });
  assert.equal(result.status, "ok");
  assert.match(result.detail, LATEST_VERSION_PATTERN);
  assert.match(result.detail, NEWER_BETA_VERSION_PATTERN);
});

test("a real prerelease latest (not the 0.0.0 placeholder) is ok", () => {
  // Only the exact placeholder string is a hazard; any other real version —
  // including a non-zero prerelease promoted to `latest` — passes.
  assert.equal(classifyDistTagPosture(PKG, { latest: "0.1.0-rc.1" }).status, "ok");
  assert.equal(classifyDistTagPosture(PKG, { latest: "0.0.1" }).status, "ok");
});

// --- skip: unpublished package or unreachable registry -----------------------

test("a null dist-tags object (not published / registry unreachable) is a skip", () => {
  const result = classifyDistTagPosture(PKG, null);
  assert.equal(result.status, "skip");
  assert.match(result.detail, NOT_PUBLISHED_PATTERN);
});

test("an empty dist-tags object (no tags published yet) is a skip", () => {
  const result = classifyDistTagPosture(PKG, {});
  assert.equal(result.status, "skip");
  assert.match(result.detail, NOTHING_TO_VERIFY_PATTERN);
});

// --- placeholder constant ----------------------------------------------------

test("the placeholder version constant is the conventional 0.0.0", () => {
  // Pinned so a drift in the placeholder convention is a deliberate, reviewed
  // change rather than a silent one that would quietly stop catching hazards.
  assert.equal(placeholderVersion, "0.0.0");
});

// --- return shape ------------------------------------------------------------

test("every verdict has a known status and a human-readable detail string", () => {
  const cases = [
    classifyDistTagPosture(PKG, { latest: placeholderVersion, beta: "0.1.0-beta.7" }),
    classifyDistTagPosture(PKG, { latest: "1.2.3" }),
    classifyDistTagPosture(PKG, { beta: "0.1.0-beta.7" }),
    classifyDistTagPosture(PKG, null),
    classifyDistTagPosture(PKG, {}),
  ];
  for (const result of cases) {
    assert.ok(["ok", "hazard", "skip"].includes(result.status), `unexpected status: ${result.status}`);
    assert.equal(typeof result.detail, "string");
    assert.ok(result.detail.length > 0);
    assert.match(result.detail, PKG_PATTERN);
  }
});

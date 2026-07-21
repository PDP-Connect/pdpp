#!/usr/bin/env node
// Hermetic guard for the dist-tag posture check (scripts/check-dist-tag-posture.mjs).
//
// The live `release:dist-tag-check` script queries the npm registry, so it is
// intentionally NOT part of the offline `release:policy-check`. This suite pins
// the script's pure classification logic — `classifyDistTagPosture` — so the
// decision that protects operators from a placeholder `latest` is regression-
// tested without any network access. It mirrors the offline coverage that
// `check-package-release-policy.test.mjs`
// already give their scripts.
//
// Nothing here shells out to `npm view` or reaches the registry: every case
// feeds the classifier a pre-parsed dist-tags object (the shape `npm view <pkg>
// dist-tags --json` returns) or `null` (the shape the script substitutes when
// the package is missing or the registry is unreachable).

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDistTagPosture, placeholderVersion } from './check-dist-tag-posture.mjs';

const PKG = '@pdpp/cli';

// --- hazard: the placeholder `latest` posture this check exists to catch ------

test('placeholder latest with a published beta is a hazard', () => {
  const result = classifyDistTagPosture(PKG, { latest: placeholderVersion, beta: '0.1.0-beta.7' });
  assert.equal(result.status, 'hazard');
  assert.match(result.detail, /placeholder/);
  // The operator-facing detail names the package, the bare-install consequence,
  // and the competing beta so the finding is self-explanatory in CI logs.
  assert.match(result.detail, new RegExp(PKG.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(result.detail, /npm install/);
  assert.match(result.detail, /0\.1\.0-beta\.7/);
});

test('placeholder latest with no beta is still a hazard', () => {
  // The placeholder alone is the problem; a bare install resolves to an empty
  // package whether or not a beta exists.
  const result = classifyDistTagPosture(PKG, { latest: placeholderVersion });
  assert.equal(result.status, 'hazard');
  assert.match(result.detail, /placeholder/);
  // With no beta, the detail must not fabricate a "while beta is …" clause.
  assert.doesNotMatch(result.detail, /while "beta"/);
});

test('the documented live posture (latest 0.0.0, beta 0.1.0-beta.7) classifies as a hazard', () => {
  // This is the exact registry state the release audit observed. The script
  // correctly fails on it live; this asserts the offline verdict matches.
  const result = classifyDistTagPosture('@pdpp/local-collector', {
    latest: '0.0.0',
    beta: '0.1.0-beta.7',
  });
  assert.equal(result.status, 'hazard');
});

// --- hazard: a missing `latest` while a beta is published --------------------

test('missing latest while a beta is published is a hazard (no stable target)', () => {
  const result = classifyDistTagPosture(PKG, { beta: '0.1.0-beta.7' });
  assert.equal(result.status, 'hazard');
  assert.match(result.detail, /no "latest"/);
  assert.match(result.detail, /no stable target/);
});

// --- ok: a real, non-placeholder `latest` ------------------------------------

test('a real latest with no beta is ok', () => {
  const result = classifyDistTagPosture(PKG, { latest: '1.2.3' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /1\.2\.3/);
});

test('a real latest alongside a newer beta is ok and reports both', () => {
  const result = classifyDistTagPosture(PKG, { latest: '1.2.3', beta: '1.3.0-beta.1' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /1\.2\.3/);
  assert.match(result.detail, /1\.3\.0-beta\.1/);
});

test('a real prerelease latest (not the 0.0.0 placeholder) is ok', () => {
  // Only the exact placeholder string is a hazard; any other real version —
  // including a non-zero prerelease promoted to `latest` — passes.
  assert.equal(classifyDistTagPosture(PKG, { latest: '0.1.0-rc.1' }).status, 'ok');
  assert.equal(classifyDistTagPosture(PKG, { latest: '0.0.1' }).status, 'ok');
});

// --- skip: unpublished package or unreachable registry -----------------------

test('a null dist-tags object (not published / registry unreachable) is a skip', () => {
  const result = classifyDistTagPosture(PKG, null);
  assert.equal(result.status, 'skip');
  assert.match(result.detail, /not published yet or registry unreachable/);
});

test('an empty dist-tags object (no tags published yet) is a skip', () => {
  const result = classifyDistTagPosture(PKG, {});
  assert.equal(result.status, 'skip');
  assert.match(result.detail, /nothing to verify/);
});

// --- placeholder constant ----------------------------------------------------

test('the placeholder version constant is the conventional 0.0.0', () => {
  // Pinned so a drift in the placeholder convention is a deliberate, reviewed
  // change rather than a silent one that would quietly stop catching hazards.
  assert.equal(placeholderVersion, '0.0.0');
});

// --- return shape ------------------------------------------------------------

test('every verdict has a known status and a human-readable detail string', () => {
  const cases = [
    classifyDistTagPosture(PKG, { latest: placeholderVersion, beta: '0.1.0-beta.7' }),
    classifyDistTagPosture(PKG, { latest: '1.2.3' }),
    classifyDistTagPosture(PKG, { beta: '0.1.0-beta.7' }),
    classifyDistTagPosture(PKG, null),
    classifyDistTagPosture(PKG, {}),
  ];
  for (const result of cases) {
    assert.ok(['ok', 'hazard', 'skip'].includes(result.status), `unexpected status: ${result.status}`);
    assert.equal(typeof result.detail, 'string');
    assert.ok(result.detail.length > 0);
    assert.match(result.detail, new RegExp(PKG.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
  }
});

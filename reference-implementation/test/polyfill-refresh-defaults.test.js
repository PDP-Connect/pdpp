// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Locks the first-party polyfill refresh-policy classification documented
 * in `openspec/changes/add-connector-refresh-policy-controls/design-notes/
 * 2026-04-26-first-party-refresh-defaults.md`.
 *
 * Shape rules for every manifest under
 * `packages/polyfill-connectors/manifests/`:
 *
 *   1. `capabilities.refresh_policy` is present and validator-clean.
 *   2. `recommended_mode` is one of `automatic` or `manual`.
 *      `paused` is reserved for future shipped-but-unsupported cases
 *      and SHOULD trigger an explicit design-note update before any
 *      first-party connector adopts it.
 *   3. Automatic policies declare `recommended_interval_seconds`,
 *      `minimum_interval_seconds`, and `background_safe: true`.
 *   4. `interaction_posture` is consistent with
 *      `capabilities.human_interaction`:
 *      - lists `otp` → posture must be `otp_likely`
 *      - lists `manual_action` or `credentials` (but not `otp`) →
 *        posture must be `credentials` or `manual_action_likely`
 *      - lists nothing → posture must be `none` or
 *        `manual_action_likely` (manual-export / file-based connectors)
 *
 * `refresh_policy` is reference/polyfill metadata, not finalized PDPP core
 * protocol. This test exists so a manifest edit that contradicts the
 * documented bucket fails fast in CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const POLYFILL_MANIFEST_DIR = join(REPO_ROOT, 'packages/polyfill-connectors/manifests');

const POLYFILL_MANIFEST_NAMES = readdirSync(POLYFILL_MANIFEST_DIR)
  .filter((fileName) => fileName.endsWith('.json'))
  .map((fileName) => fileName.replace(/\.json$/, ''))
  .sort();

function readManifest(name) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFEST_DIR, `${name}.json`), 'utf8'));
}

const RECOMMENDED_MODES = new Set(['automatic', 'manual']);
const KNOWN_POSTURES = new Set([
  'none',
  'credentials',
  'otp_likely',
  'manual_action_likely',
]);

test('every first-party manifest declares capabilities.refresh_policy', () => {
  assert.ok(
    POLYFILL_MANIFEST_NAMES.length > 0,
    'expected at least one polyfill manifest under packages/polyfill-connectors/manifests',
  );
  for (const name of POLYFILL_MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const policy = manifest.capabilities?.refresh_policy;
    assert.ok(
      policy && typeof policy === 'object' && !Array.isArray(policy),
      `${name}: capabilities.refresh_policy is required`,
    );
    assert.ok(
      RECOMMENDED_MODES.has(policy.recommended_mode),
      `${name}: recommended_mode must be one of ${[...RECOMMENDED_MODES].join(', ')} (got ${policy.recommended_mode}). 'paused' is reserved; update the design note before adopting it.`,
    );
    assert.equal(
      typeof policy.rationale,
      'string',
      `${name}: rationale must be a non-empty owner-readable string`,
    );
    assert.ok(
      policy.rationale.trim().length > 0,
      `${name}: rationale must be a non-empty owner-readable string`,
    );
    if (policy.interaction_posture !== undefined) {
      assert.ok(
        KNOWN_POSTURES.has(policy.interaction_posture),
        `${name}: unknown interaction_posture ${policy.interaction_posture}`,
      );
    }
  }
});

test('automatic first-party manifests declare cadence + background_safe + a staleness window', () => {
  for (const name of POLYFILL_MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const policy = manifest.capabilities?.refresh_policy;
    if (!policy || policy.recommended_mode !== 'automatic') continue;
    assert.equal(
      typeof policy.recommended_interval_seconds,
      'number',
      `${name}: automatic policy must declare recommended_interval_seconds`,
    );
    assert.equal(
      typeof policy.minimum_interval_seconds,
      'number',
      `${name}: automatic policy must declare minimum_interval_seconds`,
    );
    assert.ok(
      policy.recommended_interval_seconds >= policy.minimum_interval_seconds,
      `${name}: recommended_interval_seconds (${policy.recommended_interval_seconds}) must be >= minimum_interval_seconds (${policy.minimum_interval_seconds})`,
    );
    assert.equal(
      policy.background_safe,
      true,
      `${name}: automatic policy must set background_safe: true`,
    );
    // `maximum_staleness_seconds` is the single field that makes freshness
    // computable: `deriveReferenceFreshness` returns `unknown` (never `current`)
    // when it is absent, so a local-device collector whose heartbeat is fresh
    // could not project `healthy` without it. The validator treats the field as
    // optional, so an automatic manifest could silently drop it and regress a
    // green local collector back to `idle` with no other test failing. Pin it
    // for every automatic policy. See
    // `openspec/changes/add-local-device-collection-verdict/` — the verdict is
    // gated on freshness `fresh`, which depends on this window.
    assert.equal(
      typeof policy.maximum_staleness_seconds,
      'number',
      `${name}: automatic policy must declare maximum_staleness_seconds (freshness is otherwise unknown and a fresh local collector cannot project healthy)`,
    );
    assert.ok(
      Number.isFinite(policy.maximum_staleness_seconds) && policy.maximum_staleness_seconds > 0,
      `${name}: maximum_staleness_seconds must be a positive finite number (got ${policy.maximum_staleness_seconds})`,
    );
    assert.ok(
      policy.maximum_staleness_seconds >= policy.minimum_interval_seconds,
      `${name}: maximum_staleness_seconds (${policy.maximum_staleness_seconds}) must be >= minimum_interval_seconds (${policy.minimum_interval_seconds}); a staleness window shorter than the minimum refresh interval can never be satisfied`,
    );
  }
});

test('interaction_posture is consistent with human_interaction', () => {
  for (const name of POLYFILL_MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const policy = manifest.capabilities?.refresh_policy;
    if (!policy) continue;
    const interactions = manifest.capabilities?.human_interaction ?? [];
    assert.ok(
      Array.isArray(interactions),
      `${name}: capabilities.human_interaction must be an array when declared`,
    );
    const posture = policy.interaction_posture;
    if (interactions.includes('otp')) {
      assert.equal(
        posture,
        'otp_likely',
        `${name}: human_interaction includes 'otp' so interaction_posture must be 'otp_likely' (got ${posture})`,
      );
      continue;
    }
    if (interactions.includes('manual_action') || interactions.includes('credentials')) {
      assert.notEqual(
        posture,
        'none',
        `${name}: human_interaction declares friction (${interactions.join(',')}); interaction_posture must not be 'none'`,
      );
      assert.ok(
        posture === 'credentials' || posture === 'manual_action_likely',
        `${name}: interaction_posture must be 'credentials' or 'manual_action_likely' when human_interaction declares ${interactions.join(',')} (got ${posture})`,
      );
      continue;
    }
    assert.ok(
      posture === undefined || posture === 'none' || posture === 'manual_action_likely',
      `${name}: with empty human_interaction, interaction_posture must be 'none' or 'manual_action_likely' (got ${posture})`,
    );
  }
});

test('first-party manifests do not silently use the paused mode', () => {
  // `paused` is a valid validator value but not one any first-party
  // connector ships today. If this assertion ever fails, the design
  // note `2026-04-26-first-party-refresh-defaults.md` needs an explicit
  // paused-bucket entry first.
  const paused = POLYFILL_MANIFEST_NAMES.filter((name) => {
    const manifest = readManifest(name);
    return manifest.capabilities?.refresh_policy?.recommended_mode === 'paused';
  });
  assert.deepEqual(
    paused,
    [],
    `unexpected paused first-party manifests: ${paused.join(', ')}. Update the design note before adopting 'paused'.`,
  );
});

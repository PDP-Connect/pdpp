/**
 * Runtime controller — connector path resolution.
 *
 * Regression: the reference fixture manifest and the shipped polyfill
 * manifest can share a `connector_id`. GitHub is the live example today:
 * both reference-implementation/manifests/github.json and
 * packages/polyfill-connectors/manifests/github.json use connector_id
 * https://registry.pdpp.org/connectors/github. Before the fix in
 * runtime/controller.ts, a controller-triggered polyfill GitHub run
 * executed the reference seed connector, whose GitHub fixture emits a
 * `commits` PROGRESS stream the polyfill manifest does not declare.
 * That surfaced in production as:
 *
 *   run.failed reason=connector_protocol_violation
 *   subtype=progress_for_undeclared_stream message_type=PROGRESS
 *   stream=commits expected=[user, repositories, starred, issues,
 *   pull_requests, gists]
 *
 * This test proves the resolver now picks the polyfill connector
 * implementation when the active manifest is the polyfill GitHub
 * manifest, and still picks the reference seed when the active manifest
 * is the reference fixture GitHub manifest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetControllerPathResolverCachesForTests,
  resolveDefaultConnectorPath,
} from '../runtime/controller.ts';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const POLYFILL_MANIFESTS_DIR = join(
  REFERENCE_IMPL_DIR,
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);
const REFERENCE_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, 'manifests');

function readManifest(dir, file) {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

test('resolves polyfill GitHub connector when active manifest is the polyfill manifest', () => {
  __resetControllerPathResolverCachesForTests();
  const polyfillGithub = readManifest(POLYFILL_MANIFESTS_DIR, 'github.json');
  const referenceGithub = readManifest(REFERENCE_MANIFESTS_DIR, 'github.json');

  // Sanity: the collision is real, otherwise this regression cannot trip.
  assert.equal(polyfillGithub.connector_id, referenceGithub.connector_id);
  assert.notDeepEqual(
    [...polyfillGithub.streams.map((s) => s.name)].sort(),
    [...referenceGithub.streams.map((s) => s.name)].sort(),
    'manifests must differ in declared streams; this test relies on the fingerprint disambiguator',
  );

  const resolved = resolveDefaultConnectorPath(
    polyfillGithub.connector_id,
    polyfillGithub,
  );
  assert.ok(resolved, 'polyfill GitHub run must resolve to a runnable connector path');
  assert.match(
    resolved,
    /packages\/polyfill-connectors\/connectors\/github\/index\.(ts|js)$/,
    `expected polyfill connector, got ${resolved}`,
  );
  assert.doesNotMatch(
    resolved,
    /reference-implementation\/connectors\/seed\/index\.js$/,
    'polyfill GitHub run must not fall through to the reference seed fixture',
  );
});

test('resolves reference seed when active manifest is the reference GitHub fixture', () => {
  __resetControllerPathResolverCachesForTests();
  const referenceGithub = readManifest(REFERENCE_MANIFESTS_DIR, 'github.json');
  const resolved = resolveDefaultConnectorPath(
    referenceGithub.connector_id,
    referenceGithub,
  );
  assert.ok(resolved, 'reference GitHub fixture must still resolve');
  assert.match(
    resolved,
    /reference-implementation\/connectors\/seed\/index\.js$/,
    `expected reference seed, got ${resolved}`,
  );
});

test('prefers polyfill path when no manifest is provided and a polyfill implementation exists', () => {
  __resetControllerPathResolverCachesForTests();
  const polyfillGithub = readManifest(POLYFILL_MANIFESTS_DIR, 'github.json');
  // Call without a manifest argument. The legacy behavior returned the
  // seed connector for any reference fixture id; the fixed behavior
  // prefers the shipped polyfill implementation when one exists.
  const resolved = resolveDefaultConnectorPath(polyfillGithub.connector_id);
  assert.ok(resolved, 'resolver must still return a path for known connector ids');
  assert.match(
    resolved,
    /packages\/polyfill-connectors\/connectors\/github\/index\.(ts|js)$/,
    `expected polyfill connector without manifest hint, got ${resolved}`,
  );
});

test('still resolves polyfill-only connectors (no reference fixture collision) to polyfill path', () => {
  __resetControllerPathResolverCachesForTests();
  const ynab = readManifest(POLYFILL_MANIFESTS_DIR, 'ynab.json');
  const resolved = resolveDefaultConnectorPath(ynab.connector_id, ynab);
  assert.ok(resolved, 'ynab must resolve to a runnable connector path');
  assert.match(
    resolved,
    /packages\/polyfill-connectors\/connectors\/ynab\/index\.ts$/,
    `expected polyfill ynab connector, got ${resolved}`,
  );
});

test('resolves canonical connector keys for URL-shaped reference fixture manifests', () => {
  __resetControllerPathResolverCachesForTests();
  const spotify = readManifest(REFERENCE_MANIFESTS_DIR, 'spotify.json');
  const canonicalKey = canonicalConnectorKeyFromManifest(spotify);
  assert.equal(canonicalKey, 'spotify');

  const storedManifest = {
    ...spotify,
    connector_id: canonicalKey,
    manifest_uri: spotify.connector_id,
  };
  const resolved = resolveDefaultConnectorPath(canonicalKey, storedManifest);
  assert.ok(resolved, 'canonical spotify key must resolve to a runnable connector path');
  assert.match(
    resolved,
    /reference-implementation\/connectors\/seed\/index\.js$/,
    `expected reference seed for canonical spotify key, got ${resolved}`,
  );
});

/**
 * GitHub manifest/connector contract parity.
 *
 * Two real failure modes this guards against:
 *
 *   1. Reference fixture manifest at `reference-implementation/manifests/github.json`
 *      advertises streams that no GitHub connector (real or seed) actually emits.
 *      That is the bug from `ri-github-stream-contract-v1`: the fixture declared
 *      `commits` and the seed connector emitted 8 fake `gh:commit:abc*` records.
 *      Owner-mode stream-list builds the read grant from the persisted manifest's
 *      stream names (see `rs-read.ts:buildOwnerReadGrantForManifest`), so any
 *      advertised stream the connector never emits becomes a stream-list entry
 *      with no records-read backing. The records page then sees a 404, which is
 *      an honest dashboard outcome (the page handles it gracefully now) but is
 *      not what the contract should advertise.
 *
 *   2. The shipped polyfill manifest at
 *      `packages/polyfill-connectors/manifests/github.json` declares streams
 *      that the real connector's `SCHEMAS` registry does not cover. The
 *      polyfill runtime validates emitted records against `SCHEMAS[stream]`,
 *      so a manifest-declared stream with no schema cannot be emitted as
 *      well-formed data; the contract advertises something the connector
 *      cannot deliver.
 *
 * The parity rule is one-way:
 *   - every manifest-declared stream must have a backing emission path
 *   - extra emission paths (e.g. `user_stats` derived from `user`) are fine
 *     as long as the manifest also declares them (otherwise the records-list
 *     endpoint returns `not_found` for the un-advertised name)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function manifestStreamNames(manifestPath) {
  const manifest = readJson(manifestPath);
  return (manifest.streams || []).map((s) => s.name).sort();
}

test('reference fixture manifest only advertises streams the seed connector emits', () => {
  const fixtureManifestPath = join(REPO_ROOT, 'reference-implementation', 'manifests', 'github.json');
  const seedPath = join(REPO_ROOT, 'reference-implementation', 'connectors', 'seed', 'index.js');
  const fixtureStreams = manifestStreamNames(fixtureManifestPath);

  // The seed connector is a plain JS file that emits via `emitRecord(stream, ...)`.
  // Inspect the source for the literal stream names it can emit under the
  // GitHub branch. A regex over the file is sufficient because the seed
  // connector deliberately uses literal stream names (no interpolation).
  const seedSource = readFileSync(seedPath, 'utf8');
  const emittedStreams = new Set();
  // Match: emitRecord('stream_name', ...) - single-quoted literal stream name.
  for (const match of seedSource.matchAll(/emitRecord\('([^']+)'/g)) {
    emittedStreams.add(match[1]);
  }
  // Match: emit({ type: 'PROGRESS'|'STATE', stream: 'stream_name', ... })
  for (const match of seedSource.matchAll(/stream:\s*'([^']+)'/g)) {
    emittedStreams.add(match[1]);
  }

  const orphans = fixtureStreams.filter((name) => !emittedStreams.has(name));
  assert.deepStrictEqual(
    orphans,
    [],
    `Fixture manifest declares streams that the seed connector never emits: ${orphans.join(', ')}. ` +
      `Either remove the stream from the manifest or add an emission path to the seed connector.`
  );
});

test('polyfill manifest only advertises streams the GitHub connector has schemas for', async () => {
  const polyfillManifestPath = join(
    REPO_ROOT,
    'packages',
    'polyfill-connectors',
    'manifests',
    'github.json'
  );
  const manifestStreams = manifestStreamNames(polyfillManifestPath);

  const { SCHEMAS } = await import(
    join(REPO_ROOT, 'packages', 'polyfill-connectors', 'connectors', 'github', 'schemas.ts')
  ).catch(async () => {
    // Node strips TS via --experimental-strip-types under v22+; if that
    // fails (older runtime, no loader), fall back to source inspection.
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'polyfill-connectors', 'connectors', 'github', 'schemas.ts'),
      'utf8'
    );
    const keys = new Set();
    // Match: `key: someSchema,` inside the SCHEMAS block - capture the key.
    const schemasBlockMatch = source.match(/SCHEMAS[^=]*=\s*{([\s\S]*?)};/);
    if (schemasBlockMatch) {
      for (const m of schemasBlockMatch[1].matchAll(/^\s*(\w+):/gm)) {
        keys.add(m[1]);
      }
    }
    return { SCHEMAS: Object.fromEntries([...keys].map((k) => [k, true])) };
  });

  const schemaStreams = new Set(Object.keys(SCHEMAS));
  const orphans = manifestStreams.filter((name) => !schemaStreams.has(name));
  assert.deepStrictEqual(
    orphans,
    [],
    `Polyfill manifest declares streams without a SCHEMAS entry: ${orphans.join(', ')}. ` +
      `Either add the schema or drop the stream from the manifest.`
  );
});

test('reference fixture and shipped polyfill manifests share the same connector identity', () => {
  const fixturePath = join(REPO_ROOT, 'reference-implementation', 'manifests', 'github.json');
  const polyfillPath = join(REPO_ROOT, 'packages', 'polyfill-connectors', 'manifests', 'github.json');
  const fixture = readJson(fixturePath);
  const polyfill = readJson(polyfillPath);

  // The polyfill reconciler keys off `connector_id`: the persisted (fixture)
  // and shipped (polyfill) manifests MUST agree on identity or the
  // `(version, sorted-stream-names)` fixture-to-polyfill transition check
  // never fires and stale fixture records are not invalidated on upgrade.
  assert.strictEqual(fixture.connector_id, polyfill.connector_id);
  assert.strictEqual(fixture.connector_key, polyfill.connector_key);
});

test('reference fixture manifest does not declare a top-level `commits` stream', () => {
  // Regression pin for ri-github-stream-contract-v1: `commits` is a PR-detail
  // field on the polyfill connector's `pull_requests` stream
  // (`commits_count`), not a stream the connector emits as top-level records.
  // Re-advertising it would re-introduce the fixture/connector mismatch.
  const fixturePath = join(REPO_ROOT, 'reference-implementation', 'manifests', 'github.json');
  const streams = manifestStreamNames(fixturePath);
  assert.ok(
    !streams.includes('commits'),
    `Fixture manifest must not advertise a 'commits' stream. Got streams: ${streams.join(', ')}`
  );
});

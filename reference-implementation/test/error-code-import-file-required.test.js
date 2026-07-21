// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the `import_file_required` typed-error code
 * (server/routes/ref-manual-upload-draft-connection.ts).
 *
 * The manual-upload validation-preview endpoint requires a non-empty import
 * file body. When the request supplies an accepted `file_name` but an empty
 * body, the route refuses with HTTP 400 and code `import_file_required` rather
 * than proceeding to validate/stage an empty artifact.
 *
 * No `test/` file exercised `import_file_required` by name, so a mutation
 * dropping the empty-body guard (or corrupting the code string) went
 * undetected. This test pins the empty-body branch against a real registered
 * manual-upload connector (`google-maps`) and contrasts it with a non-empty
 * body, which passes the guard and reaches validation instead.
 *
 * Owner auth is left disabled so the owner session auto-passes and the only
 * thing under test is the import-file precondition.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startServer } from '../server/index.js';

async function closeServer(server) {
  const closeOne = (httpServer) =>
    new Promise((resolve) => {
      if (!httpServer) return resolve();
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      httpServer.closeAllConnections?.();
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function loadManifest(name) {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), 'utf8'),
  );
}

test('manual-upload validation-preview refuses an empty body with import_file_required (400)', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const manifest = loadManifest('google_maps');
    const connectorId = manifest.connector_id;
    const register = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(register.status, 201, 'connector registration precondition');

    const previewUrl = new URL(`${asUrl}/_ref/connectors/${connectorId}/manual-upload-validation-preview`);
    previewUrl.searchParams.set('file_name', 'Timeline.json');

    // Empty body -> import_file_required.
    const empty = await fetch(previewUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      body: '',
      redirect: 'manual',
    });
    assert.equal(empty.status, 400, 'empty body SHALL 400');
    const emptyBody = await empty.json();
    assert.equal(emptyBody.error.code, 'import_file_required');
    assert.equal(emptyBody.error.type, 'invalid_request_error', '400 envelope type');

    // Non-empty body -> passes the import-file guard (does NOT report
    // import_file_required; it proceeds to content validation instead).
    const validTimeline = JSON.stringify({
      locations: [{ timestampMs: '1717595122000', latitudeE7: 377_749_000, longitudeE7: -1_224_194_000 }],
    });
    const nonEmpty = await fetch(previewUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
      body: validTimeline,
      redirect: 'manual',
    });
    const nonEmptyBody = await nonEmpty.json();
    assert.notEqual(
      nonEmptyBody.error?.code,
      'import_file_required',
      'a non-empty body SHALL pass the import-file guard',
    );
  } finally {
    await closeServer(server);
  }
});

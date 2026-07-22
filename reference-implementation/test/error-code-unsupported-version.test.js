// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the public `unsupported_version` typed-error
 * code (server/routes/ref-error-status.ts: `unsupported_version: 400`).
 *
 * The RS app negotiates a wire protocol version via the `PDPP-Version` request
 * header. A request that supplies a version other than the server's current
 * one is rejected — BEFORE routing/auth — with a 400 typed-error envelope whose
 * `code` is `unsupported_version` and whose `type` is `invalid_request_error`
 * (typeFor(400)). A request that omits the header, or sends the current
 * version, is accepted and the response carries `PDPP-Version: <current>`.
 *
 * Prior to this test no `test/` file exercised the `unsupported_version` code
 * by name, so mutations to the negotiation branch (dropping the guard, altering
 * the status, or corrupting the code/type string) went undetected.
 *
 * Boots the real reference server once against the ephemeral Postgres database
 * the test harness provisions in `PDPP_TEST_POSTGRES_URL`; the version guard
 * runs in the RS middleware chain ahead of any storage access, so these are
 * end-to-end HTTP observations of the public contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { closeDb } from '../server/db.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// The server's advertised current protocol version. Kept in lockstep with the
// `CURRENT_VERSION` constant in the RS version-negotiation middleware.
const CURRENT_VERSION = '2026-04-06';

async function closeStartedServer(server) {
  if (!server) return;
  const closeOne = (httpServer) =>
    new Promise((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
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

if (!POSTGRES_URL) {
  test('unsupported_version typed error (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('PDPP-Version negotiation and the unsupported_version 400 envelope', async (t) => {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      storageBackend: 'postgres',
      databaseUrl: POSTGRES_URL,
      reconcilePolyfillManifests: false,
    });
    const rsUrl = `http://localhost:${server.rsPort}`;
    // A well-known metadata path keeps every request otherwise-valid (no auth
    // required); the version guard runs before routing, so it is exercised
    // regardless of the target path.
    const metadataPath = `${rsUrl}/.well-known/oauth-protected-resource`;

    try {
      await t.test('a mismatched version is rejected with the typed 400 envelope', async () => {
        const resp = await fetch(metadataPath, { headers: { 'PDPP-Version': '1999-01-01' } });
        assert.equal(resp.status, 400, 'mismatched version SHALL be rejected with HTTP 400');
        const body = await resp.json();
        assert.equal(body.error.code, 'unsupported_version');
        assert.equal(
          body.error.type,
          'invalid_request_error',
          'the 400 envelope SHALL advertise the invalid_request_error type',
        );
        // The message names both the rejected and current version so a client
        // can self-correct.
        assert.match(body.error.message, /1999-01-01/);
        assert.match(body.error.message, new RegExp(CURRENT_VERSION));
      });

      await t.test('the current version is accepted and echoed on the response', async () => {
        const resp = await fetch(metadataPath, { headers: { 'PDPP-Version': CURRENT_VERSION } });
        assert.equal(resp.status, 200, 'the current version SHALL be accepted');
        assert.equal(
          resp.headers.get('PDPP-Version'),
          CURRENT_VERSION,
          'accepted requests SHALL echo the advertised current version',
        );
      });

      await t.test('a request omitting the version is accepted and advertises the current version', async () => {
        const resp = await fetch(metadataPath);
        assert.equal(resp.status, 200, 'a version-less request SHALL be accepted');
        assert.equal(
          resp.headers.get('PDPP-Version'),
          CURRENT_VERSION,
          'the server SHALL advertise its current version even when none was requested',
        );
      });
    } finally {
      await closeStartedServer(server);
      closeDb();
    }
  });
}

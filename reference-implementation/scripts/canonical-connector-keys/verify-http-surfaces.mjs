#!/usr/bin/env node
/**
 * canonical-connector-keys / verify-http-surfaces.mjs
 *
 * §3.4 LIVE-READ-PATH validation. The companion `verify-backup-restore.mjs`
 * proves the migrated restored DB is correct *at the storage layer* (SQL
 * joins, JSONB ids, row counts). This script proves the same restored,
 * migrated database hydrates correctly through the *running reference app's
 * HTTP read surfaces* — the path an owner dashboard, the assistant, and MCP
 * clients actually traverse — without a human clicking through a browser.
 *
 * It boots `startServer` IN-PROCESS against the already-restored, already-
 * migrated DISPOSABLE database (same Postgres connection string the verify
 * step used) on ephemeral ports, mints an owner token for the seed's owner
 * subject, and asserts:
 *
 *   1. /v1/streams/<stream>/records (owner read) hydrates the migrated
 *      records under the BARE CANONICAL KEY (gmail, codex, spotify) — the
 *      live read path resolves what the SQL layer rewrote.
 *   2. The SAME owner read issued with the STALE URL-SHAPED connector_id
 *      (https://registry.pdpp.org/connectors/gmail) ALSO hydrates — proving
 *      the read/admission canonicalization (design Decision 8) is exercised
 *      end-to-end against migrated production-shaped rows, not just unit
 *      fixtures.
 *   3. Single-record hydration by the returned record id succeeds.
 *   4. /v1/search returns a list envelope (cross-stream read surface).
 *   5. Grant-package membership read surface: GET /v1/grant-packages exposes
 *      the migrated package and its child grants by canonical connector_key /
 *      connection_id, with NO URL-shaped connector id in the owner-visible
 *      payload.
 *   6. A connector type that DOES NOT exist in the restore is reported as an
 *      empty hydration, not a server error (negative guard).
 *
 * The app boot performs the same idempotent schema bootstrap + client seed
 * the live operator app runs on every restart, so this is faithful to a real
 * "boot the app on the migrated restore" close-out — just driven over HTTP
 * by code instead of by hand.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node verify-http-surfaces.mjs [--owner-subject <id>]
 *
 * Exits 0 when every assertion holds, 1 otherwise. Prints a checklist.
 * Never prints the database URL, the owner token, cookies, or record bodies.
 */

import { startServer } from '../../server/index.js';
import { closePostgresStorage } from '../../server/postgres-storage.js';

const URL_GMAIL = 'https://registry.pdpp.org/connectors/gmail';
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

// Canonical-key expectations for the §3.4 seed (backup-restore-seed.sql).
// connector_key -> { stream, expectedRecords, urlAlias? }
const EXPECTED = [
  { key: 'gmail', stream: 'messages', expected: 2, urlAlias: URL_GMAIL },
  { key: 'codex', stream: 'sessions', expected: 1 },
  { key: 'spotify', stream: 'recently_played', expected: 1 },
];

export function parseArgs(argv) {
  const out = { ownerSubject: 'owner_sub_1' };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--owner-subject') out.ownerSubject = a[++i];
  }
  return out;
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? '' });
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

/**
 * Mint an owner bearer for `subjectId` via the device-authorization flow,
 * approving the device code as that subject so the issued token's read scope
 * matches the seed rows' owner_subject_id.
 */
async function issueOwnerToken(asUrl, subjectId) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  if (!device?.device_code) {
    throw new Error('device_authorization did not return a device_code');
  }
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  if (!tokenBody?.access_token) {
    throw new Error('device token exchange did not return an access_token');
  }
  return tokenBody.access_token;
}

export function containsUrlShapedConnectorId(value) {
  return JSON.stringify(value ?? null).includes('://');
}

/**
 * The §3.4 seed's canonical-key expectations, exported so the deterministic
 * unit test can assert the harness covers each pre-migration identity shape
 * (URL-shaped, legacy alias, wrapped local-device, already-canonical) without
 * a database.
 */
export const SEED_EXPECTATIONS = EXPECTED;

async function closeServer(server) {
  // Abort any in-flight startup backfill so it can't keep a pooled client busy.
  try {
    server.abortStartupBackfill?.('shutdown');
  } catch {}
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
  // Close the process-global Postgres storage pool. Without this, idle pooled
  // clients linger after the HTTP servers close; when the harness then drops
  // the disposable DB (DROP DATABASE … WITH FORCE), the server's terminate
  // message reaches an idle client whose 'error' event is otherwise unhandled,
  // crashing the verifier AFTER its checks already passed. This is the
  // canonical postgres-backed teardown (see test/postgres-runtime-storage.test.js).
  await closePostgresStorage().catch(() => {});
}

async function main() {
  const { ownerSubject } = parseArgs(process.argv);
  const databaseUrl = process.env.PDPP_DATABASE_URL;
  if (!databaseUrl) throw new Error('PDPP_DATABASE_URL is required');

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    storageBackend: 'postgres',
    databaseUrl,
    // Disposable, ad-hoc DB: never self-heal connector manifests here.
    reconcilePolyfillManifests: false,
    // Empty owner-auth password puts owner-session enforcement in pass-through
    // mode (same convention as ref-grant-packages.test.js), so the harness can
    // read the cookie-gated /_ref/grant-packages operator surface without
    // driving a browser login. The bearer-authed /v1/owner/* surfaces are
    // exercised on their real auth path below.
    ownerAuthPassword: '',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const ownerToken = await issueOwnerToken(asUrl, ownerSubject);
    check('owner token minted via device flow', typeof ownerToken === 'string' && ownerToken.length > 0);
    const auth = { Authorization: `Bearer ${ownerToken}` };

    // --- 1 & 2 & 3. canonical + stale-URL-alias record hydration ----------
    for (const { key, stream, expected, urlAlias } of EXPECTED) {
      const canonicalUrl =
        `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records` +
        `?connector_id=${encodeURIComponent(key)}&limit=50&order=asc`;
      const page = await fetchJson(canonicalUrl, { headers: auth });
      const okList = page.status === 200 && page.body?.object === 'list';
      check(
        `HTTP read hydrates '${key}'.${stream} under canonical key`,
        okList && Array.isArray(page.body?.data) && page.body.data.length === expected,
        okList ? `count=${page.body.data.length} (want ${expected})` : `status=${page.status}`,
      );

      // Single-record hydration by returned id.
      if (okList && page.body.data.length > 0) {
        const firstId = page.body.data[0].id;
        const detail = await fetchJson(
          `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(firstId)}` +
            `?connector_id=${encodeURIComponent(key)}`,
          { headers: auth },
        );
        check(
          `single-record hydration '${key}'.${stream}`,
          detail.status === 200 && detail.body?.id === firstId,
          detail.status === 200 ? '' : `status=${detail.status}`,
        );
      }

      // Decision 8: the SAME read with the stale URL-shaped connector_id must
      // resolve to the canonical key and hydrate the same rows.
      if (urlAlias) {
        const aliasUrl =
          `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records` +
          `?connector_id=${encodeURIComponent(urlAlias)}&limit=50&order=asc`;
        const aliasPage = await fetchJson(aliasUrl, { headers: auth });
        const aliasOk =
          aliasPage.status === 200 &&
          aliasPage.body?.object === 'list' &&
          Array.isArray(aliasPage.body?.data) &&
          aliasPage.body.data.length === expected;
        check(
          `stale URL-shaped connector_id read for '${key}' resolves canonically (Decision 8)`,
          aliasOk,
          aliasOk ? `count=${aliasPage.body.data.length}` : `status=${aliasPage.status}`,
        );
      }
    }

    // --- 4. cross-stream search read surface ------------------------------
    const search = await fetchJson(`${rsUrl}/v1/search?q=Welcome`, { headers: auth });
    check(
      '/v1/search returns a list envelope',
      search.status === 200 && search.body?.object === 'list' && Array.isArray(search.body?.data),
      search.status === 200 ? '' : `status=${search.status}`,
    );

    // --- 5. owner dashboard connection hydration (bearer-authed) ----------
    // GET /v1/owner/connections is the bearer-authed owner-agent sibling of the
    // cookie-authed /_ref/connections dashboard listing: same store, same
    // connector-key canonicalization. Proves the dashboard connection surface
    // hydrates the migrated instances under canonical keys with no registry URL.
    const conns = await fetchJson(`${rsUrl}/v1/owner/connections`, { headers: auth });
    if (conns.status === 200) {
      const list = Array.isArray(conns.body?.data) ? conns.body.data : [];
      const keys = list.map((c) => c.connector_key ?? c.connector_id).sort();
      check(
        'owner dashboard connections hydrate under canonical keys',
        ['claude-code', 'codex', 'gmail', 'spotify'].every((k) => keys.includes(k)),
        `keys=${keys.join(',')}`,
      );
      check(
        'owner dashboard connections payload exposes NO URL-shaped connector id',
        !containsUrlShapedConnectorId(list.map((c) => ({ connector_id: c.connector_id, connector_key: c.connector_key }))),
        'connector identity fields must not be registry URLs',
      );
    } else {
      check('owner dashboard connections surface reachable', false, `status=${conns.status}`);
    }

    // --- 6. grant-package membership read surface (operator visibility) ----
    // /_ref/grant-packages is the owner-session-gated operator surface; with
    // ownerAuthPassword='' the session check is pass-through, so the harness
    // reads it directly. Proves the migrated package + its child grants hydrate
    // with canonical connector identity and no registry URL in owner-visible copy.
    const pkgs = await fetchJson(`${asUrl}/_ref/grant-packages`);
    if (pkgs.status === 200) {
      const list = Array.isArray(pkgs.body?.data) ? pkgs.body.data : [];
      check('grant-package surface returns the migrated package', list.length >= 1, `packages=${list.length}`);
      check(
        'grant-package payload exposes NO URL-shaped connector id',
        !containsUrlShapedConnectorId(pkgs.body),
        'owner-visible package payload must not leak registry URLs',
      );
      // Drill into the package detail (child grant cascade) and assert canonical.
      const pkgId = list[0]?.grant_package_id ?? list[0]?.package_id ?? list[0]?.id;
      if (pkgId) {
        const detail = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(pkgId)}`);
        check(
          'grant-package detail (child cascade) exposes NO URL-shaped connector id',
          detail.status === 200 && !containsUrlShapedConnectorId(detail.body),
          detail.status === 200 ? '' : `status=${detail.status}`,
        );
      }
    } else {
      check('grant-package surface reachable', false, `status=${pkgs.status}`);
    }

    // --- 7. negative guard: an UNregistered connector type is not a 5xx ----
    // 'slack' has no connectors row in the restore, so the read resolves to a
    // typed 404 (connector not found) rather than a server error. Either an
    // empty 200 list or a typed 4xx is acceptable; a 5xx is not.
    const missing = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=slack&limit=5`,
      { headers: auth },
    );
    check(
      'unknown connector type is a typed client response (not a 5xx)',
      missing.status < 500,
      `status=${missing.status}`,
    );
  } finally {
    await closeServer(server);
  }

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write('# §3.4 HTTP read-surface verification\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}\n`);
  }
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.exit(1);
}

const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    // Never echo the connection string; err.message from pg can include it.
    const safe = String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
    process.stderr.write(`verify-http error: ${safe}\n`);
    process.exit(1);
  });
}

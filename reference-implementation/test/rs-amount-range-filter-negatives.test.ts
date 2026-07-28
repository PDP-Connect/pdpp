// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const POLYFILL_MANIFEST_DIR = join(REPO_ROOT, "packages/polyfill-connectors/manifests");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

type HarnessServer = Awaited<ReturnType<typeof startServer>>;

// @types/node's http2 declarations omit `closeAllConnections`, unlike
// http.Server, even though Node has shipped it on both since 15.x. Guard at
// runtime instead of casting the declared type away.
function hasCloseAllConnections(value: object): value is { closeAllConnections: () => void } {
  return typeof (value as { closeAllConnections?: unknown }).closeAllConnections === "function";
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  [key: string]: unknown;
}

interface TokenResponse {
  access_token: string;
  [key: string]: unknown;
}

interface RecordsResponse {
  data: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ChaseRecord {
  account_id: string;
  amount: number;
  currency: string;
  date: string;
  fitid: string;
  id: string;
}

interface HarnessUrls {
  asUrl: string;
  rsUrl: string;
}

function readManifest(name: string): { connector_id: string; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFEST_DIR, `${name}.json`), "utf8"));
}

async function closeServer(server: HarnessServer): Promise<void> {
  const { asServer, rsServer } = server;
  assert.ok(hasCloseAllConnections(asServer), "asServer must expose closeAllConnections");
  assert.ok(hasCloseAllConnections(rsServer), "rsServer must expose closeAllConnections");
  asServer.closeAllConnections();
  rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => asServer.close(() => resolve())),
    new Promise<void>((resolve) => rsServer.close(() => resolve())),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as DeviceAuthorizationResponse;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenResponseBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenBody = tokenResponseBody as TokenResponse;
  return tokenBody.access_token;
}

async function withHarness(fn: (urls: HarnessUrls) => Promise<void>): Promise<void> {
  const server: HarnessServer = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

async function registerManifest(
  asUrl: string,
  manifest: { connector_id: string; [key: string]: unknown }
): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: readonly ChaseRecord[]
): Promise<void> {
  const lines = records
    .map((record) =>
      JSON.stringify({
        data: record,
        emitted_at: record.date ? `${record.date}T00:00:00Z` : new Date().toISOString(),
        key: record.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: lines,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${connectorId} ${stream}: ${await resp.text()}`);
}

// Chase `transactions.amount` is a signed integer (cents): negative for debits,
// positive for credits. The stream advertises `amount` as a range filter. These
// records straddle zero so each predicate must be enforced for real: a filter
// that is silently ignored would let negatives leak through `gte=0` or let
// positives leak through `lte=-50000`.
const CHASE_RECORDS = [
  { account_id: "acct_1", amount: -75_000, currency: "USD", date: "2026-05-02", fitid: "f1", id: "big_debit" },
  { account_id: "acct_1", amount: -2000, currency: "USD", date: "2026-05-03", fitid: "f2", id: "small_debit" },
  { account_id: "acct_1", amount: 0, currency: "USD", date: "2026-05-04", fitid: "f3", id: "zero" },
  { account_id: "acct_1", amount: 5000, currency: "USD", date: "2026-05-05", fitid: "f4", id: "credit" },
  // Out of the date window below; guards the combined date+amount case.
  { account_id: "acct_1", amount: -90_000, currency: "USD", date: "2026-04-01", fitid: "f5", id: "old_big_debit" },
];

async function recordIdsFor(rsUrl: string, ownerToken: string, connectorId: string, query: string): Promise<string[]> {
  // biome-ignore lint/complexity/noUselessStringConcat: fixture intentionally tests concatenated input
  const url = `${rsUrl}/v1/streams/transactions/records` + `?connector_id=${encodeURIComponent(connectorId)}&${query}`;
  const { status, body } = await fetchJson(url, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(status, 200, `query ${query}: ${JSON.stringify(body)}`);
  const recordsBody = body as RecordsResponse;
  // biome-ignore lint/suspicious/useArraySortCompare: fixture ordering intentionally uses lexical default sort
  return recordsBody.data.map((record) => record.id).sort();
}

test("amount range filters are enforced across zero (negatives, combined date+amount)", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = readManifest("chase");
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl, "amount_range_owner");
    await seedStream(rsUrl, ownerToken, manifest.connector_id, "transactions", CHASE_RECORDS);

    // gte=0 must EXCLUDE negative amounts (the live-reported defect).
    assert.deepEqual(
      await recordIdsFor(rsUrl, ownerToken, manifest.connector_id, "filter[amount][gte]=0"),
      ["credit", "zero"],
      "filter[amount][gte]=0 must exclude negative amounts"
    );

    // lte=-50000 must exclude positives and small negatives.
    assert.deepEqual(
      await recordIdsFor(rsUrl, ownerToken, manifest.connector_id, "filter[amount][lte]=-50000"),
      ["big_debit", "old_big_debit"],
      "filter[amount][lte]=-50000 must keep only large debits"
    );

    // Date range alone (regression guard: the date filter is reported working).
    assert.deepEqual(
      await recordIdsFor(
        rsUrl,
        ownerToken,
        manifest.connector_id,
        "filter[date][gte]=2026-05-01&filter[date][lte]=2026-05-05"
      ),
      ["big_debit", "credit", "small_debit", "zero"],
      "filter[date] range must bound by date"
    );

    // Combined date + amount must honor BOTH predicates. Within the May window,
    // only big_debit is <= -50000; old_big_debit is excluded by the date bound.
    assert.deepEqual(
      await recordIdsFor(
        rsUrl,
        ownerToken,
        manifest.connector_id,
        "filter[date][gte]=2026-05-01&filter[date][lte]=2026-05-05&filter[amount][lte]=-50000"
      ),
      ["big_debit"],
      "combined date+amount must honor both predicates"
    );
  });
});

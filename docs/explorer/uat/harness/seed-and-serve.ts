// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Explorer live-fidelity UAT harness — seed + serve.
 *
 * Starts the reference AS (7662) + RS (7663) against a temp sqlite DB with the
 * OWNER GATE DISABLED (no PDPP_OWNER_PASSWORD), registers the REAL committed
 * chase + gmail manifests, mints an owner token via the same JSON device flow
 * the dashboard uses, seeds synthetic real-shaped records through the public
 * `POST /v1/ingest/:stream` path, then VERIFIES end-to-end that:
 *   - GET /v1/streams/:stream surfaces the declared `field_capabilities[].type`
 *     (chase.amount=currency, gmail.from_name=person, …);
 *   - the seeded records read back through GET /v1/streams/:stream/records.
 *
 * It then stays alive so the Next.js dashboard (pointed at 7662/7663, owner gate
 * also disabled) can render `/explore` against this exact data.
 *
 * Run: node --import tsx docs/explorer/uat/harness/seed-and-serve.ts
 * Env: PDPP_DB_PATH (optional; defaults to a temp file beside this script).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHASE_CONNECTOR_ID, CHASE_TRANSACTIONS, GMAIL_CONNECTOR_ID, GMAIL_MESSAGES } from "./fixtures.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
// harness lives at docs/explorer/uat/harness/ — repo root is four levels up.
const ROOT = join(__dir, "../../../..");
const MANIFESTS_DIR = join(ROOT, "packages/polyfill-connectors/manifests");

const AS_PORT = Number(process.env.AS_PORT || 7662);
const RS_PORT = Number(process.env.RS_PORT || 7663);
const AS_URL = `http://localhost:${AS_PORT}`;
const RS_URL = `http://localhost:${RS_PORT}`;
// Default the sqlite under the repo's gitignored tmp/ so a harness run never
// dirties this tracked directory.
const DB_PATH = process.env.PDPP_DB_PATH || join(ROOT, "tmp/explorer-uat-harness.sqlite");

const CLIENT_ID = "pdpp-polyfill-owner-bootstrap"; // same client the dashboard uses

interface Manifest {
  connector_key: string;
  [field: string]: unknown;
}
interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}
interface TokenResponse {
  access_token: string;
}
interface FieldCapability {
  type?: string;
}
type FieldCapabilities = Record<string, FieldCapability | undefined>;
interface IngestResult {
  records_accepted: number;
}
interface RecordsResponse {
  data: unknown[];
}

function loadManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, name), "utf8"));
}

async function jsonFetch<Body>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: Body }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body = (text ? JSON.parse(text) : null) as Body;
  return { status: resp.status, body };
}

/** Mint an owner token via the JSON device flow (owner gate disabled → auto-approve, default subject). */
async function mintOwnerToken(): Promise<string> {
  const { status: ds, body: device } = await jsonFetch<DeviceAuthorization>(`${AS_URL}/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (ds !== 200) {
    throw new Error(`device_authorization failed (${ds}): ${JSON.stringify(device)}`);
  }
  const { status: as } = await jsonFetch(`${AS_URL}/device/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_code: device.user_code }),
  });
  if (as !== 200) {
    throw new Error(`device/approve failed (${as})`);
  }
  const { status: ts, body: tok } = await jsonFetch<TokenResponse>(`${AS_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: CLIENT_ID,
    }),
  });
  if (ts !== 200) {
    throw new Error(`token failed (${ts}): ${JSON.stringify(tok)}`);
  }
  return tok.access_token;
}

async function registerManifest(manifest: Manifest): Promise<void> {
  const resp = await fetch(`${AS_URL}/connectors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (resp.status !== 201 && resp.status !== 200) {
    throw new Error(`register ${manifest.connector_key} failed (${resp.status}): ${await resp.text()}`);
  }
}

async function ingest(
  token: string,
  connectorId: string,
  stream: string,
  records: Record<string, unknown>[],
  timeField: string
): Promise<IngestResult> {
  const lines = records.map((r) => JSON.stringify({ key: r.id, data: r, emitted_at: r[timeField] })).join("\n");
  const { status, body } = await jsonFetch<IngestResult>(
    `${RS_URL}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
      body: lines,
    }
  );
  if (status !== 200) {
    throw new Error(`ingest ${stream} failed (${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function readFieldCapabilities(token: string, connectorId: string, stream: string): Promise<FieldCapabilities> {
  const { status, body } = await jsonFetch<{ field_capabilities?: FieldCapabilities }>(
    `${RS_URL}/v1/streams/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) {
    throw new Error(`GET /v1/streams/${stream} failed (${status})`);
  }
  return body.field_capabilities || {};
}

async function readRecords(token: string, connectorId: string, stream: string, limit = 5): Promise<unknown[]> {
  const { status, body } = await jsonFetch<RecordsResponse>(
    `${RS_URL}/v1/streams/${encodeURIComponent(stream)}/records?connector_id=${encodeURIComponent(connectorId)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (status !== 200) {
    throw new Error(`GET records ${stream} failed (${status})`);
  }
  return body.data || [];
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
}

interface ReferenceServer {
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
}

async function main() {
  process.env.PDPP_DB_PATH = DB_PATH;
  process.env.AS_PORT = String(AS_PORT);
  process.env.RS_PORT = String(RS_PORT);
  // Owner gate disabled: do NOT set PDPP_OWNER_PASSWORD. Device flow auto-approves.
  delete process.env.PDPP_OWNER_PASSWORD;

  interface StartServerOptions {
    asPort: number;
    dbPath: string;
    quiet: boolean;
    rsPort: number;
  }
  const { startServer }: { startServer: (options: StartServerOptions) => Promise<ReferenceServer> } = await import(
    new URL("../../../../reference-implementation/server/index.js", import.meta.url).href
  );
  const server = await startServer({
    quiet: true,
    asPort: AS_PORT,
    rsPort: RS_PORT,
    dbPath: DB_PATH,
  });
  console.log(`[uat] AS ${AS_URL} · RS ${RS_URL} · db ${DB_PATH}`);

  const token = await mintOwnerToken();
  console.log("[uat] owner token minted");

  await registerManifest(loadManifest("chase.json"));
  await registerManifest(loadManifest("gmail.json"));
  console.log("[uat] manifests registered: chase, gmail");

  const chaseIngest = await ingest(token, CHASE_CONNECTOR_ID, "transactions", CHASE_TRANSACTIONS, "fetched_at");
  const gmailIngest = await ingest(token, GMAIL_CONNECTOR_ID, "messages", GMAIL_MESSAGES, "received_at");
  console.log(
    `[uat] seeded: chase/transactions accepted=${chaseIngest.records_accepted} · gmail/messages accepted=${gmailIngest.records_accepted}`
  );
  assert(chaseIngest.records_accepted === CHASE_TRANSACTIONS.length, "all chase rows accepted");
  assert(gmailIngest.records_accepted === GMAIL_MESSAGES.length, "all gmail rows accepted");

  // ── Verify declared presentation types surface on the live read path ──
  const chaseFc = await readFieldCapabilities(token, CHASE_CONNECTOR_ID, "transactions");
  assert(chaseFc.amount?.type === "currency", `chase.amount.type=currency (got ${chaseFc.amount?.type})`);
  assert(chaseFc.date?.type === "timestamp", `chase.date.type=timestamp (got ${chaseFc.date?.type})`);
  assert(chaseFc.name?.type === "text", `chase.name.type=text (got ${chaseFc.name?.type})`);
  assert(!Object.hasOwn(chaseFc.memo || {}, "type"), "chase.memo omits type (honest absence)");

  const gmailFc = await readFieldCapabilities(token, GMAIL_CONNECTOR_ID, "messages");
  assert(gmailFc.from_name?.type === "person", `gmail.from_name.type=person (got ${gmailFc.from_name?.type})`);
  assert(gmailFc.subject?.type === "text", `gmail.subject.type=text (got ${gmailFc.subject?.type})`);
  assert(gmailFc.snippet?.type === "text", `gmail.snippet.type=text (got ${gmailFc.snippet?.type})`);
  assert(gmailFc.date?.type === "timestamp", `gmail.date.type=timestamp (got ${gmailFc.date?.type})`);
  assert(!Object.hasOwn(gmailFc.from_email || {}, "type"), "gmail.from_email omits type (honest absence)");

  // ── Verify the seeded records read back ──
  const chaseRecs = await readRecords(token, CHASE_CONNECTOR_ID, "transactions");
  const gmailRecs = await readRecords(token, GMAIL_CONNECTOR_ID, "messages");
  assert(chaseRecs.length >= 1, "chase records read back");
  assert(gmailRecs.length >= 1, "gmail records read back");

  console.log("[uat] VERIFY OK: declared types surface + records read back");
  console.log("[uat] READY — dashboard may now load /explore against this stack");
  console.log("[uat] (process stays alive; SIGINT/SIGTERM to stop)");

  // Stay alive for the dashboard + browser capture.
  const keepalive = setInterval(() => {
    // no-op: setInterval just needs to hold the event loop open.
  }, 2 ** 30);
  const shutdown = () => {
    clearInterval(keepalive);
    try {
      server.asServer.closeAllConnections?.();
      server.rsServer.closeAllConnections?.();
    } catch {
      // best-effort connection drain before close below.
    }
    server.asServer.close(() => {
      // no-op: process.exit below does not wait on this callback.
    });
    server.rsServer.close(() => {
      // no-op: process.exit below does not wait on this callback.
    });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[uat] FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

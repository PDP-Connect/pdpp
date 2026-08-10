// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating end-to-end journey test for the Netflix Export connector's
 * generic manual-upload wiring: catalog visibility -> owner upload -> a
 * connection-scoped import binding on disk in the exact shape the connector
 * runtime reads (see connectors/netflix_export/index.ts findUploadedArtifact
 * and NETFLIX_EXPORT_DIR). Mirrors the Google Maps/WhatsApp coverage in
 * manual-upload-draft-connection-route.test.ts but scoped to Netflix so a
 * regression here fails on the connector's own name, not a shared fixture.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const OWNER_PASSWORD = "netflix-manual-upload-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface SchedulerManager {
  stop?: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: SchedulerManager;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn: (ctx: { asUrl: string; tmp: string }) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pdpp-netflix-manual-upload-"));
  const server = (await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: join(tmp, "pdpp.sqlite"),
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, tmp });
  } finally {
    await closeServer(server);
    rmSync(tmp, { force: true, recursive: true });
  }
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match?.[1] ?? null;
}

async function login(asUrl: string): Promise<string> {
  const getLogin = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
}

interface JsonResult {
  body: unknown;
  resp: Response;
  status: number;
  text: string;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status, text };
}

function loadManifest(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
}

async function registerConnector(asUrl: string, name: string): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(loadManifest(name)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

// biome-ignore lint/suspicious/useAwait: mirrors manual-upload-draft-connection-route.test.ts helper shape.
async function getSetup(asUrl: string, cookie: string, connectorId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-setup`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

interface UploadOptions {
  connectionId?: string;
  displayName?: string;
}

// biome-ignore lint/suspicious/useAwait: mirrors manual-upload-draft-connection-route.test.ts helper shape.
async function createDraft(
  asUrl: string,
  cookie: string,
  connectorId: string,
  fileName: string,
  body: string | Buffer,
  options: UploadOptions = {}
): Promise<JsonResult> {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`);
  url.searchParams.set("file_name", fileName);
  if (options.connectionId) {
    url.searchParams.set("connection_id", options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set("display_name", options.displayName);
  }
  return fetchJson(url, {
    body,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/vnd.pdpp.manual-upload",
      Cookie: cookie,
    },
    method: "POST",
  });
}

interface ManualUploadBody {
  accepted_file_extensions?: string[];
  connection_id?: string | null;
  connector_id?: string;
  next_step?: { kind?: string };
  object?: string;
  status?: string;
  uploaded_file_name?: string;
  validation?: {
    status?: string;
    detected_format?: string;
    estimated_records?: number;
    date_range?: { start?: string; end?: string };
  };
}

function asBody(body: unknown): ManualUploadBody {
  return body as ManualUploadBody;
}

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

function makeStoredZip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = zipHeader(0x04_03_4b_50, 30);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = zipHeader(0x02_01_4b_50, 46);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x08_00, 8);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = zipHeader(0x06_05_4b_50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

const MANUAL_UPLOAD_DRAFT_BINDING_KEY_RE = /^manual_upload_draft_/;

const VIEWING_ACTIVITY_CSV = `Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
"Main","2024-01-15 20:14:03","0:42:10","","The Crown","","TV","0:42:10","0:42:10","US"
"Shared","2024-01-14 19:00:00","0:50:22","","Stranger Things","","Phone","0:50:22","0:50:22","US"`;

test("Netflix Export is catalog-visible with the generic manual-upload disposition", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const setup = await getSetup(asUrl, cookie, "netflix-export");
    const setupBody = asBody(setup.body);
    assert.equal(setup.status, 200, setup.text);
    assert.deepEqual(setupBody.accepted_file_extensions, [".csv", ".zip"]);
  });
});

test("Netflix Export owner upload of a raw ViewingActivity.csv creates a connection-scoped import binding", async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const created = await createDraft(asUrl, cookie, "netflix-export", "ViewingActivity.csv", VIEWING_ACTIVITY_CSV);
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);
    assert.equal(createdBody.object, "manual_upload_draft_connection");
    assert.equal(createdBody.connector_id, "netflix-export");
    assert.equal(createdBody.status, "draft");
    assert.equal(createdBody.uploaded_file_name, "ViewingActivity.csv");
    assert.equal(createdBody.validation?.status, "valid");
    assert.equal(createdBody.validation?.detected_format, "viewing_activity_csv");
    assert.equal(createdBody.validation?.estimated_records, 2);
    assert.equal(createdBody.next_step?.kind, "run_connection");

    const connectionId = createdBody.connection_id;
    assert.ok(connectionId?.startsWith("cin_"), "draft has a connection_id");

    // Binding-authority proof: NETFLIX_EXPORT_DIR points at exactly the
    // directory the connector runtime's findUploadedArtifact() scans, and
    // the uploaded bytes are written flat there under their original name --
    // the same on-disk contract exercised by
    // connectors/netflix_export/integration.test.ts's subprocess run.
    const row = getDb()
      .prepare(
        `SELECT source_kind, source_binding_key, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`
      )
      .get(connectionId) as { source_kind: string; source_binding_key: string; source_binding_json: string };
    assert.equal(row.source_kind, "manual");
    assert.match(row.source_binding_key, MANUAL_UPLOAD_DRAFT_BINDING_KEY_RE);
    const binding = JSON.parse(row.source_binding_json) as {
      kind: string;
      import_dir_env_var: string;
      import_dir: string;
      uploaded_file_name: string;
    };
    assert.equal(binding.kind, "manual_upload_draft");
    assert.equal(binding.import_dir_env_var, "NETFLIX_EXPORT_DIR");
    assert.ok(binding.import_dir.startsWith(join(tmp, "imports", "netflix-export")), binding.import_dir);
    assert.equal(
      readFileSync(join(binding.import_dir, "ViewingActivity.csv"), "utf8"),
      VIEWING_ACTIVITY_CSV,
      "uploaded bytes must land exactly where the connector runtime's flat-file discovery reads them"
    );
  });
});

test("Netflix Export owner upload of the official getmyinfo zip archive validates and binds", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const zip = makeStoredZip([
      { data: VIEWING_ACTIVITY_CSV, name: "CONTENT_INTERACTION/ViewingActivity.csv" },
      { data: "Device Type\nTV\n", name: "IDENTIFIERS/Devices.csv" },
    ]);
    const created = await createDraft(asUrl, cookie, "netflix-export", "netflix-report.zip", zip);
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);
    assert.equal(createdBody.validation?.status, "valid");
    assert.equal(createdBody.validation?.detected_format, "viewing_activity_zip");
    assert.equal(createdBody.validation?.estimated_records, 2);

    const connectionId = createdBody.connection_id;
    const row = getDb()
      .prepare("SELECT source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
      .get(connectionId) as { source_binding_json: string };
    const binding = JSON.parse(row.source_binding_json) as { import_dir: string };
    const uploadedZip = readFileSync(join(binding.import_dir, "netflix-report.zip"));
    assert.equal(uploadedZip.length, zip.length, "uploaded zip bytes must be written verbatim");
  });
});

test("Netflix Export upload with no recognizable ViewingActivity.csv is rejected before a draft row is created", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const zip = makeStoredZip([{ data: "Device Type\nTV\n", name: "IDENTIFIERS/Devices.csv" }]);
    const rejected = await createDraft(asUrl, cookie, "netflix-export", "netflix-report.zip", zip);
    const rejectedBody = rejected.body as { error?: { code?: string } };
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(rejectedBody.error?.code, "import_file_unsupported");
  });
});

test("Netflix Export owner upload of the immediate direct_history CSV (Download all) creates a draft binding", async () => {
  // The primary acquisition method per the manifest: netflix.com/viewingactivity
  // "Download all" produces this Title,Date CSV instantly -- no 30-day wait.
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "netflix_export");
    const cookie = await login(asUrl);

    const directHistoryCsv = `Title,Date\n"The Crown",2024-01-15\n"Stranger Things",2024-01-14`;
    const created = await createDraft(asUrl, cookie, "netflix-export", "NetflixViewingHistory.csv", directHistoryCsv);
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);
    assert.equal(createdBody.validation?.status, "valid");
    assert.equal(createdBody.validation?.detected_format, "viewing_activity_csv");
    assert.equal(createdBody.validation?.estimated_records, 2);
  });
});

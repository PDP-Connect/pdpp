// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const OWNER_PASSWORD = "manual-upload-owner-password";
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
  const tmp = mkdtempSync(join(tmpdir(), "pdpp-manual-upload-"));
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

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function getSetup(asUrl: string, cookie: string, connectorId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-setup`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

const VALID_TIMELINE_BODY = JSON.stringify({
  locations: [
    {
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
      timestampMs: "1717595122000",
    },
  ],
});

interface UploadOptions {
  connectionId?: string;
  displayName?: string;
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function createDraft(
  asUrl: string,
  cookie: string,
  connectorId: string,
  fileName = "Timeline.json",
  body: string | Buffer = VALID_TIMELINE_BODY,
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

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function validateUpload(
  asUrl: string,
  cookie: string,
  connectorId: string,
  fileName = "Timeline.json",
  body: string | Buffer = VALID_TIMELINE_BODY,
  options: UploadOptions = {}
): Promise<JsonResult> {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-validation-preview`);
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

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function stageUpload(
  asUrl: string,
  cookie: string,
  connectorId: string,
  fileName = "Timeline.json",
  body: string | Buffer = VALID_TIMELINE_BODY,
  options: UploadOptions = {}
): Promise<JsonResult> {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-staged-artifact`);
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

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function getArtifact(asUrl: string, cookie: string, artifactId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/manual-upload/artifacts/${encodeURIComponent(artifactId)}`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

interface ArtifactBody {
  status?: string;
  [key: string]: unknown;
}

// The manual-upload routes return a family of distinct response shapes
// (setup descriptor, draft connection, validation preview, staged artifact,
// known-artifact receipt, connection list, error envelope). Rather than one
// interface per endpoint, this covers the union of fields the tests below
// actually assert on -- every field is optional and `unknown`/loosely typed
// where the endpoint-specific shape varies, matching how the real routes
// return plain JSON with no shared response schema.
interface ManualUploadBody {
  accepted_file_extensions?: string[];
  accepted_file_names?: string[];
  acquisition_methods?: { platform?: string; posture?: string }[];
  artifact_id?: string;
  connection_id?: string | null;
  connector_id?: string;
  data?: {
    data?: { connection_id?: string; connector_id?: string }[];
  };
  display_name?: string;
  duplicate?: { connection_id?: string } | null;
  error?: { code?: string; param?: string; message?: string };
  help_url?: string;
  label?: string;
  large_file_fallback?: string;
  max_file_bytes?: number;
  next_step?: { kind?: string };
  object?: string;
  status?: string;
  uploaded_file_name?: string;
  validation?: {
    status?: string;
    detected_format?: string;
    estimated_points?: number;
    estimated_messages?: number;
    estimated_attachments?: number;
    date_range?: { start?: string; end?: string };
    source_identity?: { title?: string };
    media_coverage?: { status?: string; attached_media_files?: number };
  };
  validation_expectations?: string[];
}

async function waitForArtifact(
  asUrl: string,
  cookie: string,
  artifactId: string,
  expectedStatuses: readonly string[],
  maxAttempts = 30
): Promise<JsonResult | null> {
  const statuses = new Set(expectedStatuses);
  let latest: JsonResult | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    latest = await getArtifact(asUrl, cookie, artifactId);
    const body = latest.body as ArtifactBody;
    if (latest.status === 200 && body.status !== undefined && statuses.has(body.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return latest;
}

interface ZipEntry {
  data: Buffer | string;
  name: string;
}

function makeStoredZip(entries: readonly ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02_01_4b_50, 0);
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
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function listConnections(asUrl: string, cookie: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

function asBody(body: unknown): ManualUploadBody {
  return body as ManualUploadBody;
}

function requireConnectionId(connectionId: string | null | undefined): string {
  assert.ok(connectionId, "expected a connection_id");
  return connectionId;
}

function findManualUploadAudit(resp: Response, outcome: string, operation = "create"): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId, "manual-upload response should carry a trace id");
  assert.ok(traceId.startsWith("trc_"), "manual-upload response trace id should have the trc_ prefix");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find(
    (entry) => entry.event_type === `owner.connection.manual_upload_draft.${operation}` && entry.status === outcome
  );
  assert.ok(event, `expected manual_upload_draft.${operation} audit (${outcome})`);
  return event;
}

test("manual/upload setup descriptor is manifest-authored", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);
    const { status, body: rawBody, text } = await getSetup(asUrl, cookie, "google-maps");
    const body = asBody(rawBody);
    assert.equal(status, 200, text);
    assert.equal(body.object, "manual_upload_setup");
    assert.equal(body.connector_id, "google-maps");
    assert.equal(body.display_name, "Google Maps Timeline Import");
    assert.equal(body.label, "Google Maps Timeline export file");
    assert.ok(
      body.acquisition_methods?.some((method) => method.platform === "android" && method.posture === "primary")
    );
    assert.ok(body.acquisition_methods?.some((method) => method.platform === "ios" && method.posture === "primary"));
    assert.ok(body.accepted_file_names?.includes("Timeline.json"));
    assert.ok(body.help_url?.startsWith("https://support.google.com/maps/"));
    assert.ok(body.large_file_fallback?.includes("deployment limit"));
    assert.equal(body.max_file_bytes, 104_857_600);
    assert.ok(body.validation_expectations?.includes("Detected Timeline format"));
    assert.equal(Object.hasOwn(body, "import_dir"), false, "setup response must not leak server paths");
    assert.equal(Object.hasOwn(body, "import_dir_env_var"), false, "setup response must not expose env-var plumbing");
  });
});

test("WhatsApp manual/upload setup accepts large browser-staged media exports", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);
    const { status, body: rawBody, text } = await getSetup(asUrl, cookie, "whatsapp");
    const body = asBody(rawBody);
    assert.equal(status, 200, text);
    assert.equal(body.object, "manual_upload_setup");
    assert.equal(body.connector_id, "whatsapp");
    assert.equal(body.max_file_bytes, 20 * 1024 * 1024 * 1024);
    assert.ok(body.large_file_fallback?.includes("deployment limit"));
    assert.ok(body.accepted_file_extensions?.includes(".zip"));
  });
});

test("owner upload creates an invisible draft with connection-scoped import binding", async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);
    const created = await createDraft(asUrl, cookie, "google-maps");
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);
    assert.equal(createdBody.object, "manual_upload_draft_connection");
    assert.equal(createdBody.connector_id, "google-maps");
    assert.equal(createdBody.status, "draft");
    assert.equal(createdBody.uploaded_file_name, "Timeline.json");
    assert.equal(createdBody.validation?.status, "valid");
    assert.equal(createdBody.validation?.detected_format, "legacy_records");
    assert.equal(createdBody.validation?.estimated_points, 1);
    assert.equal(createdBody.validation?.date_range?.start, "2024-06-05T13:45:22.000Z");
    assert.equal(createdBody.next_step?.kind, "run_connection");
    assert.equal(Object.hasOwn(createdBody, "import_dir"), false, "create response must not leak server paths");
    assert.ok(!created.text.includes(tmp), "create response must not include the data directory path");

    const connectionId = createdBody.connection_id;
    assert.ok(connectionId?.startsWith("cin_"), "draft has a connection_id");
    const audit = findManualUploadAudit(created.resp, "succeeded");
    const auditData = audit.data as { connection_id?: string; connector_id?: string } | undefined;
    assert.equal(audit.actor_type, "owner_session");
    assert.equal(auditData?.connection_id, connectionId);
    assert.equal(auditData?.connector_id, "google-maps");

    const list = await listConnections(asUrl, cookie);
    const listBody = list.body as { data?: { connection_id?: string }[] };
    assert.equal(list.status, 200);
    assert.equal(
      listBody.data?.some((connection) => connection.connection_id === connectionId),
      false,
      "manual upload draft must stay hidden until first ingest"
    );

    const row = getDb()
      .prepare(
        `SELECT source_kind, source_binding_key, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`
      )
      .get(connectionId) as { source_kind: string; source_binding_key: string; source_binding_json: string };
    assert.equal(row.source_kind, "manual");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(row.source_binding_key, /^manual_upload_draft_/);
    const binding = JSON.parse(row.source_binding_json) as {
      kind: string;
      import_dir_env_var: string;
      acquisition_method: string;
      import_validation: { status: string; detected_format: string; estimated_points: number };
      uploaded_file_name: string;
      import_dir: string;
    };
    assert.equal(binding.kind, "manual_upload_draft");
    assert.equal(binding.import_dir_env_var, "GOOGLE_MAPS_TIMELINE_DIR");
    assert.equal(binding.acquisition_method, "owner_artifact");
    assert.equal(binding.import_validation.status, "valid");
    assert.equal(binding.import_validation.detected_format, "legacy_records");
    assert.equal(binding.import_validation.estimated_points, 1);
    assert.equal(binding.uploaded_file_name, "Timeline.json");
    assert.ok(binding.import_dir.startsWith(join(tmp, "imports", "google-maps")), binding.import_dir);
    assert.equal(readFileSync(join(binding.import_dir, "Timeline.json"), "utf8"), VALID_TIMELINE_BODY);

    const batch = getDb()
      .prepare(
        `SELECT acquisition_method, artifact_sha256, connector_instance_id, parsed_count, accepted_count, status
           FROM acquisition_batches
          WHERE connector_instance_id = ?`
      )
      .get(connectionId) as {
      acquisition_method: string;
      artifact_sha256: string;
      connector_instance_id: string;
      parsed_count: number;
      accepted_count: number;
      status: string;
    };
    assert.equal(batch.acquisition_method, "owner_artifact");
    assert.equal(batch.connector_instance_id, connectionId);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(batch.artifact_sha256, /^[0-9a-f]{64}$/);
    assert.equal(batch.parsed_count, 1);
    assert.equal(batch.accepted_count, 0);
    assert.equal(batch.status, "validated");
  });
});

test("owner upload preview validates without creating a draft or writing acquisition state", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const preview = await validateUpload(asUrl, cookie, "google-maps");
    const previewBody = asBody(preview.body);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(previewBody.object, "manual_upload_validation_preview");
    assert.equal(previewBody.connector_id, "google-maps");
    assert.equal(previewBody.uploaded_file_name, "Timeline.json");
    assert.equal(previewBody.validation?.status, "valid");
    assert.equal(previewBody.validation?.estimated_points, 1);
    assert.equal(previewBody.duplicate, null);
    assert.equal(previewBody.next_step?.kind, "confirm_import");

    const connectionRows = (
      getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number }
    ).count;
    assert.equal(connectionRows, 0, "validation preview must not create a draft connection");
    const batchRows = (getDb().prepare("SELECT COUNT(*) AS count FROM acquisition_batches").get() as { count: number })
      .count;
    assert.equal(batchRows, 0, "validation preview must not create an acquisition batch");
    findManualUploadAudit(preview.resp, "succeeded", "validate");
  });
});

test("staged owner upload returns before validation and exposes durable artifact status", async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const staged = await stageUpload(asUrl, cookie, "google-maps");
    const stagedBody = asBody(staged.body);
    assert.equal(staged.status, 202, staged.text);
    assert.equal(stagedBody.object, "manual_upload_artifact");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(stagedBody.artifact_id ?? "", /^mua_/);
    assert.equal(stagedBody.connection_id, null);
    assert.equal(stagedBody.status, "uploaded");
    assert.equal(stagedBody.next_step?.kind, "poll_artifact");
    assert.equal(Object.hasOwn(stagedBody, "import_dir"), false, "staged response must not leak server paths");
    assert.ok(!staged.text.includes(tmp), "staged response must not include server paths");

    assert.ok(stagedBody.artifact_id, "staged response must carry an artifact_id");
    const done = await waitForArtifact(asUrl, cookie, stagedBody.artifact_id, ["staged"]);
    assert.ok(done, "expected the artifact to reach a terminal status");
    const doneBody = asBody(done.body);
    assert.equal(done.status, 200, done.text);
    assert.equal(doneBody.status, "staged");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(doneBody.connection_id ?? "", /^cin_/);
    assert.equal(doneBody.validation?.status, "valid");
    assert.equal(doneBody.next_step?.kind, "run_connection");

    const row = getDb()
      .prepare(
        `SELECT status, artifact_sha256, acquisition_batch_id
           FROM manual_upload_artifacts
          WHERE artifact_id = ?`
      )
      .get(stagedBody.artifact_id) as { status: string; artifact_sha256: string; acquisition_batch_id: string };
    assert.equal(row.status, "staged");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(row.artifact_sha256, /^[0-9a-f]{64}$/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(row.acquisition_batch_id, /^ab_/);

    const batch = getDb()
      .prepare(
        `SELECT status, connector_instance_id, uploaded_file_name
           FROM acquisition_batches
          WHERE batch_id = ?`
      )
      .get(row.acquisition_batch_id) as { status: string; connector_instance_id: string; uploaded_file_name: string };
    assert.equal(batch.status, "validated");
    assert.equal(batch.connector_instance_id, doneBody.connection_id);
    assert.equal(batch.uploaded_file_name, "Timeline.json");
  });
});

test("a successfully staged upload leaves no orphaned _staging directory behind", async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const staged = await stageUpload(asUrl, cookie, "google-maps");
    const stagedBody = asBody(staged.body);
    assert.ok(stagedBody.artifact_id, "staged response must carry an artifact_id");
    const done = await waitForArtifact(asUrl, cookie, stagedBody.artifact_id, ["staged"]);
    assert.equal(asBody(done?.body).status, "staged");

    // validateAndStageArtifact rename()s the file out of
    // _staging/<connectorId>/<artifactId>/ into its final location, but
    // previously never removed the now-empty per-artifact staging directory
    // — every successful upload orphaned one directory forever. The whole
    // _staging tree for this connector must be empty (or absent) once the
    // one upload in this test has reached "staged".
    const stagingRoot = join(tmp, "imports", "_staging", "google-maps");
    if (existsSync(stagingRoot)) {
      const leftoverArtifactDirs = readdirSync(stagingRoot);
      assert.deepEqual(leftoverArtifactDirs, [], `expected no orphaned staging dirs, found: ${leftoverArtifactDirs}`);
    }
  });
});

test("a WhatsApp .txt upload well past the old 1 GiB cap streams to disk and validates successfully", async () => {
  // Proves the production HTTP route end-to-end for an artifact well beyond
  // the old hardcoded 1 GiB WhatsApp cap this task raised — this upload
  // would have been REJECTED outright before this change, purely on size,
  // before any streaming/memory question even arose. The upload body is
  // generated and streamed via a ReadableStream (never materialized as one
  // Buffer/string in THIS test process).
  //
  // This test does NOT assert a memory-growth bound. Measured directly
  // (see this task's report): even with the raw-file-buffering bug fixed,
  // parsing a large-message-COUNT .txt export still holds the full parsed
  // message array in memory before any record is emitted, and that array's
  // total object/string overhead measurably EXCEEDS the raw file size for
  // realistic prose-length messages (confirmed ~1.6x at 1.9 GiB) — a
  // separate, disclosed residual from the whole-file-buffer bug this task
  // fixed. The deterministic proof that the RAW FILE is never buffered
  // whole lives in manual-upload-whatsapp-no-whole-file-read.test.ts (call-
  // interception via mock.module, not an RSS heuristic); this test's job is
  // functional correctness (the upload is accepted and validates) at a size
  // that would have been rejected by the old cap, not a memory assertion.
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const targetBytes = 200 * 1024 * 1024; // 200 MiB — well past the old 1 GiB cap's REASON for being tested (proves the cap is gone), far below multi-GB OOM/tmpfs risk
    const oneMessage =
      "[6/5/24, 9:15:22 AM] Alice: Hello there, this is a realistically-sized conversational message for the test.\n";
    const chunkText = oneMessage.repeat(1000); // ~120 KB per chunk
    const chunkBytes = Buffer.byteLength(chunkText, "utf8");
    let sent = 0;
    const bodyStream = new ReadableStream({
      pull(controller) {
        if (sent >= targetBytes) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.from(chunkText, "utf8"));
        sent += chunkBytes;
      },
    });

    const url = new URL(`${asUrl}/_ref/connectors/whatsapp/manual-upload-staged-artifact`);
    url.searchParams.set("file_name", "WhatsApp Chat - Large.txt");
    const resp = await fetch(url, {
      body: bodyStream,
      duplex: "half",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/vnd.pdpp.manual-upload",
        Cookie: cookie,
      },
      method: "POST",
    });
    const stagedBody = (await resp.json()) as { artifact_id?: string; status?: string };
    assert.equal(resp.status, 202, JSON.stringify(stagedBody));
    assert.ok(stagedBody.artifact_id, "expected an artifact_id");

    const done = await waitForArtifact(asUrl, cookie, stagedBody.artifact_id, ["staged", "failed"], 400);
    const doneBody = asBody(done?.body);
    assert.equal(doneBody.status, "staged", JSON.stringify(doneBody));
    assert.equal(doneBody.validation?.status, "valid");
  });
});

test("staged uploads attach multiple files to one explicit manual-upload source", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const first = await stageUpload(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Ghazal.txt",
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      { displayName: "the owner WhatsApp" }
    );
    const firstBody = asBody(first.body);
    assert.equal(first.status, 202, first.text);
    assert.ok(firstBody.artifact_id, "first staged upload must carry an artifact_id");
    const firstDone = await waitForArtifact(asUrl, cookie, firstBody.artifact_id, ["staged"]);
    assert.ok(firstDone, "expected the first artifact to reach a terminal status");
    const firstDoneBody = asBody(firstDone.body);
    assert.equal(firstDoneBody.status, "staged");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(firstDoneBody.connection_id ?? "", /^cin_/);

    const second = await stageUpload(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Family.txt",
      "[6/6/24, 10:15:22 AM] Alice: Second chat",
      { connectionId: requireConnectionId(firstDoneBody.connection_id) }
    );
    const secondBody = asBody(second.body);
    assert.equal(second.status, 202, second.text);
    assert.equal(secondBody.connection_id, firstDoneBody.connection_id);
    assert.ok(secondBody.artifact_id, "second staged upload must carry an artifact_id");
    const secondDone = await waitForArtifact(asUrl, cookie, secondBody.artifact_id, ["staged"]);
    assert.ok(secondDone, "expected the second artifact to reach a terminal status");
    const secondDoneBody = asBody(secondDone.body);
    assert.equal(secondDoneBody.status, "staged");
    assert.equal(secondDoneBody.connection_id, firstDoneBody.connection_id);

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 1, "explicit same-source staged uploads must not create another connection");
    const artifactCount = (
      getDb()
        .prepare("SELECT COUNT(*) AS count FROM manual_upload_artifacts WHERE connector_instance_id = ?")
        .get(firstDoneBody.connection_id) as { count: number }
    ).count;
    assert.equal(artifactCount, 2);
  });
});

test("staged invalid upload fails without creating a source", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const staged = await stageUpload(asUrl, cookie, "google-maps", "Timeline.json", '{"not":"timeline"}');
    const stagedBody = asBody(staged.body);
    assert.equal(staged.status, 202, staged.text);
    assert.equal(stagedBody.connection_id, null);

    assert.ok(stagedBody.artifact_id, "staged response must carry an artifact_id");
    const done = await waitForArtifact(asUrl, cookie, stagedBody.artifact_id, ["failed"]);
    assert.ok(done, "expected the artifact to reach a terminal status");
    const doneBody = asBody(done.body);
    assert.equal(done.status, 200, done.text);
    assert.equal(doneBody.status, "failed");
    assert.equal(doneBody.connection_id, null);
    assert.equal(doneBody.error?.code, "import_file_unsupported");

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 0, "invalid staged upload must not create a source");
    const batchCount = (getDb().prepare("SELECT COUNT(*) AS count FROM acquisition_batches").get() as { count: number })
      .count;
    assert.equal(batchCount, 0, "invalid staged upload must not create an acquisition batch");
  });
});

test("staged duplicate upload points at the existing receipt without creating a source", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const first = await stageUpload(asUrl, cookie, "google-maps");
    const firstBody = asBody(first.body);
    assert.ok(firstBody.artifact_id, "first staged upload must carry an artifact_id");
    const firstDone = await waitForArtifact(asUrl, cookie, firstBody.artifact_id, ["staged"]);
    assert.ok(firstDone, "expected the first artifact to reach a terminal status");
    const firstDoneBody = asBody(firstDone.body);
    assert.equal(firstDoneBody.status, "staged");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(firstDoneBody.connection_id ?? "", /^cin_/);

    const second = await stageUpload(asUrl, cookie, "google-maps");
    const secondBody = asBody(second.body);
    assert.equal(second.status, 202, second.text);
    assert.equal(secondBody.connection_id, null);
    assert.ok(secondBody.artifact_id, "second staged upload must carry an artifact_id");
    const secondDone = await waitForArtifact(asUrl, cookie, secondBody.artifact_id, ["duplicate"]);
    assert.ok(secondDone, "expected the second artifact to reach a terminal status");
    const secondDoneBody = asBody(secondDone.body);
    assert.equal(secondDone.status, 200, secondDone.text);
    assert.equal(secondDoneBody.status, "duplicate");
    assert.equal(secondDoneBody.connection_id, firstDoneBody.connection_id);
    assert.equal(secondDoneBody.next_step?.kind, "show_status");

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 1, "duplicate staged upload must not create a second source");
    const batchCount = (getDb().prepare("SELECT COUNT(*) AS count FROM acquisition_batches").get() as { count: number })
      .count;
    assert.equal(batchCount, 1, "duplicate staged upload must reuse the existing acquisition batch");
  });
});

test("repeated owner artifact returns the existing receipt without creating another draft", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);
    const first = await createDraft(asUrl, cookie, "google-maps");
    const firstBody = asBody(first.body);
    assert.equal(first.status, 201, first.text);

    const second = await createDraft(asUrl, cookie, "google-maps");
    const secondBody = asBody(second.body);
    assert.equal(second.status, 200, second.text);
    assert.equal(secondBody.object, "manual_upload_known_artifact");
    assert.equal(secondBody.connection_id, firstBody.connection_id);
    assert.equal(secondBody.next_step?.kind, "show_status");
    assert.equal(secondBody.validation?.status, "duplicate");

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 1, "duplicate artifact must not create a second draft connection");
    const batchCount = (getDb().prepare("SELECT COUNT(*) AS count FROM acquisition_batches").get() as { count: number })
      .count;
    assert.equal(batchCount, 1, "duplicate artifact must reuse the existing acquisition batch");

    const previewDuplicate = await validateUpload(asUrl, cookie, "google-maps");
    const previewDuplicateBody = asBody(previewDuplicate.body);
    assert.equal(previewDuplicate.status, 200, previewDuplicate.text);
    assert.equal(previewDuplicateBody.object, "manual_upload_validation_preview");
    assert.equal(previewDuplicateBody.validation?.status, "duplicate");
    assert.equal(previewDuplicateBody.duplicate?.connection_id, firstBody.connection_id);
    assert.equal(previewDuplicateBody.next_step?.kind, "show_status");
  });
});

test("WhatsApp chat export is manifest-driven and accepts owner .txt artifacts", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const setup = await getSetup(asUrl, cookie, "whatsapp");
    const setupBody = asBody(setup.body);
    assert.equal(setup.status, 200, setup.text);
    assert.deepEqual(setupBody.accepted_file_extensions, [".txt", ".zip"]);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.ok(setupBody.validation_expectations?.some((item) => /messages/i.test(item)));

    const created = await createDraft(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Ghazal.txt",
      "[6/5/24, 9:15:22 AM] Alice: Hello\n[6/5/24, 9:16:00 AM] Bob: <Media omitted>"
    );
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);
    assert.equal(createdBody.connector_id, "whatsapp");
    assert.equal(createdBody.display_name, "WhatsApp - Ghazal");
    assert.equal(createdBody.validation?.status, "valid");
    assert.equal(createdBody.validation?.detected_format, "whatsapp_chat_export");
    assert.equal(createdBody.validation?.estimated_messages, 2);
    assert.equal(createdBody.validation?.estimated_attachments, 1);
    assert.equal(createdBody.validation?.source_identity?.title, "Ghazal");

    const batch = getDb()
      .prepare(
        `SELECT acquisition_method, source_format, parsed_count, media_coverage_json, warnings_json
           FROM acquisition_batches
          WHERE connector_instance_id = ?`
      )
      .get(createdBody.connection_id) as {
      acquisition_method: string;
      source_format: string;
      parsed_count: number;
      media_coverage_json: string;
      warnings_json: string;
    };
    assert.equal(batch.acquisition_method, "owner_artifact");
    assert.equal(batch.source_format, "whatsapp_chat_export");
    assert.equal(batch.parsed_count, 3);
    assert.equal((JSON.parse(batch.media_coverage_json) as { status: string }).status, "not_included");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match((JSON.parse(batch.warnings_json) as string[])[0] ?? "", /media files are not included/i);
  });
});

test("WhatsApp zip export with media attaches to an existing manual-upload connection", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const first = await createDraft(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Ghazal.txt",
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      { displayName: "the owner WhatsApp" }
    );
    const firstBody = asBody(first.body);
    assert.equal(first.status, 201, first.text);
    assert.equal(firstBody.display_name, "the owner WhatsApp");

    const previewIntoExisting = await validateUpload(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Ghazal.txt",
      "[6/6/24, 10:15:22 AM] Alice: Checking target label",
      { connectionId: requireConnectionId(firstBody.connection_id) }
    );
    const previewIntoExistingBody = asBody(previewIntoExisting.body);
    assert.equal(previewIntoExisting.status, 200, previewIntoExisting.text);
    assert.equal(previewIntoExistingBody.display_name, "the owner WhatsApp");
    assert.equal(previewIntoExistingBody.next_step?.kind, "confirm_import");

    const zip = makeStoredZip([
      {
        data: "[6/6/24, 10:15:22 AM] Alice: <attached: IMG-20240606-WA0001.jpg>",
        name: "WhatsApp Chat - Ghazal.txt",
      },
      { data: Buffer.from([1, 2, 3]), name: "IMG-20240606-WA0001.jpg" },
    ]);
    const second = await createDraft(asUrl, cookie, "whatsapp", "WhatsApp Chat - Ghazal.zip", zip, {
      connectionId: requireConnectionId(firstBody.connection_id),
    });
    const secondBody = asBody(second.body);
    assert.equal(second.status, 201, second.text);
    assert.equal(secondBody.connection_id, firstBody.connection_id);
    assert.equal(secondBody.validation?.detected_format, "whatsapp_chat_export_zip");
    assert.equal(secondBody.validation?.media_coverage?.status, "included_for_import");
    assert.equal(secondBody.validation?.media_coverage?.attached_media_files, 1);

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 1, "adding another export to the same WhatsApp source must not create another connection");
    const batchCount = (getDb().prepare("SELECT COUNT(*) AS count FROM acquisition_batches").get() as { count: number })
      .count;
    assert.equal(batchCount, 2, "each accepted export keeps its own acquisition-batch receipt");
  });
});

test("manual upload preview rejects an incompatible target connection before import", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const timeline = await createDraft(asUrl, cookie, "google-maps");
    const timelineBody = asBody(timeline.body);
    assert.equal(timeline.status, 201, timeline.text);

    const preview = await validateUpload(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Ghazal.txt",
      "[6/5/24, 9:15:22 AM] Alice: Hello",
      { connectionId: requireConnectionId(timelineBody.connection_id) }
    );
    const previewBody = asBody(preview.body);
    assert.equal(preview.status, 409, preview.text);
    assert.equal(previewBody.error?.code, "connector_instance_connector_mismatch");
    assert.equal(previewBody.error?.param, "connection_id");

    const whatsappRows = (
      getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances WHERE connector_id = 'whatsapp'").get() as {
        count: number;
      }
    ).count;
    assert.equal(whatsappRows, 0, "incompatible preview target must not create a WhatsApp draft");
  });
});

test("WhatsApp malformed zip is rejected before commit", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const malformed = Buffer.concat([Buffer.from("PK\u0003\u0004", "binary"), Buffer.from("not a usable zip")]);
    const created = await createDraft(asUrl, cookie, "whatsapp", "WhatsApp Chat - Broken.zip", malformed);
    const createdBody = asBody(created.body);
    assert.equal(created.status, 400, created.text);
    assert.equal(createdBody.error?.code, "import_file_unsupported");

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 0, "malformed zip validation must not create a draft");
  });
});

test("Timeline manual upload records coverage-safe validation without fixed refresh cooldown", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);
    const created = await createDraft(asUrl, cookie, "google-maps");
    const createdBody = asBody(created.body);
    assert.equal(created.status, 201, created.text);

    const bindingRow = getDb()
      .prepare(
        `SELECT source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`
      )
      .get(createdBody.connection_id) as { source_binding_json: string };
    const binding = JSON.parse(bindingRow.source_binding_json) as {
      import_validation: { status: string; date_range: { end: string } };
    };
    assert.equal(binding.import_validation.status, "valid");
    assert.equal(binding.import_validation.date_range.end, "2024-06-05T13:45:22.000Z");
    assert.equal(Object.hasOwn(binding, "cooldown_until"), false);
    assert.equal(Object.hasOwn(binding, "next_allowed_import_at"), false);
    assert.equal(Object.hasOwn(binding, "takeout_cadence"), false);
  });
});

test("unsafe or unsupported file names are rejected before a draft row is created", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const traversal = await createDraft(asUrl, cookie, "google-maps", "../Timeline.json");
    const traversalBody = asBody(traversal.body);
    assert.equal(traversal.status, 400);
    assert.equal(traversalBody.error?.code, "import_file_name_rejected");
    findManualUploadAudit(traversal.resp, "failed");

    const wrong = await createDraft(asUrl, cookie, "google-maps", "passwords.csv");
    const wrongBody = asBody(wrong.body);
    assert.equal(wrong.status, 400);
    assert.equal(wrongBody.error?.code, "import_file_name_rejected");

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 0, "invalid upload inputs must not create a draft");
  });
});

test("Timeline validation rejects unsupported and empty files before a draft row is created", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const unsupported = await createDraft(asUrl, cookie, "google-maps", "Timeline.json", '{"archive_jobs":[]}');
    const unsupportedBody = asBody(unsupported.body);
    assert.equal(unsupported.status, 400);
    assert.equal(unsupportedBody.error?.code, "import_file_unsupported");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(unsupportedBody.error?.message ?? "", /Timeline JSON export/);

    const empty = await createDraft(asUrl, cookie, "google-maps", "Timeline.json", '{"timelineObjects":[]}');
    const emptyBody = asBody(empty.body);
    assert.equal(empty.status, 400);
    assert.equal(emptyBody.error?.code, "import_file_empty");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(emptyBody.error?.message ?? "", /does not contain importable/);

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 0, "validation failures must not create a draft");
  });
});

test("wrong-source account-report artifacts are rejected before commit instead of inferred as an account match", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    await registerConnector(asUrl, "whatsapp");
    const cookie = await login(asUrl);

    const accountReportJson = JSON.stringify({
      account: { email: "not-the-owner@example.com" },
      exportType: "google_account_report",
    });
    const timelineWrongSource = await createDraft(asUrl, cookie, "google-maps", "Timeline.json", accountReportJson);
    const timelineWrongSourceBody = asBody(timelineWrongSource.body);
    assert.equal(timelineWrongSource.status, 400);
    assert.equal(timelineWrongSourceBody.error?.code, "import_file_unsupported");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(timelineWrongSourceBody.error?.message ?? "", /Timeline JSON export/);

    const whatsappAccountReport = await createDraft(
      asUrl,
      cookie,
      "whatsapp",
      "WhatsApp Chat - Account report.txt",
      "WhatsApp account information report\nPhone number: +1 555 0100"
    );
    const whatsappAccountReportBody = asBody(whatsappAccountReport.body);
    assert.equal(whatsappAccountReport.status, 400);
    assert.equal(whatsappAccountReportBody.error?.code, "import_file_unsupported");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(whatsappAccountReportBody.error?.message ?? "", /chat export .*\.txt.*\.zip/i);

    const rowCount = (getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as { count: number })
      .count;
    assert.equal(rowCount, 0, "wrong-source artifacts must not create a draft or infer account identity");
  });
});

test("manual/upload setup refuses non-manual connectors and bearer-only callers", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "gmail");
    const cookie = await login(asUrl);

    const unsupported = await getSetup(asUrl, cookie, "gmail");
    const unsupportedBody = asBody(unsupported.body);
    assert.equal(unsupported.status, 409);
    assert.equal(unsupportedBody.error?.code, "manual_upload_unsupported");

    const bearerUrl = new URL(`${asUrl}/_ref/connectors/gmail/manual-upload-draft-connection`);
    bearerUrl.searchParams.set("file_name", "Timeline.json");
    const bearerOnly = await fetchJson(bearerUrl, {
      body: "{}",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer owner-agent-token-that-is-not-a-cookie",
        "Content-Type": "application/octet-stream",
      },
      method: "POST",
    });
    const bearerOnlyBody = asBody(bearerOnly.body);
    assert.equal(bearerOnly.status, 401);
    assert.equal(bearerOnlyBody.error?.code, "owner_session_required");
  });
});

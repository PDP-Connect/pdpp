// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_SEED_CONNECTOR_KEYS } from "../../connectors/seed/index.ts";
import { canonicalConnectorKey } from "../../server/connector-key.ts";
import { initDb } from "../../server/db.ts";
import { initPostgresStorage, isPostgresStorageBackend, resolveStorageBackend } from "../../server/postgres-storage.ts";
import {
  admitOwnerRunConnection,
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../../server/stores/connector-instance-store.ts";
import type { CliFlags } from "../lib/args.ts";
import { parseArgs } from "../lib/args.ts";
import { resolveAsUrl, resolveRsUrl } from "../lib/common.ts";
import { PdppCliError, PdppUsageError } from "../lib/errors.ts";
import { ownerSessionHeaders } from "../lib/fetch.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REF_ROOT = join(__dirname, "..", "..");
const SEED_CONNECTOR_PATH = join(REF_ROOT, "connectors", "seed", "index.ts");
const MANIFESTS_DIR = join(REF_ROOT, "fixtures", "seed-manifests");
const OWNER_AUTH_REQUIRED_PATTERN = /owner_session_required|owner placeholder auth|401/i;

interface SeedManifestFields {
  connector_id?: unknown;
  connector_key?: unknown;
}

/**
 * Pure selection logic, no filesystem access: which of the already-read
 * manifests are seedable. The seed connector (connectors/seed/index.ts)
 * only has fixture-emit logic for the connector keys it exports via
 * SUPPORTED_SEED_CONNECTOR_KEYS — that export is the connector-owned fact
 * of what it can actually emit. A manifest declaring connector_id/connector_key
 * is necessary (this command still needs manifests/<key>.json to register
 * the connector) but not sufficient: a manifest with no corresponding
 * fixture logic in the seed connector would register successfully then
 * emit zero records, silently over-claiming seedability. Intersecting
 * against SUPPORTED_SEED_CONNECTOR_KEYS closes that gap instead of
 * inferring seedability from manifest presence alone.
 */
export function seedableConnectorsFromManifests(
  manifests: readonly SeedManifestFields[],
  supportedSeedKeys: readonly string[]
): string[] {
  const supported = new Set(supportedSeedKeys);
  const names: string[] = [];
  for (const manifest of manifests) {
    const key =
      (typeof manifest.connector_key === "string" && manifest.connector_key.trim()) ||
      (typeof manifest.connector_id === "string" ? canonicalConnectorKey(manifest.connector_id) : null);
    if (key && supported.has(key)) {
      names.push(key);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Parses one manifest JSON file at `manifestPath`. */
function readManifestFile(manifestPath: string): SeedManifestFields {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as SeedManifestFields;
}

/** Reads every manifest JSON file directly under `manifestsDir` (non-recursive, `.json` only). */
function readManifestsDir(manifestsDir: string): SeedManifestFields[] {
  const manifests: SeedManifestFields[] = [];
  for (const file of readdirSync(manifestsDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    manifests.push(readManifestFile(join(manifestsDir, file)));
  }
  return manifests;
}

function readDefaultConnectors(): string[] {
  return seedableConnectorsFromManifests(readManifestsDir(MANIFESTS_DIR), SUPPORTED_SEED_CONNECTOR_KEYS);
}

const DEFAULT_CONNECTORS = readDefaultConnectors();
const OWNER_BOOTSTRAP_CLIENT = "pdpp-polyfill-owner-bootstrap";

// A connector manifest, loaded from manifests/<name>.json: only the fields
// this command actually reads are typed; the manifest is otherwise passed
// through opaquely to registerManifest/runConnector.
interface SeedManifest {
  connector_id: string;
  [key: string]: unknown;
}

// runtime/index.ts (typed source boundary)
// exports runConnector at this shape; declared narrowly here rather than
// widening the dynamic import's inferred `any`.
interface RunConnectorResult {
  records?: number;
  [key: string]: unknown;
}
type RunConnectorFn = (args: {
  admitRunConnection: (input: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>;
  connectorPath: string;
  connectorId: string;
  ownerToken: string;
  manifest: SeedManifest;
  state: null;
  collectionMode: string;
  rsUrl: string | true;
}) => Promise<RunConnectorResult>;

interface SeedOutcome {
  connectorId?: string;
  error?: string;
  name: string;
  ok: boolean;
  result?: RunConnectorResult;
}

interface DatasetSummary {
  connector_count: number;
  earliest_record_time?: string;
  latest_record_time?: string;
  record_count: number;
  stream_count: number;
  total_retained_bytes: number;
}

function resolveRequestedConnectors(flags: CliFlags): string[] {
  const requested = flags.connector;
  const connectors =
    !requested || requested === true
      ? DEFAULT_CONNECTORS
      : String(requested)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  for (const name of connectors) {
    if (!DEFAULT_CONNECTORS.includes(name)) {
      throw new PdppUsageError(`Unknown seed connector: ${name}. Supported: ${DEFAULT_CONNECTORS.join(", ")}`);
    }
  }
  return connectors;
}

// Seeds one connector: registers its manifest, runs it, and records the
// outcome. Extracted from runSeed's per-connector loop only to keep its own
// cognitive complexity in budget; behavior (registration then run, ok/error
// outcome shape, progress text) is unchanged.
async function seedOneConnector(
  name: string,
  asUrl: string | true,
  rsUrl: string | true,
  ownerToken: string,
  ownerSubjectId: string,
  runConnector: RunConnectorFn
): Promise<SeedOutcome> {
  process.stdout.write(`  · ${name} … `);
  try {
    const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SeedManifest;

    await registerManifest(asUrl, manifest);

    const connectorInstanceStore = isPostgresStorageBackend()
      ? createPostgresConnectorInstanceStore()
      : createSqliteConnectorInstanceStore();

    const result = await runConnector({
      // Authoritative admission: resolves (and, for an omitted selector,
      // materializes) the owner's exact connection through the same store
      // boundary the reference server uses for every other run starter
      // (server/index.ts's admitRunConnection wiring). This never trusts a
      // caller-recomputed id — the store is the only source of truth for
      // which connector_instance_id belongs to this owner+connector.
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId: admittedOwnerSubjectId }) => {
        const namespace = await admitOwnerRunConnection({
          connectorId,
          connectorInstanceId,
          connectorInstanceStore,
          ownerSubjectId: admittedOwnerSubjectId ?? ownerSubjectId,
        });
        return {
          connectorId: namespace.connectorId,
          connectorInstanceId: namespace.connectorInstanceId,
          ownerSubjectId: namespace.ownerSubjectId,
        };
      },
      collectionMode: "full_refresh",
      // The raw manifest connector_id may be a URL-form first-party id
      // (e.g. https://registry.pdpp.dev/connectors/spotify); runConnector
      // canonicalizes it (canonicalConnectorKey) before admission, so admit
      // against the SAME canonical key here rather than the raw manifest
      // value — otherwise the store resolves a different connector than the
      // one runConnector actually starts.
      connectorId: canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id,
      connectorPath: SEED_CONNECTOR_PATH,
      manifest,
      ownerToken,
      rsUrl,
      state: null,
    });

    const recordCount = typeof result.records === "number" ? result.records : null;
    process.stdout.write(recordCount === null ? "ok\n" : `ok · ${recordCount.toLocaleString()} records\n`);
    return { connectorId: manifest.connector_id, name, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`failed: ${message}\n`);
    return { error: message, name, ok: false };
  }
}

async function fetchDatasetSummary(asUrl: string | true): Promise<DatasetSummary | null> {
  try {
    const res = await fetch(`${asUrl}/_ref/dataset/summary`, {
      headers: { ...ownerSessionHeaders() },
    });
    if (res.ok) {
      return (await res.json()) as DatasetSummary;
    }
  } catch {
    // non-fatal — server may not expose /_ref yet
  }
  return null;
}

function writeDatasetSummary(summary: DatasetSummary | null): void {
  process.stdout.write("\nDataset summary\n");
  if (!summary) {
    process.stdout.write("  (summary unavailable)\n");
    return;
  }
  process.stdout.write(
    `  connectors: ${summary.connector_count}\n` +
      `  streams:    ${summary.stream_count}\n` +
      `  records:    ${summary.record_count.toLocaleString()}\n` +
      `  retained:   ${formatBytes(summary.total_retained_bytes)}\n`
  );
  if (summary.earliest_record_time) {
    const start = summary.earliest_record_time.slice(0, 10);
    const end = (summary.latest_record_time ?? "").slice(0, 10);
    process.stdout.write(`  timespan:   ${start} → ${end}\n`);
  }
}

export async function runSeed(argv: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(argv);
  if (positionals.length > 0) {
    throw new PdppUsageError("pdpp seed does not take positional arguments; use --connector <name>");
  }

  const asUrl = resolveAsUrl(flags);
  const rsUrl = resolveRsUrl(flags);
  const subjectId = flags.subject || process.env.PDPP_SUBJECT_ID || "owner_local";
  const connectors = resolveRequestedConnectors(flags);

  await ensureReachable(asUrl);
  await connectSeedStorageBackend();

  const runtimeModule = (await import(join(REF_ROOT, "runtime", "index.ts"))) as { runConnector: RunConnectorFn };
  const { runConnector } = runtimeModule;

  process.stdout.write(`Seeding ${connectors.length} connector(s) against ${asUrl}\n`);

  const ownerToken = await issueOwnerToken(asUrl, subjectId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (OWNER_AUTH_REQUIRED_PATTERN.test(message)) {
      throw new PdppCliError(
        "Seed requires open local-dev owner auth. The reference server has placeholder owner\n" +
          "auth enabled (PDPP_OWNER_PASSWORD is set). Sign in at /owner/login and approve the\n" +
          "device flow there, or restart the server without PDPP_OWNER_PASSWORD so `pdpp seed`\n" +
          "can mint owner tokens directly."
      );
    }
    throw new PdppCliError(`Failed to mint owner token: ${message}`);
  });

  const results: SeedOutcome[] = [];
  for (const name of connectors) {
    // Deliberate sequential seeding: connectors register and run one at a
    // time so the per-connector progress output stays interleaved in
    // order, and later connectors can rely on earlier ones having
    // finished registering against the shared reference server.
    // biome-ignore lint/performance/noAwaitInLoops: see comment above
    const outcome = await seedOneConnector(name, asUrl, rsUrl, ownerToken, String(subjectId), runConnector);
    results.push(outcome);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    throw new PdppCliError(`All ${failed.length} seed connector(s) failed. See errors above.`);
  }

  // Dataset summary — so the operator sees exactly what the dashboard will see.
  writeDatasetSummary(await fetchDatasetSummary(asUrl));

  if (failed.length > 0) {
    process.stdout.write(
      `\n${failed.length} connector(s) failed. Succeeded: ${results
        .filter((r) => r.ok)
        .map((r) => r.name)
        .join(", ")}.\n`
    );
    process.exitCode = 1;
  }
}

// `seed` drives `runConnector` in-process (not over HTTP) so it can await
// each connector's full synchronous result before printing progress. That
// only produces authoritative admission (and dataset-summary-visible
// records) when this process's storage handle is the SAME database the
// target reference server is reading — never a private, disconnected
// default. Mirrors the server's own storage bootstrap (server/index.ts's
// `startServer`) so `pdpp seed`'s admission checks the identical store.
async function connectSeedStorageBackend(): Promise<void> {
  const backend = resolveStorageBackend();
  if (backend.backend === "postgres") {
    await initPostgresStorage(backend);
    return;
  }
  const dbPath = process.env.PDPP_DB_PATH || process.env.DB_PATH;
  if (!dbPath) {
    throw new PdppCliError(
      "pdpp seed requires PDPP_DB_PATH (or PDPP_DATABASE_URL for Postgres) set to the SAME\n" +
        "database the target reference server uses. Without it, seed would open its own private\n" +
        "in-memory database that the server can never see, and every seeded connector would\n" +
        "appear to succeed while writing records nobody can read."
    );
  }
  await initDb(dbPath);
}

async function ensureReachable(asUrl: string | true): Promise<void> {
  try {
    const res = await fetch(`${asUrl}/.well-known/pdpp-provider`);
    if (!res.ok && res.status !== 404) {
      throw new PdppCliError(`Reference server at ${asUrl} responded ${res.status}. Is the right server running?`);
    }
  } catch (err) {
    if (err instanceof PdppCliError) {
      throw err;
    }
    // PdppCliError carries context via `details`, not the native cause chain
    // (see errors.ts); this replaces a low-level fetch failure with an
    // actionable operator message rather than wrapping it.
    // biome-ignore lint/style/useErrorCause: see comment above
    throw new PdppCliError(
      `Reference server unreachable at ${asUrl}. Start it with:\n` +
        "  PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/pdpp.sqlite \\\n" +
        "    node reference-implementation/server/index.ts"
    );
  }
}

async function registerManifest(asUrl: string | true, manifest: SeedManifest): Promise<void> {
  const res = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await res.text();
  // 409 on re-register is fine — manifest version unchanged.
  if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
    throw new Error(`register manifest failed ${res.status}: ${text}`);
  }
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenResponseBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string | true, subjectId: CliFlags["subject"] | string): Promise<string> {
  const clientId = OWNER_BOOTSTRAP_CLIENT;

  const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!deviceRes.ok) {
    throw new Error(`device_authorization failed ${deviceRes.status}: ${await deviceRes.text()}`);
  }
  const device = (await deviceRes.json()) as DeviceAuthorizationBody;

  const approveRes = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: String(subjectId),
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!approveRes.ok) {
    throw new Error(`device/approve failed ${approveRes.status}: ${await approveRes.text()}`);
  }

  const tokenRes = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!tokenRes.ok) {
    throw new Error(`/oauth/token failed ${tokenRes.status}: ${await tokenRes.text()}`);
  }
  const tokenBody = (await tokenRes.json()) as TokenResponseBody;
  return tokenBody.access_token;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let rounded: number | string = value.toFixed(2);
  if (value >= 100) {
    rounded = Math.round(value);
  } else if (value >= 10) {
    rounded = value.toFixed(1);
  }
  return `${rounded} ${units[unitIndex] ?? "TB"}`;
}

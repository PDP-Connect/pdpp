#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator CLI — starts the personal server (embedded), registers the
 * requested connector's manifest, issues an owner token, runs the connector,
 * and prints a verification summary (records per stream landed in the RS).
 *
 * BROKEN as of the reference implementation's move to PDP-Connect/data-connect
 * (Move B): "the personal server (embedded)" above means this tool spawns
 * reference-implementation/runtime/index.ts, postgres-storage.ts, and
 * stores/connector-instance-store.ts directly from a local checkout of that
 * directory, which no longer exists in this repo. The `run` command below
 * will throw a real, immediate module-not-found error the first time it
 * tries to load any of those three modules — it is not silently broken,
 * it fails loudly, but it cannot currently succeed. Fixing this for real
 * needs either a network-facing rewrite (talk to a data-connect-hosted
 * server over HTTP instead of spawning one in-process) or a published
 * package data-connect exposes these three modules through — both are
 * real design decisions, not made here. Use `bin/connector-dev.ts` for
 * local connector development in the meantime (see that file's own doc
 * comment for why it was already the recommended day-to-day tool before
 * this broke).
 *
 * Usage:
 *   node bin/orchestrate.js run <connector>    (e.g. "ynab")
 *   node bin/orchestrate.js query <stream>     (requires already-running server)
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { handleInteraction } from "../src/interaction-handler.ts";
import {
  DEFAULT_AS_URL,
  DEFAULT_RS_URL,
  getConnectorPaths,
  issueOwnerToken,
  queryStream,
  readManifest,
  registerManifest,
  startEmbeddedServer,
} from "../src/orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..", "..", "..", "reference-implementation");
const REPO_ROOT = join(__dirname, "..", "..", "..");

dotenvConfig({ path: join(REPO_ROOT, ".env.local") });

const [, , cmd, ...rest] = process.argv;

interface HttpServer {
  close: (cb: () => void) => void;
  closeAllConnections?: () => void;
}
interface EmbeddedServer {
  asPort: number;
  asServer: HttpServer;
  rsPort: number;
  rsServer: HttpServer;
}

interface RunResult {
  error?: unknown;
  records_emitted: number;
  status: string;
}

interface ProgressEvent {
  message?: string;
  stream?: string;
  text?: string;
  type?: string;
}

interface RunConnectorOpts {
  admitRunConnection: (input: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>;
  collectionMode: "incremental" | "full_refresh";
  connectorId: string;
  connectorPath: string;
  manifest: unknown;
  onInteraction: (msg: unknown) => unknown;
  onProgress: (p: ProgressEvent) => void;
  ownerToken: string;
  persistState: boolean;
  rsUrl: string;
  state: unknown;
}

interface RuntimeModule {
  loadSyncState: (args: { connectorId: string; ownerToken: string; rsUrl: string }) => Promise<Record<string, unknown>>;
  runConnector: (opts: RunConnectorOpts) => Promise<RunResult>;
}

interface ConnectorInstanceNamespace {
  connectorId: string;
  connectorInstanceId: string;
  ownerSubjectId: string;
}

// reference-implementation/server/postgres-storage.ts and
// stores/connector-instance-store.ts moved to PDP-Connect/data-connect
// (Move B); this repo can no longer statically import them. Loaded
// dynamically (like `runtime` above) so `tsc` doesn't need the module to
// exist locally — this throws a clear, real error at the `import()` call
// below rather than lying about a capability this tool no longer has. This
// tool's embedded-server flow is broken until it's ported to talk to a
// data-connect-hosted server instead of a local checkout; use
// `bin/connector-dev.ts` for local connector development in the meantime
// (see that file's own doc comment).
interface StorageModule {
  admitOwnerRunConnection: (args: {
    connectorId: string;
    connectorInstanceId: string | null;
    connectorInstanceStore: unknown;
    ownerSubjectId: string;
  }) => Promise<ConnectorInstanceNamespace>;
  createPostgresConnectorInstanceStore: () => unknown;
  createSqliteConnectorInstanceStore: () => unknown;
  isPostgresStorageBackend: () => boolean;
}

interface StreamManifest {
  name: string;
}

async function cmdRun(name: string): Promise<{ ok: boolean; result: RunResult }> {
  const manifest = readManifest(name);
  const streams = (manifest.streams ?? []) as StreamManifest[];
  const { connectorPath } = getConnectorPaths(name);

  const dbPath = process.env.PDPP_DB_PATH || join(REPO_ROOT, "packages/polyfill-connectors/.pdpp-data/pdpp.sqlite");

  console.error(`[orchestrate] starting embedded server (db=${dbPath})...`);
  const server = (await startEmbeddedServer({ dbPath })) as EmbeddedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  console.error(`[orchestrate] AS at ${asUrl}  RS at ${rsUrl}`);

  try {
    console.error(`[orchestrate] registering manifest for ${name}...`);
    await registerManifest(asUrl, manifest);

    console.error("[orchestrate] minting owner token...");
    const ownerSubjectId = process.env.PDPP_SUBJECT_ID || "owner_local";
    const ownerToken = await issueOwnerToken(asUrl, ownerSubjectId);

    console.error("[orchestrate] loading prior sync state...");
    const runtime = (await import(pathToFileURL(join(REFERENCE_IMPL_DIR, "runtime/index.ts")).href)) as RuntimeModule;
    const { runConnector, loadSyncState } = runtime;
    const { isPostgresStorageBackend } = (await import(
      pathToFileURL(join(REFERENCE_IMPL_DIR, "server/postgres-storage.ts")).href
    )) as Pick<StorageModule, "isPostgresStorageBackend">;
    const { admitOwnerRunConnection, createPostgresConnectorInstanceStore, createSqliteConnectorInstanceStore } =
      (await import(pathToFileURL(join(REFERENCE_IMPL_DIR, "server/stores/connector-instance-store.ts")).href)) as Omit<
        StorageModule,
        "isPostgresStorageBackend"
      >;
    const connectorInstanceStore = isPostgresStorageBackend()
      ? createPostgresConnectorInstanceStore()
      : createSqliteConnectorInstanceStore();
    const prior = await loadSyncState({
      connectorId: manifest.connector_id,
      ownerToken,
      rsUrl,
    }).catch(() => ({}));
    const priorState = prior && Object.keys(prior).length ? prior : null;
    console.error(`[orchestrate] prior state: ${priorState ? "present (incremental)" : "none (full_refresh)"}`);

    console.error(`[orchestrate] running connector: ${connectorPath}`);
    const result = await runConnector({
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
      connectorPath,
      connectorId: manifest.connector_id,
      ownerToken,
      manifest,
      state: priorState,
      collectionMode: priorState ? "incremental" : "full_refresh",
      persistState: true,
      rsUrl,
      onProgress: (p) => {
        if (p.message) {
          process.stderr.write(`  • ${p.stream ? `[${p.stream}] ` : ""}${p.message}\n`);
        }
        if (p.type === "stderr" && p.text) {
          process.stderr.write(`[child-stderr] ${p.text}`);
        }
      },
      onInteraction: (msg) =>
        handleInteraction(msg as Parameters<typeof handleInteraction>[0], {
          connectorName: name,
        }),
    });

    console.error(`[orchestrate] result: status=${result.status} records_emitted=${result.records_emitted}`);
    if (result.error) {
      console.error(`[orchestrate] error: ${JSON.stringify(result.error).slice(0, 800)}`);
    }

    // Verify: query each stream and report record count. Each stream's query is
    // an independent read against the RS with no shared state between streams,
    // so they fan out concurrently; results are printed after in declared
    // `streams` order so the summary stays deterministic regardless of which
    // query resolves first.
    console.error("\n[orchestrate] verifying records in RS:");
    const streamReports = await Promise.all(
      streams.map(async (stream) => {
        const countQ = await queryStream(rsUrl, ownerToken, stream.name, {
          limit: 100,
          connectorId: manifest.connector_id,
        });
        return { stream, countQ };
      })
    );
    for (const { stream, countQ } of streamReports) {
      if (countQ.status !== 200) {
        console.error(
          `  ✗ ${stream.name.padEnd(28)} status=${countQ.status} ${JSON.stringify(countQ.body).slice(0, 100)}`
        );
        continue;
      }
      const body = countQ.body as {
        data?: unknown[];
        has_more?: boolean;
      } | null;
      const count = Array.isArray(body?.data) ? body.data.length : 0;
      const hasMore = body?.has_more ? "+" : "";
      console.error(`  ✓ ${stream.name.padEnd(28)} ${count}${hasMore} record(s)`);
    }

    return { ok: result.status === "succeeded", result };
  } finally {
    console.error("[orchestrate] shutting down server...");
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise<void>((r) => server.asServer.close(() => r()));
    await new Promise<void>((r) => server.rsServer.close(() => r()));
  }
}

async function cmdQuery(stream: string): Promise<void> {
  const asUrl = DEFAULT_AS_URL;
  const rsUrl = DEFAULT_RS_URL;
  const ownerToken = await issueOwnerToken(asUrl, process.env.PDPP_SUBJECT_ID || "owner_local");
  const q = await queryStream(rsUrl, ownerToken, stream, { limit: 10 });
  console.log(JSON.stringify(q.body, null, 2));
}

async function main(): Promise<void> {
  if (cmd === "run" && rest[0]) {
    const r = await cmdRun(rest[0]);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "query" && rest[0]) {
    await cmdQuery(rest[0]);
    process.exit(0);
  }
  console.error("Usage:");
  console.error("  orchestrate run <connector>       # ynab | gmail | chatgpt | usaa | amazon");
  console.error("  orchestrate query <stream>        # against already-running server");
  process.exit(2);
}

main().catch((e: unknown) => {
  console.error("[orchestrate] ERROR:", e);
  process.exit(1);
});

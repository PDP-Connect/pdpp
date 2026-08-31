import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { closeDb } from "../../server/db.ts";
import { startServer } from "../../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";
import { makeLocalTransformerBackend } from "../../server/search-semantic.ts";

class NeverExitingTransformerChild extends EventEmitter {
  readonly pid: number;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: Writable;
  readonly onKill: (signal: NodeJS.Signals) => void;

  constructor(onKill: (signal: NodeJS.Signals) => void) {
    super();
    this.onKill = onKill;
    this.pid = process.pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals) {
    this.onKill(signal);
    return true;
  }
}

function deterministicRecoveryBackend() {
  const vector = new Float32Array([0.25, 0.5, 0.75]);
  return {
    available: () => true,
    close: async () => undefined,
    dimensions: () => vector.length,
    distanceMetric: () => "cosine",
    embedDocument: async () => vector,
    embedQuery: async () => vector,
    model: () => "failstop-recovery",
    supportsDeviceAttemptDeadline: () => true,
  };
}

function failStopBackend() {
  const backend = makeLocalTransformerBackend(
    {
      cacheDir: "/not-read-by-fake-child",
      dimensions: 3,
      distanceMetric: "cosine",
      downloadAllowed: true,
      dtype: "q4",
      languageBias: { note: "fixture backend", primary: "en" },
      modelId: "never-exits",
      profileId: "failstop-test",
    },
    {
      executorOptions: {
        deadlineMs: 30,
        killGraceMs: 30,
        queueLimit: 1,
        spawnChild: () =>
          new NeverExitingTransformerChild((signal) => {
            if (signal === "SIGKILL") {
              process.stdout.write(`${JSON.stringify({ event: "transformer-child-sigkill" })}\n`);
            }
          }),
        termGraceMs: 30,
        workLimit: 1,
      },
    }
  );
  // This fixture tests an unconfirmed transformer exit during device ingest.
  // Automatic startup warmup would consume the deliberately nonresponsive
  // child before the fixture can publish its ready receipt, testing a
  // different lifecycle phase and making the intended request unreachable.
  const { close } = backend;
  return {
    ...backend,
    close: async () => {
      await close?.();
    },
    prepare: undefined,
  };
}

const mode = process.env.PDPP_FAILSTOP_FIXTURE_MODE;
const databaseUrl = process.env.PDPP_FAILSTOP_FIXTURE_DATABASE_URL;
const childAttachment = process.env.PDPP_FAILSTOP_FIXTURE_CHILD_ATTACHMENT;
if (!(databaseUrl && childAttachment) || (mode !== "fail" && mode !== "recover")) {
  throw new Error("fail-stop fixture requires mode, database URL, and a parent-minted child attachment");
}

process.env.PDPP_INGEST_BATCH_ATTEMPT_DEADLINE_MS = "5000";
process.env.PDPP_INGEST_FINAL_INDEX_PLAN_CONCURRENCY = "1";
process.env.PDPP_SEMANTIC_WORK_LIMIT = "1";
process.env.DATABASE_URL = databaseUrl;
process.env.PDPP_STORAGE_BACKEND = "postgres";

const backend = mode === "fail" ? failStopBackend() : deterministicRecoveryBackend();
// The parent admits this empty, guarded database before either child process
// starts, then mints one single-use attachment per child. Claim it here before
// the parent creates device rows; `startServer` still performs its ordinary
// startup admission after this bootstrap, while the recovery child can safely
// attach to the accepted rows it must replay.
await initPostgresStorage(
  { backend: "postgres", databaseUrl },
  { testOnlyAlreadyAdmittedChildAttachment: childAttachment }
);
const server = await startServer({
  asPort: 0,
  awaitStartupBackfill: true,
  dbPath: ":memory:",
  quiet: true,
  rsPort: 0,
  semanticRetrievalBackend: backend,
  startClientEventDeliveryWorker: false,
});

const manifestResult = await postgresQuery("SELECT manifest FROM connectors WHERE connector_id = $1", ["codex"]);
const manifest =
  typeof manifestResult.rows[0]?.manifest === "string"
    ? JSON.parse(manifestResult.rows[0].manifest)
    : manifestResult.rows[0]?.manifest;
const messages = manifest.streams.find((stream: { name: string }) => stream.name === "messages");
messages.query.search.lexical_fields = ["content"];
messages.query.search.semantic_fields = ["content"];
const manifestJson = JSON.stringify(manifest);
await postgresQuery("UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2", [manifestJson, "codex"]);

process.stdout.write(`${JSON.stringify({ asPort: server.asPort, mode, ready: true })}\n`);

async function shutdown() {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
  server.abortStartupBackfill?.("fixture shutdown");
  server.schedulerManager?.stop();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
  server.stopBrowserSurfaceLeaseSweep?.();
  if ("closeAllConnections" in server.asServer && typeof server.asServer.closeAllConnections === "function") {
    server.asServer.closeAllConnections();
  }
  if ("closeAllConnections" in server.rsServer && typeof server.rsServer.closeAllConnections === "function") {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    backend.close(),
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
  await closePostgresStorage();
  closeDb();
  process.exit(0);
}

process.once("SIGTERM", () => {
  shutdown().catch(() => process.exit(2));
});
process.once("SIGINT", () => {
  shutdown().catch(() => process.exit(2));
});

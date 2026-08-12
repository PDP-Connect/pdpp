// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome 2.5.5's built-in Node module registry does not yet recognize node:sqlite; Node's own resolver and tsc both resolve it (same pre-existing gap as packages/polyfill-connectors/src/local-device-outbox.ts and its sibling test files).
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  // The concrete bundled-connector registry is assembled at the composition
  // root (the bin) from connector-owned definitions; the src runtime is
  // connector-agnostic. These imports moved here from `../src/runner.ts` when
  // the collector was inverted to connector-defines-collector.
  BUNDLED_CONNECTOR_IDS,
  BUNDLED_CONNECTOR_VERSIONS,
  BUNDLED_CONNECTORS,
  buildConnectorSpec,
  buildLocalOutboxDoctor,
  type CliOptions,
  CollectorInterruptedAbort,
  classifyLocalCollectorDeploymentPosture,
  compactOutbox,
  findLocalCollectorProfiles,
  getBundledConnector,
  HELP_TEXT,
  inspectLocalOutboxStatus,
  inspectLocalReferenceRoute,
  installInterruptAbort,
  type LocalOutboxStatusOutput,
  normalizeConnectorId,
  parseArgs,
  parseCollectorProfileEnv,
  pruneSentOutboxRows,
  readLocalOutboxDeadLetterErrorSummary,
  recoverLocalCollector,
  removeLocalCollectorProfile,
  resolveConnectScopeChoice,
  resolveInspectionOptions,
  resolveLocalCollectorPackageVersion,
  resolveRunProfileOptions,
  retryLocalOutboxDeadLetters,
  runCollectorOnce,
  runCollectorSample,
  runConnect,
  runLogout,
  runSetup,
  summarizeRunResultForCli,
  writeLocalCollectorProfile,
} from "../bin/pdpp-local-collector.ts";
// Use a tsx-loader-style import indirectly: the runner module is .ts, so
// these tests exercise the same path the bin uses. Node 22+ supports
// loading .ts via tsx; the package's `verify` script runs with the
// monorepo's tsx loader.
import {
  buildLocalDeviceOutboxId,
  COLLECTOR_PROTOCOL_VERSION,
  COLLECTOR_RUNTIME_CAPABILITIES,
  LocalDeviceHttpError,
  LocalDeviceOutbox,
} from "../src/runner.ts";

/**
 * Neutral published posture injected into outbox-focused tests so their
 * assertions about queue health stay deterministic regardless of where the
 * test process itself resolves from (the test runs from the repo worktree, so
 * live detection would classify repo_dist_override). Posture classification has
 * its own dedicated tests below.
 */
const PUBLISHED_POSTURE = Object.freeze({
  kind: "published_package",
  is_placeholder_version: false,
  location_hint: "node_modules/@pdpp/local-collector",
  module_basename: "pdpp-local-collector.js",
  version: "0.1.0-beta.7",
});

import { ALLOW_CUSTOM_COMMAND_ENV, CollectorCustomCommandRefusedError, CollectorUsageError } from "../src/errors.ts";

const FRESH_DEVICE_TOKEN_PATTERN = /PDPP_LOCAL_DEVICE_TOKEN="fresh-token"/;
const FRESH_DEVICE_ID_PATTERN = /PDPP_LOCAL_DEVICE_ID="fresh-device"/;
const SAMPLE_STOPPED_NOTE_PATTERN = /Sample stopped after/;
const SAMPLE_COMPLETE_NOTE_PATTERN = /complete pass, not a truncated one/;
const HELP_RECENT_FLAG_PATTERN = /--recent <days>/;
const HELP_ALL_FLAG_PATTERN = /--all\b/;
const HELP_SINCE_FLAG_PATTERN = /--since <iso>/;
const HELP_SOURCE_ROOTS_FLAG_PATTERN = /--source-roots a,b/;
const HELP_REQUEST_NOT_GUARANTEE_PATTERN = /REQUEST, not a guarantee/;
const HELP_NARROWS_ONLY_PATTERN = /narrows-only/;
const USAGE_ERROR_CONNECT_PATTERN = /\bconnect\b/;
const HELP_TEXT_CONNECT_PATTERN = /\bconnect\b/;
const REQUESTED_SCOPE_SERVER_DEFAULT_PATTERN = /server default/;
const REQUESTED_SCOPE_RECENT_7_PATTERN = /recent 7 day/;
const REQUESTED_SCOPE_ALL_HISTORY_PATTERN = /all history/;
const WIDENING_REJECTION_MESSAGE_PATTERN = /wider than the server-declared boundary|already declared a boundary/;
const REQUIRES_FORCE_PATTERN = /--force/;
const MISSING_PROFILE_PATTERN = /could not find local collector profile 'missing'/;

test("runner exports the collector runtime capability profile with collector id", () => {
  assert.equal(COLLECTOR_RUNTIME_CAPABILITIES.id, "collector");
  const bindings = [...COLLECTOR_RUNTIME_CAPABILITIES.bindings].sort();
  assert.deepEqual(bindings, ["filesystem", "local_device", "network"]);
});

test("runner exports a stable COLLECTOR_PROTOCOL_VERSION string", () => {
  assert.equal(typeof COLLECTOR_PROTOCOL_VERSION, "string");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(COLLECTOR_PROTOCOL_VERSION, /^\d+$/);
});

test("bundled connectors registry contains every supported local connector", () => {
  assert.deepEqual([...BUNDLED_CONNECTOR_IDS].sort(), [
    "apple_photos",
    "claude_code",
    "codex",
    "google_messages",
    "google_takeout",
    "imessage",
  ]);
  assert.ok(BUNDLED_CONNECTORS.claude_code);
  assert.ok(BUNDLED_CONNECTORS.codex);
  assert.ok(BUNDLED_CONNECTORS.imessage);
  assert.ok(BUNDLED_CONNECTORS.google_takeout);
  assert.ok(BUNDLED_CONNECTORS.apple_photos);
  assert.ok(BUNDLED_CONNECTORS.google_messages);
});

test("bundled registry is assembled from the connector-owned definitions (runtime names no connector)", async () => {
  // Inversion invariant: the runtime does not author the connector list — the
  // bin injects the connectors' own LOCAL_COLLECTOR_DEFINITIONS. The runnable
  // registry must therefore be exactly those definitions, id-for-id, with each
  // entry's default streams/bindings coming straight from its definition.
  const { LOCAL_COLLECTOR_DEFINITIONS } = await import("../../polyfill-connectors/src/collector-registry.ts");
  assert.deepEqual([...BUNDLED_CONNECTOR_IDS].sort(), LOCAL_COLLECTOR_DEFINITIONS.map((d) => d.connector_id).sort());
  for (const def of LOCAL_COLLECTOR_DEFINITIONS) {
    const entry = getBundledConnector(def.connector_id);
    assert.ok(entry, `entry for ${def.connector_id}`);
    assert.deepEqual([...entry.streams], [...def.streams], `${def.connector_id} streams`);
    assert.deepEqual(entry.bindings, def.bindings, `${def.connector_id} bindings`);
  }
});

test("tsconfig packaging manifest bundles exactly the connectors in the definitions registry", async () => {
  // The generic runtime names no connector, but the collector build still has
  // to COMPILE the bundled connectors into dist so it can spawn them. That
  // packaging list lives in tsconfig.build.json; this guard keeps it in
  // lockstep with the connector-owned registry so the two never drift (a
  // connector added to the registry but not compiled would fail to spawn from
  // the tarball, and vice-versa).
  const { LOCAL_COLLECTOR_DEFINITIONS } = await import("../../polyfill-connectors/src/collector-registry.ts");
  // tsconfig.build.json is JSONC (tsc allows comments); strip `//` line
  // comments before JSON.parse so this guard reads the same file tsc compiles.
  const tsconfigText = await readFile(new URL("../tsconfig.build.json", import.meta.url), "utf8");
  const tsconfig = JSON.parse(tsconfigText.replace(/^\s*\/\/.*$/gm, ""));
  const compiledConnectors = tsconfig.include
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    .map((entry) => /connectors\/([^/]+)\/\*\*/.exec(entry)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    compiledConnectors,
    LOCAL_COLLECTOR_DEFINITIONS.map((d) => d.entry).sort(),
    "tsconfig.build.json must compile exactly the connectors declared in LOCAL_COLLECTOR_DEFINITIONS"
  );
});

test("bundled connector entries declare filesystem binding as required", () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    assert.equal(entry.connector_id, id);
    assert.equal(entry.bindings.filesystem.required, true);
    assert.ok(Array.isArray(entry.streams) && entry.streams.length > 0);
  }
});

test("bundled connector defaults request coverage_diagnostics whenever the connector's manifest declares that stream, so a drained run is never coverage_unknown", async () => {
  // Local-device collectors push records from a device outbox and write no
  // spine run, so the connection-health rollup can only project a non-`unknown`
  // coverage axis from durable `coverage_diagnostics` records where that is the
  // connector's coverage mechanism. If the published default stream set omits
  // that stream, every `pdpp-local-collector run` emits zero coverage evidence
  // and the dashboard is stuck at `coverage_unknown` even after a healthy
  // drain. See openspec/changes/derive-local-collector-coverage-from-diagnostics.
  //
  // Not every connector uses this mechanism: iMessage declares a per-stream
  // `coverage_strategy` (snapshot_import_receipt) in its manifest instead, and
  // has no coverage_diagnostics stream to request at all — this check only
  // applies when the manifest declares one.
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    const manifestPath = new URL(`../../polyfill-connectors/manifests/${id}.json`, import.meta.url);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declaresCoverageDiagnostics = manifest.streams.some((stream) => stream.name === "coverage_diagnostics");
    if (!declaresCoverageDiagnostics) {
      continue;
    }
    assert.ok(
      entry.streams.includes("coverage_diagnostics"),
      `${id} default streams must include coverage_diagnostics; got ${entry.streams.join(", ")}`
    );
  }
});

test("bundled connector default streams are all manifest-declared (no undeclared stream requested)", async () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    const entry = getBundledConnector(id);
    assert.ok(entry, `entry for ${id}`);
    const manifestPath = join(import.meta.dirname, "..", "..", "polyfill-connectors", "manifests", `${id}.json`);
    // biome-ignore lint/performance/noAwaitInLoops: each iteration reads an independent connector manifest fixture; sequential reads keep the per-id assertion failure attributable.
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const declared = new Set(manifest.streams.map((stream) => stream.name));
    for (const stream of entry.streams) {
      assert.ok(declared.has(stream), `${id} default stream '${stream}' is not declared in the manifest`);
    }
  }
});

test("bundled connector versions map covers every bundled id", () => {
  for (const id of BUNDLED_CONNECTOR_IDS) {
    assert.equal(typeof BUNDLED_CONNECTOR_VERSIONS[id], "string");
  }
});

test("runner exports the durable local outbox substrate without private package imports", () => {
  assert.equal(typeof LocalDeviceOutbox, "function");
});

test("local collector CLI resolves the installed package manifest version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-collector-version-"));
  const binPath = join(root, "dist", "local-collector", "bin", "pdpp-local-collector.js");
  await mkdir(join(root, "dist", "local-collector", "bin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@pdpp/local-collector", version: "0.1.0-beta.99" })
  );

  assert.equal(resolveLocalCollectorPackageVersion(binPath), "0.1.0-beta.99");
});

test("local collector package no longer ships the temporary legacy JSON queue migration bridge", async () => {
  const files = [
    "../tsconfig.build.json",
    "../scripts/postbuild.ts",
    "../src/runner.ts",
    "../../polyfill-connectors/src/runner/index.ts",
  ];

  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: each iteration reads an independent source file fixture; sequential reads keep the per-file assertion failure attributable.
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(
      text,
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      /local-device-queue-migration|LegacyLocalDeviceQueue|importLegacyLocalDeviceQueue|inspectLegacyLocalDeviceQueue/
    );
  }
});

test("getBundledConnector returns null for non-bundled ids", () => {
  assert.equal(getBundledConnector("gmail"), null);
  assert.equal(getBundledConnector("whatever"), null);
});

test("CollectorUsageError carries an exit code", () => {
  const err = new CollectorUsageError("bad usage");
  assert.equal(err.exitCode, 64);
  assert.equal(err.name, "CollectorUsageError");

  const overridden = new CollectorUsageError("bad usage", { exitCode: 65 });
  assert.equal(overridden.exitCode, 65);
});

test("CollectorCustomCommandRefusedError names the opt-in env var", () => {
  const err = new CollectorCustomCommandRefusedError();
  assert.equal(err.code, "custom_command_refused");
  assert.match(err.message, new RegExp(ALLOW_CUSTOM_COMMAND_ENV));
});

test("local collector status reports aggregate durable outbox health without payloads", async () => {
  const path = await tempOutboxPath();
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    outbox.enqueue({
      id: "pending-secret-id",
      kind: "record_batch",
      payload: { secret: "do-not-print", token: "nope" },
      sourceInstanceId: "src-1",
    });
    outbox.enqueue({
      id: "leased-secret-id",
      kind: "checkpoint",
      payload: { private: "leased-payload" },
      sourceInstanceId: "src-1",
    });
    const [leased] = outbox.claimReady({ holder: "worker-a", leaseMs: 1000, sourceInstanceId: "src-1" });
    assert.ok(leased);
    now = new Date("2026-05-19T12:00:02.000Z");

    const status = inspectLocalOutboxStatus({
      baseUrl: "http://127.0.0.1:7662",
      command: "status",
      deviceId: "device-1",
      deviceToken: "device-token-secret",
      queuePath: path,
      sourceInstanceId: "src-1",
    });

    assert.equal(status.db.path, path);
    assert.equal(status.db.exists, true);
    assert.equal(status.configured_device.device_id_configured, true);
    assert.equal(status.configured_device.device_token_configured, true);
    assert.deepEqual(status.source, {
      connection_id: "src-1",
      source_instance_id: "src-1",
    });
    assert.deepEqual(status.outbox.counts, {
      dead_letter: 0,
      leased: 1,
      pending: 1,
      retrying: 0,
      sent: 0,
      total: 2,
    });
    assert.equal(status.outbox.expired_leases, 1);
    assert.equal(status.outbox.oldest_pending_at, "2026-05-19T12:00:00.000Z");

    const rendered = JSON.stringify(status);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(rendered, /do-not-print|device-token-secret|leased-payload|pending-secret-id|leased-secret-id/);
  } finally {
    outbox.close();
  }
});

test("local collector doctor flags missing db, expired leases, and dead letters", async () => {
  const missing = inspectLocalOutboxStatus(parseArgs(["doctor", "--queue", join(await tempDir(), "missing.sqlite")]), {
    deploymentPosture: PUBLISHED_POSTURE,
  });
  const missingDoctor = buildLocalOutboxDoctor(missing);
  assert.equal(missingDoctor.checks.outbox_db, "missing");
  assert.equal(missingDoctor.status, "warning");

  const path = await tempOutboxPath();
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    outbox.enqueue({
      id: "dead-letter-id",
      kind: "gap",
      payload: { secret: "dead-letter-payload" },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId: "src-1" });
    assert.ok(claim);
    outbox.deadLetter({
      error: "bounded error",
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });

    outbox.enqueue({
      id: "expired-lease-id",
      kind: "checkpoint",
      payload: { secret: "expired-lease-payload" },
      sourceInstanceId: "src-1",
    });
    outbox.claimReady({ holder: "worker-a", leaseMs: 1000, sourceInstanceId: "src-1" });
    outbox.enqueue({
      id: "retrying-id",
      kind: "record_batch",
      nextAttemptAt: new Date("2099-05-19T12:05:00.000Z"),
      payload: { secret: "retrying-payload" },
      sourceInstanceId: "src-1",
    });
    now = new Date("2026-05-19T12:00:02.000Z");

    const doctor = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus(
        {
          baseUrl: "http://127.0.0.1:7662",
          command: "doctor",
          queuePath: path,
          sourceInstanceId: "src-1",
        },
        { deploymentPosture: PUBLISHED_POSTURE }
      )
    );

    assert.equal(doctor.status, "critical");
    assert.deepEqual(doctor.checks, {
      coverage_diagnostics: "ok",
      deployment_posture: "ok",
      expired_leases: "warn",
      outbox_db: "ok",
      outbox_failures: "fail",
    });
    // Dead letters dominate the lifecycle state even though no coverage
    // diagnostic was observed: a lane that needs recovery is not first
    // labeled "coverage missing".
    assert.equal(doctor.lifecycle_state, "dead_letter");
    assert.equal(doctor.outbox.counts.dead_letter, 1);
    assert.equal(doctor.outbox.counts.retrying, 1);
    assert.equal(doctor.outbox.expired_leases, 1);
    assert.doesNotMatch(
      JSON.stringify(doctor),
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      /dead-letter-payload|expired-lease-payload|retrying-payload|dead-letter-id|expired-lease-id|retrying-id/
    );

    // When dead letters are present, doctor points the operator at the
    // recovery primitive (dry-run preview, then --apply with backup). This
    // scenario also has an expired lease, so doctor emits a distinct
    // self-heal hint for that — each non-ok check gets its own line.
    assert.ok(Array.isArray(doctor.remediation));
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    const deadLetterHint = doctor.remediation.find((line) => /recover --source-instance-id <id>/.test(line));
    assert.ok(deadLetterHint, "expected a dead-letter remediation hint");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(deadLetterHint, /--apply/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    const expiredLeaseHint = doctor.remediation.find((line) => /past expiry/.test(line));
    assert.ok(expiredLeaseHint, "expected an expired-lease remediation hint");

    // When an error summary is supplied, doctor surfaces the top redacted
    // error class (the "why") and names it in the remediation hint.
    const doctorWithCause = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus(
        {
          baseUrl: "http://127.0.0.1:7662",
          command: "doctor",
          queuePath: path,
          sourceInstanceId: "src-1",
        },
        { deploymentPosture: PUBLISHED_POSTURE }
      ),
      readLocalOutboxDeadLetterErrorSummary({
        baseUrl: "http://127.0.0.1:7662",
        command: "doctor",
        queuePath: path,
        sourceInstanceId: "src-1",
      })
    );
    assert.ok(doctorWithCause.dead_letter_error_summary);
    assert.equal(doctorWithCause.dead_letter_error_summary.dead_letter_count, 1);
    assert.equal(doctorWithCause.dead_letter_error_summary.top_classes[0].error_class, "bounded error");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(doctorWithCause.remediation[0], /bounded error/);
    // Payloads/ids still never leak even with the cause surfaced.
    assert.doesNotMatch(
      JSON.stringify(doctorWithCause),
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      /dead-letter-payload|expired-lease-payload|retrying-payload|dead-letter-id|expired-lease-id|retrying-id/
    );
  } finally {
    outbox.close();
  }
});

test("local collector doctor omits remediation when the outbox is healthy", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: "healthy-id",
      kind: "record_batch",
      payload: { ok: true },
      sourceInstanceId: "src-1",
    });
    const doctor = buildLocalOutboxDoctor(
      inspectLocalOutboxStatus(
        {
          baseUrl: "http://127.0.0.1:7662",
          command: "doctor",
          queuePath: path,
          sourceInstanceId: "src-1",
        },
        { deploymentPosture: PUBLISHED_POSTURE }
      )
    );
    assert.equal(doctor.checks.outbox_failures, "ok");
    assert.equal(doctor.checks.deployment_posture, "ok");
    assert.equal(doctor.remediation, undefined);
  } finally {
    outbox.close();
  }
});

test("local collector doctor reports configured reference route health without secrets", async () => {
  const okServer = await startReferenceRouteServer({ status: 200 });
  try {
    const route = await inspectLocalReferenceRoute({
      baseUrl: okServer.url,
      command: "doctor",
      deviceId: "device-1",
      deviceToken: "device-token-secret",
      queuePath: join(await tempDir(), "missing.sqlite"),
      sourceInstanceId: "src-1",
    });
    assert.equal(route.status, "ok");
    assert.equal(route.check, "device_source_state");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(JSON.stringify(route), /device-token-secret/);
  } finally {
    await okServer.close();
  }

  const failServer = await startReferenceRouteServer({ body: "<html>bad gateway</html>", status: 502 });
  try {
    const status = inspectLocalOutboxStatus(
      {
        baseUrl: failServer.url,
        command: "doctor",
        deviceId: "device-1",
        deviceToken: "device-token-secret",
        queuePath: join(await tempDir(), "missing.sqlite"),
        sourceInstanceId: "src-1",
      },
      { deploymentPosture: PUBLISHED_POSTURE }
    );
    const route = await inspectLocalReferenceRoute({
      baseUrl: failServer.url,
      command: "doctor",
      deviceId: "device-1",
      deviceToken: "device-token-secret",
      queuePath: status.db.path,
      sourceInstanceId: "src-1",
    });
    const doctor = buildLocalOutboxDoctor(status, null, route);

    assert.equal(route.status, "fail");
    assert.equal(route.http_status, 502);
    assert.equal(route.error_class, "http_502");
    assert.equal(doctor.checks.reference_route, "fail");
    assert.equal(doctor.status, "critical");
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(doctor.remediation.join("\n"), /PDPP_REFERENCE_BASE_URL/);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.doesNotMatch(JSON.stringify(doctor), /device-token-secret|bad gateway/);
  } finally {
    await failServer.close();
  }

  const unknown = await inspectLocalReferenceRoute({
    baseUrl: "http://127.0.0.1:7662",
    command: "doctor",
    queuePath: join(await tempDir(), "missing.sqlite"),
  });
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(unknown.missing, ["device_id", "device_token", "source_instance_id"]);
});

// --- Deployment posture (published-vs-dev runtime classification). Make the
// documented `command -v` + `readlink -f` + version cross-check mechanical:
// status/doctor must classify a published install vs a repo dist override vs
// unknown, redaction-safe. ---

/**
 * Write a synthetic `@pdpp/local-collector` package layout under `root` and
 * return the absolute path to the (real, on-disk) bin module so
 * `classifyLocalCollectorDeploymentPosture` can resolve and realpath it.
 *
 * @param {object} opts
 * @param {string[]} opts.packageDirSegments path segments from root to the package root
 * @param {string} [opts.version] manifest version (default a real published version)
 * @param {boolean} [opts.repoSiblings] also create repo-only siblings (src/, bin/)
 * @param {string} [opts.binExt] bin module extension ('.js' built, '.ts' source)
 */
async function writeCollectorLayout(root, opts) {
  const { packageDirSegments, version = "0.1.0-beta.7", repoSiblings = false, binExt = ".js" } = opts;
  const packageRoot = join(root, ...packageDirSegments);
  const binDir = join(packageRoot, "dist", "local-collector", "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@pdpp/local-collector", version }));
  if (repoSiblings) {
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await mkdir(join(packageRoot, "bin"), { recursive: true });
  }
  const binPath = join(binDir, `pdpp-local-collector${binExt}`);
  await writeFile(binPath, "// synthetic bin\n");
  return binPath;
}

test("deployment posture classifies a node_modules install as published_package", async () => {
  const root = await tempDir();
  const binPath = await writeCollectorLayout(root, {
    packageDirSegments: ["node_modules", "@pdpp", "local-collector"],
    version: "0.1.0-beta.7",
  });

  const posture = classifyLocalCollectorDeploymentPosture(binPath);
  assert.equal(posture.kind, "published_package");
  assert.equal(posture.is_placeholder_version, false);
  assert.equal(posture.version, "0.1.0-beta.7");
  assert.equal(posture.location_hint, "node_modules/@pdpp/local-collector");
  assert.equal(posture.module_basename, "pdpp-local-collector.js");
  // No absolute home path leaks through the redacted descriptor.
  assert.doesNotMatch(JSON.stringify(posture), new RegExp(escapeRegExp(root)));
});

test("deployment posture classifies a repo checkout (src/+bin/ siblings) as repo_dist_override", async () => {
  const root = await tempDir();
  const binPath = await writeCollectorLayout(root, {
    packageDirSegments: ["pdpp", "packages", "local-collector"],
    version: "0.0.0",
    repoSiblings: true,
  });

  const posture = classifyLocalCollectorDeploymentPosture(binPath);
  assert.equal(posture.kind, "repo_dist_override");
  // The in-repo manifest is the 0.0.0 placeholder by design.
  assert.equal(posture.is_placeholder_version, true);
  assert.equal(posture.location_hint, "packages/local-collector");
  // The redacted hint exposes the package dir name, never the home path above it.
  assert.doesNotMatch(JSON.stringify(posture), new RegExp(escapeRegExp(root)));
});

test("deployment posture treats a raw .ts entrypoint as a repo/source override", async () => {
  const root = await tempDir();
  // No node_modules, no repo siblings — but the entrypoint is raw .ts, which
  // the published package never ships, so it is a source override.
  const binPath = await writeCollectorLayout(root, {
    packageDirSegments: ["somewhere", "local-collector"],
    version: "0.1.0-beta.7",
    binExt: ".ts",
  });

  const posture = classifyLocalCollectorDeploymentPosture(binPath);
  assert.equal(posture.kind, "repo_dist_override");
  assert.equal(posture.module_basename, "pdpp-local-collector.ts");
});

test("deployment posture is unknown when neither published nor repo signals are present", async () => {
  const root = await tempDir();
  // Built .js bin, no node_modules ancestor, no repo-only siblings — the
  // surface refuses to guess published_package.
  const binPath = await writeCollectorLayout(root, {
    packageDirSegments: ["opt", "vendored", "local-collector"],
    version: "0.1.0-beta.7",
    repoSiblings: false,
    binExt: ".js",
  });

  const posture = classifyLocalCollectorDeploymentPosture(binPath);
  assert.equal(posture.kind, "unknown");
});

test("status carries the deployment_posture block; doctor warns (not critical) for a repo override", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();

  const repoPosture = {
    kind: "repo_dist_override",
    is_placeholder_version: true,
    location_hint: "packages/local-collector",
    module_basename: "pdpp-local-collector.ts",
    version: "0.0.0",
  };
  const status = inspectLocalOutboxStatus(
    {
      baseUrl: "http://127.0.0.1:7662",
      command: "doctor",
      queuePath: path,
      sourceInstanceId: "src-1",
    },
    { deploymentPosture: repoPosture }
  );
  assert.deepEqual(status.deployment_posture, repoPosture);

  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.deployment_posture, "warn");
  // A dev/placeholder posture is a warning that disqualifies operator-host
  // evidence — never the critical severity reserved for dead-letter recovery.
  assert.equal(doctor.status, "warning");
  assert.ok(Array.isArray(doctor.remediation));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  const postureHint = doctor.remediation.find((line) => /Deployment Posture/.test(line));
  assert.ok(postureHint, "expected a deployment-posture remediation hint");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(postureHint, /repo `dist\/` override/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(postureHint, /0\.0\.0/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(postureHint, /@pdpp\/local-collector/);
  // The remediation must not promise that the published build is current:
  // it can lag the repo build, so re-pinning a repo override onto a stale
  // published release would regress it. The hint routes through the release
  // owner's dist-tag check instead of asserting the published build is current.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(postureHint, /can lag the repo build/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(postureHint, /release:dist-tag-check/);
});

test("doctor deployment_posture check is ok for a pinned published install", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();

  const doctor = buildLocalOutboxDoctor(
    inspectLocalOutboxStatus(
      {
        baseUrl: "http://127.0.0.1:7662",
        command: "doctor",
        queuePath: path,
        sourceInstanceId: "src-1",
      },
      { deploymentPosture: PUBLISHED_POSTURE }
    )
  );
  assert.equal(doctor.checks.deployment_posture, "ok");
});

test("doctor deployment_posture warns on the 0.0.0 placeholder even for a node_modules install", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();

  // A bare/`@latest` global install resolves the placeholder under
  // node_modules — published-package layout, but still not real evidence.
  const placeholderPublished = {
    kind: "published_package",
    is_placeholder_version: true,
    location_hint: "node_modules/@pdpp/local-collector",
    module_basename: "pdpp-local-collector.js",
    version: "0.0.0",
  };
  const doctor = buildLocalOutboxDoctor(
    inspectLocalOutboxStatus(
      {
        baseUrl: "http://127.0.0.1:7662",
        command: "doctor",
        queuePath: path,
        sourceInstanceId: "src-1",
      },
      { deploymentPosture: placeholderPublished }
    )
  );
  assert.equal(doctor.checks.deployment_posture, "warn");
  assert.equal(doctor.status, "warning");
});

test("live deployment posture detection of the running test process never leaks an absolute home path", () => {
  // No argument → live detection from the running module. In the repo worktree
  // this is a repo override; the point is that whatever it resolves, the
  // emitted block is redaction-safe (no leading-slash absolute path).
  const posture = classifyLocalCollectorDeploymentPosture();
  assert.ok(["published_package", "repo_dist_override", "unknown"].includes(posture.kind));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(posture.location_hint, /^\//);
  assert.doesNotMatch(posture.location_hint, new RegExp(escapeRegExp(homedir())));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("local collector retry-dead-letters is dry-run by default and backs up before apply", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: "dead-letter-id",
      kind: "record_batch",
      payload: { secret: "dead-letter-payload" },
      sourceInstanceId: "src-1",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId: "src-1" });
    assert.ok(claim);
    outbox.deadLetter({
      error: "terminal",
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });
  } finally {
    outbox.close();
  }

  const parsed = parseArgs([
    "retry-dead-letters",
    "--queue",
    path,
    "--connection-id",
    "src-1",
    "--kind",
    "record_batch",
    "--limit",
    "10",
  ]);
  assert.equal(parsed.apply, undefined);
  assert.equal(parsed.deadLetterKind, "record_batch");
  assert.equal(parsed.limit, 10);

  const dryRun = retryLocalOutboxDeadLetters(parsed);
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.matched, 1);
  assert.equal(dryRun.requeued, 0);
  assert.equal(dryRun.backup_path, null);
  assert.equal(dryRun.status_before.dead_letter, 1);
  assert.equal(dryRun.status_after.dead_letter, 1);
  // Dry run previews the cause and points at the next step.
  assert.equal(dryRun.dead_letter_error_summary.top_classes[0].error_class, "terminal");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(dryRun.note, /dry run/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(dryRun.note, /--apply/);

  const applied = retryLocalOutboxDeadLetters({ ...parsed, apply: true });
  assert.equal(applied.dry_run, false);
  assert.equal(applied.matched, 1);
  assert.equal(applied.requeued, 1);
  assert.ok(applied.backup_path);
  assert.equal(existsSync(applied.backup_path), true);
  assert.equal(applied.status_before.dead_letter, 1);
  assert.equal(applied.status_after.dead_letter, 0);
  assert.equal(applied.status_after.pending, 1);
  // After requeue the note points normal recovery at the source-profile command.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(applied.note, /recover --source-instance-id <id> --apply/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(applied.note, /does not ingest/);

  // Payloads and ids never leak; the redacted error class ("terminal") is
  // intentionally surfaced as the recovery cause.
  const rendered = JSON.stringify(applied);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(rendered, /dead-letter-payload|dead-letter-id/);
});

test("local collector retry-dead-letters explains a state-read block when nothing matches", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A healthy (no dead-letter) outbox: nothing to requeue.
    outbox.enqueue({ id: "ok-id", kind: "record_batch", payload: { ok: true }, sourceInstanceId: "src-1" });
  } finally {
    outbox.close();
  }
  const result = retryLocalOutboxDeadLetters(
    parseArgs(["retry-dead-letters", "--queue", path, "--connection-id", "src-1"])
  );
  assert.equal(result.matched, 0);
  assert.equal(result.requeued, 0);
  assert.equal(result.dead_letter_error_summary, undefined);
  // The note distinguishes a state-read block (nothing to requeue) from a
  // dead-letter backlog and points at source-profile recovery.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /state-read block/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /recover --source-instance-id <id> --apply/);
});

test("local collector profile parser reads source identity and durable queue settings", () => {
  const env = parseCollectorProfileEnv(`
    # comment
    export PDPP_REFERENCE_BASE_URL="https://pdpp.example.com"
    PDPP_CONNECTION_ID='dsrc_profile'
    PDPP_COLLECTOR_QUEUE=/var/lib/pdpp/collector.sqlite
    ignored-line
  `);
  assert.equal(env.PDPP_REFERENCE_BASE_URL, "https://pdpp.example.com");
  assert.equal(env.PDPP_CONNECTION_ID, "dsrc_profile");
  assert.equal(env.PDPP_COLLECTOR_QUEUE, "/var/lib/pdpp/collector.sqlite");
  assert.equal(env["ignored-line"], undefined);
});

test("local collector status resolves the matching source-instance profile queue", async () => {
  const profileDir = await tempDir();
  const queuePath = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path: queuePath });
  try {
    outbox.enqueue({
      id: "pending-row",
      kind: "record_batch",
      payload: { private: "not-rendered" },
      sourceInstanceId: "dsrc_laptop",
    });
  } finally {
    outbox.close();
  }
  await writeFile(
    join(profileDir, "claude_code.env"),
    [
      "PDPP_REFERENCE_BASE_URL=https://pdpp.example.com",
      "PDPP_COLLECTOR_CONNECTOR=claude_code",
      "PDPP_LOCAL_DEVICE_ID=device-1",
      "PDPP_LOCAL_DEVICE_TOKEN=token-1",
      "PDPP_SOURCE_INSTANCE_ID=dsrc_laptop",
      `PDPP_COLLECTOR_QUEUE=${queuePath}`,
      "",
    ].join("\n")
  );

  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const options = resolveInspectionOptions(parseArgs(["status", "--source-instance-id", "dsrc_laptop"]));
    const status = inspectLocalOutboxStatus(options, { deploymentPosture: PUBLISHED_POSTURE });
    assert.equal(status.db.exists, true);
    assert.equal(status.db.path, queuePath);
    assert.equal(status.configured_device.device_id_configured, true);
    assert.equal(status.configured_device.device_token_configured, true);
    assert.equal(status.outbox.counts.pending, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("local collector doctor resolves an explicitly named profile without a source id", async () => {
  const profileDir = await tempDir();
  const queuePath = await tempOutboxPath();
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  await writeFile(
    join(profileDir, "codex.env"),
    [
      "PDPP_REFERENCE_BASE_URL=http://127.0.0.1:3012",
      "PDPP_COLLECTOR_CONNECTOR=codex",
      "PDPP_LOCAL_DEVICE_ID=device-1",
      "PDPP_LOCAL_DEVICE_TOKEN=token-1",
      "PDPP_CONNECTION_ID=dsrc_codex",
      `PDPP_COLLECTOR_QUEUE=${queuePath}`,
      "",
    ].join("\n")
  );
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const options = resolveInspectionOptions(parseArgs(["doctor", "--profile", "codex"]));
    assert.equal(options.sourceInstanceId, "dsrc_codex");
    assert.equal(options.baseUrl, "http://127.0.0.1:3012");
    assert.equal(options.queuePath, queuePath);
    assert.equal(options.deviceId, "device-1");
    assert.equal(options.deviceToken, "token-1");
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("local collector inspection refuses a missing named profile instead of using the default queue", () => {
  const profileDir = tempDirSync();
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    assert.throws(
      () => resolveInspectionOptions(parseArgs(["status", "--profile", "missing"])),
      MISSING_PROFILE_PATTERN
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("normalizeConnectorId lowercases and folds hyphens to underscores", () => {
  assert.equal(normalizeConnectorId("claude-code"), "claude_code");
  assert.equal(normalizeConnectorId("CLAUDE_CODE"), "claude_code");
  assert.equal(normalizeConnectorId("  Claude-Code  "), "claude_code");
  assert.equal(normalizeConnectorId("codex"), "codex");
});

test("writeLocalCollectorProfile writes a profile .env that findLocalCollectorProfiles resolves back", () => {
  const profileDir = tempDirSync();
  const path = writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "claude_code",
    deviceId: "device-42",
    deviceToken: "token-42",
    name: "claude_code",
    profileDir,
    sourceInstanceId: "dsrc_setup",
  });
  assert.equal(path, join(profileDir, "claude_code.env"));
  assert.equal(existsSync(path), true);

  const lookup = findLocalCollectorProfiles({ profileDir, sourceInstanceId: "dsrc_setup" });
  assert.equal(lookup.matches.length, 1);
  const [profile] = lookup.matches;
  assert.ok(profile, "expected exactly one matching profile");
  assert.equal(profile.env.PDPP_REFERENCE_BASE_URL, "https://pdpp.example.com");
  assert.equal(profile.env.PDPP_COLLECTOR_CONNECTOR, "claude_code");
  assert.equal(profile.env.PDPP_LOCAL_DEVICE_ID, "device-42");
  assert.equal(profile.env.PDPP_LOCAL_DEVICE_TOKEN, "token-42");
  assert.equal(profile.source_instance_id, "dsrc_setup");
});

test("writeLocalCollectorProfile restricts directory and file permissions to the owner (POSIX)", {
  skip: process.platform === "win32",
}, () => {
  const profileDir = tempDirSync();
  const path = writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "codex",
    deviceId: "device-1",
    deviceToken: "token-1",
    name: "codex",
    profileDir,
    sourceInstanceId: "dsrc_perm",
  });
  // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
  const fileMode = statSync(path).mode & 0o777;
  // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
  const dirMode = statSync(profileDir).mode & 0o777;
  assert.equal(fileMode, 0o600);
  assert.equal(dirMode, 0o700);
});

test("writeLocalCollectorProfile re-tightens a pre-existing profile file/dir left at weaker permissions (P3: connect --force overwrite)", {
  skip: process.platform === "win32",
}, () => {
  const profileDir = tempDirSync();
  const path = writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "codex",
    deviceId: "device-old",
    deviceToken: "token-old",
    name: "codex",
    profileDir,
    sourceInstanceId: "dsrc_perm_weak",
  });
  // Simulate a profile left world/group-readable by something outside this
  // CLI's own write paths (manual chmod, restored backup, older build).
  chmodSync(path, 0o644);
  chmodSync(profileDir, 0o755);

  writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "codex",
    deviceId: "device-new",
    deviceToken: "token-new",
    name: "codex",
    profileDir,
    sourceInstanceId: "dsrc_perm_weak",
  });

  // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
  const fileMode = statSync(path).mode & 0o777;
  // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
  const dirMode = statSync(profileDir).mode & 0o777;
  assert.equal(fileMode, 0o600, "overwrite must re-tighten a pre-existing 0644 file back to 0600");
  assert.equal(dirMode, 0o700, "overwrite must re-tighten a pre-existing 0755 directory back to 0700");
});

test("writeLocalCollectorProfile round-trips a base URL containing special characters", () => {
  const profileDir = tempDirSync();
  writeLocalCollectorProfile({
    baseUrl: 'https://pdpp.example.com/path?x="y"&z=\\',
    connectorId: "claude_code",
    deviceId: "device-1",
    deviceToken: "token-1",
    name: "claude_code",
    profileDir,
    sourceInstanceId: "dsrc_escape",
  });
  const lookup = findLocalCollectorProfiles({ profileDir, sourceInstanceId: "dsrc_escape" });
  const [profile] = lookup.matches;
  assert.ok(profile, "expected exactly one matching profile");
  assert.equal(profile.env.PDPP_REFERENCE_BASE_URL, 'https://pdpp.example.com/path?x="y"&z=\\');
});

test("removeLocalCollectorProfile deletes an existing profile and is idempotent on a missing one", () => {
  const profileDir = tempDirSync();
  writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "claude_code",
    deviceId: "device-1",
    deviceToken: "token-1",
    name: "claude_code",
    profileDir,
    sourceInstanceId: "dsrc_remove",
  });
  const first = removeLocalCollectorProfile({ name: "claude_code", profileDir });
  assert.equal(first.removed, true);
  assert.equal(existsSync(first.path), false);

  const second = removeLocalCollectorProfile({ name: "claude_code", profileDir });
  assert.equal(second.removed, false);
});

test("run without --queue fills device-id/device-token/connector from a matching profile", () => {
  const profileDir = tempDirSync();
  writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "claude_code",
    deviceId: "device-from-profile",
    deviceToken: "token-from-profile",
    name: "claude_code",
    profileDir,
    sourceInstanceId: "dsrc_run_profile",
  });
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const options = parseArgs(["run", "--connection-id", "dsrc_run_profile"]);
    const resolved = resolveRunProfileOptions(options);
    assert.equal(resolved.deviceId, "device-from-profile");
    assert.equal(resolved.deviceToken, "token-from-profile");
    assert.equal(resolved.connector, "claude_code");
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("run with device-id/device-token/connector supplied via flags never consults the profile dir (automation compatibility)", () => {
  // Regression guard: existing automation supplies device-id/device-token/
  // connector entirely via flags or PDPP_LOCAL_DEVICE_ID/PDPP_LOCAL_DEVICE_TOKEN
  // env vars with no profile file ever written on disk. `run` must keep
  // working exactly as before — never refuse just because no profile matches.
  const profileDir = tempDirSync(); // deliberately empty — no profile written
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const options = parseArgs([
      "run",
      "--connection-id",
      "dsrc_no_profile",
      "--device-id",
      "device-1",
      "--device-token",
      "token-1",
      "--connector",
      "claude_code",
    ]);
    const resolved = resolveRunProfileOptions(options);
    assert.equal(resolved.deviceId, "device-1");
    assert.equal(resolved.deviceToken, "token-1");
    assert.equal(resolved.connector, "claude_code");
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("logout removes the named profile and reports removed:false when absent", () => {
  const profileDir = tempDirSync();
  writeLocalCollectorProfile({
    baseUrl: "https://pdpp.example.com",
    connectorId: "claude_code",
    deviceId: "device-1",
    deviceToken: "token-1",
    name: "claude_code",
    profileDir,
    sourceInstanceId: "dsrc_logout",
  });
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const first = removeLocalCollectorProfile({ name: "claude_code" });
    assert.equal(first.removed, true);
    const second = removeLocalCollectorProfile({ name: "claude_code" });
    assert.equal(second.removed, false);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

async function withProfileDir<T>(profileDir: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
}

/**
 * Table-driven `runLogout` cases. Each seeds a profile (or not), stubs
 * `selfRevoke`, and asserts the resulting removed/revoked state plus
 * whether the local profile survives. Covers the required discriminators:
 * self-only revoke's client contract (success), idempotent retry (401/403
 * treated as already-revoked), network failure fails closed and preserves
 * the profile, an unrecognized 5xx also fails closed, --local-only skips
 * the server entirely, and a missing profile is a no-op.
 */
const LOGOUT_CASES: Array<{
  expectRevokeCalled: boolean;
  localOnly?: boolean;
  name: string;
  rejects?: boolean;
  seedProfile: boolean;
  selfRevoke: () => Promise<unknown>;
  want?: { removed: boolean; revoked: boolean };
}> = [
  {
    expectRevokeCalled: true,
    name: "success: revokes server-side then deletes the local profile",
    seedProfile: true,
    selfRevoke: async () => ({ device_id: "device-1", object: "device_exporter_revocation", revoked_at: "now" }),
    want: { removed: true, revoked: true },
  },
  {
    expectRevokeCalled: true,
    name: "idempotent retry: a 401 (already revoked) still deletes locally",
    seedProfile: true,
    selfRevoke: () => {
      throw new LocalDeviceHttpError(401, JSON.stringify({ error: { code: "authentication_error" } }));
    },
    want: { removed: true, revoked: true },
  },
  {
    expectRevokeCalled: true,
    name: "ambiguous network failure: fails closed, local profile preserved",
    rejects: true,
    seedProfile: true,
    selfRevoke: () => {
      throw new TypeError("fetch failed");
    },
  },
  {
    expectRevokeCalled: true,
    name: "5xx: fails closed like a network failure, not treated as already-revoked",
    rejects: true,
    seedProfile: true,
    selfRevoke: () => {
      throw new LocalDeviceHttpError(500, JSON.stringify({ error: { code: "internal_error" } }));
    },
  },
  {
    expectRevokeCalled: false,
    localOnly: true,
    name: "--local-only: skips the server call and deletes unconditionally",
    seedProfile: true,
    selfRevoke: async () => ({ device_id: "device-1", object: "device_exporter_revocation", revoked_at: "now" }),
    want: { removed: true, revoked: false },
  },
  {
    expectRevokeCalled: false,
    name: "missing profile: no-op, never calls the server",
    seedProfile: false,
    selfRevoke: async () => ({ device_id: "device-1", object: "device_exporter_revocation", revoked_at: "now" }),
    want: { removed: false, revoked: false },
  },
];

for (const testCase of LOGOUT_CASES) {
  test(`runLogout: ${testCase.name}`, async () => {
    const profileDir = tempDirSync();
    const profilePath = join(profileDir, "claude_code.env");
    if (testCase.seedProfile) {
      writeLocalCollectorProfile({
        baseUrl: "https://pdpp.example.com",
        connectorId: "claude_code",
        deviceId: "device-1",
        deviceToken: "token-1",
        name: "claude_code",
        profileDir,
        sourceInstanceId: "dsrc_logout",
      });
    }
    await withProfileDir(profileDir, async () => {
      let called = false;
      const options: CliOptions = {
        baseUrl: "https://pdpp.example.com",
        command: "logout",
        connector: "claude_code",
        ...(testCase.localOnly ? { localOnly: true } : {}),
        queuePath: "unused.sqlite",
      };
      const deps = {
        selfRevoke: () => {
          called = true;
          return testCase.selfRevoke();
        },
      };
      if (testCase.rejects) {
        await assert.rejects(runLogout(options, deps), CollectorUsageError);
        assert.equal(existsSync(profilePath), true, "a fail-closed logout must preserve the local profile");
      } else {
        const result = await runLogout(options, deps);
        assert.equal(result.removed, testCase.want?.removed);
        assert.equal(result.revoked, testCase.want?.revoked);
        // The profile file must be gone iff this case seeded one AND it was
        // removed; a case that never seeded a profile has nothing to check.
        if (testCase.seedProfile) {
          assert.equal(existsSync(profilePath), !testCase.want?.removed);
        }
      }
      assert.equal(called, testCase.expectRevokeCalled);
    });
  });
}

test("local collector recover dry-run loads the matching source-instance profile queue", async () => {
  const profileDir = await tempDir();
  const queuePath = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path: queuePath });
  try {
    outbox.enqueue({
      id: "dead-letter-id",
      kind: "record_batch",
      payload: { secret: "dead-letter-payload" },
      sourceInstanceId: "dsrc_laptop",
    });
    const [claim] = outbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId: "dsrc_laptop" });
    outbox.deadLetter({
      error: "local device request failed: 502",
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });
  } finally {
    outbox.close();
  }
  await writeFile(
    join(profileDir, "claude_code.env"),
    [
      "PDPP_REFERENCE_BASE_URL=https://pdpp.example.com",
      "PDPP_COLLECTOR_CONNECTOR=claude_code",
      "PDPP_LOCAL_DEVICE_ID=device-1",
      "PDPP_LOCAL_DEVICE_TOKEN=token-1",
      "PDPP_SOURCE_INSTANCE_ID=dsrc_laptop",
      `PDPP_COLLECTOR_QUEUE=${queuePath}`,
      "",
    ].join("\n")
  );

  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const lookup = findLocalCollectorProfiles({ sourceInstanceId: "dsrc_laptop" });
    assert.equal(lookup.matches.length, 1);
    assert.equal(lookup.matches[0]?.name, "claude_code");

    const result = await recoverLocalCollector(parseArgs(["recover", "--source-instance-id", "dsrc_laptop"]));
    assert.equal(result.object, "local_collector_recovery");
    assert.equal(result.dry_run, true);
    assert.equal(result.profile.name, "claude_code");
    assert.equal(result.profile.source, "local_profile");
    assert.equal(result.db.exists, true);
    assert.equal(result.db.path, queuePath);
    assert.equal(result.retry_dead_letters?.matched, 1);
    assert.equal(result.retry_dead_letters?.requeued, 0);
    assert.equal(result.status_before.outbox.counts.dead_letter, 1);
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    assert.match(result.note, /would be prepared for retry/);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("local collector recover respects explicit queue over the matching profile queue", async () => {
  const profileDir = await tempDir();
  const profileQueuePath = await tempOutboxPath();
  const explicitQueuePath = await tempOutboxPath();
  const profileOutbox = new LocalDeviceOutbox({ path: profileQueuePath });
  const explicitOutbox = new LocalDeviceOutbox({ path: explicitQueuePath });
  try {
    profileOutbox.enqueue({ id: "profile-row", kind: "record_batch", payload: {}, sourceInstanceId: "dsrc_laptop" });
    explicitOutbox.enqueue({ id: "explicit-row", kind: "record_batch", payload: {}, sourceInstanceId: "dsrc_laptop" });
    const [claim] = explicitOutbox.claimReady({ holder: "worker-a", leaseMs: 60_000, sourceInstanceId: "dsrc_laptop" });
    explicitOutbox.deadLetter({
      error: "explicit queue error",
      holder: "worker-a",
      id: claim.id,
      leaseEpoch: claim.lease_epoch,
    });
  } finally {
    profileOutbox.close();
    explicitOutbox.close();
  }
  await writeFile(
    join(profileDir, "claude_code.env"),
    ["PDPP_SOURCE_INSTANCE_ID=dsrc_laptop", `PDPP_COLLECTOR_QUEUE=${profileQueuePath}`, ""].join("\n")
  );

  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    const result = await recoverLocalCollector(
      parseArgs(["recover", "--source-instance-id", "dsrc_laptop", "--queue", explicitQueuePath])
    );
    assert.equal(result.db.path, explicitQueuePath);
    assert.equal(result.retry_dead_letters?.matched, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("local collector recover apply keeps draining while the backlog shrinks", async () => {
  const status = (pending) => ({
    collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
    configured_device: {
      device_id_configured: true,
      device_token_configured: true,
    },
    coverage: {
      observed: true,
      record_batches: 1,
    },
    db: {
      configured: true,
      exists: true,
      path: "/tmp/pdpp-test-collector.sqlite",
    },
    deployment_posture: PUBLISHED_POSTURE,
    lifecycle_state: pending > 0 ? "draining" : "healthy_idle",
    outbox: {
      counts: {
        dead_letter: 0,
        leased: 0,
        pending,
        retrying: pending,
        sent: 10,
        total: 10 + pending,
      },
      expired_leases: 0,
      oldest_pending_at: pending > 0 ? "2026-06-17T01:39:24.812Z" : null,
    },
    package: {
      name: "@pdpp/local-collector",
      version: "0.1.0-beta.7",
    },
    source: {
      connection_id: "dsrc_laptop",
      source_instance_id: "dsrc_laptop",
    },
  });
  const statuses = [status(24), status(24), status(12), status(0)];
  let runCount = 0;

  const result = await recoverLocalCollector(
    parseArgs([
      "recover",
      "--source-instance-id",
      "dsrc_laptop",
      "--queue",
      "/tmp/pdpp-test-collector.sqlite",
      "--apply",
      "--max-drain-passes",
      "5",
    ]),
    {
      inspectStatus: () => statuses.shift() ?? status(0),
      // biome-ignore lint/suspicious/useAwait: RecoverLocalCollectorDeps.runOnce is typed Promise<CollectorRunResult>; async is required to satisfy the interface even though this mock has no internal await.
      runOnce: async () => {
        runCount += 1;
        return drainOnlyRunResult({ ready: Math.max(0, 24 - runCount * 12), succeeded: 10, total: 10 });
      },
    }
  );

  assert.equal(result.applied, true);
  assert.equal(result.drain_attempts, 2);
  assert.equal(result.drain_stopped_reason, "drained");
  assert.equal(result.fully_drained, true);
  assert.equal(result.run.drained, true);
  assert.equal(result.runs.length, 2);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /drained queued work in 2 pass/);
});

test("local collector recover apply stops honestly when a drain pass makes no progress", async () => {
  const status = (pending) => ({
    collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
    configured_device: {
      device_id_configured: true,
      device_token_configured: true,
    },
    coverage: {
      observed: true,
      record_batches: 1,
    },
    db: {
      configured: true,
      exists: true,
      path: "/tmp/pdpp-test-collector.sqlite",
    },
    deployment_posture: PUBLISHED_POSTURE,
    lifecycle_state: "draining",
    outbox: {
      counts: {
        dead_letter: 0,
        leased: 0,
        pending,
        retrying: 0,
        sent: 10,
        total: 10 + pending,
      },
      expired_leases: 0,
      oldest_pending_at: "2026-06-17T01:39:24.812Z",
    },
    package: {
      name: "@pdpp/local-collector",
      version: "0.1.0-beta.7",
    },
    source: {
      connection_id: "dsrc_laptop",
      source_instance_id: "dsrc_laptop",
    },
  });
  const statuses = [status(24), status(24), status(24)];

  const result = await recoverLocalCollector(
    parseArgs([
      "recover",
      "--source-instance-id",
      "dsrc_laptop",
      "--queue",
      "/tmp/pdpp-test-collector.sqlite",
      "--apply",
      "--max-drain-passes",
      "5",
    ]),
    {
      inspectStatus: () => statuses.shift() ?? status(24),
      runOnce: async () => drainOnlyRunResult({ ready: 24, retrying: 24, succeeded: 10, total: 34 }),
    }
  );

  assert.equal(result.drain_attempts, 2);
  assert.equal(result.drain_stopped_reason, "no_progress");
  assert.equal(result.fully_drained, false);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /did not reduce the backlog/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /24 queued row/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(result.note, /48 queued row/);
});

test("local collector recover apply keeps draining after a fresh scan queues new work", async () => {
  const status = (pending) => ({
    collector_protocol_version: COLLECTOR_PROTOCOL_VERSION,
    configured_device: {
      device_id_configured: true,
      device_token_configured: true,
    },
    coverage: {
      observed: true,
      record_batches: 1,
    },
    db: {
      configured: true,
      exists: true,
      path: "/tmp/pdpp-test-collector.sqlite",
    },
    deployment_posture: PUBLISHED_POSTURE,
    lifecycle_state: pending > 0 ? "draining" : "healthy_idle",
    outbox: {
      counts: {
        dead_letter: 0,
        leased: 0,
        pending,
        retrying: 0,
        sent: 10,
        total: 10 + pending,
      },
      expired_leases: 0,
      oldest_pending_at: pending > 0 ? "2026-06-17T01:39:24.812Z" : null,
    },
    package: {
      name: "@pdpp/local-collector",
      version: "0.1.0-beta.7",
    },
    source: {
      connection_id: "dsrc_laptop",
      source_instance_id: "dsrc_laptop",
    },
  });
  const statuses = [
    status(24), // status_before
    status(24), // after retry step
    status(12), // stale backlog drains
    status(100), // fresh scan found new source work; this must not be "no_progress"
    status(40),
    status(0),
  ];
  let runCount = 0;

  const result = await recoverLocalCollector(
    parseArgs([
      "recover",
      "--source-instance-id",
      "dsrc_laptop",
      "--queue",
      "/tmp/pdpp-test-collector.sqlite",
      "--apply",
      "--max-drain-passes",
      "6",
    ]),
    {
      inspectStatus: () => statuses.shift() ?? status(0),
      // biome-ignore lint/suspicious/useAwait: RecoverLocalCollectorDeps.runOnce is typed Promise<CollectorRunResult>; async is required to satisfy the interface even though this mock has no internal await.
      runOnce: async () => {
        runCount += 1;
        if (runCount === 2) {
          return {
            ...baseRunResult({ ready: 100, succeeded: 10, total: 110 }),
            enqueuedBatches: 100,
            recordsQueued: 999,
          };
        }
        return drainOnlyRunResult({ ready: Math.max(0, 24 - runCount * 12), succeeded: 10, total: 10 });
      },
    }
  );

  assert.equal(result.drain_attempts, 4);
  assert.equal(result.drain_stopped_reason, "drained");
  assert.equal(result.fully_drained, true);
  assert.equal(result.runs.length, 4);
});

test("local collector rejects conflicting source identity flags", () => {
  assert.throws(
    () => parseArgs(["recover", "--connection-id", "dsrc_a", "--source-instance-id", "dsrc_b"]),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /disagrees/
  );
});

test("local collector recover refuses an unscoped default queue when no profile exists", async () => {
  const profileDir = await tempDir();
  const previous = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDir;
  try {
    await assert.rejects(
      recoverLocalCollector(parseArgs(["recover", "--source-instance-id", "dsrc_missing"])),
      (error) => {
        // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
        assert.match(String(error), /could not find a local collector profile/);
        assert.doesNotMatch(String(error), new RegExp(profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    } else {
      process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previous;
    }
  }
});

test("local collector run output summarizes state cursors without dumping payload maps", () => {
  const output = summarizeRunResultForCli({
    done: { records_emitted: 1, status: "succeeded", type: "DONE" },
    enqueuedBatches: 1,
    flushedState: {
      messages: {
        fetched_at: "2026-05-20T00:00:00.000Z",
        file_mtimes: {
          "/private/path/a.jsonl": 1,
          "/private/path/b.jsonl": 2,
        },
        file_cursors: {
          "/private/path/a.jsonl": {
            mtime_ms: 1,
            size_bytes: 100,
            offset_bytes: 90,
            line_count: 3,
            head_sha256: "deadbeef".repeat(8),
            guard_bytes: 90,
            session_id: "sess-private",
            message_count: 2,
            function_call_count: 1,
            first_ts: "2026-05-20T00:00:00.000Z",
            last_ts: "2026-05-20T00:00:01.000Z",
          },
        },
      },
    },
    outboxSummary: {
      deadLetter: 0,
      leased: 0,
      oldestReadyAt: null,
      ready: 0,
      retrying: 0,
      staleLeases: 0,
      succeeded: 1,
      total: 1,
    },
    priorState: {
      messages: {
        fetched_at: "2026-05-19T00:00:00.000Z",
        file_mtimes: {
          "/private/path/a.jsonl": 1,
        },
      },
    },
    recordsQueued: 1,
    recoveredLeases: 0,
    autoRecoveredTransientDeadLetters: 0,
    satisfiedBindings: ["filesystem"],
    sentBatches: 1,
    skippedScanForBacklog: false,
    scanBudgetExceeded: false,
    statePutFailed: false,
    streamingBufferHighWaterMark: 1,
  });

  assert.equal(output.flushedState.streams.messages.file_mtimes_count, 2);
  // The append-safe rollout cursor's `file_cursors` map is summarized by count
  // only — its key (the private path) lands in `keys` as the literal string
  // "file_cursors", never the path itself.
  assert.equal(output.flushedState.streams.messages.file_cursors_count, 1);
  assert.deepEqual(output.flushedState.streams.messages.keys, ["fetched_at", "file_cursors", "file_mtimes"]);
  assert.equal(output.priorState.streams.messages.file_mtimes_count, 1);
  const rendered = JSON.stringify(output);
  assert.equal(rendered.includes("/private/path"), false);
  assert.equal(rendered.includes("a.jsonl"), false);
  assert.equal(rendered.includes("b.jsonl"), false);
  // The per-file cursor's offsets, integrity hash, and session id must not leak
  // into the CLI summary — only the count survives.
  assert.equal(rendered.includes("deadbeef"), false);
  assert.equal(rendered.includes("sess-private"), false);
});

// --- Run-summary drain honesty (outbox-retention-health-v1) ---
//
// A connector pass can succeed on the source (done.status === 'succeeded')
// while leaving ready/retrying/leased/dead-letter work in the durable outbox.
// The live incident: records_queued=177387, sent_batches=276, then the queue
// still held pending=1203. summarizeRunResultForCli must never let such a run
// read as "fully drained".

/** A baseline succeeded-source run result with a fully drained outbox. */
function baseRunResult(outboxSummary) {
  return {
    completeness: null,
    done: { records_emitted: 1, status: "succeeded", type: "DONE" },
    enqueuedBatches: 1,
    flushedState: {},
    outboxSummary: {
      deadLetter: 0,
      leased: 0,
      oldestReadyAt: null,
      ready: 0,
      retrying: 0,
      staleLeases: 0,
      succeeded: 1,
      total: 1,
      ...outboxSummary,
    },
    priorState: {},
    recordsQueued: 1,
    recoveredLeases: 0,
    autoRecoveredTransientDeadLetters: 0,
    satisfiedBindings: ["filesystem"],
    scanBudgetExceeded: false,
    sentBatches: 1,
    skippedScanForBacklog: false,
    statePutFailed: false,
    streamingBufferHighWaterMark: 1,
  };
}

function drainOnlyRunResult(outboxSummary) {
  return {
    ...baseRunResult(outboxSummary),
    enqueuedBatches: 0,
    recordsQueued: 0,
  };
}

test("run summary reports drained:true and healthy_idle on a fully drained outbox", () => {
  const output = summarizeRunResultForCli(baseRunResult({ ready: 0, succeeded: 5, total: 5 }));
  assert.equal(output.drained, true);
  assert.equal(output.lifecycle_state, "healthy_idle");
  assert.equal(output.residual_backlog.total_open, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /Outbox fully drained/);
});

test("a succeeded run that leaves a ready backlog is NOT reported as fully drained", () => {
  // The live incident shape: source succeeded, but pending work remains.
  const output = summarizeRunResultForCli(baseRunResult({ ready: 1203, succeeded: 177_387, total: 178_590 }));
  assert.equal(output.done.status, "succeeded");
  assert.equal(output.drained, false, "a ready backlog must never read as drained");
  assert.equal(output.lifecycle_state, "draining");
  assert.equal(output.residual_backlog.ready, 1203);
  assert.equal(output.residual_backlog.total_open, 1203);
  // The note must assert the negative ("NOT fully drained"); it must never
  // claim the lane is drained.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(output.drain_note, /Outbox fully drained/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /NOT fully drained/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /1203 ready/);
});

test("run summary surfaces a retry backlog distinctly from a ready backlog", () => {
  // All ready rows are waiting on backoff (ready === retrying), nothing
  // claimable now: lifecycle is retryable_backlog, not draining.
  const output = summarizeRunResultForCli(baseRunResult({ ready: 4, retrying: 4, succeeded: 10, total: 14 }));
  assert.equal(output.drained, false);
  assert.equal(output.lifecycle_state, "retryable_backlog");
  assert.equal(output.residual_backlog.retrying, 4);
  assert.equal(output.residual_backlog.total_open, 4);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /retrying/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(output.drain_note, /ready/);
});

test("run summary does not double-count retrying rows when some ready rows are claimable", () => {
  const output = summarizeRunResultForCli(baseRunResult({ ready: 6, retrying: 4, succeeded: 10, total: 16 }));
  assert.equal(output.drained, false);
  assert.equal(output.residual_backlog.total_open, 6);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /2 ready/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /4 retrying/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(output.drain_note, /6 ready/);
});

test("run summary surfaces a dead-letter backlog with a recovery pointer", () => {
  const output = summarizeRunResultForCli(baseRunResult({ deadLetter: 2, succeeded: 8, total: 10 }));
  assert.equal(output.drained, false);
  assert.equal(output.lifecycle_state, "dead_letter");
  assert.equal(output.residual_backlog.dead_letter, 2);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /recover --source-instance-id <id> --apply/);
});

test("run summary explains a backlog-skipped scan without claiming a fresh drain", () => {
  const result = baseRunResult({ ready: 50, succeeded: 0, total: 50 });
  result.skippedScanForBacklog = true;
  const output = summarizeRunResultForCli(result);
  assert.equal(output.drained, false);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /Scan was skipped/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /50 open/);
});

test("run summary names the scan-budget cutoff so the backlog is not read as the whole source", () => {
  const result = baseRunResult({ ready: 500, succeeded: 1000, total: 1500 });
  result.scanBudgetExceeded = true;
  const output = summarizeRunResultForCli(result);
  assert.equal(output.drained, false);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.drain_note, /enqueue budget/);
});

// --- coverage_note: exhaustive-vs-partial completion honesty ---
//
// A run's coverage_note must agree EXACTLY with whether collector-runner.ts's
// own reportTerminalCollection gate fired — the same three axes: scan budget,
// DONE status, and a real coverage observation. It must never say "committed"
// for a run that could not have reached that call.

test("coverage_note reports committed + fully accounted for a clean succeeded run", () => {
  const result = baseRunResult({ ready: 0, succeeded: 5, total: 5 });
  result.completeness = {
    byStore: { messages: "observed_collected" },
    countsByStatus: { observed_collected: 1 },
    fullyAccounted: true,
    storeCount: 1,
    unaccountedStores: [],
  };
  const output = summarizeRunResultForCli(result);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /Coverage committed/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /fully accounted/);
});

test("coverage_note names unaccounted stores rather than claiming full coverage", () => {
  const result = baseRunResult({ ready: 0, succeeded: 5, total: 5 });
  result.completeness = {
    byStore: { attachments: "unaccounted", messages: "observed_collected" },
    countsByStatus: { observed_collected: 1, unaccounted: 1 },
    fullyAccounted: false,
    storeCount: 2,
    unaccountedStores: ["attachments"],
  };
  const output = summarizeRunResultForCli(result);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /Coverage committed/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /attachments/);
});

test("coverage_note never claims committed coverage when the scan budget stopped the run", () => {
  const result = baseRunResult({ ready: 500, succeeded: 1000, total: 1500 });
  result.scanBudgetExceeded = true;
  result.completeness = {
    byStore: { messages: "observed_collected" },
    countsByStatus: { observed_collected: 1 },
    fullyAccounted: true,
    storeCount: 1,
    unaccountedStores: [],
  };
  const output = summarizeRunResultForCli(result);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /NOT committed/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /scan budget/);
});

test("coverage_note never claims committed coverage when the connector did not report succeeded", () => {
  const result = baseRunResult({ ready: 0, succeeded: 0, total: 0 });
  result.done = { records_emitted: 0, status: "failed", type: "DONE" };
  const output = summarizeRunResultForCli(result);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /NOT committed/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /did not finish/);
});

test("coverage_note never claims committed coverage when no coverage diagnostic was observed", () => {
  const output = summarizeRunResultForCli(baseRunResult({ ready: 0, succeeded: 5, total: 5 }));
  assert.equal(output.completeness, null);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /NOT committed/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(output.coverage_note, /reported no coverage diagnostics/);
});

test("run summary drained flag is true iff lifecycle_state is healthy_idle", () => {
  // Invariant: the boolean honesty flag and the lifecycle taxonomy must never
  // disagree. Exercise every non-stale open-work shape plus the idle case.
  const shapes = [
    { deadLetter: 0, leased: 0, ready: 0, retrying: 0 }, // idle
    { deadLetter: 0, leased: 0, ready: 5, retrying: 0 }, // draining
    { deadLetter: 0, leased: 0, ready: 5, retrying: 5 }, // retryable_backlog
    { deadLetter: 0, leased: 3, ready: 0, retrying: 0 }, // draining (leased)
    { deadLetter: 2, leased: 0, ready: 0, retrying: 0 }, // dead_letter
  ];
  for (const shape of shapes) {
    const total = shape.deadLetter + shape.leased + shape.ready + 1;
    const output = summarizeRunResultForCli(baseRunResult({ ...shape, succeeded: 1, total }));
    assert.equal(
      output.drained,
      output.lifecycle_state === "healthy_idle",
      `drained/lifecycle mismatch for ${JSON.stringify(shape)} → ${output.lifecycle_state}`
    );
  }
});

// --- Connector adoption (tasks 5.1-5.4) ---

test("pdpp-local-collector run --connector claude_code resolves to the bundled durable-outbox entrypoint", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "claude_code",
    "--device-id",
    "device-1",
    "--device-token",
    "token-1",
    "--connection-id",
    "src-claude",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "claude_code");
  assert.equal(spec.command, BUNDLED_CONNECTORS.claude_code.command);
  assert.deepEqual([...spec.args], [...BUNDLED_CONNECTORS.claude_code.args]);
  assert.deepEqual([...spec.streams].sort(), [...BUNDLED_CONNECTORS.claude_code.streams].sort());
  assert.equal(spec.runtime_requirements.bindings.filesystem?.required, true);
});

test("pdpp-local-collector run --connector claude-code (hyphen) normalizes to the bundled claude_code entrypoint", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "claude-code",
    "--device-id",
    "device-1",
    "--device-token",
    "token-1",
    "--connection-id",
    "src-claude",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "claude_code");
  assert.equal(spec.command, BUNDLED_CONNECTORS.claude_code.command);
});

test("pdpp-local-collector run --connector CLAUDE_CODE (uppercase) normalizes to the bundled claude_code entrypoint", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "CLAUDE_CODE",
    "--device-id",
    "device-1",
    "--device-token",
    "token-1",
    "--connection-id",
    "src-claude",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "claude_code");
});

test("pdpp-local-collector run reads connector id from PDPP_COLLECTOR_CONNECTOR", () => {
  const previous = process.env.PDPP_COLLECTOR_CONNECTOR;
  process.env.PDPP_COLLECTOR_CONNECTOR = "claude_code";
  try {
    const options = parseArgs([
      "run",
      "--base-url",
      "http://127.0.0.1:7662",
      "--device-id",
      "device-1",
      "--device-token",
      "token-1",
      "--connection-id",
      "src-claude",
    ]);
    const spec = buildConnectorSpec(options);
    assert.equal(spec.connector_id, "claude_code");
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_COLLECTOR_CONNECTOR;
    } else {
      process.env.PDPP_COLLECTOR_CONNECTOR = previous;
    }
  }
});

test("pdpp-local-collector run --connector codex resolves to the bundled durable-outbox entrypoint", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "codex",
    "--device-id",
    "device-1",
    "--device-token",
    "token-1",
    "--connection-id",
    "src-codex",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "codex");
  assert.equal(spec.command, BUNDLED_CONNECTORS.codex.command);
  assert.deepEqual([...spec.args], [...BUNDLED_CONNECTORS.codex.args]);
  assert.deepEqual([...spec.streams].sort(), [...BUNDLED_CONNECTORS.codex.streams].sort());
  assert.equal(spec.runtime_requirements.bindings.filesystem?.required, true);
});

test("pdpp-local-collector run refuses unbundled connector ids without the dev opt-in env", () => {
  // Tasks 5.1 / 5.2 / 5.3 are gated by the bundled connector registry. Any
  // non-bundled --connector id must refuse before reaching the durable
  // outbox path, so an arbitrary binary cannot be paired with a device
  // token via the published CLI.
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
  try {
    const options = parseArgs([
      "run",
      "--base-url",
      "http://127.0.0.1:7662",
      "--connector",
      "gmail",
      "--device-id",
      "device-1",
      "--device-token",
      "token-1",
      "--connection-id",
      "src-1",
    ]);
    assert.throws(() => buildConnectorSpec(options), CollectorUsageError);
  } finally {
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

test("pdpp-local-collector run refuses --command <bin> without the dev opt-in env", () => {
  // Even for a bundled connector id, an arbitrary --command override must
  // refuse so the device-token supply chain stays narrow. This is the
  // compatibility flag guard tying 5.1 to the published surface.
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
  try {
    const options = parseArgs([
      "run",
      "--base-url",
      "http://127.0.0.1:7662",
      "--connector",
      "claude_code",
      "--device-id",
      "device-1",
      "--device-token",
      "token-1",
      "--connection-id",
      "src-claude",
      "--command",
      "/bin/cat",
    ]);
    assert.throws(() => buildConnectorSpec(options), CollectorCustomCommandRefusedError);
  } finally {
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

test("buildLocalDeviceOutboxId namespaces ids by source instance so identical payload parts do not collide", () => {
  // Task 5.4: when the same connector emits the same logical work on two
  // devices / source instances, the durable outbox id must differ. This
  // protects the unique-key constraint on the local outbox row and keeps
  // multi-device local collection collision-safe.
  const partsA = ["claude_code", 1, "batch-shared-id"];
  const partsB = ["claude_code", 1, "batch-shared-id"];
  const idA = buildLocalDeviceOutboxId({ kind: "record_batch", parts: partsA, sourceInstanceId: "src-A" });
  const idB = buildLocalDeviceOutboxId({ kind: "record_batch", parts: partsB, sourceInstanceId: "src-B" });
  assert.notEqual(idA, idB, "same parts under different source instances must yield different ids");

  // Determinism: same inputs yield byte-identical ids so re-observing the
  // same work on a re-run is idempotent (no duplicate row creation).
  const idAagain = buildLocalDeviceOutboxId({
    kind: "record_batch",
    parts: ["claude_code", 1, "batch-shared-id"],
    sourceInstanceId: "src-A",
  });
  assert.equal(idA, idAagain);
});

test("LocalDeviceOutbox isolates rows across connection-scoped source instances", async () => {
  // Tasks 5.2 / 5.3 / 5.4: two source instances pointed at the same outbox
  // file must each see only their own work via the per-source filters
  // even when row ids differ only by source_instance_id.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({
        kind: "record_batch",
        parts: ["claude_code", 1, "batch-A"],
        sourceInstanceId: "src-A",
      }),
      kind: "record_batch",
      payload: { ok: "A" },
      sourceInstanceId: "src-A",
    });
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({
        kind: "record_batch",
        parts: ["claude_code", 1, "batch-B"],
        sourceInstanceId: "src-B",
      }),
      kind: "record_batch",
      payload: { ok: "B" },
      sourceInstanceId: "src-B",
    });

    const summaryA = outbox.summary({ sourceInstanceId: "src-A" });
    const summaryB = outbox.summary({ sourceInstanceId: "src-B" });
    assert.equal(summaryA.total, 1);
    assert.equal(summaryB.total, 1);
    assert.equal(summaryA.ready, 1);
    assert.equal(summaryB.ready, 1);

    const listA = outbox.list({ sourceInstanceId: "src-A" });
    const listB = outbox.list({ sourceInstanceId: "src-B" });
    assert.equal(listA.length, 1);
    assert.equal(listB.length, 1);
    assert.equal(listA[0].source_instance_id, "src-A");
    assert.equal(listB[0].source_instance_id, "src-B");
  } finally {
    outbox.close();
  }
});

test("inspectLocalOutboxStatus reads connection-scoped counts from the scoped default queue path", async () => {
  // Operator-facing proof of 5.4 from the published CLI angle: the
  // status surface, when given a connection-id, only reports work
  // belonging to that connection-scoped source instance and reads from
  // the connection-scoped default queue file.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({
        kind: "record_batch",
        parts: ["claude_code", 1, "batch-A"],
        sourceInstanceId: "src-only-A",
      }),
      kind: "record_batch",
      payload: {},
      sourceInstanceId: "src-only-A",
    });
    outbox.enqueue({
      id: buildLocalDeviceOutboxId({
        kind: "record_batch",
        parts: ["codex", 1, "batch-B"],
        sourceInstanceId: "src-only-B",
      }),
      kind: "record_batch",
      payload: {},
      sourceInstanceId: "src-only-B",
    });
  } finally {
    outbox.close();
  }

  const aOnly = inspectLocalOutboxStatus({
    baseUrl: "http://127.0.0.1:7662",
    command: "status",
    queuePath: path,
    sourceInstanceId: "src-only-A",
  });
  assert.equal(aOnly.outbox.counts.pending, 1);
  assert.equal(aOnly.outbox.counts.total, 1);
  assert.equal(aOnly.source.source_instance_id, "src-only-A");

  const bOnly = inspectLocalOutboxStatus({
    baseUrl: "http://127.0.0.1:7662",
    command: "status",
    queuePath: path,
    sourceInstanceId: "src-only-B",
  });
  assert.equal(bOnly.outbox.counts.pending, 1);
  assert.equal(bOnly.outbox.counts.total, 1);
});

// --- Lifecycle state axis (Target 2/4): status/doctor must distinguish
// healthy_idle, draining, retryable_backlog, dead_letter, stale_lease, and
// coverage_missing from the durable outbox alone. ---

function statusFor(path, sourceInstanceId = "src-1") {
  return inspectLocalOutboxStatus(
    {
      baseUrl: "http://127.0.0.1:7662",
      command: "status",
      queuePath: path,
      sourceInstanceId,
    },
    { deploymentPosture: PUBLISHED_POSTURE }
  );
}

/** Enqueue a record_batch whose envelopes carry the given stream names. */
function enqueueRecordBatch(outbox, { id, sourceInstanceId = "src-1", streams }) {
  outbox.enqueue({
    id,
    kind: "record_batch",
    payload: {
      batchId: id,
      batchSeq: 1,
      connectorId: "claude_code",
      deviceId: "device-1",
      // Shape mirrors buildLocalDeviceRecordEnvelope output: the outbox's
      // coverage scan reads $.records[*].stream.
      records: streams.map((stream, index) => ({ data: { id: `${stream}-${index}` }, stream })),
      sourceInstanceId,
    },
    sourceInstanceId,
  });
}

/** Claim + acknowledge a row so it reaches status 'succeeded' (drained). */
function drainRow(outbox, id, sourceInstanceId = "src-1") {
  const [claim] = outbox.claimReady({ holder: "drainer", leaseMs: 60_000, sourceInstanceId });
  assert.ok(claim, `expected to claim a ready row for ${id}`);
  outbox.acknowledge({ holder: "drainer", id: claim.id, leaseEpoch: claim.lease_epoch });
}

test("lifecycle_state is healthy_idle on an empty outbox (nothing collected, no coverage to miss)", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();
  const status = statusFor(path);
  assert.equal(status.lifecycle_state, "healthy_idle");
  assert.deepEqual(status.coverage, { observed: false, record_batches: 0 });
  assert.equal(buildLocalOutboxDoctor(status).checks.coverage_diagnostics, "ok");
});

test("lifecycle_state is draining when claimable-now record work exists", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "rb-1", streams: ["messages"] });
  } finally {
    outbox.close();
  }
  assert.equal(statusFor(path).lifecycle_state, "draining");
});

test("lifecycle_state is retryable_backlog when all ready work is waiting on backoff", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A ready row whose next_attempt_at is in the future is "retrying":
    // nothing is claimable this instant, but work remains.
    outbox.enqueue({
      id: "rb-backoff",
      kind: "record_batch",
      nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
      payload: { records: [{ data: { id: "m-1" }, stream: "messages" }] },
      sourceInstanceId: "src-1",
    });
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.counts.retrying, 1);
  assert.equal(status.lifecycle_state, "retryable_backlog");
});

test("lifecycle_state is dead_letter when a row exhausted retries", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "rb-dl", streams: ["messages"] });
    const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    outbox.deadLetter({ error: "terminal", holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.lifecycle_state, "dead_letter");
  assert.equal(buildLocalOutboxDoctor(status).status, "critical");
});

test("lifecycle_state is stale_lease when a lease is past expiry", async () => {
  const path = await tempOutboxPath();
  let now = new Date("2026-05-19T12:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    enqueueRecordBatch(outbox, { id: "rb-stale", streams: ["messages"] });
    outbox.claimReady({ holder: "w", leaseMs: 1000, sourceInstanceId: "src-1" });
    // Advance the clock past the lease so the lease is expired but not yet
    // recovered — exactly the "previous run crashed mid-drain" shape.
    now = new Date("2026-05-19T12:01:00.000Z");
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.expired_leases, 1);
  assert.equal(status.lifecycle_state, "stale_lease");
  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.expired_leases, "warn");
  assert.equal(doctor.status, "warning");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.ok(doctor.remediation.some((line) => /past expiry/.test(line)));
});

test("lifecycle_state is coverage_missing after a clean drain that never carried a coverage record", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // Collect and fully drain real records, but none on coverage_diagnostics.
    enqueueRecordBatch(outbox, { id: "rb-content", streams: ["sessions", "messages"] });
    drainRow(outbox, "rb-content");
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.outbox.counts.pending, 0);
  assert.equal(status.outbox.counts.leased, 0);
  assert.equal(status.coverage.observed, false);
  assert.ok(status.coverage.record_batches >= 1);
  assert.equal(status.lifecycle_state, "coverage_missing");

  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.coverage_diagnostics, "warn");
  assert.equal(doctor.status, "warning");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.ok(doctor.remediation.some((line) => /coverage_unknown/.test(line)));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.ok(doctor.remediation.some((line) => /default stream set/.test(line)));
  // The hint must name the npx -y path so an operator with a stale globally-installed
  // binary (which may predate coverage_diagnostics in bundled defaults) gets the right
  // recovery: fetch a current published build, not just re-run with the existing install.
  assert.ok(
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    doctor.remediation.some((line) => /npx -y @pdpp\/local-collector/.test(line)),
    "coverage_missing remediation must name the npx -y upgrade path"
  );
  // …but it must not promise that the published build is current. When the
  // coverage fix only exists on the repo build and not yet published, the npx
  // path alone would not close the gap, so the hint routes verification through
  // the release owner's dist-tag check instead of asserting the publish is current.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  const coverageHint = doctor.remediation.find((line) => /coverage_unknown/.test(line));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(coverageHint, /can still lag the repo build/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(coverageHint, /release:dist-tag-check/);
});

test("lifecycle_state is healthy_idle once a drained lane has carried a coverage_diagnostics record", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "rb-content", streams: ["messages"] });
    drainRow(outbox, "rb-content");
    enqueueRecordBatch(outbox, { id: "rb-coverage", streams: ["coverage_diagnostics"] });
    drainRow(outbox, "rb-coverage");
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  assert.equal(status.coverage.observed, true);
  assert.equal(status.lifecycle_state, "healthy_idle");
  assert.equal(buildLocalOutboxDoctor(status).checks.coverage_diagnostics, "ok");
});

test("coverage observation survives a clean drain and ignores dead-letter rows", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // A coverage record that only ever dead-lettered was never durably
    // observed by the lane, so it must not count as coverage.
    enqueueRecordBatch(outbox, { id: "rb-dl-coverage", streams: ["coverage_diagnostics"] });
    const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    outbox.deadLetter({ error: "terminal", holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });
    // A separate, successfully drained content batch with no coverage.
    enqueueRecordBatch(outbox, { id: "rb-content", streams: ["messages"] });
    drainRow(outbox, "rb-content");
  } finally {
    outbox.close();
  }
  // dead_letter dominates the lifecycle verdict, but the coverage signal
  // itself still reports observed:false because the only coverage row
  // dead-lettered.
  const status = statusFor(path);
  assert.equal(status.coverage.observed, false);
  assert.equal(status.lifecycle_state, "dead_letter");
});

test("lifecycle/coverage status leaks no payloads", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id: "secret-row",
      kind: "record_batch",
      payload: { records: [{ data: { id: "do-not-print", token: "nope" }, stream: "coverage_diagnostics" }] },
      sourceInstanceId: "src-1",
    });
    drainRow(outbox, "secret-row");
  } finally {
    outbox.close();
  }
  const status = statusFor(path);
  const doctor = buildLocalOutboxDoctor(status);
  const rendered = JSON.stringify({ status, doctor });
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(rendered, /do-not-print|secret-row|nope/);
});

test("status/doctor stay bounded and report observed:null on a giant legacy (pre-index) outbox", async () => {
  // The performance flaw this lane fixes: doctor against a real ~35 GB Codex
  // outbox hung because coverage detection scanned every retained payload with
  // json_each. The fix moves coverage to a payload-light index; a pre-index
  // outbox whose unindexed backlog exceeds the bounded scan budget must report
  // observed:null (unknown) instead of launching an unbounded scan. We assert
  // the bounded behavior by timing a status/doctor pass over an over-budget
  // legacy DB and proving it answers null rather than a partial false negative.
  const path = await tempOutboxPath();
  const budget = 5000;
  seedLegacyV1Outbox(
    path,
    Array.from({ length: budget + 50 }, (_value, index) => ({
      id: `legacy-${index}`,
      sourceInstanceId: "src-legacy",
      streams: ["messages"],
    }))
  );

  const status = inspectLocalOutboxStatus({
    baseUrl: "http://127.0.0.1:7662",
    command: "status",
    queuePath: path,
    sourceInstanceId: "src-legacy",
  });
  // Unknown coverage suppresses the coverage_missing verdict (never guess from
  // a partial scan); the lane is fully drained otherwise, so it is healthy_idle.
  assert.equal(status.coverage.observed, null);
  assert.equal(status.lifecycle_state, "healthy_idle");

  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.coverage_diagnostics, "ok");
  // The whole pass leaks no payloads even on the legacy path.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(JSON.stringify({ status, doctor }), /messages-\d/);
});

// --- Sent-row retention / prune-sent (outbox-retention-health-v1) ---
//
// Invariant: pruneSent never touches pending, leased, retrying, or dead-letter
// rows. It only deletes succeeded rows that satisfy the age/count policy.

test("pruneSent dry-run reports matched count without deleting", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // Drain three rows so they are in succeeded status.
    for (const id of ["sent-1", "sent-2", "sent-3"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).succeeded, 3);

    // Dry-run (the default): use a future timestamp so all rows are "older than" it.
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = outbox.pruneSent({ olderThanIso: future });
    assert.equal(result.matched, 3);
    assert.equal(result.pruned, 0);
    // DB unchanged.
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).succeeded, 3);
  } finally {
    outbox.close();
  }
});

test("pruneSent deletes only succeeded rows, never pending/leased/retrying/dead-letter", async () => {
  const path = await tempOutboxPath();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    // One sent row (old).
    enqueueRecordBatch(outbox, { id: "sent-old", streams: ["messages"] });
    drainRow(outbox, "sent-old");

    // One pending row (should survive).
    enqueueRecordBatch(outbox, { id: "pending-row", streams: ["messages"] });

    // One retrying row (future next_attempt_at; should survive).
    outbox.enqueue({
      id: "retrying-row",
      kind: "record_batch",
      nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
      payload: { records: [] },
      sourceInstanceId: "src-1",
    });

    // One dead-letter row (should survive).
    outbox.enqueue({ id: "dl-row", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-1" });
    const [dlClaim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    outbox.deadLetter({ error: "terminal", holder: "w", id: dlClaim.id, leaseEpoch: dlClaim.lease_epoch });

    const before = outbox.summary({ sourceInstanceId: "src-1" });
    assert.equal(before.succeeded, 1);
    assert.equal(before.ready, 2); // pending + retrying
    assert.equal(before.deadLetter, 1);

    const result = outbox.pruneSent({ dryRun: false, olderThanIso: new Date().toISOString() });
    assert.equal(result.matched, 1);
    assert.equal(result.pruned, 1);

    const after = outbox.summary({ sourceInstanceId: "src-1" });
    assert.equal(after.succeeded, 0);
    assert.equal(after.ready, 2, "pending + retrying must survive");
    assert.equal(after.deadLetter, 1, "dead-letter must survive");
  } finally {
    outbox.close();
  }
});

test("pruneSent keepCount retains the N most-recent sent rows per source", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    for (const id of ["sent-1", "sent-2", "sent-3", "sent-4", "sent-5"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).succeeded, 5);

    // Keep the 2 most-recent; prune the 3 older ones.
    const result = outbox.pruneSent({ dryRun: false, keepCount: 2 });
    assert.equal(result.matched, 3);
    assert.equal(result.pruned, 3);
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).succeeded, 2);
  } finally {
    outbox.close();
  }
});

test("pruneSent keepCount=0 prunes all sent rows", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    for (const id of ["sent-a", "sent-b"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
    const result = outbox.pruneSent({ dryRun: false, keepCount: 0 });
    assert.equal(result.pruned, 2);
    assert.equal(outbox.summary({ sourceInstanceId: "src-1" }).succeeded, 0);
  } finally {
    outbox.close();
  }
});

test("pruneSent cascades to the observed-stream index", async () => {
  // When a sent row is pruned, its local_device_observed_stream index entries
  // must also be removed so the index stays consistent.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "rb-1", streams: ["messages", "sessions"] });
    drainRow(outbox, "rb-1");

    // Verify coverage observation works before pruning.
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "messages" }), true);

    const result = outbox.pruneSent({ dryRun: false, keepCount: 0 });
    assert.equal(result.pruned, 1);

    // After pruning, the parent outbox row is gone. The index entries for this
    // outbox_id are also gone (no orphan rows left behind).
    // The coverage observation now returns false (no non-dead-letter record_batch rows).
    assert.equal(outbox.hasObservedStream({ sourceInstanceId: "src-1", stream: "messages" }), false);
    assert.equal(outbox.countRecordBatches({ sourceInstanceId: "src-1" }), 0);
  } finally {
    outbox.close();
  }
});

test("prune-sent CLI is dry-run by default and backs up before apply", async () => {
  const path = await tempOutboxPath();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const outbox = new LocalDeviceOutbox({ clock: () => now, path });
  try {
    // Drain 3 old rows.
    for (const id of ["sent-1", "sent-2", "sent-3"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
    // Keep one pending row alive.
    enqueueRecordBatch(outbox, { id: "pending-row", streams: ["messages"] });
  } finally {
    outbox.close();
  }

  // Dry-run with --older-than-days 0 targets all sent rows.
  const dryRunOpts = parseArgs(["prune-sent", "--queue", path, "--connection-id", "src-1", "--older-than-days", "0"]);
  assert.equal(dryRunOpts.command, "prune-sent");
  assert.equal(dryRunOpts.apply, undefined);

  const dryRun = pruneSentOutboxRows(dryRunOpts);
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.matched, 3);
  assert.equal(dryRun.pruned, 0);
  assert.equal(dryRun.backup_path, null);
  assert.equal(dryRun.status_before.sent, 3);
  assert.equal(dryRun.status_before.pending, 1);
  assert.equal(dryRun.status_after.sent, 3, "dry-run must not mutate");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(dryRun.note, /dry run/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(dryRun.note, /--apply/);

  // Apply: backs up, then actually deletes sent rows.
  const applyOpts = parseArgs([
    "prune-sent",
    "--queue",
    path,
    "--connection-id",
    "src-1",
    "--older-than-days",
    "0",
    "--apply",
  ]);
  const applied = pruneSentOutboxRows(applyOpts);
  assert.equal(applied.dry_run, false);
  assert.equal(applied.matched, 3);
  assert.equal(applied.pruned, 3);
  assert.ok(applied.backup_path, "apply must produce a backup path");
  assert.equal(existsSync(applied.backup_path), true);
  assert.equal(applied.status_after.sent, 0);
  assert.equal(applied.status_after.pending, 1, "pending row must survive");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(applied.note, /pruned/);
});

test("prune-sent CLI --keep-count limits retained sent rows", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    for (const id of ["s1", "s2", "s3", "s4"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
  } finally {
    outbox.close();
  }

  const opts = parseArgs(["prune-sent", "--queue", path, "--connection-id", "src-1", "--keep-count", "2", "--apply"]);
  assert.equal(opts.keepCount, 2);

  const result = pruneSentOutboxRows(opts);
  assert.equal(result.pruned, 2);
  assert.equal(result.status_after.sent, 2);
  assert.equal(result.filter.keep_count, 2);
  assert.equal(result.filter.older_than_days, null);
  assert.equal(result.filter.older_than_iso, null);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(result.note, /older than 30 days/);
});

test("prune-sent CLI reports no-op when nothing matches the policy", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "fresh-sent", streams: ["messages"] });
    drainRow(outbox, "fresh-sent");
  } finally {
    outbox.close();
  }

  // --older-than-days 9999 means "only prune rows more than 9999 days old";
  // the fresh row is not that old.
  const opts = parseArgs(["prune-sent", "--queue", path, "--connection-id", "src-1", "--older-than-days", "9999"]);
  const result = pruneSentOutboxRows(opts);
  assert.equal(result.matched, 0);
  assert.equal(result.pruned, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /Nothing to prune/);
});

test("prune-sent CLI keep-count-only no-op reports the actual policy", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    for (const id of ["s1", "s2"]) {
      enqueueRecordBatch(outbox, { id, streams: ["messages"] });
      drainRow(outbox, id);
    }
  } finally {
    outbox.close();
  }

  const opts = parseArgs(["prune-sent", "--queue", path, "--connection-id", "src-1", "--keep-count", "2"]);
  const result = pruneSentOutboxRows(opts);
  assert.equal(result.matched, 0);
  assert.equal(result.pruned, 0);
  assert.equal(result.filter.keep_count, 2);
  assert.equal(result.filter.older_than_days, null);
  assert.equal(result.filter.older_than_iso, null);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /keep-count 2/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(result.note, /older than 30 days/);
});

// --- compact / disk reclaim CLI (local-collector-memory-slvp-v1) ---
//
// compact rebuilds the SQLite file with VACUUM to return the freelist a prune
// leaves behind. Dry-run by default; --apply refuses while unsent rows exist
// unless --force; --apply backs up the DB first. VACUUM is lossless.

/**
 * Seed `count` ~2 KiB succeeded rows then prune them, leaving a large freelist
 * on the file so a compact has something real to reclaim. Returns once the
 * outbox is closed.
 */
function seedAndPruneForCompact(path, count) {
  // Initialize the real schema first, then seed historical succeeded rows in
  // one transaction. The compact tests exercise page reclamation, not the
  // enqueue/claim/ack state machine; per-row public-method calls turn this
  // fixture setup into thousands of SQLite transactions and starve the rest
  // of the aggregate test run.
  const outbox = new LocalDeviceOutbox({ path });
  outbox.close();
  const db = new DatabaseSync(path);
  try {
    const blob = "z".repeat(2000);
    const stamp = "2026-05-19T12:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, acknowledged_at, created_at, updated_at
       ) VALUES (?, 'src-1', 'record_batch', 'succeeded', ?, 'hash', 0, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      for (let i = 0; i < count; i += 1) {
        const payload = JSON.stringify({ records: [{ data: { blob, i }, stream: "messages" }] });
        insert.run(`c:${i}`, payload, stamp, stamp, stamp, stamp);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.prepare(`DELETE FROM local_device_outbox WHERE source_instance_id = 'src-1' AND status = 'succeeded'`).run();
  } finally {
    db.close();
  }
}

test("compact CLI parses the command and --force flag", () => {
  const opts = parseArgs(["compact", "--queue", "/tmp/x.sqlite", "--connection-id", "src-1", "--apply", "--force"]);
  assert.equal(opts.command, "compact");
  assert.equal(opts.apply, true);
  assert.equal(opts.force, true);
});

test("compact CLI dry-run reports reclaimable bytes without mutating the file", async () => {
  const path = await tempOutboxPath();
  seedAndPruneForCompact(path, 1000);
  const sizeBefore = (await import("node:fs")).statSync(path).size;

  const opts = parseArgs(["compact", "--queue", path, "--connection-id", "src-1"]);
  const result = compactOutbox(opts);
  assert.equal(result.dry_run, true);
  assert.equal(result.refused, false);
  assert.equal(result.reclaimed_bytes, 0, "dry-run never reclaims");
  assert.ok(result.page_stats.reclaimableBytes > 0, "dry-run reports a reclaimable freelist");
  assert.equal(result.backup_path, null);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /--apply/);

  const sizeAfter = (await import("node:fs")).statSync(path).size;
  assert.equal(sizeAfter, sizeBefore, "dry-run must not change the file");
});

test("compact CLI --apply on a drained outbox backs up then shrinks the file", async () => {
  const path = await tempOutboxPath();
  seedAndPruneForCompact(path, 1500);
  const sizeBefore = statSync(path).size;

  const opts = parseArgs(["compact", "--queue", path, "--connection-id", "src-1", "--apply"]);
  const result = compactOutbox(opts);
  assert.equal(result.dry_run, false);
  assert.equal(result.refused, false);
  assert.ok(result.reclaimed_bytes > 0, "apply returns bytes to the filesystem");
  assert.ok(result.backup_path, "apply must produce a backup path");
  assert.equal(existsSync(result.backup_path), true);
  assert.equal(result.compacted.freelistPages, 0, "freelist emptied after rebuild");

  const sizeAfter = statSync(path).size;
  assert.ok(sizeAfter < sizeBefore, "apply shrinks the on-disk file");
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /Compacted/);
});

test("compact CLI --apply REFUSES when unsent rows exist and no --force, leaving the file untouched", async () => {
  const path = await tempOutboxPath();
  seedAndPruneForCompact(path, 800);
  // Add an unsent (ready) row so the lane is no longer quiet.
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "unsent-ready", streams: ["messages"] });
  } finally {
    outbox.close();
  }
  const sizeBefore = statSync(path).size;

  const opts = parseArgs(["compact", "--queue", path, "--connection-id", "src-1", "--apply"]);
  const result = compactOutbox(opts);
  assert.equal(result.refused, true, "apply with unsent rows must be refused");
  assert.equal(result.reclaimed_bytes, 0, "a refusal reclaims nothing");
  assert.equal(result.backup_path, null, "a refusal makes no backup");
  assert.ok(result.non_succeeded_rows >= 1);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /Refusing to compact/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /--force/);

  const sizeAfter = statSync(path).size;
  assert.equal(sizeAfter, sizeBefore, "a refused compact must not mutate the file");
  // The unsent row is still there.
  assert.equal(statusFor(path).outbox.counts.pending, 1);
});

test("compact CLI --apply --force compacts even with unsent rows, preserving them", async () => {
  const path = await tempOutboxPath();
  seedAndPruneForCompact(path, 800);
  const outbox = new LocalDeviceOutbox({ path });
  try {
    enqueueRecordBatch(outbox, { id: "unsent-ready", streams: ["messages"] });
  } finally {
    outbox.close();
  }
  const sizeBefore = statSync(path).size;

  const opts = parseArgs(["compact", "--queue", path, "--connection-id", "src-1", "--apply", "--force"]);
  const result = compactOutbox(opts);
  assert.equal(result.refused, false, "--force overrides the unsent-rows guard");
  assert.ok(result.reclaimed_bytes > 0);
  assert.ok(result.backup_path && existsSync(result.backup_path));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /--force/);

  const sizeAfter = statSync(path).size;
  assert.ok(sizeAfter < sizeBefore, "force compact still shrinks the file");
  // The unsent row survived the lossless rebuild.
  assert.equal(statusFor(path).outbox.counts.pending, 1);
});

test("compact CLI on a missing DB reports nothing to do, never refuses", async () => {
  const path = join(await tempDir(), "does-not-exist.sqlite");
  const opts = parseArgs(["compact", "--queue", path, "--connection-id", "src-1", "--apply"]);
  const result = compactOutbox(opts);
  assert.equal(result.db.exists, false);
  assert.equal(result.refused, false);
  assert.equal(result.reclaimed_bytes, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.note, /does not exist/);
});

test("active draining without retry/dead-letter shows draining lifecycle_state, not stalled", async () => {
  // Regression guard: a large sent-only outbox that is actively draining
  // (has claimable pending work) must be classified as draining, not any
  // unhealthy state.
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // Many succeeded (sent) rows simulate a large pre-prune backlog.
    for (let i = 0; i < 5; i += 1) {
      enqueueRecordBatch(outbox, { id: `sent-${i}`, streams: ["messages"] });
      drainRow(outbox, `sent-${i}`);
    }
    // One active pending row (drain in progress).
    enqueueRecordBatch(outbox, { id: "active-pending", streams: ["messages"] });
  } finally {
    outbox.close();
  }

  const status = statusFor(path);
  assert.equal(status.lifecycle_state, "draining");
  assert.equal(status.outbox.counts.sent, 5);
  assert.equal(status.outbox.counts.pending, 1);
  const doctor = buildLocalOutboxDoctor(status);
  // Doctor must be ok (no dead letters, no stale leases, no failures).
  assert.equal(doctor.checks.outbox_failures, "ok");
  assert.equal(doctor.remediation, undefined);
});

test("stalled/dead-letter still surfaces as a problem even with a large sent backlog", async () => {
  const path = await tempOutboxPath();
  const outbox = new LocalDeviceOutbox({ path });
  try {
    // Many succeeded rows.
    for (let i = 0; i < 3; i += 1) {
      enqueueRecordBatch(outbox, { id: `sent-${i}`, streams: ["messages"] });
      drainRow(outbox, `sent-${i}`);
    }
    // One dead-letter row.
    outbox.enqueue({ id: "dl-row", kind: "record_batch", payload: { records: [] }, sourceInstanceId: "src-1" });
    const [claim] = outbox.claimReady({ holder: "w", leaseMs: 60_000, sourceInstanceId: "src-1" });
    outbox.deadLetter({ error: "server rejected", holder: "w", id: claim.id, leaseEpoch: claim.lease_epoch });
  } finally {
    outbox.close();
  }

  const status = statusFor(path);
  assert.equal(status.lifecycle_state, "dead_letter");
  assert.equal(status.outbox.counts.dead_letter, 1);
  const doctor = buildLocalOutboxDoctor(status);
  assert.equal(doctor.checks.outbox_failures, "fail");
  assert.equal(doctor.status, "critical");
  assert.ok(Array.isArray(doctor.remediation));
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.ok(doctor.remediation.some((line) => /recover --source-instance-id <id>/.test(line)));
});

async function startReferenceRouteServer({ body = '{"ok":true}', status }) {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/state") && req.method === "GET") {
      res.writeHead(status, { "content-type": "application/json" });
      if (status >= 400) {
        res.end(body);
        return;
      }
      res.end(
        JSON.stringify({
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: "src-1",
          state: {},
          updated_at: null,
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function tempOutboxPath() {
  return join(await tempDir(), "outbox.sqlite");
}

function tempDir() {
  return mkdtemp(join(tmpdir(), "pdpp-local-collector-test-"));
}

function tempDirSync(): string {
  return mkdtempSync(join(tmpdir(), "pdpp-local-collector-test-"));
}

/**
 * Minimal fake reference server for `runCollectorSample`'s real (non-mocked)
 * pass against a fixture connector child: only state + ingest-batches, the
 * two routes a sample run actually hits. Not a general harness — keep it
 * this small; `collector-runner.test.ts` already owns the full route set.
 */
async function startSampleTestServer(): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/state")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: "dsrc-1",
          state: {},
          updated_at: null,
        })
      );
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "device_ingest_batch_result", status: "accepted" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
}

/**
 * A fixture connector child that emits `count` RECORDs then DONE, one per
 * event-loop tick. `runCollectorSample`'s sample-limit abort only stops
 * further child output — it does not discard lines the child already wrote
 * to its stdout pipe before the parent could react (real connectors stream
 * as they scan real files, so this race does not arise in practice). A
 * per-tick delay gives the parent's abort a real chance to land between
 * records, the same way a genuinely slow filesystem scan would.
 */
async function writeCountingFixtureConnector(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-collector-fixture-"));
  const path = join(dir, "fixture.mjs");
  const emits = Array.from(
    { length: count },
    (_, index) =>
      `await new Promise((r) => setImmediate(r));\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify({
          data: { id: `m-${index}` },
          emitted_at: new Date(0).toISOString(),
          key: `m-${index}`,
          stream: "messages",
          type: "RECORD",
        })
      )} + "\\n");`
  ).join("\n");
  await writeFile(
    path,
    `(async () => {\n${emits}\nprocess.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: ${count} }) + "\\n");\n})();\n`
  );
  return path;
}

async function runFixtureSample(emit: number, sample: number) {
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  process.env[ALLOW_CUSTOM_COMMAND_ENV] = "1";
  const server = await startSampleTestServer();
  try {
    const fixture = await writeCountingFixtureConnector(emit);
    return await runCollectorSample({
      args: [fixture],
      baseUrl: server.url,
      command: "run",
      connector: "custom",
      deviceId: "device-1",
      deviceToken: "token-1",
      entrypointCommand: "node",
      quiet: true,
      queuePath: await tempOutboxPath(),
      sample,
      sourceInstanceId: "dsrc-1",
      streams: ["messages"],
    });
  } finally {
    await server.close();
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
}

test("runCollectorSample aborts once the sample limit is reached, reporting a truncated (not complete) pass", async () => {
  // onMessage still fires for any lines already buffered in the child's
  // stdout pipe by the time abort() lands (real connectors stream as they
  // scan real files, so a burst of already-buffered output does not arise
  // in practice) — so records_seen is only guaranteed to reach the limit,
  // not stop exactly at it. What must hold: it never stops short of the
  // limit, and the run is honestly reported as truncated, not complete.
  const result = await runFixtureSample(10, 3);
  assert.ok(result.records_seen >= 3, "must not stop before the sample limit");
  assert.equal(result.sample_limit, 3);
  assert.match(result.note, SAMPLE_STOPPED_NOTE_PATTERN);
});

test("runCollectorSample reports a complete pass when the source finishes under the limit", async () => {
  const result = await runFixtureSample(2, 10);
  assert.equal(result.records_seen, 2, "the connector only had 2 records to emit, under the 10-record limit");
  assert.equal(result.sample_limit, 10);
  assert.match(result.note, SAMPLE_COMPLETE_NOTE_PATTERN);
});

test("runSetup enrolls, writes a local profile, then runs a sample using the freshly enrolled credentials (not the caller's), in that order", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    const calls: string[] = [];
    let sampleOptionsSeen: CliOptions | null = null;
    const output = await runSetup(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "setup",
        connector: "claude_code",
        // Deliberately stale/wrong credentials on the input options, to
        // prove the sample pass uses the enrollment's fresh ones instead.
        deviceId: "stale-device",
        deviceToken: "stale-token",
        json: true,
        profile: "claude_code",
        queuePath: "unused.sqlite",
        sample: 2,
      } as CliOptions,
      {
        enroll: (input) => {
          calls.push("enroll");
          assert.equal(input.code, "one-time-code");
          return Promise.resolve({
            connector_id: "claude_code",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          });
        },
        runSample: (sampleOptions) => {
          calls.push("sample");
          sampleOptionsSeen = sampleOptions;
          return Promise.resolve({
            connector: "claude_code",
            note: "sampled",
            object: "local_collector_sample",
            records_seen: 2,
            sample_limit: 2,
            status: {} as LocalOutboxStatusOutput,
          });
        },
      }
    );

    // enroll -> write profile -> sample, in that dependency order. The
    // profile file existing by the time `sample` runs is the load-bearing
    // proof: writeLocalCollectorProfile is synchronous and runs strictly
    // between the two injected calls.
    assert.deepEqual(calls, ["enroll", "sample"]);
    assert.ok(existsSync(output.profile_path), "the profile must be written before setup returns");
    const profileContents = await readFile(output.profile_path, "utf8");
    assert.match(profileContents, FRESH_DEVICE_TOKEN_PATTERN);
    assert.match(profileContents, FRESH_DEVICE_ID_PATTERN);

    assert.equal(sampleOptionsSeen?.deviceId, "fresh-device");
    assert.equal(sampleOptionsSeen?.deviceToken, "fresh-token");
    assert.equal(sampleOptionsSeen?.sourceInstanceId, "dsrc-fresh");
    assert.notEqual(sampleOptionsSeen?.deviceId, "stale-device");

    assert.equal(output.object, "local_collector_setup");
    assert.equal(output.device_id, "fresh-device");
    assert.equal(output.source_instance_id, "dsrc-fresh");
    assert.ok(output.sample);
    assert.equal(output.sample?.records_seen, 2);
  });
});

test("runSetup without --sample enrolls and writes the profile but never runs a proof pass", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    let sampleCalled = false;
    const output = await runSetup(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "setup",
        connector: "claude_code",
        json: true,
        profile: "claude_code",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: () =>
          Promise.resolve({
            connector_id: "claude_code",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          }),
        runSample: () => {
          sampleCalled = true;
          throw new Error("must not be called when --sample is omitted");
        },
      }
    );
    assert.equal(sampleCalled, false);
    assert.equal(output.sample, null);
    assert.ok(existsSync(output.profile_path));
  });
});

// --- connect: resolveConnectScopeChoice (parser/resolver unit tests) ---

test("resolveConnectScopeChoice: no scope flags at all is unspecified", () => {
  const choice = resolveConnectScopeChoice({ command: "connect" } as CliOptions);
  assert.deepEqual(choice, { kind: "unspecified" });
});

test("resolveConnectScopeChoice: --recent <days>", () => {
  const choice = resolveConnectScopeChoice({ command: "connect", recentDays: 7 } as CliOptions);
  assert.deepEqual(choice, { kind: "recent", recentDays: 7 });
});

test("resolveConnectScopeChoice: --all", () => {
  const choice = resolveConnectScopeChoice({ allHistory: true, command: "connect" } as CliOptions);
  assert.deepEqual(choice, { kind: "all" });
});

test("resolveConnectScopeChoice: --since and --source-roots together form one custom choice", () => {
  const choice = resolveConnectScopeChoice({
    command: "connect",
    since: "2026-07-01T00:00:00.000Z",
    sourceRoots: ["proj-a"],
  } as CliOptions);
  assert.deepEqual(choice, { kind: "custom", since: "2026-07-01T00:00:00.000Z", sourceRoots: ["proj-a"] });
});

test("resolveConnectScopeChoice: --since alone is custom", () => {
  const choice = resolveConnectScopeChoice({ command: "connect", since: "2026-07-01T00:00:00.000Z" } as CliOptions);
  assert.deepEqual(choice, { kind: "custom", since: "2026-07-01T00:00:00.000Z" });
});

test("resolveConnectScopeChoice: --recent and --all together is rejected as ambiguous", () => {
  assert.throws(
    () => resolveConnectScopeChoice({ allHistory: true, command: "connect", recentDays: 7 } as CliOptions),
    CollectorUsageError
  );
});

test("resolveConnectScopeChoice: --recent and --since together is rejected as ambiguous", () => {
  assert.throws(
    () =>
      resolveConnectScopeChoice({
        command: "connect",
        recentDays: 7,
        since: "2026-07-01T00:00:00.000Z",
      } as CliOptions),
    CollectorUsageError
  );
});

test("resolveConnectScopeChoice: --all and --source-roots together is rejected as ambiguous", () => {
  assert.throws(
    () => resolveConnectScopeChoice({ allHistory: true, command: "connect", sourceRoots: ["proj-a"] } as CliOptions),
    CollectorUsageError
  );
});

// --- connect: parseArgs recognizes the command and every new flag ---

test("parseArgs: connect with --recent", () => {
  const options = parseArgs([
    "connect",
    "--base-url",
    "https://pdpp.example.com",
    "--code",
    "one-time-code",
    "--connector",
    "codex",
    "--recent",
    "7",
  ]);
  assert.equal(options.command, "connect");
  assert.equal(options.recentDays, 7);
});

test("parseArgs: connect with --all", () => {
  const options = parseArgs([
    "connect",
    "--base-url",
    "https://pdpp.example.com",
    "--code",
    "one-time-code",
    "--connector",
    "codex",
    "--all",
  ]);
  assert.equal(options.allHistory, true);
});

test("parseArgs: connect with --since and --source-roots", () => {
  const options = parseArgs([
    "connect",
    "--base-url",
    "https://pdpp.example.com",
    "--code",
    "one-time-code",
    "--connector",
    "codex",
    "--since",
    "2026-07-01T00:00:00.000Z",
    "--source-roots",
    "proj-a,proj-b",
  ]);
  assert.equal(options.since, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(options.sourceRoots, ["proj-a", "proj-b"]);
});

test("parseArgs: connect with no scope flags leaves them all unset", () => {
  const options = parseArgs([
    "connect",
    "--base-url",
    "https://pdpp.example.com",
    "--code",
    "one-time-code",
    "--connector",
    "codex",
  ]);
  assert.equal(options.recentDays, undefined);
  assert.equal(options.allHistory, undefined);
  assert.equal(options.since, undefined);
  assert.equal(options.sourceRoots, undefined);
});

// --- connect: help/copy tests ---

test("help text documents connect and every scope flag", () => {
  assert.match(HELP_TEXT, HELP_TEXT_CONNECT_PATTERN);
  assert.match(HELP_TEXT, HELP_RECENT_FLAG_PATTERN);
  assert.match(HELP_TEXT, HELP_ALL_FLAG_PATTERN);
  assert.match(HELP_TEXT, HELP_SINCE_FLAG_PATTERN);
  assert.match(HELP_TEXT, HELP_SOURCE_ROOTS_FLAG_PATTERN);
  // The honesty guarantee must be stated in the help text itself, not just
  // in code comments — an operator reading --help should see it.
  assert.match(HELP_TEXT, HELP_REQUEST_NOT_GUARANTEE_PATTERN);
  assert.match(HELP_TEXT, HELP_NARROWS_ONLY_PATTERN);
});

test("usage error string mentions connect alongside every other command", () => {
  assert.throws(
    () => parseArgs(["not-a-real-command"]),
    (err: unknown) => {
      assert.ok(err instanceof CollectorUsageError);
      assert.match(err.message, USAGE_ERROR_CONNECT_PATTERN);
      return true;
    }
  );
});

// --- connect: full command behavior via runConnect ---

test("runConnect: bare invocation (no scope flags) forwards no collection_scope field at all", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    let seenScope: unknown = "not-called";
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: (input) => {
          seenScope = "collectionScope" in input ? input.collectionScope : "absent";
          return Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          });
        },
      }
    );
    assert.equal(
      seenScope,
      "absent",
      "connect with no scope flags must not set collectionScope on the enroll call at all"
    );
    assert.match(output.requested_scope, REQUESTED_SCOPE_SERVER_DEFAULT_PATTERN);
    assert.equal(output.object, "local_collector_connect");
  });
});

test("runConnect: --recent 7 forwards an explicit since exactly 7 days back", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    let seenScope: { since?: string; source_roots?: string[] } | null | undefined;
    const fixedNow = "2026-08-09T00:00:00.000Z";
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
        recentDays: 7,
      } as CliOptions,
      {
        enroll: (input) => {
          seenScope = input.collectionScope;
          return Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          });
        },
        now: () => fixedNow,
      }
    );
    assert.deepEqual(seenScope, { since: "2026-08-02T00:00:00.000Z" });
    assert.match(output.requested_scope, REQUESTED_SCOPE_RECENT_7_PATTERN);
  });
});

test("runConnect: --all forwards an explicit collection_scope: null (full pass)", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    let seenScope: unknown = "not-called";
    const output = await runConnect(
      {
        allHistory: true,
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: (input) => {
          seenScope = input.collectionScope;
          return Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          });
        },
      }
    );
    assert.equal(seenScope, null);
    assert.match(output.requested_scope, REQUESTED_SCOPE_ALL_HISTORY_PATTERN);
  });
});

test("runConnect: --since/--source-roots forward exactly as given", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    let seenScope: unknown;
    await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
        since: "2026-07-01T00:00:00.000Z",
        sourceRoots: ["proj-a"],
      } as CliOptions,
      {
        enroll: (input) => {
          seenScope = input.collectionScope;
          return Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          });
        },
      }
    );
    assert.deepEqual(seenScope, { since: "2026-07-01T00:00:00.000Z", source_roots: ["proj-a"] });
  });
});

test("runConnect: a server-side widening rejection (400) surfaces as a CollectorUsageError, never a silent local override", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    await assert.rejects(
      () =>
        runConnect(
          {
            allHistory: true,
            baseUrl: "https://pdpp.example.com",
            code: "one-time-code",
            command: "connect",
            connector: "codex",
            json: true,
            profile: "codex",
            queuePath: "unused.sqlite",
          } as CliOptions,
          {
            enroll: () => {
              throw new LocalDeviceHttpError(
                400,
                JSON.stringify({
                  error: {
                    code: "invalid_request",
                    message:
                      "the device requested an unscoped (all-history) pass, but the server has already declared a boundary (since=2026-06-01T00:00:00.000Z)",
                    param: "collection_scope",
                  },
                })
              );
            },
          }
        ),
      (err: unknown) => {
        assert.ok(err instanceof CollectorUsageError);
        assert.match(err.message, WIDENING_REJECTION_MESSAGE_PATTERN);
        return true;
      }
    );
  });
});

test("runConnect: writes the local profile with restrictive permissions, same as setup", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: () =>
          Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "fresh-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          }),
      }
    );
    assert.ok(existsSync(output.profile_path));
    // POSIX permission check mirrors writeLocalCollectorProfile's own test
    // ("restricts directory and file permissions to the owner").
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
      const fileMode = statSync(output.profile_path).mode & 0o777;
      assert.equal(fileMode, 0o600);
      // biome-ignore lint/suspicious/noBitwiseOperators: genuine POSIX file-mode bitmask, not a style mistake.
      const dirMode = statSync(dirname(output.profile_path)).mode & 0o777;
      assert.equal(dirMode, 0o700);
    }
  });
});

test("runConnect: JSON output never leaks the device_token or enrollment code", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "super-secret-one-time-code",
        command: "connect",
        connector: "codex",
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: () =>
          Promise.resolve({
            connector_id: "codex",
            device_id: "fresh-device",
            device_token: "super-secret-device-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-fresh",
          }),
      }
    );
    const rendered = JSON.stringify(output);
    assert.equal(rendered.includes("super-secret-device-token"), false);
    assert.equal(rendered.includes("super-secret-one-time-code"), false);
  });
});

// --- connect: --source-roots / --since local validation (before any enroll call) ---

test("resolveConnectScopeChoice FAILS BEFORE any request when --source-roots names a path that does not exist on this host", () => {
  const missing = join(tmpdir(), "pdpp-runner-test-does-not-exist-xyz");
  assert.throws(
    () => resolveConnectScopeChoice({ command: "connect", sourceRoots: [missing] } as CliOptions),
    CollectorUsageError
  );
});

test("resolveConnectScopeChoice FAILS BEFORE any request on an unparseable --since", () => {
  assert.throws(
    () => resolveConnectScopeChoice({ command: "connect", since: "definitely-not-a-date" } as CliOptions),
    CollectorUsageError
  );
});

test("runConnect never calls enroll when --source-roots fails local validation (no one-time code consumed)", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    const missing = join(tmpdir(), "pdpp-runner-test-runconnect-missing-root");
    let enrollCalled = false;
    await assert.rejects(
      () =>
        runConnect(
          {
            baseUrl: "https://pdpp.example.com",
            code: "one-time-code",
            command: "connect",
            connector: "codex",
            json: true,
            profile: "codex",
            queuePath: "unused.sqlite",
            sourceRoots: [missing],
          } as CliOptions,
          {
            enroll: () => {
              enrollCalled = true;
              return Promise.resolve({
                connector_id: "codex",
                device_id: "fresh-device",
                device_token: "fresh-token",
                local_binding_name: "test-binding",
                source_instance_id: "dsrc-fresh",
              });
            },
          }
        ),
      CollectorUsageError
    );
    assert.equal(enrollCalled, false, "a locally-invalid source root must never reach the server");
  });
});

test("runConnect expands a ~-relative --source-roots entry into the collection_scope request", async () => {
  const profileDir = tempDirSync();
  const tempHome = mkdtempSync(join(tmpdir(), "pdpp-runner-test-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await withProfileDir(profileDir, async () => {
      let seenScope: { since?: string; source_roots?: string[] } | null | undefined;
      await runConnect(
        {
          baseUrl: "https://pdpp.example.com",
          code: "one-time-code",
          command: "connect",
          connector: "codex",
          json: true,
          profile: "codex",
          queuePath: "unused.sqlite",
          sourceRoots: ["~"],
        } as CliOptions,
        {
          enroll: (input) => {
            seenScope = input.collectionScope;
            return Promise.resolve({
              connector_id: "codex",
              device_id: "fresh-device",
              device_token: "fresh-token",
              local_binding_name: "test-binding",
              source_instance_id: "dsrc-fresh",
            });
          },
        }
      );
      assert.deepEqual(seenScope, { source_roots: [tempHome] });
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

// --- connect: repeated connect must not silently overwrite/orphan a live credential ---

test("runConnect FAILS BEFORE overwriting an existing profile without --force, and never calls enroll", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    writeLocalCollectorProfile({
      baseUrl: "https://pdpp.example.com",
      connectorId: "codex",
      deviceId: "old-device",
      deviceToken: "old-token",
      name: "codex",
      sourceInstanceId: "dsrc-old",
    });
    let enrollCalled = false;
    await assert.rejects(
      () =>
        runConnect(
          {
            baseUrl: "https://pdpp.example.com",
            code: "one-time-code",
            command: "connect",
            connector: "codex",
            json: true,
            profile: "codex",
            queuePath: "unused.sqlite",
          } as CliOptions,
          {
            enroll: () => {
              enrollCalled = true;
              return Promise.resolve({
                connector_id: "codex",
                device_id: "new-device",
                device_token: "new-token",
                local_binding_name: "test-binding",
                source_instance_id: "dsrc-new",
              });
            },
          }
        ),
      (err: unknown) => {
        assert.ok(err instanceof CollectorUsageError);
        assert.match(err.message, REQUIRES_FORCE_PATTERN);
        return true;
      }
    );
    assert.equal(enrollCalled, false, "connect must refuse before consuming the one-time code");
    const stillOld = parseCollectorProfileEnv(await readFile(join(profileDir, "codex.env"), "utf8"));
    assert.equal(stillOld.PDPP_LOCAL_DEVICE_ID, "old-device", "the existing profile must be left untouched");
  });
});

test("runConnect --force revokes the existing credential server-side before overwriting the profile", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    writeLocalCollectorProfile({
      baseUrl: "https://pdpp.example.com",
      connectorId: "codex",
      deviceId: "old-device",
      deviceToken: "old-token",
      name: "codex",
      sourceInstanceId: "dsrc-old",
    });
    let revokedDeviceId: string | undefined;
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        force: true,
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: () =>
          Promise.resolve({
            connector_id: "codex",
            device_id: "new-device",
            device_token: "new-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-new",
          }),
        revokeExistingProfile: (input) => {
          revokedDeviceId = input.deviceId;
          return Promise.resolve({ revoked: true });
        },
      }
    );
    assert.equal(revokedDeviceId, "old-device", "the OLD credential must be revoked, not the new one");
    assert.equal(output.device_id, "new-device");
    const nowStored = parseCollectorProfileEnv(await readFile(output.profile_path, "utf8"));
    assert.equal(nowStored.PDPP_LOCAL_DEVICE_ID, "new-device");
  });
});

test("runConnect --force aborts before enrolling (no code consumed) when the existing credential cannot be confirmed revoked", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    writeLocalCollectorProfile({
      baseUrl: "https://pdpp.example.com",
      connectorId: "codex",
      deviceId: "old-device",
      deviceToken: "old-token",
      name: "codex",
      sourceInstanceId: "dsrc-old",
    });
    let enrollCalled = false;
    await assert.rejects(
      () =>
        runConnect(
          {
            baseUrl: "https://pdpp.example.com",
            code: "one-time-code",
            command: "connect",
            connector: "codex",
            force: true,
            json: true,
            profile: "codex",
            queuePath: "unused.sqlite",
          } as CliOptions,
          {
            enroll: () => {
              enrollCalled = true;
              return Promise.resolve({
                connector_id: "codex",
                device_id: "new-device",
                device_token: "new-token",
                local_binding_name: "test-binding",
                source_instance_id: "dsrc-new",
              });
            },
            revokeExistingProfile: () => Promise.reject(new Error("network unreachable")),
          }
        ),
      CollectorUsageError
    );
    assert.equal(enrollCalled, false, "an unconfirmed revoke must never proceed to consume the new code");
    const stillOld = parseCollectorProfileEnv(await readFile(join(profileDir, "codex.env"), "utf8"));
    assert.equal(stillOld.PDPP_LOCAL_DEVICE_ID, "old-device");
  });
});

test("runConnect --force proceeds when the existing credential is already revoked/invalid server-side (401)", async () => {
  const profileDir = tempDirSync();
  await withProfileDir(profileDir, async () => {
    writeLocalCollectorProfile({
      baseUrl: "https://pdpp.example.com",
      connectorId: "codex",
      deviceId: "old-device",
      deviceToken: "old-token",
      name: "codex",
      sourceInstanceId: "dsrc-old",
    });
    const output = await runConnect(
      {
        baseUrl: "https://pdpp.example.com",
        code: "one-time-code",
        command: "connect",
        connector: "codex",
        force: true,
        json: true,
        profile: "codex",
        queuePath: "unused.sqlite",
      } as CliOptions,
      {
        enroll: () =>
          Promise.resolve({
            connector_id: "codex",
            device_id: "new-device",
            device_token: "new-token",
            local_binding_name: "test-binding",
            source_instance_id: "dsrc-new",
          }),
        revokeExistingProfile: () =>
          Promise.reject(new LocalDeviceHttpError(401, JSON.stringify({ error: { code: "authentication_error" } }))),
      }
    );
    assert.equal(output.device_id, "new-device");
  });
});

test("installInterruptAbort registers SIGINT/SIGTERM listeners and aborts with CollectorInterruptedAbort", () => {
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  const controller = new AbortController();
  const remove = installInterruptAbort(controller);
  try {
    assert.equal(process.listenerCount("SIGINT"), beforeInt + 1);
    assert.equal(process.listenerCount("SIGTERM"), beforeTerm + 1);
    assert.equal(controller.signal.aborted, false);

    const handler = process.listeners("SIGINT").at(-1) as () => void;
    handler();

    assert.equal(controller.signal.aborted, true);
    assert.ok(controller.signal.reason instanceof CollectorInterruptedAbort);
  } finally {
    remove();
  }
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});

test("installInterruptAbort's SIGTERM handler also aborts, and removal cleans up both listeners", () => {
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  const controller = new AbortController();
  const remove = installInterruptAbort(controller);
  const handler = process.listeners("SIGTERM").at(-1) as () => void;
  handler();
  assert.equal(controller.signal.aborted, true);
  assert.ok(controller.signal.reason instanceof CollectorInterruptedAbort);
  remove();
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});

test("plain run installs a real SIGINT handler and an interrupt mid-run flushes durably instead of losing records", async () => {
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  process.env[ALLOW_CUSTOM_COMMAND_ENV] = "1";
  const server = await startSampleTestServer();
  try {
    // Emits one record, then hangs (never sent stdin) so the test can
    // interrupt deterministically instead of racing a real finish.
    const dir = await tempDir();
    const fixture = join(dir, "slow.mjs");
    await writeFile(
      fixture,
      // setInterval (never cleared) keeps the event loop alive; a bare
      // unresolved Promise does not hold Node open once the microtask queue
      // drains, so the child would exit on its own instead of hanging.
      '  process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", key: "m-1", data: { id: "m-1" }, emitted_at: new Date(0).toISOString() }) + "\\n");\n  setInterval(() => {}, 1000);\n'
    );
    const queuePath = await tempOutboxPath();
    const beforeInt = process.listenerCount("SIGINT");

    const runPromise = runCollectorOnce({
      args: [fixture],
      baseUrl: server.url,
      command: "run",
      connector: "custom",
      deviceId: "device-1",
      deviceToken: "token-1",
      entrypointCommand: "node",
      quiet: true,
      queuePath,
      sourceInstanceId: "dsrc-1",
      streams: ["messages"],
    });

    // Let the child spawn and emit its record, then interrupt like Ctrl+C
    // would: invoke the freshly installed SIGINT handler directly (same
    // technique as installInterruptAbort's tests above).
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(process.listenerCount("SIGINT"), beforeInt + 1, "plain run must install a real SIGINT handler");
    (process.listeners("SIGINT").at(-1) as () => void)();

    await assert.rejects(runPromise);
    assert.equal(process.listenerCount("SIGINT"), beforeInt, "the handler must be removed once the run settles");

    const outbox = new LocalDeviceOutbox({ path: queuePath });
    try {
      const status = outbox.summary({ sourceInstanceId: "dsrc-1" });
      assert.ok(
        status.ready + status.leased + status.retrying + status.succeeded >= 1,
        "the record emitted before the interrupt must be durably flushed, not lost"
      );
    } finally {
      outbox.close();
    }
  } finally {
    await server.close();
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

/**
 * Seed a schema-v1 (pre-observed-stream-index) outbox file directly so the CLI
 * surface can be tested against the legacy bounded-scan fallback. Mirrors the
 * v1 table DDL and creates NO observed-stream index table, exactly as a
 * database created before this index existed would look.
 */
function seedLegacyV1Outbox(path, rows) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE local_device_outbox (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_holder TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        last_error TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const insert = db.prepare(
      `INSERT INTO local_device_outbox (
         id, source_instance_id, kind, status, payload_json, body_hash,
         attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'record_batch', 'succeeded', ?, 'hash', 0, ?, ?, ?)`
    );
    const stamp = "2026-05-19T12:00:00.000Z";
    // This fixture is intentionally over the legacy bounded-scan budget. Its
    // setup is not the behavior under test, so seed it in one transaction
    // rather than paying an fsync for every synthetic row and making the
    // aggregate suite look like it has leaked an open handle.
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const payload = JSON.stringify({
          records: row.streams.map((stream, index) => ({ data: { id: `${stream}-${index}` }, stream })),
        });
        insert.run(row.id, row.sourceInstanceId, payload, stamp, stamp, stamp);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

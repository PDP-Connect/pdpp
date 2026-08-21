// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the canary harness's judgment: manifest validation, the OTP
 * denylist, predicate evaluation, env derivation, container-spec
 * preservation, and the rollback trigger.
 *
 * Every fixture in this file is drawn from the LIVE production instance
 * (container `pdpp-core-prod-drain`, image `pdpp-core:drain32`) as measured
 * read-only on 2026-08-21, so the assertions are about the real failure modes
 * rather than invented ones.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRunArgs, parseInspect, rollbackContainerName } from "../scripts/canary/container-spec.ts";
import { redact, renderRunArgs } from "../scripts/canary/deploy-canary.ts";
import { deriveEnv, parseEnvEntries, toDockerEnvArgs } from "../scripts/canary/env-derivation.ts";
import {
  type CheckOutcome,
  evaluateNumericPredicate,
  evaluateTimestampPredicate,
  findUncastTextTimestampComparison,
  isOtpDenylisted,
  ManifestError,
  OTP_DENYLISTED_CONNECTORS,
  parseManifest,
  shouldRollback,
} from "../scripts/canary/manifest.ts";

// --- ManifestError message assertions, hoisted so each `assert.throws`
// --- predicate below reuses a module-level pattern instead of allocating one.
const OTP_DENYLISTED_MESSAGE_PATTERN = /OTP-denylisted/u;
const DIGEST_PINNED_MESSAGE_PATTERN = /digest-pinned/u;
const ARTIFACT_ASSERTIONS_MESSAGE_PATTERN = /artifactAssertions/u;
const DUPLICATE_CHECK_ID_MESSAGE_PATTERN = /duplicate check id/u;
const BOUND_REQUIRED_MESSAGE_PATTERN = /bound is required/u;
const TEXT_TIMESTAMP_TRAP_MESSAGE_PATTERN = /TEXT in the live schema/u;
const NO_BEFORE_VALUE_DETAIL_PATTERN = /no before value/u;
const NO_CONTAINER_NAME_MESSAGE_PATTERN = /no container Name/u;
const NO_CONFIG_IMAGE_MESSAGE_PATTERN = /no Config.Image/u;

// --- `buildRunArgs` argv assertions.
const RESTART_UNLESS_STOPPED_PATTERN = /--restart unless-stopped/u;
const MEMORY_LIMIT_BYTES_PATTERN = /--memory 6442450944/u;
const CPUS_LIMIT_PATTERN = /--cpus 6/u;
const NETWORK_MODE_PATTERN = /--network pdpp_default/u;
const PORT_BINDING_PATTERN = /-p 3002:3000\/tcp/u;
const WORKING_DIR_PATTERN = /-w \/app/u;

// --- `rollbackContainerName` shape assertions.
const ROLLBACK_NAME_PREFIX_PATTERN = /^pdpp-core-prod-drain-prev-/u;
const DOCKER_NAME_ILLEGAL_CHARS_PATTERN = /[:.]/u;

// --- `renderRunArgs` redaction assertions.
const REDACTED_OWNER_TOKEN_PATTERN = /PDPP_OWNER_TOKEN=<redacted>/u;
const VISIBLE_DB_PATH_PATTERN = /PDPP_DB_PATH=\/root\/\.pdpp\/pdpp\.sqlite/u;
const VISIBLE_NTFY_TOPIC_PATTERN = /NTFY_TOPIC=pdpp/u;

const BASE_MANIFEST = {
  artifactAssertions: [{ description: "d", id: "a", minCount: 1, path: "/app/x.ts", pattern: "marker" }],
  checks: [
    {
      blocking: true,
      description: "restart count must not climb",
      fact: "restart_count",
      id: "restarts",
      kind: "container_fact",
      predicate: "must_not_increase",
    },
  ],
  container: "pdpp-core-prod-drain",
  description: "fixture",
  dockerfileTarget: "core",
  imageRepo: "pdpp-core",
  imageTag: "test1",
  nodeBaseImage: "node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
  postgresContainer: "pdpp-postgres-1",
  step: "test",
};

function manifestWithChecks(checks: unknown[]): unknown {
  return { ...BASE_MANIFEST, checks };
}

test("OTP denylist covers every connector that texts the owner a code", () => {
  for (const connector of ["usaa", "chase", "heb", "amazon", "venmo", "reddit"]) {
    assert.equal(isOtpDenylisted(connector), true, `${connector} must be denylisted`);
  }
  assert.deepEqual([...OTP_DENYLISTED_CONNECTORS].sort(), ["amazon", "chase", "heb", "reddit", "usaa", "venmo"]);
});

test("OTP denylist resists casing and separator spellings", () => {
  for (const spelling of ["USAA", " Chase ", "chase-bank", "chase_bank", "HEB", "Amazon"]) {
    assert.equal(isOtpDenylisted(spelling), true, `${spelling} must be denylisted`);
  }
});

test("OTP denylist does not over-match unrelated connectors", () => {
  for (const connector of ["slack", "gmail", "whatsapp", "google_maps", "chaseable", "amazonia"]) {
    assert.equal(isOtpDenylisted(connector), false, `${connector} must not be denylisted`);
  }
});

test("parseManifest REFUSES a connector_run for an OTP-gated connector", () => {
  for (const connector of OTP_DENYLISTED_CONNECTORS) {
    const manifest = manifestWithChecks([
      {
        blocking: true,
        connectionId: "cin_deadbeef",
        connectorSlug: connector,
        description: "triggered run",
        expectStatus: "succeeded",
        id: "run",
        kind: "connector_run",
        timeoutSeconds: 600,
      },
    ]);
    assert.throws(
      () => parseManifest(manifest),
      (error: unknown) =>
        error instanceof ManifestError && OTP_DENYLISTED_MESSAGE_PATTERN.test((error as Error).message),
      `${connector} run must be rejected at parse time`
    );
  }
});

test("parseManifest allows a connector_run for a non-denylisted connector", () => {
  const manifest = manifestWithChecks([
    {
      blocking: true,
      connectionId: "cin_f565a96cb0a114b0a27e9606",
      connectorSlug: "slack",
      description: "slack liveness",
      expectStatus: "succeeded",
      id: "slack-run",
      kind: "connector_run",
      timeoutSeconds: 900,
    },
  ]);
  const parsed = parseManifest(manifest);
  assert.equal(parsed.checks.length, 1);
  assert.equal(parsed.checks[0]?.kind, "connector_run");
});

test("parseManifest rejects a floating (non-digest-pinned) base image", () => {
  assert.throws(
    () => parseManifest({ ...BASE_MANIFEST, nodeBaseImage: "node:24.19.0-bookworm-slim" }),
    (error: unknown) => error instanceof ManifestError && DIGEST_PINNED_MESSAGE_PATTERN.test((error as Error).message)
  );
});

test("parseManifest requires at least one artifact assertion", () => {
  assert.throws(
    () => parseManifest({ ...BASE_MANIFEST, artifactAssertions: [] }),
    (error: unknown) =>
      error instanceof ManifestError && ARTIFACT_ASSERTIONS_MESSAGE_PATTERN.test((error as Error).message)
  );
});

test("parseManifest rejects duplicate check ids", () => {
  const check = {
    blocking: true,
    description: "d",
    fact: "restart_count",
    id: "same",
    kind: "container_fact",
    predicate: "must_not_increase",
  };
  assert.throws(
    () => parseManifest(manifestWithChecks([check, { ...check }])),
    (error: unknown) =>
      error instanceof ManifestError && DUPLICATE_CHECK_ID_MESSAGE_PATTERN.test((error as Error).message)
  );
});

test("parseManifest requires a bound for threshold predicates", () => {
  assert.throws(
    () =>
      parseManifest(
        manifestWithChecks([
          {
            blocking: true,
            description: "d",
            id: "s",
            kind: "sql_scalar",
            predicate: "must_be_at_most",
            sql: "select 1",
          },
        ])
      ),
    (error: unknown) => error instanceof ManifestError && BOUND_REQUIRED_MESSAGE_PATTERN.test((error as Error).message)
  );
});

// --- The TEXT-timestamp trap. Measured live: the uncast form returned 208
// --- rows where the cast form returned 8, for the same intended window.

test("findUncastTextTimestampComparison catches the live 208-vs-8 query", () => {
  const trap = "select count(*) from device_ingest_batch_outcomes where created_at > (now() - interval '1 hour')::text";
  assert.equal(findUncastTextTimestampComparison(trap), "created_at");
});

test("findUncastTextTimestampComparison accepts the explicitly cast form", () => {
  const safe =
    "select count(*) from device_ingest_batch_outcomes where (created_at)::timestamptz > now() - interval '1 hour'";
  assert.equal(findUncastTextTimestampComparison(safe), null);
});

test("findUncastTextTimestampComparison ignores queries with no interval math", () => {
  assert.equal(findUncastTextTimestampComparison("select max(emitted_at) from records"), null);
});

test("parseManifest rejects an uncast TEXT-timestamp comparison", () => {
  assert.throws(
    () =>
      parseManifest(
        manifestWithChecks([
          {
            blocking: true,
            description: "d",
            id: "trap",
            kind: "sql_scalar",
            predicate: "must_not_increase",
            sql: "select count(*) from device_ingest_batch_outcomes where created_at > (now() - interval '1 hour')::text",
          },
        ])
      ),
    (error: unknown) =>
      error instanceof ManifestError && TEXT_TIMESTAMP_TRAP_MESSAGE_PATTERN.test((error as Error).message)
  );
});

test("requireExplicitCast:false lets an operator accept the risk deliberately", () => {
  const parsed = parseManifest(
    manifestWithChecks([
      {
        blocking: true,
        description: "d",
        id: "trap",
        kind: "sql_scalar",
        predicate: "must_not_increase",
        requireExplicitCast: false,
        sql: "select count(*) from device_ingest_batch_outcomes where created_at > (now() - interval '1 hour')::text",
      },
    ])
  );
  assert.equal(parsed.checks.length, 1);
});

// --- Predicates.

test("must_not_increase passes when equal or lower, fails when higher", () => {
  assert.equal(evaluateNumericPredicate("must_not_increase", 8, 8, undefined).passed, true);
  assert.equal(evaluateNumericPredicate("must_not_increase", 8, 7, undefined).passed, true);
  assert.equal(evaluateNumericPredicate("must_not_increase", 8, 9, undefined).passed, false);
});

test("must_not_increase fails closed when no before value was captured", () => {
  const result = evaluateNumericPredicate("must_not_increase", null, 0, undefined);
  assert.equal(result.passed, false);
  assert.match(result.detail, NO_BEFORE_VALUE_DETAIL_PATTERN);
});

test("must_stay_zero fails on any nonzero", () => {
  assert.equal(evaluateNumericPredicate("must_stay_zero", 0, 0, undefined).passed, true);
  assert.equal(evaluateNumericPredicate("must_stay_zero", 0, 2, undefined).passed, false);
});

test("must_be_at_most honours its bound", () => {
  assert.equal(evaluateNumericPredicate("must_be_at_most", null, 2, 2).passed, true);
  assert.equal(evaluateNumericPredicate("must_be_at_most", null, 3, 2).passed, false);
});

test("must_not_advance holds the Gmail damage timestamp frozen", () => {
  const frozen = "2026-08-21T15:54:44.503Z";
  assert.equal(evaluateTimestampPredicate(frozen, frozen).passed, true);
  assert.equal(evaluateTimestampPredicate(frozen, "2026-08-21T16:10:00.000Z").passed, false);
  assert.equal(evaluateTimestampPredicate(frozen, "2026-08-21T15:00:00.000Z").passed, true);
});

test("must_not_advance treats appearance and disappearance as failures", () => {
  assert.equal(evaluateTimestampPredicate(null, "2026-08-21T16:00:00.000Z").passed, false);
  assert.equal(evaluateTimestampPredicate("2026-08-21T16:00:00.000Z", null).passed, false);
  assert.equal(evaluateTimestampPredicate(null, null).passed, true);
});

// --- Rollback trigger.

function outcome(id: string, blocking: boolean, passed: boolean): CheckOutcome {
  return { after: 0, before: 0, blocking, description: id, detail: "", id, kind: "sql_scalar", passed };
}

test("shouldRollback fires on a failing blocking check", () => {
  assert.equal(shouldRollback([outcome("a", true, true), outcome("b", true, false)]), true);
});

test("shouldRollback ignores a failing NON-blocking check", () => {
  assert.equal(shouldRollback([outcome("a", true, true), outcome("b", false, false)]), false);
});

test("shouldRollback is false when everything passes", () => {
  assert.equal(shouldRollback([outcome("a", true, true), outcome("b", false, true)]), false);
});

// --- Env derivation. Fixtures are the live 97-var container against the
// --- 25-var image, reduced to the vars that exercise each branch.

const LIVE_ENV_SAMPLE = [
  "PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite",
  "PDPP_CONNECTOR_ARTIFACT_ROOT=/root/.pdpp/connector-artifacts",
  "PDPP_EMBEDDING_CACHE_DIR=/var/cache/pdpp/transformers",
  "PDPP_REFERENCE_ORIGIN=https://pdpp.vivid.fish",
  "PDPP_REFERENCE_REVISION=drain",
  "NODE_ENV=production",
  "PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers",
  "PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=24.19.0",
  "GMAIL_APP_PASSWORD=secret-value",
  "NTFY_TOPIC=pdpp",
];

const IMAGE_ENV_SAMPLE = [
  "PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite",
  "PDPP_CONNECTOR_ARTIFACT_ROOT=/var/lib/pdpp/connector-artifacts",
  "PDPP_EMBEDDING_CACHE_DIR=/var/lib/pdpp/transformers",
  "PDPP_REFERENCE_ORIGIN=http://localhost:3000",
  "PDPP_REFERENCE_REVISION=unknown",
  "NODE_ENV=production",
  "PLAYWRIGHT_BROWSERS_PATH=/opt/patchright-browsers",
  "PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=24.19.0",
];

test("deriveEnv carries PDPP_DB_PATH — the var a name-based filter would drop", () => {
  const derived = deriveEnv(LIVE_ENV_SAMPLE, IMAGE_ENV_SAMPLE);
  const dbPath = derived.carried.find((entry) => entry.name === "PDPP_DB_PATH");
  assert.ok(dbPath, "PDPP_DB_PATH must be carried");
  assert.equal(dbPath.value, "/root/.pdpp/pdpp.sqlite");
  assert.equal(
    derived.droppedAsImageIdentical.some((entry) => entry.name === "PDPP_DB_PATH"),
    false,
    "dropping PDPP_DB_PATH would point production at the wrong database"
  );
});

test("deriveEnv carries every name-colliding override and reports it", () => {
  const derived = deriveEnv(LIVE_ENV_SAMPLE, IMAGE_ENV_SAMPLE);
  const reported = derived.carriedOverrides.map((entry) => entry.name).sort();
  assert.deepEqual(reported, [
    "PDPP_CONNECTOR_ARTIFACT_ROOT",
    "PDPP_DB_PATH",
    "PDPP_EMBEDDING_CACHE_DIR",
    "PDPP_REFERENCE_ORIGIN",
    "PDPP_REFERENCE_REVISION",
  ]);
  for (const name of reported) {
    assert.ok(
      derived.carried.some((entry) => entry.name === name),
      `${name} must be carried, not dropped`
    );
  }
});

test("deriveEnv drops only value-identical vars, letting the new image supply them", () => {
  const derived = deriveEnv(LIVE_ENV_SAMPLE, IMAGE_ENV_SAMPLE);
  const dropped = derived.droppedAsImageIdentical.map((entry) => entry.name).sort();
  assert.deepEqual(dropped, ["NODE_ENV", "NODE_VERSION", "PATH", "PLAYWRIGHT_BROWSERS_PATH"]);
});

test("deriveEnv carries operator-only vars the image never declares", () => {
  const derived = deriveEnv(LIVE_ENV_SAMPLE, IMAGE_ENV_SAMPLE);
  for (const name of ["GMAIL_APP_PASSWORD", "NTFY_TOPIC"]) {
    assert.ok(
      derived.carried.some((entry) => entry.name === name),
      `${name} must be carried`
    );
  }
});

test("deriveEnv lets a CHANGED image default win over the stale live value", () => {
  // The new image bumps PATH. Because the live value equals the OLD image's
  // value and differs from the new one, a naive value-compare would carry the
  // stale PATH forward and mask the change. deriveEnv compares against the
  // NEW image, so this is carried only when it is a genuine operator override.
  const derived = deriveEnv(["PATH=/old/bin"], ["PATH=/new/bin"]);
  assert.equal(derived.carried.length, 1);
  assert.equal(derived.carriedOverrides[0]?.name, "PATH");
  // Reported, so an operator can see that a live PATH is overriding the image.
  assert.equal(derived.carriedOverrides[0]?.imageValue, "/new/bin");
});

test("parseEnvEntries keeps '=' inside values intact", () => {
  const parsed = parseEnvEntries(["A=b=c", "BARE"]);
  assert.deepEqual(parsed, [
    { name: "A", value: "b=c" },
    { name: "BARE", value: "" },
  ]);
});

test("toDockerEnvArgs passes each value as its own argv entry", () => {
  const derived = deriveEnv(["A=has space", "B=x"], []);
  assert.deepEqual(toDockerEnvArgs(derived), ["-e", "A=has space", "-e", "B=x"]);
});

// --- Container spec preservation. Fixture mirrors the live inspect output.

const LIVE_INSPECT = {
  Config: {
    Cmd: ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"],
    Entrypoint: ["docker-entrypoint.sh"],
    Env: ["PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite"],
    Image: "pdpp-core:drain32",
    User: "",
    WorkingDir: "/app",
  },
  HostConfig: {
    Binds: [
      "pdpp_pdpp-transformers:/var/cache/pdpp/transformers",
      "/home/tnunamak/.claude:/imports/claude:ro",
      "pdpp_pdpp-data:/var/lib/pdpp",
      "pdpp_pdpp-home:/root/.pdpp",
    ],
    Memory: 6_442_450_944,
    NanoCpus: 6_000_000_000,
    NetworkMode: "pdpp_default",
    PortBindings: { "3000/tcp": [{ HostIp: "", HostPort: "3002" }] },
    RestartPolicy: { MaximumRetryCount: 0, Name: "unless-stopped" },
  },
  Image: "sha256:32b253cba254ef358e286bf062b5ad43d8f7e5e090231ace11d6299524b59214",
  Name: "/pdpp-core-prod-drain",
  RestartCount: 0,
  State: { StartedAt: "2026-08-21T17:24:15.83838229Z" },
};

test("parseInspect reads the live container's identity and limits", () => {
  const spec = parseInspect(LIVE_INSPECT);
  assert.equal(spec.name, "pdpp-core-prod-drain");
  assert.equal(spec.configImage, "pdpp-core:drain32");
  assert.equal(spec.restartCount, 0);
  assert.equal(spec.memoryBytes, 6_442_450_944);
  assert.equal(spec.nanoCpus, 6_000_000_000);
  assert.equal(spec.restartPolicyName, "unless-stopped");
});

test("buildRunArgs preserves restart policy, limits, network, ports and ALL volumes", () => {
  const spec = parseInspect(LIVE_INSPECT);
  const args = buildRunArgs(spec, "pdpp-core:new", ["-e", "PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite"]);
  const joined = args.join(" ");

  assert.match(joined, RESTART_UNLESS_STOPPED_PATTERN);
  assert.match(joined, MEMORY_LIMIT_BYTES_PATTERN);
  assert.match(joined, CPUS_LIMIT_PATTERN);
  assert.match(joined, NETWORK_MODE_PATTERN);
  assert.match(joined, PORT_BINDING_PATTERN);
  for (const bind of LIVE_INSPECT.HostConfig.Binds) {
    assert.ok(args.includes(bind), `volume ${bind} must be preserved`);
  }
  assert.equal(args.filter((arg) => arg === "-v").length, 4, "all four mounts must be preserved");
  assert.match(joined, WORKING_DIR_PATTERN);
});

test("buildRunArgs puts the new image before the command, and keeps the command", () => {
  const spec = parseInspect(LIVE_INSPECT);
  const args = buildRunArgs(spec, "pdpp-core:new", []);
  const imageIndex = args.indexOf("pdpp-core:new");
  assert.ok(imageIndex > 0, "image must appear in argv");
  assert.deepEqual(args.slice(imageIndex + 1), ["node", "--import", "tsx", "/app/deploy/railway/core-supervisor.ts"]);
  assert.equal(args[args.indexOf("--entrypoint") + 1], "docker-entrypoint.sh");
});

test("buildRunArgs never carries the OLD image tag", () => {
  const spec = parseInspect(LIVE_INSPECT);
  const args = buildRunArgs(spec, "pdpp-core:new", []);
  assert.equal(args.includes("pdpp-core:drain32"), false, "the old tag must not survive into the new run");
});

test("rollbackContainerName is unique per deploy and marks the rollback target", () => {
  const first = rollbackContainerName("pdpp-core-prod-drain", new Date("2026-08-21T18:00:00.000Z"));
  const second = rollbackContainerName("pdpp-core-prod-drain", new Date("2026-08-21T19:00:00.000Z"));
  assert.match(first, ROLLBACK_NAME_PREFIX_PATTERN);
  assert.notEqual(first, second);
  assert.equal(DOCKER_NAME_ILLEGAL_CHARS_PATTERN.test(first), false, "docker names cannot contain ':' or '.'");
});

test("parseInspect refuses output with no name or image", () => {
  assert.throws(() => parseInspect({ Config: { Image: "x" } }), NO_CONTAINER_NAME_MESSAGE_PATTERN);
  assert.throws(() => parseInspect({ Config: {}, Name: "/x" }), NO_CONFIG_IMAGE_MESSAGE_PATTERN);
});

// --- Secret redaction. The live container carries 97 vars including
// --- PDPP_OWNER_TOKEN, SLACK_COOKIE and several *_PASSWORD entries; the
// --- receipt is durable and the console output gets pasted into issues.

test("redact masks credential-shaped names and keeps ordinary ones", () => {
  for (const name of [
    "PDPP_OWNER_PASSWORD",
    "PDPP_OWNER_TOKEN",
    "SLACK_COOKIE",
    "PDPP_CREDENTIAL_ENCRYPTION_KEY",
    "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
    "GMAIL_APP_PASSWORD",
  ]) {
    assert.equal(redact(name, "hunter2"), "<redacted>", `${name} must be redacted`);
  }
  assert.equal(redact("PDPP_DB_PATH", "/root/.pdpp/pdpp.sqlite"), "/root/.pdpp/pdpp.sqlite");
  assert.equal(redact("NODE_ENV", "production"), "production");
});

test("renderRunArgs redacts every secret env value in the printed command", () => {
  const args = buildRunArgs(parseInspect(LIVE_INSPECT), "pdpp-core:new", [
    "-e",
    "PDPP_OWNER_TOKEN=super-secret",
    "-e",
    "PDPP_DB_PATH=/root/.pdpp/pdpp.sqlite",
  ]);
  const rendered = renderRunArgs(args);
  assert.equal(rendered.includes("super-secret"), false, "the token value must not be printed");
  assert.match(rendered, REDACTED_OWNER_TOKEN_PATTERN);
  // Non-secret operator overrides stay visible: they are what the operator
  // must eyeball to catch a wrong env call.
  assert.match(rendered, VISIBLE_DB_PATH_PATTERN);
});

test("renderRunArgs does not leak a secret whose value contains a space", () => {
  // The previous regex-over-joined-string form leaked exactly this case,
  // because it could not tell where the value ended.
  const rendered = renderRunArgs(["-e", "CHASE_PASSWORD=two words here", "-e", "NTFY_TOPIC=pdpp"]);
  assert.equal(rendered.includes("two words here"), false);
  assert.match(rendered, VISIBLE_NTFY_TOPIC_PATTERN);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "../..");
const relativeCliPath = "reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts";
const appliedFalsePattern = /"applied": false/;

let postgresTestDatabaseCounter = 0;

function postgresTestDatabaseName(): string {
  postgresTestDatabaseCounter += 1;
  return `pdpp_repair_online_${process.pid}_${postgresTestDatabaseCounter}`;
}

async function runCli(databaseUrl: string): Promise<{ stderr: string; stdout: string; status: number | null }> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", relativeCliPath, "--connector-id=gmail", "--connector-instance-id=cin_test"],
    {
      cwd: repoRoot,
      env: { ...process.env, PDPP_DATABASE_URL: databaseUrl, PDPP_TEST_POSTGRES_URL: databaseUrl },
    }
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("repair dry-run did not finish while a live records writer held its transaction"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr: Buffer.concat(stderr).toString(), stdout: Buffer.concat(stdout).toString() });
    });
  });
}

test("direct import does not execute the repair CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import('./reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts')",
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("documented relative invocation executes main before database access", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(process.execPath, [relativeCliPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--connector-id is required/);
  assert.equal(result.stdout, "");
});

test("--reason=too_large is refused before any database connection is attempted", () => {
  // No PDPP_DATABASE_URL/PDPP_TEST_POSTGRES_URL in the child env at all: if
  // the CLI's `--reason` allowlist check ran AFTER the database-url guard (or
  // skipped straight to a DB call), this would fail with a DIFFERENT error
  // ("PDPP_DATABASE_URL is required") instead of the reason refusal — proving
  // the refusal is unconditional and connection-free, not merely reachable.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--connector-id=gmail", "--connector-instance-id=cin_test", "--reason=too_large"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--reason='too_large' is not requeueable/);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.doesNotMatch(result.stderr, /PDPP_DATABASE_URL/);
  assert.equal(result.stdout, "");
});

test("an unrecognized --reason is refused the same way as too_large", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--connector-id=gmail", "--connector-instance-id=cin_test", "--reason=not_found"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--reason='not_found' is not requeueable/);
  assert.equal(result.stdout, "");
});

/**
 * Regression: `--reason too_large` (space-separated) parsed as `reason = "true"`.
 *
 * The loop read a flag's value only from the `--key=value` form and substituted
 * the boolean `true` otherwise, so a space-separated value was silently dropped
 * and replaced. The operator saw `--reason='true' is not requeueable`, naming a
 * value they never typed, which hid the real refusal and made the tool look
 * broken in a different way than it was.
 *
 * This asserts the honest failure: the reason the operator ACTUALLY typed is the
 * one echoed back. A tool that writes to production must never misread its own
 * arguments.
 */
test("a space-separated --reason value is read, not replaced with 'true'", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [
      relativeCliPath,
      "--connector-id",
      "test-connector",
      "--connector-instance-id",
      "cin_test",
      "--reason",
      "too_large",
    ],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--reason='too_large' is not requeueable/);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.doesNotMatch(result.stderr, /'true'/);
  assert.equal(result.stdout, "");
});

/**
 * The space-separated form must also WORK, not merely be read: a connector id
 * supplied that way has to satisfy the required-argument check rather than
 * fall through as missing.
 */
test("space-separated required arguments satisfy validation", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--connector-id", "test-connector", "--connector-instance-id", "cin_test"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  // Args are satisfied, so the run advances PAST validation to the database
  // guard — proving both values were actually captured.
  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /PDPP_DATABASE_URL is required/);
});

/**
 * A value-taking flag with no value must REFUSE rather than silently default.
 * Defaulting is what produced the original defect; failing closed is the only
 * safe reading of an ambiguous argument list.
 */
test("a value-taking flag given no value is refused, never defaulted", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(process.execPath, [relativeCliPath, "--connector-id", "test-connector", "--reason"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /missing value for: --reason/);
  assert.equal(result.stdout, "");
});

/** `--apply` is the only genuine boolean and must not swallow the next argument. */
test("--apply does not consume the following flag's value", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--apply", "--connector-id", "test-connector", "--connector-instance-id", "cin_test"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /PDPP_DATABASE_URL is required/);
});

/**
 * A value-taking flag followed by another FLAG has no value, and must be
 * refused rather than swallowing that flag as its operand.
 *
 * `--stream` is the sharp case: it is repeatable and additive, so silently
 * consuming `--connector-id` as a stream name would both widen the set of
 * streams a production write touches AND leave the connector id unset.
 *
 * Note on the `index += 1` skip in the parser: omitting it is an EQUIVALENT
 * mutation, not an untested path. A consumed value can never begin with `--`
 * (the guard below rejects that case before consumption), and the loop's first
 * guard ignores any token that does not, so a re-read value is inert for every
 * reachable argv. The skip is kept because it states the intent directly and
 * stops that reasoning from silently becoming load-bearing.
 */
test("a consumed flag value is not re-read as a separate argument", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  // `--reason` takes the NEXT entry. If the loop failed to skip it, `too_large`
  // would be re-examined; it does not start with `--` so it is dropped, and the
  // refusal below still names the right reason either way. The discriminating
  // part is `--stream`: its value `--connector-id` is `--`-prefixed, so a
  // non-skipping loop would treat it as the connector-id FLAG and leave
  // connectorId unset, changing which error surfaces.
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--stream", "--connector-id", "--connector-instance-id", "cin_test"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // `--stream` is followed by a `--`-prefixed token, so it has NO value: the
  // tool must say so rather than silently consuming the following flag.
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /missing value for: --stream/);
});

const postgresUrl = process.env.PDPP_TEST_POSTGRES_URL;
if (postgresUrl) {
  test("dry-run startup does not deadlock with a concurrent live records write", async () => {
    const { closePostgresStorage, getPostgresPool, initPostgresStorage } = await import(
      "../server/postgres-storage.ts"
    );
    const { withTemporaryPostgresDatabase } = await import("../test/helpers/postgres-temp-database.ts");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: postgresUrl,
        databaseName: postgresTestDatabaseName(),
      },
      async (databaseUrl) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        const client = await getPostgresPool().connect();
        try {
          await client.query("BEGIN");
          // UPDATE takes the same relation-level RowExclusiveLock as a normal
          // live ingest write. The dry-run must finish while this transaction
          // remains open; full bootstrap DDL would wait here (and, in the
          // incident's opposite lock ordering, deadlock with this writer).
          await client.query("UPDATE records SET emitted_at = emitted_at WHERE false");
          const result = await runCli(databaseUrl);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, appliedFalsePattern);
        } finally {
          await client.query("ROLLBACK").catch(() => {
            // The temporary database helper closes all remaining connections.
          });
          client.release();
          await closePostgresStorage();
        }
      }
    );
  });
} else {
  test("dry-run startup concurrency guard (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}

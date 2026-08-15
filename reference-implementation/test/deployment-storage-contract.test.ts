// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A deployment whose own artifact declares Postgres must never be served from
 * SQLite.
 *
 * Reported by the owner, 2026-08-08: `docker compose up -d` was run without
 * the `--env-file .env.docker` that supplies PDPP_STORAGE_BACKEND=postgres and
 * PDPP_DATABASE_URL. Both interpolated to empty strings, the runtime fell back
 * to SQLite, created an EMPTY database at /root/.pdpp/pdpp.sqlite, and served
 * it behind the owner's production URL for ~7 hours returning HTTP 200 — while
 * 23 connections and 4,543,263 records sat untouched in Postgres.
 *
 * The signal keyed on is PDPP_DEPLOYMENT_STORAGE_CONTRACT: the artifact's own
 * assertion about where its records live, in the same vein as
 * PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT. It is a CONTRACT, not a
 * heuristic, on three counts:
 *
 *   1. The deployment states it explicitly. Nothing is inferred from the
 *      environment's shape.
 *   2. It is a literal in the artifact, so it survives the missing
 *      `--env-file` that is the very failure being guarded. Reading it from
 *      the env file would make it vanish in exactly the case it must catch.
 *   3. It is orthogonal to the config it asserts about, which is what lets the
 *      contradiction (declared Postgres, no Postgres config) be detected at
 *      all.
 *
 * Nearby-postgres-service was explicitly REJECTED as the signal. The root
 * compose brings a `postgres` service up unconditionally for env-gated
 * conformance proofs and its own comment says the reference "falls back to the
 * SQLite default" without the backend vars — so a service, or a `depends_on`
 * on it, declares nothing about storage.
 *
 * The rules pinned here:
 *   1. Declared Postgres + no Postgres config = refuse to boot.
 *   2. NO contract at all + no config = SQLite, exactly as before. The
 *      single-container product runs with no storage config and that is a
 *      legitimate deployment, not a misconfiguration.
 *   3. Every artifact that declares the contract must also ship the config it
 *      asserts (or a literal URL), and vice versa.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveStorageBackend } from "../server/postgres-storage.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT = "PDPP_DEPLOYMENT_STORAGE_CONTRACT";
const RE_REFUSES = /Refusing to start: PDPP_DEPLOYMENT_STORAGE_CONTRACT=postgres/;
const RE_NAMES_URL_VAR = /PDPP_DATABASE_URL/;
const RE_NAMES_BACKEND_VAR = /PDPP_STORAGE_BACKEND=postgres/;
const RE_NAMES_ENV_FILE_FIX = /--env-file \.env\.docker/;
const RE_BACKEND_VAR_PASSTHROUGH = /PDPP_STORAGE_BACKEND:\s*\$\{PDPP_STORAGE_BACKEND:-\}/;
const RE_URL_VAR_PASSTHROUGH = /PDPP_DATABASE_URL:\s*\$\{PDPP_DATABASE_URL:-\}/;
const RE_LITERAL_DATABASE_URL = /PDPP_DATABASE_URL:\s*postgresql:\/\//;
const RE_DECLARES_POSTGRES = /:\s*["']?postgres["']?\s*$/;
const RE_INTERPOLATED = /\$\{/;
const RE_BAKED_SQLITE_PATH = /PDPP_DB_PATH=\/var\/lib\/pdpp\/pdpp\.sqlite/;
const RE_BAKED_CONTRACT = /PDPP_DEPLOYMENT_STORAGE_CONTRACT\s*=\s*postgres/;

// ─── the runtime guard ───────────────────────────────────────────────────

test("a deployment declaring Postgres with no Postgres config refuses to boot", () => {
  // The exact live shape: the compose declares the contract; `--env-file` was
  // never passed, so both backend vars interpolated to empty strings.
  assert.throws(
    () =>
      resolveStorageBackend({
        env: {
          PDPP_DATABASE_URL: "",
          PDPP_DB_PATH: "/root/.pdpp/pdpp.sqlite",
          PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres",
          PDPP_STORAGE_BACKEND: "",
        },
      }),
    RE_REFUSES,
    "serving an empty SQLite database behind a Postgres deployment's URL is worse than not starting"
  );
});

test("the refusal names the configuration the operator must supply", () => {
  assert.throws(
    () => resolveStorageBackend({ env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres" } }),
    (err: Error) => {
      assert.match(err.message, RE_NAMES_URL_VAR, "names the URL var");
      assert.match(err.message, RE_NAMES_BACKEND_VAR, "and the backend var");
      assert.match(err.message, RE_NAMES_ENV_FILE_FIX, "and the concrete fix for the reference stack");
      return true;
    }
  );
});

test("the declared contract is satisfied by either backend var, and does not fire", () => {
  assert.deepEqual(
    resolveStorageBackend({
      env: {
        PDPP_DATABASE_URL: "postgres://user:pass@localhost:5432/pdpp",
        PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres",
      },
    }),
    { backend: "postgres", databaseUrl: "postgres://user:pass@localhost:5432/pdpp" }
  );
  assert.deepEqual(
    resolveStorageBackend({
      env: {
        PDPP_DATABASE_URL: "postgres://user:pass@localhost:5432/pdpp",
        PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres",
        PDPP_STORAGE_BACKEND: "postgres",
      },
    }),
    { backend: "postgres", databaseUrl: "postgres://user:pass@localhost:5432/pdpp" }
  );
});

// ─── the SQLite product must keep working ────────────────────────────────

test("the single-container SQLite product still boots with NO storage config at all", () => {
  // The counterweight. A generic 'unset backend is fatal' rule would break the
  // coherent single-container product, which intentionally relies on SQLite.
  assert.deepEqual(resolveStorageBackend({ env: {} }), { backend: "sqlite" });
  assert.deepEqual(
    resolveStorageBackend({ env: { PDPP_DB_PATH: "/var/lib/pdpp/pdpp.sqlite" } }),
    { backend: "sqlite" },
    "the core image's baked SQLite path is a legitimate deployment, not a misconfiguration"
  );
});

test("an explicit sqlite deployment may declare its own contract without tripping the guard", () => {
  assert.deepEqual(resolveStorageBackend({ env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: "sqlite" } }), {
    backend: "sqlite",
  });
  // The boundary the ruling draws: fail closed on ABSENT config, not on a
  // deliberate answer. An operator who typed PDPP_STORAGE_BACKEND=sqlite has
  // chosen; the empty-string case above is the silent fallback and still
  // refuses. Widening this to any contradiction would block the documented
  // "run the Postgres stack against SQLite" escape hatch.
  assert.deepEqual(
    resolveStorageBackend({
      env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres", PDPP_STORAGE_BACKEND: "sqlite" },
    }),
    { backend: "sqlite" },
    "an operator explicitly choosing sqlite has answered the question the contract asks"
  );
  assert.throws(
    () =>
      resolveStorageBackend({
        env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: "postgres", PDPP_STORAGE_BACKEND: "" },
      }),
    RE_REFUSES,
    "but an EMPTY backend var is absent config, not a choice — that is the live failure"
  );
});

test("only an exact 'postgres' declaration arms the guard", () => {
  // A contract var carrying anything else is not a Postgres declaration, and
  // must not turn every unconfigured deployment into a boot failure.
  for (const declared of ["", "  ", "maybe", "1", "true"]) {
    assert.deepEqual(
      resolveStorageBackend({ env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: declared } }),
      { backend: "sqlite" },
      `${JSON.stringify(declared)} does not declare Postgres`
    );
  }
  // Case and surrounding whitespace are tolerated on the real declaration.
  assert.throws(() => resolveStorageBackend({ env: { PDPP_DEPLOYMENT_STORAGE_CONTRACT: " Postgres " } }), RE_REFUSES);
});

// ─── artifact pairing ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/useAwait: localized test helper preserves its explicit contract.
async function read(relPath: string): Promise<string> {
  return readFile(`${REPO_ROOT}${relPath}`, "utf8");
}

/**
 * The contract must be a LITERAL, not `${VAR:-}`. Read from the operator's env
 * file it would vanish in exactly the missing-`--env-file` case it exists to
 * catch, and the guard would be silently vacuous.
 */
function assertLiteralContractDeclaration(artifact: string, label: string): void {
  const declaration = artifact.split("\n").find((line) => line.trim().startsWith(`${CONTRACT}:`));
  assert.ok(declaration, `${label}: expected a ${CONTRACT} declaration`);
  assert.match(declaration, RE_DECLARES_POSTGRES, `${label}: must declare postgres`);
  assert.doesNotMatch(
    declaration,
    RE_INTERPOLATED,
    `${label}: must be a literal — an interpolated value defeats the guard`
  );
}

test("the root compose declares the Postgres contract as a literal", async () => {
  const compose = await read("docker-compose.yml");
  assertLiteralContractDeclaration(compose, "docker-compose.yml");
  // And it is the artifact that actually intends Postgres: it still passes the
  // two backend vars through for `--env-file` to fill.
  assert.match(compose, RE_BACKEND_VAR_PASSTHROUGH);
  assert.match(compose, RE_URL_VAR_PASSTHROUGH);
});

test("the self-host Core compose declares the contract and ships a literal database URL", async () => {
  const compose = await read("deploy/docker/docker-compose.yml");
  assertLiteralContractDeclaration(compose, "deploy/docker/docker-compose.yml");
  assert.match(compose, RE_LITERAL_DATABASE_URL, "the config the contract asserts must actually be present");
});

test("the single-container image does NOT bake the Postgres contract", async () => {
  // The inverse direction, and the one that keeps the guard honest: an
  // operator can `docker run` the core image with no config at all, and that
  // is a supported SQLite deployment. Baking the contract there would refuse
  // to boot the product's own default path.
  const dockerfile = await read("Dockerfile");
  assert.doesNotMatch(dockerfile, RE_BAKED_CONTRACT);
  assert.match(dockerfile, RE_BAKED_SQLITE_PATH, "it bakes a SQLite path instead");
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * P2 fix (reviewer HOLD on PR #278): the template's usability was previously
 * verified only by `datistemplate`/`datallowconn` on `pg_database` -- does a
 * template exist and accept no connections. That says nothing about
 * whether the migration/bootstrap CODE that built it is the code this
 * process would run today. `scripts/postgres-test-template.ts` now binds a
 * `schema_source_digest` (a hash of `server/postgres-storage.ts`, which
 * defines `bootstrapPostgresSchema` and every migration function it runs)
 * into a metadata row on the admin `postgres` database, keyed by template
 * name, and `assertPostgresTestTemplateUsable` -- the clone-time check every
 * call site that received a template name via env var goes through -- must
 * verify that digest before trusting the template.
 *
 * This file proves the identity check fails closed in both directions a
 * template could be untrustworthy without failing the pg_database flag
 * check alone:
 *
 *   1. A template with no metadata row at all (e.g. built by an older
 *      version of this code, or a foreign process that never wrote one).
 *   2. A template whose metadata row's digest does not match this process's
 *      own `postgres-storage.ts` (the migration code changed since the
 *      template was built).
 *
 * Both must be refused, not silently trusted -- a template that passes
 * `datistemplate=true, datallowconn=false` but fails identity verification
 * is exactly the "looks fine, quietly wrong" shape the reviewer's P2 finding
 * was about.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { assertPostgresTestTemplateUsable, ensurePostgresTestTemplate } from "../scripts/postgres-test-template.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";
const RE_NO_METADATA_ROW = /failed identity verification.*no metadata row found/s;
const RE_DIGEST_MISMATCH = /failed identity verification.*schema source digest mismatch/s;

function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

async function withAdmin<T>(base: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrlFor(base) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropTemplate(base: string, templateName: string): Promise<void> {
  await withAdmin(base, async (admin) => {
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    await admin
      .query("DELETE FROM pdpp_test_template_metadata WHERE template_name = $1", [templateName])
      .catch(() => undefined);
  });
}

test("REFUSES a template with no metadata row (built by an older/foreign process)", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idnone${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query("DELETE FROM pdpp_test_template_metadata WHERE template_name = $1", [templateName]);
    });
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      RE_NO_METADATA_ROW,
      "a template with pg_database flags set but no metadata row must be refused, not trusted"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("REFUSES a template whose metadata digest does not match this process's own migration source", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idmis${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(
        `UPDATE pdpp_test_template_metadata SET schema_source_digest = 'deliberately-wrong-digest' WHERE template_name = $1`,
        [templateName]
      );
    });
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      RE_DIGEST_MISMATCH,
      "a template whose metadata digest disagrees with this process's own postgres-storage.ts must be refused"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("ALLOWS a freshly-built template whose metadata matches this process's own migration source", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idok${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await assert.doesNotReject(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      "a template built by this same process's own ensurePostgresTestTemplate must pass its own identity check"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("Postgres test template identity tests (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: POSTGRES_URL !== null,
}, () => {
  assert.ok(true);
});

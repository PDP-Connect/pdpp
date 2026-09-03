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
 * The independent review of that fix found the row's `runner_id` and
 * `built_at` were written but never read back, so a row with a wrong runner
 * id and a correct digest was accepted. The check now binds all four
 * identity elements (runner id, schema version, source digest, creation
 * time) through a stored `identity_digest`, and accepts an identity token
 * from the run that built the template. This file proves the check fails
 * closed for every way a template could be untrustworthy without failing
 * the pg_database flag check alone:
 *
 *   1. A template with no metadata row at all (e.g. built by an older
 *      version of this code, or a foreign process that never wrote one).
 *   2. A template whose metadata row's digest does not match this process's
 *      own `postgres-storage.ts` (the migration code changed since the
 *      template was built).
 *   3. A template whose metadata row's runner id ALONE was altered (the
 *      review's exact reproduction).
 *   4. A template whose recorded build time ALONE was altered.
 *   5. A template whose recorded schema version ALONE was altered.
 *   6. A template that is intact but is not the build the caller's run
 *      produced (wrong identity token).
 *
 * All must be refused, not silently trusted -- a template that passes
 * `datistemplate=true, datallowconn=false` but fails identity verification
 * is exactly the "looks fine, quietly wrong" shape the reviewer's P2 finding
 * was about.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  assertPostgresTestTemplateUsable,
  ensurePostgresTestTemplate,
  readPostgresTestTemplateIdentity,
} from "../scripts/postgres-test-template.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";
const RE_NO_METADATA_ROW = /failed identity verification.*no metadata row found/s;
const RE_DIGEST_MISMATCH = /failed identity verification.*schema source digest mismatch/s;
const RE_RUNNER_ID_MISMATCH = /failed identity verification.*runner id mismatch/s;
const RE_IDENTITY_DIGEST_MISMATCH = /failed identity verification.*identity digest mismatch/s;
const RE_IDENTITY_TOKEN_MISMATCH = /failed identity verification.*identity token mismatch/s;

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

test("REFUSES a template whose metadata runner id alone was altered (digest still correct)", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idrun${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(`UPDATE pdpp_test_template_metadata SET runner_id = 'deadbeef' WHERE template_name = $1`, [
        templateName,
      ]);
    });
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      RE_RUNNER_ID_MISMATCH,
      "a row whose runner id no longer matches the run encoded in the template name must be refused even though its source digest is correct"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("REFUSES a template whose recorded build time alone was altered", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idblt${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(
        `UPDATE pdpp_test_template_metadata SET built_at = built_at - interval '1 day' WHERE template_name = $1`,
        [templateName]
      );
    });
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      RE_IDENTITY_DIGEST_MISMATCH,
      "a row whose creation time was rewritten after the build must be refused"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("REFUSES a template whose recorded schema version alone was altered", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idver${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    await withAdmin(baseUrl, async (admin) => {
      await admin.query(
        `UPDATE pdpp_test_template_metadata SET schema_version = 'deliberately-wrong-version' WHERE template_name = $1`,
        [templateName]
      );
    });
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName),
      RE_IDENTITY_DIGEST_MISMATCH,
      "a row whose schema version was rewritten after the build must be refused"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("REFUSES an intact template when the caller's identity token names a different build", {
  skip: POSTGRES_SKIP,
}, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = `idtok${process.pid}`;
  const templateName = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    const identity = await readPostgresTestTemplateIdentity(baseUrl, templateName);
    assert.match(identity, /^[0-9a-f]{64}$/, "identity token is a sha256 hex digest");
    await assert.rejects(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName, { expectedIdentity: "0".repeat(64) }),
      RE_IDENTITY_TOKEN_MISMATCH,
      "a caller holding a token from a different build must not be handed this template"
    );
    await assert.doesNotReject(
      () => assertPostgresTestTemplateUsable(baseUrl, templateName, { expectedIdentity: identity }),
      "the same template must pass when the caller holds the token of this build"
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

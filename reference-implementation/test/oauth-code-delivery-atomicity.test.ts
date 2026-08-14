// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  issueOAuthAuthorizationCodeForDeviceCode,
  issueOAuthAuthorizationCodeForPackageDeviceCode,
  stageOAuthAuthorizationCodeRequest,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOT_RECOVERABLE = /not recoverable/;

type Backend = "postgres" | "sqlite";

async function markCodeConsumed(backend: Backend, code: string): Promise<void> {
  if (backend === "postgres") {
    await postgresQuery(
      "UPDATE oauth_authorization_codes SET status = 'consumed', consumed_at = NOW() WHERE code = $1",
      [code]
    );
    return;
  }
  getDb()
    .prepare("UPDATE oauth_authorization_codes SET status = 'consumed', consumed_at = datetime('now') WHERE code = ?")
    .run(code);
}

async function countIssuedRows(backend: Backend, deviceCode: string): Promise<number> {
  if (backend === "postgres") {
    const result = await postgresQuery<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM oauth_authorization_codes WHERE device_code = $1",
      [deviceCode]
    );
    return result.rows[0]?.count ?? 0;
  }
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM oauth_authorization_codes WHERE device_code = ?")
      .get(deviceCode) as {
      count: number;
    }
  ).count;
}

async function exerciseDelivery(backend: Backend): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const clientId = `client_${backend}_${randomBytes(6).toString("hex")}`;
  const redirectUri = `https://${backend}.client.example/callback`;
  const stage = async (deviceCode: string) => {
    await stageOAuthAuthorizationCodeRequest({
      clientId,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      deviceCode,
      redirectUri,
      state: "delivery-state",
    });
  };

  const grantDeviceCode = `device_grant_${backend}_${randomBytes(6).toString("hex")}`;
  await stage(grantDeviceCode);
  const grantBinding = { grantId: `grt_${backend}`, token: `tok_${backend}` };
  const grantResults = await Promise.all([
    issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding),
    issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding),
  ]);
  assert.deepEqual(grantResults[1], grantResults[0], "concurrent delivery must converge on the persisted code");
  assert.equal(grantResults[0]?.redirect_uri, redirectUri);
  assert.equal(typeof grantResults[0]?.code, "string");
  assert.equal(await countIssuedRows(backend, grantDeviceCode), 1);
  await assert.rejects(
    () => issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, { ...grantBinding, token: "tok_mismatch" }),
    NOT_RECOVERABLE
  );
  await markCodeConsumed(backend, String(grantResults[0]?.code));
  await assert.rejects(() => issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, grantBinding), NOT_RECOVERABLE);

  const packageDeviceCode = `device_package_${backend}_${randomBytes(6).toString("hex")}`;
  await stage(packageDeviceCode);
  const packageBinding = { packageId: `gpkg_${backend}`, token: `tok_pkg_${backend}` };
  const packageResults = await Promise.all([
    issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, packageBinding),
    issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, packageBinding),
  ]);
  assert.deepEqual(packageResults[1], packageResults[0], "package delivery retry must return the persisted code");
  assert.equal(packageResults[0]?.redirect_uri, redirectUri);
  assert.equal(typeof packageResults[0]?.code, "string");
  assert.equal(await countIssuedRows(backend, packageDeviceCode), 1);
  await assert.rejects(
    () =>
      issueOAuthAuthorizationCodeForPackageDeviceCode(packageDeviceCode, {
        ...packageBinding,
        packageId: "gpkg_mismatch",
      }),
    NOT_RECOVERABLE
  );
}

test("SQLite authorization-code delivery is CAS-bound and recoverable", async () => {
  initDb(":memory:");
  try {
    await exerciseDelivery("sqlite");
  } finally {
    closeDb();
  }
});

test("PostgreSQL authorization-code delivery is CAS-bound and recoverable", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: "pdpp_test_oauth_code_delivery",
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      await exerciseDelivery("postgres");
    }
  );
});

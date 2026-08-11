#!/usr/bin/env node

import { createInterface } from "node:readline";
import { reconcileConnectorSummaryEvidence } from "../../server/connector-summary-evidence-engine.ts";
import { closeDb, initDb } from "../../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";

const dbPath = process.env.PDPP_SUMMARY_FAILURE_FIXTURE_DB_PATH;
const connectorInstanceId = process.env.PDPP_SUMMARY_FAILURE_FIXTURE_CONNECTOR_INSTANCE_ID;
const postgresUrl = process.env.PDPP_SUMMARY_FAILURE_FIXTURE_POSTGRES_URL;
if (!(connectorInstanceId && (dbPath || postgresUrl))) {
  throw new Error(
    "summary evidence failure fixture requires a database path or PostgreSQL URL and a connector instance"
  );
}

if (postgresUrl) {
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
} else {
  initDb(dbPath);
}
const input = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

await new Promise((resolve) => input.once("line", resolve));
try {
  const result = await reconcileConnectorSummaryEvidence([connectorInstanceId]);
  process.stdout.write(`${JSON.stringify({ result })}\n`);
  if (postgresUrl) {
    await closePostgresStorage();
  } else {
    closeDb();
  }
  process.exit(0);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  if (postgresUrl) {
    await closePostgresStorage();
  } else {
    closeDb();
  }
  process.exit(1);
}

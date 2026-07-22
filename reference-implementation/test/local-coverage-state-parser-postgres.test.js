// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL state-store proof for the coverage STATE trust boundary.
 * It persists hostile JSON through the production Postgres state store, then
 * reads it through the production coverage reader.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { expectedLocalCoverageStoreDescriptors } from "../../packages/polyfill-connectors/src/local-source-inventory.ts";
import {
	closePostgresStorage,
	initPostgresStorage,
	postgresQuery,
} from "../server/postgres-storage.js";
import { readCommittedLocalCoverageDiagnostics } from "../server/records.js";
import { createPostgresConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.js";

const POSTGRES_URL = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
const CONNECTOR_ID = "claude-code";
const INSTANCE_ID = "cin_local_coverage_state_parser_pg";
const PRIVACY_SENTINEL = "/private/local-coverage-state-parser-pg";

test("real PostgreSQL persisted private coverage STATE fails closed and does not echo the sentinel", {
	skip: !POSTGRES_URL,
}, async () => {
	await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
	try {
		await postgresQuery(
			"DELETE FROM connector_state WHERE connector_instance_id = $1",
			[INSTANCE_ID],
		);
		const expected = expectedLocalCoverageStoreDescriptors(CONNECTOR_ID);
		assert.ok(expected);
		await createPostgresConnectorStateStore().putState(
			{ connectorId: CONNECTOR_ID, connectorInstanceId: INSTANCE_ID },
			{
				coverage_diagnostics: {
					fetched_at: "2026-07-21T12:00:00.000Z",
					stores: expected.map(({ store, stream }) => ({
						store,
						stream,
						status: "inventory_only",
						secret_path: PRIVACY_SENTINEL,
					})),
				},
			},
		);

		const proof = await readCommittedLocalCoverageDiagnostics({
			connector_id: CONNECTOR_ID,
			connector_instance_id: INSTANCE_ID,
		});
		assert.equal(proof.malformed, true);
		assert.equal(proof.hasCommittedSnapshot, false);
		assert.equal(JSON.stringify(proof.rows).includes(PRIVACY_SENTINEL), false);
	} finally {
		await postgresQuery(
			"DELETE FROM connector_state WHERE connector_instance_id = $1",
			[INSTANCE_ID],
		);
		await closePostgresStorage();
	}
});

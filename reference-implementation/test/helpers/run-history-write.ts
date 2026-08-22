// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drive the REAL production run-history writer against a test backend.
 *
 * The point of routing through `writeSqliteRunHistoryForSpineEvent` /
 * `writePostgresRunHistoryForSpineEvent` rather than issuing the INSERT the
 * test would like to see is that a test which writes its own SQL proves only
 * that the test can write SQL. The defect class this program keeps finding is
 * a production writer that omits a column the design assumes — exactly what
 * `owner_epoch` was — and only the production writer can be wrong about that.
 */

import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../../server/postgres-storage.ts";
import {
  type RunHistorySpineEvent,
  writePostgresRunHistoryForSpineEvent,
  writeSqliteRunHistoryForSpineEvent,
} from "../../server/stores/run-history-writer.ts";
import type { RunLifecycleBackend } from "./run-lifecycle-backends.ts";

export interface RunHistoryWriteInput {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly data: Record<string, unknown>;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly status: string;
}

export async function writeRunHistoryForTest(backend: RunLifecycleBackend, input: RunHistoryWriteInput): Promise<void> {
  const event: RunHistorySpineEvent = {
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId,
    data: input.data,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    runId: input.runId,
    status: input.status,
  };

  if (backend.name === "postgres") {
    await withPostgresTransaction(async (client: PoolClient) => {
      await writePostgresRunHistoryForSpineEvent(client, event);
    });
    return;
  }
  writeSqliteRunHistoryForSpineEvent(event);
}

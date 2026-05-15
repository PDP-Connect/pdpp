import { exec, referenceQueries } from "../../lib/db.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

export interface SourceWebhookEventClaim {
  readonly sourceId: string;
  readonly eventId: string;
  readonly bodyHash: string;
  readonly receivedAt: string;
}

export interface SourceWebhookEventStore {
  claimEvent(event: SourceWebhookEventClaim): boolean | Promise<boolean>;
}

export function createSqliteSourceWebhookEventStore(): SourceWebhookEventStore {
  return {
    claimEvent({ sourceId, eventId, bodyHash, receivedAt }) {
      return exec(referenceQueries.sourceWebhooksClaimEvent, [sourceId, eventId, bodyHash, receivedAt]).changes === 1;
    },
  };
}

export function createPostgresSourceWebhookEventStore(): SourceWebhookEventStore {
  return {
    async claimEvent({ sourceId, eventId, bodyHash, receivedAt }) {
      const result = await postgresQuery(
        `INSERT INTO source_webhook_events(source_id, event_id, body_hash, received_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(source_id, event_id) DO NOTHING`,
        [sourceId, eventId, bodyHash, receivedAt],
      );
      return result.rowCount === 1;
    },
  };
}

export function createSourceWebhookEventStore(): SourceWebhookEventStore {
  return isPostgresStorageBackend()
    ? createPostgresSourceWebhookEventStore()
    : createSqliteSourceWebhookEventStore();
}

let defaultStore: SourceWebhookEventStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultSourceWebhookEventStore(): SourceWebhookEventStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createSourceWebhookEventStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}

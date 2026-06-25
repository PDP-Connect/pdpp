#!/usr/bin/env node

/**
 * slack-message-state-seed
 *
 * Owner/operator-only repair tool that seeds Slack's partition-aware messages
 * cursor from already-retained PDPP records. This is needed when older Slack
 * connector runs used only a workspace-global `messages.last_ts`: retained
 * records can prove that a channel was collected before, but the connector
 * state has no `observed_channel_ids` or `channel_last_ts` for the next run to
 * compare against the current slackdump archive inventory.
 *
 * What it does:
 *   - Reads retained current Slack `messages` records for one explicit
 *     connector instance.
 *   - Computes max Slack `ts` per `channel_id`.
 *   - Merges those channel ids into `messages.observed_channel_ids`.
 *   - Merges per-channel max ts into `messages.channel_last_ts`.
 *   - Preserves existing state fields such as `archive_dir`, `fetched_at`, and
 *     global `last_ts`.
 *
 * What it does NOT do:
 *   - It does not touch Slack credentials, slackdump archives, records, or
 *     record_changes.
 *   - It does not trigger a connector run.
 *   - It does not print message text or raw record payloads.
 *
 * Safety model:
 *   - Default is dry-run. `--apply` is required to write.
 *   - Apply runs in a transaction and snapshots the prior messages state row
 *     into a backup table before writing.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *     node reference-implementation/scripts/repair/slack-message-state-seed.mjs \
 *       --connector-instance-id=cin_... [--apply]
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

const PG_IDENTIFIER_MAX = 63;
const BACKUP_TABLE_PREFIX = 'sms_seed_backup';

export function parseArgs(argv) {
  const out = { connectorInstanceId: null, apply: false, json: false };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const val = eq > 0 ? arg.slice(eq + 1) : true;
    if (key === 'connector-instance-id') out.connectorInstanceId = String(val);
    else if (key === 'apply') out.apply = true;
    else if (key === 'json') out.json = true;
  }
  return out;
}

export function validateArgs({ connectorInstanceId }) {
  if (!connectorInstanceId) return '--connector-instance-id is required';
  return null;
}

export function truncateId(value) {
  const s = String(value ?? '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

function sanitizeIdentifierToken(value, label) {
  const s = String(value ?? '');
  const cleaned = s.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

export function backupTableName({ connectorInstanceId, stamp }) {
  const cin = sanitizeIdentifierToken(connectorInstanceId, 'connector-instance-id');
  const stmp = sanitizeIdentifierToken(stamp, 'stamp');
  const hash8 = createHash('sha256')
    .update(JSON.stringify([cin, stmp]))
    .digest('hex')
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampPart = stmp.slice(0, 14);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : '';
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

function asPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function asStringRecord(value) {
  const out = {};
  for (const [key, val] of Object.entries(asPlainObject(value))) {
    if (typeof key === 'string' && key && typeof val === 'string' && val) {
      out[key] = val;
    }
  }
  return out;
}

function asStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))].sort()
    : [];
}

function maxSlackTs(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

export function mergeMessagesState(existingState, retainedChannelTs) {
  const existing = asPlainObject(existingState);
  const existingChannelLastTs = asStringRecord(existing.channel_last_ts);
  const mergedChannelLastTs = { ...existingChannelLastTs };
  for (const [channelId, ts] of Object.entries(retainedChannelTs)) {
    const next = maxSlackTs(mergedChannelLastTs[channelId], ts);
    if (next) mergedChannelLastTs[channelId] = next;
  }

  const observed = new Set([
    ...asStringArray(existing.observed_channel_ids),
    ...Object.keys(existingChannelLastTs),
    ...Object.keys(retainedChannelTs),
  ]);

  const mergedChannelGlobalMax = Object.values(mergedChannelLastTs).reduce((acc, ts) => maxSlackTs(acc, ts), null);
  const mergedLastTs = maxSlackTs(typeof existing.last_ts === 'string' ? existing.last_ts : null, mergedChannelGlobalMax);

  return {
    ...existing,
    ...(mergedLastTs ? { last_ts: mergedLastTs } : {}),
    channel_last_ts: Object.fromEntries(Object.entries(mergedChannelLastTs).sort(([a], [b]) => a.localeCompare(b))),
    observed_channel_ids: [...observed].sort(),
  };
}

async function loadRetainedChannelTs(client, connectorInstanceId) {
  const result = await client.query(
    `
    SELECT
      record_json->>'channel_id' AS channel_id,
      MAX(COALESCE(NULLIF(record_json->>'ts', ''), NULLIF(split_part(record_key, ':', 2), ''))) AS max_ts,
      COUNT(*)::bigint AS record_count
    FROM records
    WHERE connector_instance_id = $1
      AND connector_id = 'slack'
      AND stream = 'messages'
      AND deleted = false
      AND COALESCE(record_json->>'channel_id', '') != ''
    GROUP BY record_json->>'channel_id'
    ORDER BY record_json->>'channel_id'
    `,
    [connectorInstanceId]
  );
  const retainedChannelTs = {};
  let retainedMessageCount = 0;
  for (const row of result.rows) {
    if (row.channel_id && row.max_ts) {
      retainedChannelTs[row.channel_id] = row.max_ts;
      retainedMessageCount += Number(row.record_count ?? 0);
    }
  }
  return { retainedChannelTs, retainedMessageCount };
}

async function loadExistingMessagesState(client, connectorInstanceId) {
  const result = await client.query(
    `
    SELECT state_json
    FROM connector_state
    WHERE connector_instance_id = $1
      AND connector_id = 'slack'
      AND stream = 'messages'
    `,
    [connectorInstanceId]
  );
  return result.rows[0]?.state_json ?? {};
}

async function writeMessagesState(client, connectorInstanceId, stateJson) {
  const now = new Date().toISOString();
  await client.query(
    `
    INSERT INTO connector_state (connector_instance_id, connector_id, stream, state_json, updated_at)
    VALUES ($1, 'slack', 'messages', $2::jsonb, $3)
    ON CONFLICT (connector_instance_id, stream)
    DO UPDATE SET
      connector_id = EXCLUDED.connector_id,
      state_json = EXCLUDED.state_json,
      updated_at = EXCLUDED.updated_at
    `,
    [connectorInstanceId, JSON.stringify(stateJson), now]
  );
}

async function createBackup(client, connectorInstanceId, tableName) {
  await client.query(`CREATE TABLE ${tableName} AS SELECT * FROM connector_state WHERE false`);
  await client.query(
    `
    INSERT INTO ${tableName}
    SELECT *
    FROM connector_state
    WHERE connector_instance_id = $1
      AND connector_id = 'slack'
      AND stream = 'messages'
    `,
    [connectorInstanceId]
  );
}

function summarize({ connectorInstanceId, existingState, nextState, retainedChannelTs, retainedMessageCount, apply, backupTable }) {
  const existingObserved = new Set([
    ...asStringArray(existingState.observed_channel_ids),
    ...Object.keys(asStringRecord(existingState.channel_last_ts)),
  ]);
  const nextObserved = asStringArray(nextState.observed_channel_ids);
  const addedObservedCount = nextObserved.filter((id) => !existingObserved.has(id)).length;
  return {
    action: apply ? 'applied' : 'dry_run',
    connector_instance_id: truncateId(connectorInstanceId),
    retained_message_count: retainedMessageCount,
    retained_channel_count: Object.keys(retainedChannelTs).length,
    existing_observed_channel_count: existingObserved.size,
    next_observed_channel_count: nextObserved.length,
    added_observed_channel_count: addedObservedCount,
    channel_last_ts_count: Object.keys(asStringRecord(nextState.channel_last_ts)).length,
    backup_table: backupTable ?? null,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const usageError = validateArgs(args);
  if (usageError) {
    console.error(usageError);
    process.exit(2);
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error('PDPP_DATABASE_URL is required');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let summary;
  try {
    const { retainedChannelTs, retainedMessageCount } = await loadRetainedChannelTs(client, args.connectorInstanceId);
    const existingState = await loadExistingMessagesState(client, args.connectorInstanceId);
    const nextState = mergeMessagesState(existingState, retainedChannelTs);
    let backupTable = null;
    if (args.apply) {
      const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      backupTable = backupTableName({ connectorInstanceId: args.connectorInstanceId, stamp });
      await client.query('BEGIN');
      try {
        await createBackup(client, args.connectorInstanceId, backupTable);
        await writeMessagesState(client, args.connectorInstanceId, nextState);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    summary = summarize({
      connectorInstanceId: args.connectorInstanceId,
      existingState,
      nextState,
      retainedChannelTs,
      retainedMessageCount,
      apply: args.apply,
      backupTable,
    });
  } finally {
    client.release();
    await pool.end();
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const [key, value] of Object.entries(summary)) {
      console.log(`${key}=${String(value)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    const message = String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
    console.error(message);
    process.exit(1);
  });
}

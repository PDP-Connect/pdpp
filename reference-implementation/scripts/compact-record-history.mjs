#!/usr/bin/env node

/**
 * compact-record-history
 *
 * Owner/operator-only operational tool that compacts provably-redundant
 * adjacent historical `record_changes` rows under a per-stream
 * fingerprint policy that either mirrors the connector's own
 * no-op-emit definition or treats the canonical stable-JSON of
 * `record_json` itself as the fingerprint.
 *
 * Scope is deny-by-default. Two policy families are eligible:
 *
 *   1. "Connector fingerprint mirror" — streams whose connectors
 *      ship a semantic fingerprint cursor (a08d7a0a, 47ec8edd, 228305a6).
 *      The script's `excludeKeys` mirrors the connector's:
 *        - gmail / threads
 *        - gmail / labels      (fingerprint over the stored body; the
 *                               connector's synthetic keying `id` is not
 *                               stored, so excludeKeys is empty)
 *        - slack / workspace   (fingerprint excludes `fetched_at`)
 *        - slack / users
 *        - slack / files
 *        - slack / channel_memberships (excludes `fetched_at`; real
 *                               membership identity channel_id/user_id
 *                               preserved as a fingerprint boundary)
 *        - ynab  / payee_locations
 *        - ynab  / budgets     (excludes `last_month`,`last_modified_on`)
 *        - usaa  / statements  (excludes `fetched_at`)
 *        - chase / accounts    (excludes `fetched_at`)
 *        - usaa  / accounts    (excludes `fetched_at`; real balance_cents
 *                               is preserved as a fingerprint boundary)
 *        - usaa  / credit_card_billing (excludes `fetched_at`; real
 *                               balances/rewards/APRs preserved as boundaries)
 *
 *   2. "Exact stable-JSON identity" — local-device connectors
 *      (codex, claude-code) whose record bodies are derived from
 *      on-disk JSONL / sqlite without volatile fields in the record
 *      payload itself (no `fetched_at` in `record_json`, timestamps
 *      come from the underlying source event, mtimes are gated at the
 *      file walker layer rather than included in the record).
 *      Adjacent versions with byte-identical canonical JSON are
 *      provably redundant under the connector's own emit semantics —
 *      a re-emitted row that matches a prior row is, by construction,
 *      either an idempotent re-write of the same source event or an
 *      mtime-gate miss. Compacting it removes nothing the connector
 *      would consider a meaningful version transition.
 *        - codex      / messages, function_calls, sessions, skills, prompts, rules
 *        - claude-code / messages, attachments, sessions, skills,
 *                        memory_notes, slash_commands
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP
 * route, no scheduler, no automatic background job.
 *
 * Default is dry-run. Use --apply to actually delete redundant rows.
 *
 * Apply safety:
 *   - Per-run backup table `compact_record_history_backup_<runId>` is
 *     created and populated with every row to be deleted, INSIDE the
 *     same transaction as the DELETE. The table persists after commit
 *     as the operator's rollback handle.
 *   - Insert/delete row counts are asserted equal before commit; any
 *     mismatch rolls the transaction back.
 *
 * Usage:
 *   node reference-implementation/scripts/compact-record-history.mjs \
 *     --connector-instance-id=cin_... \
 *     --stream=threads \
 *     [--connector-id=gmail] \
 *     [--limit-keys=<positive-int>] \
 *     [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

const { Pool } = pg;

// ─── Policy registry ────────────────────────────────────────────────────

/**
 * A compaction policy declares the per-stream fingerprint definition the
 * connector uses to decide whether a freshly-emitted record is "the same
 * record" as its prior version. This script mirrors that definition
 * one-for-one so a "removable historical version" classification here
 * matches the connector's "no-op emit" classification.
 *
 * Adding a new entry here is a code-review gate. The policy must
 * reference an existing connector-side fingerprint helper.
 *
 *   - `connectorId`: the connector_id column value the policy applies to.
 *   - `stream`: the stream column value the policy applies to.
 *   - `excludeKeys`: payload keys excluded from the fingerprint. Mirrors
 *     the connector's `excludeKeys` argument to its own fingerprint
 *     helper. Slack `workspace` excludes `fetched_at` because the
 *     connector excludes it (a08d7a0a — without exclusion the connector
 *     gate would never fire and the 31k-version workspace churn would
 *     not stop).
 *   - `connectorSource`: the connector file the policy mirrors. Pure
 *     documentation; not consumed at runtime.
 */
export const COMPACTION_POLICIES = [
  {
    connectorIds: ['gmail', 'https://registry.pdpp.org/connectors/gmail'],
    stream: 'threads',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/gmail/parsers.ts:buildThreadFingerprint → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'workspace',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/index.ts:FINGERPRINT_EXCLUDE.workspace (["fetched_at"]) → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'users',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/index.ts:FINGERPRINT_EXCLUDE.users ([]) → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'files',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/index.ts:FINGERPRINT_EXCLUDE.files ([]) → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `channel_memberships` record body is `{id, channel_id, user_id,
    // fetched_at}`. The per-run `fetched_at: nowIso()` forced a brand-new
    // version of every membership on every slackdump pass, and the stream
    // grew into the single largest churn stream by absolute history volume
    // for a membership set that barely moves. The connector now gates emit
    // through the per-record fingerprint cursor with
    // excludeFromFingerprint ["fetched_at"] (FINGERPRINTED_STREAMS now
    // includes channel_memberships); this policy mirrors that exclusion
    // one-for-one. Excluding ONLY `fetched_at` is lossless: the only other
    // fields (id, channel_id, user_id) are the membership identity itself,
    // so a membership appearing or disappearing is always a fingerprint
    // boundary that survives — only a true no-op refresh (same membership,
    // moved run clock) collapses.
    connectorIds: ['slack', 'https://registry.pdpp.org/connectors/slack'],
    stream: 'channel_memberships',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/slack/index.ts:FINGERPRINT_EXCLUDE.channel_memberships (["fetched_at"]) → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    connectorIds: ['ynab', 'https://registry.pdpp.org/connectors/ynab'],
    stream: 'payee_locations',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/ynab/index.ts:openPayeeLocationCursor → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `labels` re-emitted every IMAP mailbox unconditionally on every run
    // (~269 versions/label of byte-identical history). The connector now
    // gates emit through a per-label fingerprint cursor keyed by the label
    // `name`. The cursor keys on a synthetic `id = name` but EXCLUDES `id`
    // from the fingerprint, so the hash is computed over exactly the
    // stored record body — `{name, canonical_name, is_system,
    // parent_name, message_count}` — which contains no `id` and no
    // run-clock field. This policy therefore mirrors the connector with an
    // empty exclude set: a "removable historical version" here equals the
    // connector's own "no-op emit."
    connectorIds: ['gmail', 'https://registry.pdpp.org/connectors/gmail'],
    stream: 'labels',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/gmail/index.ts:emitLabelsStream → openFingerprintCursor({excludeFromFingerprint:["id"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical). Stored record_json has no `id`; script excludeKeys [] hashes the same body the connector hashes after stripping the synthetic keying id.',
  },
  {
    // `statements` carried a run-clock `fetched_at: nowIso()` in the
    // record body, forcing a new version of every statement on every run
    // (~15 versions/record). A statement's identity (id, account_id,
    // title, date_delivered) is immutable and its hydrated fields
    // (pdf_path/pdf_sha256/document_url) are content-addressed (the path
    // embeds the sha256 prefix), so the only field that moved was
    // `fetched_at`. The connector now gates emit through a per-statement
    // fingerprint cursor with excludeFromFingerprint ["fetched_at"]; this
    // policy mirrors that exclusion one-for-one.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'statements',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:emitStatementRecords → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `accounts` carried a run-clock `fetched_at` and ALL balance fields
    // hardcoded `null` (balances live in the separate `balances` stream).
    // The only field that moved between runs was `fetched_at` (~20
    // versions/record of pure run-clock churn). The connector now gates
    // emit through a per-account fingerprint cursor with
    // excludeFromFingerprint ["fetched_at"]; this policy mirrors that
    // exclusion one-for-one.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'accounts',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:emitAccountsStream → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `statements` (Chase) carried a run-clock `fetched_at`. A statement's
    // identity (id = shortHash(account_reference|date_delivered|title)) is
    // immutable and its hydrated fields (document_url/pdf_path/pdf_sha256)
    // are content-addressed (the path embeds the sha256), so the only field
    // that moved between runs was `fetched_at` (~10 versions/record of pure
    // run-clock churn). The connector now gates emit through a
    // per-statement fingerprint cursor with excludeFromFingerprint
    // ["fetched_at"]; this policy mirrors that exclusion one-for-one. This
    // is the exact shape of the already-registered usaa/statements policy.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'statements',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:processStatementRow+emitStatementIndexOnly → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `transactions` (Chase) carried a run-clock `fetched_at`. A posted
    // transaction's identity (id = account_id|fitid) and its fields (date,
    // amount, name, memo, type, …) are immutable; the only field that moved
    // between runs was `fetched_at`. Because the connector re-downloads an
    // overlapping incremental QFX window every run, every already-seen
    // transaction was re-emitted with a fresh `fetched_at` (~308
    // versions/record — the worst churn stream by ratio). The connector now
    // gates emit through a per-transaction fingerprint cursor with
    // excludeFromFingerprint ["fetched_at"]; this policy mirrors that
    // exclusion one-for-one. Excluding ONLY `fetched_at` is lossless: a new
    // transaction (new id) or a real field move is always a fingerprint
    // boundary that survives; only a re-downloaded byte-identical
    // transaction (modulo the run clock) collapses.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'transactions',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:emitTransactionsForAccount → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `accounts` (USAA) carried a run-clock `fetched_at` alongside a REAL
    // point-in-time `balance_cents` scraped from the dashboard. Unlike
    // chase/accounts (all balances null), USAA's balance is real and
    // volatile — but it is NOT excluded. Excluding ONLY `fetched_at` is
    // lossless: a balance move (or name/status change) is a fingerprint
    // boundary that is always retained, so every distinct balance value
    // survives as a version boundary; only a run whose body modulo
    // `fetched_at` is byte-identical to the prior version (a true no-op
    // refresh) collapses. The connector now gates emit through a
    // per-account fingerprint cursor with excludeFromFingerprint
    // ["fetched_at"]; this policy mirrors that exclusion one-for-one.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'accounts',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:emitAccountsStream → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `credit_card_billing` carried a run-clock `fetched_at` alongside REAL
    // point-in-time financial state (current_balance_cents,
    // available_credit_cents, credit_limit_cents, cash_rewards_cents, APRs,
    // billing_status). None of those real fields are excluded. Excluding
    // ONLY `fetched_at` is lossless: any real-field move is a fingerprint
    // boundary that is always retained; only a true no-op refresh (body
    // byte-identical modulo `fetched_at`) collapses. The connector now
    // gates emit through a per-card fingerprint cursor with
    // excludeFromFingerprint ["fetched_at"]; this policy mirrors that
    // exclusion one-for-one.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'credit_card_billing',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:runCreditCardBillingStream → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `/budgets` is a full-collection refetch with no server_knowledge
    // delta, so before 8eb2a31a every run re-emitted every budget. YNAB
    // advances `last_month` on calendar rollover and `last_modified_on`
    // on any in-budget edit, neither of which changes the budget-summary
    // fields this stream projects — ~273 versions/budget accumulated in
    // the 2026-05-26 churn report. The connector now gates emit through
    // openBudgetCursor with BUDGET_FINGERPRINT_EXCLUDE = ["last_month",
    // "last_modified_on"]; this policy mirrors that exclusion one-for-one
    // so a "removable historical version" here equals the connector's own
    // "no-op emit." Historical rows from the pre-gate window differ only
    // in those two excluded fields and collapse to their fingerprint
    // boundaries.
    connectorIds: ['ynab', 'https://registry.pdpp.org/connectors/ynab'],
    stream: 'budgets',
    excludeKeys: ['last_month', 'last_modified_on'],
    connectorSource:
      'packages/polyfill-connectors/connectors/ynab/index.ts:BUDGET_FINGERPRINT_EXCLUDE (["last_month","last_modified_on"]) → openBudgetCursor → openFingerprintCursor → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `transactions` (USAA) carried a run-clock `fetched_at`. A posted
    // transaction's identity (id = hashId(accountId|date|amount|original|
    // #ord)) and its fields are immutable; the only field that moved between
    // runs was `fetched_at`. Both emit paths re-surfaced the same
    // transaction every run — the CSV-export path re-downloads an
    // overlapping incremental date window, and the PDF-statement parse
    // re-parses the same statement PDFs. The connector now gates BOTH paths
    // through one shared per-transaction fingerprint cursor with
    // excludeFromFingerprint ["fetched_at"]; this policy mirrors that
    // exclusion one-for-one. Excluding ONLY `fetched_at` is lossless: a new
    // transaction (new id), a corrected amount (new tuple → new id), or a
    // real field move (e.g. balance_after_cents) is always a fingerprint
    // boundary that survives; only a re-surfaced byte-identical transaction
    // (modulo the run clock) collapses.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'transactions',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:emitCsvTransactions+processPdfStatementRow → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `inbox_messages` (USAA) carried a run-clock `fetched_at`. A message's
    // identity (id = hashId(date_short|preview[:120])) and its body are
    // immutable until its read/unread status flips, but the inbox page is
    // re-scraped in full every run, so every still-listed message was
    // re-emitted with a fresh `fetched_at`. The connector now gates emit
    // through a per-message fingerprint cursor with excludeFromFingerprint
    // ["fetched_at"]; this policy mirrors that exclusion one-for-one.
    // Excluding ONLY `fetched_at` is lossless: a read → unread (or unread →
    // read) status flip is a fingerprint boundary that survives; only a
    // byte-identical re-scrape (modulo the run clock) collapses.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'inbox_messages',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:runInboxStream → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `current_activity` (Chase) carried a run-clock `fetched_at`. The
    // dashboard overview re-renders the same recent rows every run; a row
    // keyed by a stable `ui_transaction_id` is otherwise immutable until it
    // transitions pending → posted, so the only field that moved between
    // byte-identical runs was `fetched_at`. The connector now gates emit
    // through a per-row fingerprint cursor with excludeFromFingerprint
    // ["fetched_at"]; this policy mirrors that exclusion one-for-one.
    // Excluding ONLY `fetched_at` is lossless: a pending → posted transition
    // (status/posted_date/amount move) on a stable id is a fingerprint
    // boundary that survives, and a fallback-keyed row whose fields change
    // gets a new id and appends as a distinct row; only a byte-identical
    // re-render (modulo the run clock) collapses.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'current_activity',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:emitCurrentActivityForAccount → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `orders` (Amazon) carried a run-clock `fetched_at`. An order's
    // identity (id = order id) is immutable and its total is fixed once
    // placed, but the current (unfrozen) year is re-scraped every run and
    // re-emitted with a fresh `fetched_at`. Year-freezing already bounds the
    // blast radius to recent years; this gate removes the per-run re-emit
    // within that window. The connector now gates emit through a per-order
    // fingerprint cursor with excludeFromFingerprint ["fetched_at"]; this
    // policy mirrors that exclusion one-for-one. Excluding ONLY `fetched_at`
    // is lossless: a new order (new id) or a real field move
    // (delivery_status / status_detail transitioning while the order ships)
    // is always a fingerprint boundary that survives; only a re-scraped
    // byte-identical order (modulo the run clock) collapses. `order_items`
    // carries no `fetched_at` and has no registered policy.
    connectorIds: ['amazon', 'https://registry.pdpp.org/connectors/amazon'],
    stream: 'orders',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/amazon/index.ts:emitOrderAndItems → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },

  // ─── Exact stable-JSON identity family ────────────────────────────────
  //
  // Codex and Claude Code emit records from local on-disk source events
  // (JSONL rollouts, sqlite threads, markdown files). Record payloads do
  // not contain a `fetched_at` timestamp; volatile state (file mtimes,
  // run timestamps) is kept in STATE cursors, not in the record body.
  // Adjacent versions whose `record_json` is byte-identical under the
  // canonical stable-stringify therefore represent re-emits of the same
  // source event — never a real source transition the user would
  // consider "the record changed."
  //
  // Per-stream notes:
  //
  //   codex/messages, codex/function_calls
  //     Record fields are pulled from rollout JSONL response_items;
  //     `timestamp` is the original event timestamp from the file
  //     (immutable), `id` is `${session_id}:${line_count}` (stable
  //     across re-parses of the same line). Re-emits happen only when
  //     `mtime` changes; identical adjacent versions mean the same
  //     line was re-emitted with the same parse output.
  //   codex/sessions
  //     Has a connector-side fingerprint cursor (af1700ad) that should
  //     stop *new* churn. Historical inflation predates the cursor.
  //     Stable-JSON identity is a strict superset of "no real change":
  //     when adjacent versions have identical JSON, no field moved.
  //   codex/skills, codex/prompts, codex/rules
  //     Records carry `mtime_epoch` (seconds, floor(mtimeMs/1000)).
  //     Every full-scan emit re-stamps the file unless content changes.
  //     Adjacent identical JSON = mtime unchanged AND content unchanged.
  //   claude-code/messages, claude-code/attachments
  //     Like Codex, fields come from JSONL line events; `timestamp` is
  //     from the source line (or, for `tool_result_file` attachments,
  //     from the file mtime — but those re-emit only on mtime change,
  //     so adjacent identical JSON still means no real change).
  //   claude-code/sessions
  //     Aggregated per-session record. `last_event_at` widens to the
  //     observed max; `message_count` is a running tally. Adjacent
  //     identical JSON means the aggregate didn't move.
  //   claude-code/memory_notes, claude-code/skills, claude-code/slash_commands
  //     Local markdown/JSON files with `mtime_epoch` (seconds) in the
  //     payload. Adjacent identical JSON = file content didn't change.
  //
  // `connector_id` values in the live database for these connectors
  // are `codex` and `claude-code` (hyphen, not underscore). Multi-device
  // local-collector deployments use `local-device:codex` and
  // `local-device:claude-code`; both forms are covered by each policy.
  ...buildLocalDeviceExactJsonPolicies('codex', [
    'messages',
    'function_calls',
    'sessions',
    'skills',
    'prompts',
    'rules',
  ]),
  ...buildLocalDeviceExactJsonPolicies('claude-code', [
    'messages',
    'attachments',
    'sessions',
    'skills',
    'memory_notes',
    'slash_commands',
  ], 'claude_code'),
];

function buildLocalDeviceExactJsonPolicies(connector, streams, dirName = connector) {
  return streams.map((stream) => ({
    connectorIds: [connector, `local-device:${connector}`],
    stream,
    excludeKeys: [],
    connectorSource:
      `packages/polyfill-connectors/connectors/${dirName}/ — exact stable-JSON identity ` +
      `(no fetched_at in record_json; record payload derived from immutable source events ` +
      `and/or mtime-gated file emits)`,
  }));
}

export function findPolicy(connectorId, stream) {
  return (
    COMPACTION_POLICIES.find(
      (p) => p.connectorIds.includes(connectorId) && p.stream === stream,
    ) || null
  );
}

export function describePolicies() {
  return COMPACTION_POLICIES.map(
    (p) =>
      `  - ${p.connectorIds[0]}/${p.stream}${p.excludeKeys.length ? ` (excludes ${p.excludeKeys.join(',')})` : ''}`,
  ).join('\n');
}

// ─── Fingerprint helper ─────────────────────────────────────────────────

/**
 * Stable per-record fingerprint. Byte-for-byte parity with
 * `packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint`
 * — the canonical authoring-layer helper Slack/Gmail/Codex/YNAB cursors
 * call when deciding whether a freshly-derived record is a no-op emit.
 *
 * Parity matters: this script's "removable historical version"
 * classification must equal the connector's "no-op emit" classification
 * for the same payload. The parity is asserted by
 * `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`,
 * which compares this implementation against the shared helper across
 * representative fixtures for every registered policy. Drift between
 * the two implementations fails that test loudly.
 *
 * Reimplemented here (instead of imported) because this is a Node `.mjs`
 * operational tool and the canonical helper is TypeScript inside a
 * different workspace package — importing it would couple this tool to
 * either a build artifact or a runtime TS shim. The parity test is the
 * substitute for the import.
 *
 * `excludeKeys` are removed at every level the stringifier visits, so
 * adding a future policy that excludes a key appearing at nested levels
 * (e.g. a `fetched_at` shoved into a nested envelope) is consistent
 * with the canonical helper's semantics.
 */
export function recordFingerprint(record, excludeKeys = []) {
  const exclude = new Set(excludeKeys);
  const canonical = stableStringify(record, exclude);
  return createHash('sha1').update(canonical).digest('hex');
}

function stableStringify(value, exclude) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, exclude)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([k]) => !exclude.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, exclude)}`).join(',')}}`;
}

// ─── Retention selector ─────────────────────────────────────────────────

/**
 * Decide which `record_changes` versions are safe to remove.
 *
 * `rows` is an array of `{ version, record_json, deleted }` sorted by
 * `version` ascending. `currentVersion` is the version of the same key
 * in `records`. `policy` provides `excludeKeys`.
 *
 * Retention rules (design.md §Retention rule):
 *
 *   - never remove `currentVersion`;
 *   - never remove a tombstone (`deleted = true`);
 *   - never remove the first version for the key;
 *   - never remove the most recent prior version whose fingerprint
 *     differs from the current row's fingerprint;
 *   - a tombstone bounds compaction — a non-tombstone whose
 *     immediately-prior surviving row is a tombstone is retained even
 *     if a same-fingerprint non-tombstone exists further back;
 *   - otherwise remove a non-tombstone whose immediately-prior
 *     surviving row is a non-tombstone with the same fingerprint.
 *
 * Returns an array of versions (numbers) that may be removed.
 */
export function selectRemovableVersions(rows, currentVersion, policy) {
  if (!rows.length) return [];

  const excludeKeys = policy.excludeKeys || [];

  // Pre-compute fingerprints once per row.
  const enriched = rows.map((r) => ({
    version: Number(r.version),
    deleted: !!r.deleted,
    fingerprint: r.deleted ? TOMBSTONE_FP : recordFingerprint(r.record_json || {}, excludeKeys),
  }));

  // Locate the current row's fingerprint (if present); used to retain the
  // most recent prior version with a different fingerprint.
  const currentRow = enriched.find((r) => r.version === Number(currentVersion));
  const currentFingerprint = currentRow ? currentRow.fingerprint : null;

  // Identify "the most recent prior row whose fingerprint differs from
  // the current row's fingerprint" — must be retained.
  let mostRecentDifferingPrior = null;
  if (currentRow) {
    for (let i = enriched.length - 1; i >= 0; i--) {
      const r = enriched[i];
      if (r.version >= currentRow.version) continue;
      if (r.fingerprint !== currentFingerprint) {
        mostRecentDifferingPrior = r.version;
        break;
      }
    }
  }

  const removable = [];

  // Walk ascending. `prevSurviving` is the prior row that survives — the
  // last one we did not mark removable. A tombstone is always a
  // surviving row.
  let prevSurviving = null;
  for (let i = 0; i < enriched.length; i++) {
    const row = enriched[i];

    // Hard pins: first row, current row, tombstone, most-recent-differing-prior.
    if (i === 0) {
      prevSurviving = row;
      continue;
    }
    if (row.version === Number(currentVersion)) {
      prevSurviving = row;
      continue;
    }
    if (row.deleted) {
      prevSurviving = row;
      continue;
    }
    if (row.version === mostRecentDifferingPrior) {
      prevSurviving = row;
      continue;
    }

    // Tombstones bound compaction — if the immediate predecessor is a
    // tombstone, this row marks a real resurrection and must be retained.
    if (prevSurviving && prevSurviving.deleted) {
      prevSurviving = row;
      continue;
    }

    // Same-fingerprint adjacent non-tombstone: removable.
    if (prevSurviving && prevSurviving.fingerprint === row.fingerprint) {
      removable.push(row.version);
      // prevSurviving does not change — the surviving anchor stays.
      continue;
    }

    // Otherwise, retain.
    prevSurviving = row;
  }

  return removable;
}

const TOMBSTONE_FP = '__tombstone__';

// ─── Argv parsing ───────────────────────────────────────────────────────

/**
 * Parse `--limit-keys`. Returns `null` if unset, a positive integer if
 * valid, or the sentinel string `'invalid'` if the value is present but
 * not a positive integer. The CLI rejects `'invalid'` early.
 */
export function parseLimitKeys(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return 'invalid';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 'invalid';
  return n;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

// ─── Compaction loop ────────────────────────────────────────────────────

export async function planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys }) {
  // Fetch the current row versions (and connector_id, for consistency).
  const limitClause = limitKeys ? `LIMIT ${Number(limitKeys)}` : '';
  const current = await pool.query(
    `SELECT connector_id, record_key, version
       FROM records
      WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
      ORDER BY record_key
      ${limitClause}`,
    [connectorInstanceId, stream],
  );

  let scannedKeys = 0;
  let scannedVersions = 0;
  const removableByKey = new Map();
  let removedBytesEstimate = 0;
  const connectorIdsSeen = new Set();

  for (const row of current.rows) {
    scannedKeys += 1;
    connectorIdsSeen.add(row.connector_id);
    const history = await pool.query(
      `SELECT version, record_json, deleted, octet_length(record_json::text) AS payload_bytes
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
        ORDER BY version ASC`,
      [connectorInstanceId, stream, row.record_key],
    );
    scannedVersions += history.rows.length;
    const removable = selectRemovableVersions(history.rows, row.version, policy);
    if (removable.length) {
      removableByKey.set(row.record_key, removable);
      const removableSet = new Set(removable.map(Number));
      for (const h of history.rows) {
        if (removableSet.has(Number(h.version))) {
          removedBytesEstimate += Number(h.payload_bytes || 0);
        }
      }
    }
  }

  const removableVersions = Array.from(removableByKey.values()).reduce(
    (n, arr) => n + arr.length,
    0,
  );

  return {
    connectorInstanceId,
    stream,
    scannedKeys,
    scannedVersions,
    removableVersions,
    retainedVersionsAfter: scannedVersions - removableVersions,
    estimatedRemovedBytes: removedBytesEstimate,
    removableByKey,
    connectorIdsSeen: Array.from(connectorIdsSeen),
  };
}

export async function applyCompaction({ pool, plan, runId }) {
  if (!plan.removableVersions) {
    return { runId, backupTable: null, deleted: 0, inserted: 0 };
  }

  const backupTable = `compact_record_history_backup_${runId}`;
  // Create backup table once per run, shared across (connector_instance_id, stream).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(backupTable)} (
       connector_id TEXT NOT NULL,
       connector_instance_id TEXT NOT NULL,
       stream TEXT NOT NULL,
       record_key TEXT NOT NULL,
       version BIGINT NOT NULL,
       record_json JSONB,
       emitted_at TEXT NOT NULL,
       deleted BOOLEAN NOT NULL,
       deleted_at TEXT,
       compacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const client = await pool.connect();
  let inserted = 0;
  let deleted = 0;
  try {
    await client.query('BEGIN');

    for (const [recordKey, versions] of plan.removableByKey) {
      const versionsAsNumbers = versions.map(Number);
      const insertRes = await client.query(
        `INSERT INTO ${quoteIdent(backupTable)}
           (connector_id, connector_instance_id, stream, record_key, version,
            record_json, emitted_at, deleted, deleted_at)
         SELECT connector_id, connector_instance_id, stream, record_key, version,
                record_json, emitted_at, deleted, deleted_at
           FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
            AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers],
      );
      const deleteRes = await client.query(
        `DELETE FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
             AND version = ANY($4::bigint[])`,
        [plan.connectorInstanceId, plan.stream, recordKey, versionsAsNumbers],
      );
      if (insertRes.rowCount !== versionsAsNumbers.length) {
        throw new Error(
          `backup insert count mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: expected ${versionsAsNumbers.length}, got ${insertRes.rowCount}`,
        );
      }
      if (deleteRes.rowCount !== insertRes.rowCount) {
        throw new Error(
          `delete/backup mismatch for ${plan.connectorInstanceId}/${plan.stream}/${recordKey}: backed up ${insertRes.rowCount}, deleted ${deleteRes.rowCount}`,
        );
      }
      inserted += insertRes.rowCount;
      deleted += deleteRes.rowCount;
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }

  return { runId, backupTable, deleted, inserted };
}

/**
 * Mark the retained-size projection dirty for the scope. We deliberately
 * keep this in a separate post-commit step rather than inside the
 * compaction transaction so a dirty-marker failure can never roll back
 * a successful compaction.
 */
export async function markScopeDirty({ pool, connectorInstanceId, stream }) {
  try {
    await pool.query(
      `UPDATE retained_size_stream
          SET dirty = 1
        WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    await pool.query(
      `UPDATE retained_size_connection
          SET dirty = 1
        WHERE connector_instance_id = $1`,
      [connectorInstanceId],
    );
    await pool.query(
      `UPDATE retained_size_global SET dirty = 1`,
    );
  } catch {
    // Dirty marker failure is non-fatal — the projection will be marked
    // dirty by the next bulk write or the next rebuild will detect drift.
  }
}

// Quote an identifier (table/column) for safe interpolation. The backup
// table name is composed from a generated runId, but we still defend
// against any future caller passing user input.
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// ─── CLI entry point ────────────────────────────────────────────────────

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const connectorInstanceId = args['connector-instance-id'];
  const stream = args.stream;
  const explicitConnectorId = args['connector-id'] || null;
  const limitKeys = parseLimitKeys(args['limit-keys']);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL ||
    process.env.PDPP_TEST_POSTGRES_URL ||
    null;

  if (!connectorInstanceId || !stream) {
    console.error(
      'usage: compact-record-history --connector-instance-id=<id> --stream=<name> [--connector-id=<id>] [--limit-keys=N] [--apply]',
    );
    process.exit(2);
  }
  if (limitKeys === 'invalid') {
    console.error('--limit-keys must be a positive integer');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error(
      'PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access',
    );
    process.exit(2);
  }

  // Resolve connector_id if not supplied: look it up from connector_instances.
  let connectorId = explicitConnectorId;
  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    if (!connectorId) {
      const r = await pool.query(
        `SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      if (!r.rows.length) {
        console.error(
          `connector_instance_id "${connectorInstanceId}" not found and --connector-id was not supplied`,
        );
        process.exit(2);
      }
      connectorId = r.rows[0].connector_id;
    }

    const policy = findPolicy(connectorId, stream);
    if (!policy) {
      console.error(
        `no compaction policy registered for connector_id="${connectorId}" stream="${stream}".\nRegistered policies:\n${describePolicies()}`,
      );
      process.exit(2);
    }

    const plan = await planCompaction({
      pool,
      connectorInstanceId,
      stream,
      policy,
      limitKeys,
    });

    printPlan({ plan, apply });

    if (apply && plan.removableVersions > 0) {
      const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const result = await applyCompaction({ pool, plan, runId });
      await markScopeDirty({
        pool,
        connectorInstanceId,
        stream,
      });
      console.log(
        `APPLIED: deleted ${result.deleted} row(s), backed up into "${result.backupTable}". retained_size_stream marked dirty for ${connectorInstanceId}/${stream}.`,
      );
    } else if (apply) {
      console.log('APPLIED: nothing to delete.');
    }
  } catch (err) {
    console.error('compact-record-history failed:', err && err.message ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}

function printPlan({ plan, apply }) {
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(
    `compact-record-history: ${mode} — ${plan.connectorInstanceId}/${plan.stream}`,
  );
  console.log(`  connector_id(s) seen: ${plan.connectorIdsSeen.join(', ') || '(none)'}`);
  console.log(`  scannedKeys:           ${plan.scannedKeys}`);
  console.log(`  scannedVersions:       ${plan.scannedVersions}`);
  console.log(`  removableVersions:     ${plan.removableVersions}`);
  console.log(`  retainedVersionsAfter: ${plan.retainedVersionsAfter}`);
  console.log(`  estimatedRemovedBytes: ${plan.estimatedRemovedBytes}`);
}

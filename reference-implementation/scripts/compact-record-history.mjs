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
 *   3. "Inventory churn gate" — local-device `inventory_only`/`defer`
 *      stores (codex, claude-code) whose metadata records carry the
 *      volatile `mtime_epoch`/`size_bytes` file-stat fields. The
 *      connector gates these streams with an inventory fingerprint
 *      cursor that excludes exactly those two keys, so an unchanged
 *      store does not re-version on a pure mtime/size tick. This policy
 *      excludes the same two keys; the inventory meaning (path, type,
 *      classification, reason) stays a fingerprint boundary.
 *        - claude-code / backup_inventory, cache_inventory,
 *                        config_inventory, file_history
 *        - codex       / history, session_index, shell_snapshots,
 *                        config_inventory, cache_inventory, logs
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (or `PDPP_TEST_POSTGRES_URL`). There is no HTTP
 * route, no scheduler, no automatic background job.
 *
 * Default is dry-run. Use --apply to actually delete redundant rows.
 *
 * Modes (--mode, default `audit`):
 *   - audit     — conservative retention (first observation + current +
 *                 most-recent-differing-prior per key); the only behavior for
 *                 every stream unless canonical is explicitly requested.
 *   - canonical — opt-in stronger convergence for streams whose policy declares
 *                 `changeModel: "immutable_semantic"` and
 *                 `representativePolicy: "current"`. Lowers the same-fingerprint
 *                 retention floor to ONE survivor per semantic run (the current
 *                 `records.version` row wins its run); preserves every distinct
 *                 canonical fingerprint boundary, tombstone, and resurrection
 *                 boundary; never renumbers. Refuses (fails closed) for any
 *                 ineligible policy. First and only eligible stream this slice:
 *                 chase/transactions.
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
 *   - `resolveExcludeKeys` (optional): a per-record function `(record) =>
 *     string[]` that computes the exclusion list for each individual record.
 *     Takes precedence over `excludeKeys` when present. Used by content-gated
 *     streams (PDF statements) whose exclusion depends on whether the record
 *     carries a positive content fingerprint. Must mirror the connector-side
 *     `resolveExcludeFromFingerprint` exactly so a "removable historical
 *     version" classification matches the connector's "no-op emit".
 *   - `connectorSource`: the connector file the policy mirrors. Pure
 *     documentation; not consumed at runtime.
 *   - `changeModel` (optional): the per-stream change model. Only
 *     `'immutable_semantic'` opts a stream into canonical mode — it asserts
 *     that, after the policy exclusions, a record's semantic body never moves
 *     (every same-key history differs only on excluded run/acquisition
 *     metadata). Absent (the default) means the stream is audit-only.
 *   - `representativePolicy` (optional): which row survives a same-fingerprint
 *     run under canonical mode. Only `'current'` is supported in this slice —
 *     the `records.version` row wins (authoritative-current-wins), so canonical
 *     apply never rewrites the `records` table. Absent means audit-only.
 *
 * Canonical mode (mode === 'canonical') is legal ONLY for a policy with both
 * `changeModel: 'immutable_semantic'` and `representativePolicy: 'current'`.
 * Any other policy fails closed (see `assertCanonicalEligible`). Default mode
 * is `'audit'`, which ignores both fields and keeps its existing conservative
 * retention for every policy.
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
    // fingerprint cursor with resolveExcludeFromFingerprint; this policy
    // mirrors that content-gated rule one-for-one:
    //   - both content fields present → exclude blob/acquisition-identity
    //     fields + run clock (lossless: positive content signal remains);
    //   - either absent → exclude only `fetched_at` (conservative fallback).
    // Canonical mode enabled: statements are immutable_semantic once
    // content fields are present; blob churn is the only field movement.
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'statements',
    excludeKeys: ['fetched_at'],
    resolveExcludeKeys: (record) => {
      const textSha = record.pdf_text_sha256;
      const pageCount = record.pdf_page_count;
      return typeof textSha === 'string' && textSha.length > 0 &&
        typeof pageCount === 'number' && pageCount > 0
        ? ['pdf_sha256', 'pdf_path', 'document_url', 'fetched_at']
        : ['fetched_at'];
    },
    changeModel: 'immutable_semantic',
    representativePolicy: 'current',
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:emitStatementRecords → openFingerprintCursor({resolveExcludeFromFingerprint:statementFingerprintExcludeKeys}) → src/statement-content-fingerprint.ts:statementFingerprintExcludeKeys (canonical)',
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
    // are content-addressed (path embeds sha256), and Chase re-encrypts the
    // PDF per download so pdf_sha256/pdf_path/document_url churn with no
    // content change. The connector now gates emit through a per-statement
    // fingerprint cursor with resolveExcludeFromFingerprint; this policy
    // mirrors that content-gated rule one-for-one:
    //   - both content fields present → exclude blob/acquisition-identity
    //     fields + run clock (lossless: positive content signal remains);
    //   - either absent → exclude only `fetched_at` (conservative fallback).
    // Canonical mode enabled: RC4 re-encryption churn is the only movement
    // once content fields are present.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'statements',
    excludeKeys: ['fetched_at'],
    resolveExcludeKeys: (record) => {
      const textSha = record.pdf_text_sha256;
      const pageCount = record.pdf_page_count;
      return typeof textSha === 'string' && textSha.length > 0 &&
        typeof pageCount === 'number' && pageCount > 0
        ? ['pdf_sha256', 'pdf_path', 'document_url', 'fetched_at']
        : ['fetched_at'];
    },
    changeModel: 'immutable_semantic',
    representativePolicy: 'current',
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:processStatementRow+emitStatementIndexOnly → openFingerprintCursor({resolveExcludeFromFingerprint:statementFingerprintExcludeKeys}) → src/statement-content-fingerprint.ts:statementFingerprintExcludeKeys (canonical)',
  },
  {
    // `transactions` (Chase) carried a run-clock `fetched_at`. A posted
    // transaction's identity (id = account_id|fitid) and its fields (date,
    // amount, name, memo, type, …) are immutable; the only field that moved
    // between runs was `fetched_at`. Because the connector re-downloads an
    // overlapping incremental QFX window every run, every already-seen
    // transaction was re-emitted with a fresh `fetched_at` (~308
    // versions/record — the worst churn stream by ratio). Later live review
    // also found acquisition-mode `source` flapping
    // (`qfx_download_all_*` ↔ `qfx_download_since_last_statement_*`) for the
    // same QFX transaction. The connector now gates emit through a
    // per-transaction fingerprint cursor with excludeFromFingerprint
    // ["fetched_at", "source"]; this policy mirrors that exclusion
    // one-for-one. Excluding only run/acquisition metadata is lossless: a new
    // transaction (new id) or a real field move is always a fingerprint
    // boundary that survives; only a re-downloaded byte-identical transaction
    // modulo those metadata fields collapses.
    //
    // CANONICAL OPT-IN (canonicalize-retained-record-history): chase/transactions
    // is the first — and, in this slice, only — stream eligible for canonical
    // mode. A posted Chase transaction is immutable once it posts: its identity
    // (id = account_id|fitid) and its real fields never move, so the same-key
    // history can only differ on the excluded run/acquisition metadata
    // (`fetched_at`, `source`). The copied-data proof shows every current Chase
    // transaction has exactly one semantic version after that exclusion
    // (1145/1145 keys, max 1 semantic version per key — see
    // tmp/workstreams/chase-transaction-immutable-ratio-20260605.md). That
    // single-semantic-version property is what makes
    // `changeModel: 'immutable_semantic'` legal here and is asserted by the
    // convergence regression test. `representativePolicy: 'current'` keeps the
    // `records.version` row as the survivor for the current same-fingerprint
    // run (the authoritative-current-wins CDC choice), which avoids any
    // `records`-table rewrite in this slice.
    connectorIds: ['chase', 'https://registry.pdpp.org/connectors/chase'],
    stream: 'transactions',
    excludeKeys: ['fetched_at', 'source'],
    changeModel: 'immutable_semantic',
    representativePolicy: 'current',
    connectorSource:
      'packages/polyfill-connectors/connectors/chase/index.ts:emitTransactionsForAccount → openFingerprintCursor({excludeFromFingerprint:["fetched_at","source"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `accounts` (USAA) post-split carries identity/settings only
    // (`id`, `type`, `name`, `last_four`, `status`) plus the run-clock
    // `fetched_at`. The point-in-time `balance_cents` /
    // `available_balance_cents` moved to the append-keyed `account_stats`
    // observation stream (split-usaa-account-balance-observation-streams), so
    // the entity body no longer carries a sampled metric — it is now the same
    // shape as chase/accounts (identity + run clock). Excluding ONLY
    // `fetched_at` is lossless: an identity/status change is a fingerprint
    // boundary that is always retained; only a run whose body modulo
    // `fetched_at` is byte-identical to the prior version (a true no-op
    // refresh) collapses. The connector gates emit through a per-account
    // fingerprint cursor with excludeFromFingerprint ["fetched_at"]; this
    // policy mirrors that exclusion one-for-one. (Pre-split history rows that
    // still differ on a real `balance_cents` value remain distinct
    // fingerprints and are never collapsed — they are retained until the owner
    // decides whether that pre-split residue is worth migrating into
    // `account_stats`; the forward gate is correct regardless.)
    connectorIds: ['usaa', 'https://registry.pdpp.org/connectors/usaa'],
    stream: 'accounts',
    excludeKeys: ['fetched_at'],
    connectorSource:
      'packages/polyfill-connectors/connectors/usaa/index.ts:emitAccountsStream → openFingerprintCursor({excludeFromFingerprint:["fetched_at"]}) → src/fingerprint-cursor.ts:recordFingerprint (canonical)',
  },
  {
    // `credit_card_billing` post-split carries the stable card identity and
    // settings (`id`, `account_id`, `account_nickname`, `credit_limit_cents`,
    // `annual_percent_rate`, `cash_advance_apr`, `card_holders`) plus the
    // run-clock `fetched_at`. The volatile per-cycle metrics
    // (`current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`,
    // `billing_status`, `minimum_payment_met`) moved to the append-keyed
    // `credit_card_billing_stats` observation stream
    // (split-usaa-account-balance-observation-streams). The settings fields
    // that remain are real semantic state (a credit-limit increase or an APR
    // change is a legitimate, low-rate version) and are NOT excluded.
    // Excluding ONLY `fetched_at` is lossless: any settings move is a
    // fingerprint boundary that is always retained; only a true no-op refresh
    // (body byte-identical modulo `fetched_at`) collapses. The connector gates
    // emit through a per-card fingerprint cursor with excludeFromFingerprint
    // ["fetched_at"]; this policy mirrors that exclusion one-for-one.
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

  {
    // `custom_instructions` re-emitted the single full custom-instructions
    // body (`/user_system_messages`) on every run. The record carries a stable
    // synthetic id (`user_custom_instructions`) and NO run-clock field —
    // `updated_at` is the source's own edit timestamp, not a fetch clock — so
    // every run that found the instructions unchanged produced a byte-identical
    // new version (the dashboard's custom_instructions churn was 100%
    // byte-identical no-op re-emit). The connector now gates emit through a
    // per-record fingerprint cursor over the whole body
    // (excludeFromFingerprint []); this policy mirrors that with an empty
    // exclude set, so a "removable historical version" here equals the
    // connector's own "no-op emit." A real instructions edit moves the body
    // hash and is always retained as a fingerprint boundary.
    connectorIds: ['chatgpt', 'https://registry.pdpp.org/connectors/chatgpt'],
    stream: 'custom_instructions',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/chatgpt/index.ts:runCustomInstructionsStream → openFingerprintCursor() (excludeFromFingerprint []) → src/fingerprint-cursor.ts:recordFingerprint (canonical). Stored record_json is the full builder body (incl. id); script excludeKeys [] hashes the same body.',
  },
  {
    // `shared_conversations` is re-listed in full every run and each still-
    // present share was re-emitted with a byte-identical body — the record
    // carries a stable share id and NO run-clock field (`created_at` is the
    // source's share-creation time), so the dashboard's shared_conversations
    // churn was 100% byte-identical no-op re-emit. The connector now gates emit
    // through a per-record fingerprint cursor over the whole body
    // (excludeFromFingerprint []) and prunes stale ids after a clean full pass;
    // this policy mirrors that with an empty exclude set. A new share (new id)
    // or a changed title/visibility moves the body hash and is always retained
    // as a fingerprint boundary; only a byte-identical re-list collapses.
    connectorIds: ['chatgpt', 'https://registry.pdpp.org/connectors/chatgpt'],
    stream: 'shared_conversations',
    excludeKeys: [],
    connectorSource:
      'packages/polyfill-connectors/connectors/chatgpt/index.ts:runSharedConversationsStream → openFingerprintCursor() (excludeFromFingerprint []) → src/fingerprint-cursor.ts:recordFingerprint (canonical). Stored record_json is the full builder body (incl. id); script excludeKeys [] hashes the same body.',
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

  // ─── Inventory churn-gate family ──────────────────────────────────────
  //
  // `inventory_only`/`defer` stores emit a metadata record (path, type,
  // privacy classification, reason) whose purpose is the local-agent-collector
  // completeness contract — NOT a freshness time-series. The `mtime_epoch` and
  // `size_bytes` file-stat fields tick on every normal tool write and would
  // re-version an otherwise-unchanged inventory record on every run. The
  // connectors now gate these streams with an `openInventoryFingerprintCursor`
  // that excludes exactly those two keys
  // (packages/polyfill-connectors/src/local-source-inventory.ts:
  //  INVENTORY_FINGERPRINT_EXCLUDE_KEYS). This policy mirrors that exclusion
  // one-for-one so a "removable historical version" classification here equals
  // the connector's "no-op emit" classification. Real inventory transitions
  // (type, path_hash, classification, reason) stay inside the fingerprint and
  // are preserved as version boundaries. Inventory enumeration is a full scan,
  // so these are full-scan policies (a disappeared store re-emits on return).
  ...buildInventoryChurnGatePolicies('claude-code', [
    'backup_inventory',
    'cache_inventory',
    'config_inventory',
    'file_history',
  ], 'claude_code'),
  ...buildInventoryChurnGatePolicies('codex', [
    'history',
    'session_index',
    'shell_snapshots',
    'config_inventory',
    'cache_inventory',
    'logs',
  ]),
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

function buildInventoryChurnGatePolicies(connector, streams, dirName = connector) {
  return streams.map((stream) => ({
    connectorIds: [connector, `local-device:${connector}`],
    stream,
    excludeKeys: ['mtime_epoch', 'size_bytes'],
    connectorSource:
      `packages/polyfill-connectors/connectors/${dirName}/ + src/local-source-inventory.ts ` +
      `— inventory churn gate (openInventoryFingerprintCursor excludes mtime_epoch,size_bytes; ` +
      `inventory meaning = path/type/classification/reason)`,
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
      `  - ${p.connectorIds[0]}/${p.stream}${p.excludeKeys.length ? ` (excludes ${p.excludeKeys.join(',')})` : ''}${isCanonicalEligible(p) ? ' [canonical-eligible]' : ''}`,
  ).join('\n');
}

// ─── Canonical-mode eligibility ─────────────────────────────────────────

/** The only supported values for the canonical-mode policy fields. A policy
 *  is canonical-eligible iff it declares BOTH, exactly. */
export const CANONICAL_CHANGE_MODEL = 'immutable_semantic';
export const CANONICAL_REPRESENTATIVE_POLICY = 'current';

/** The two compaction modes. `audit` is the default and keeps the existing
 *  conservative retention; `canonical` lowers the same-fingerprint floor to one
 *  survivor per semantic run and is gated by `isCanonicalEligible`. */
export const COMPACTION_MODES = ['audit', 'canonical'];

/**
 * Parse `--mode`. Returns `'audit'` when unset (the default), the validated
 * mode string when it is one of COMPACTION_MODES, or the sentinel string
 * `'invalid'` when present but not a recognized mode. The CLI rejects
 * `'invalid'` early.
 */
export function parseMode(raw) {
  if (raw == null || raw === '') return 'audit';
  if (typeof raw === 'boolean') return 'invalid';
  return COMPACTION_MODES.includes(raw) ? raw : 'invalid';
}

/**
 * Whether a policy opts into canonical mode. True ONLY when the policy declares
 * BOTH `changeModel: 'immutable_semantic'` and `representativePolicy: 'current'`.
 * A missing or any-other value fails closed (returns false). Pure.
 */
export function isCanonicalEligible(policy) {
  return (
    !!policy &&
    policy.changeModel === CANONICAL_CHANGE_MODEL &&
    policy.representativePolicy === CANONICAL_REPRESENTATIVE_POLICY
  );
}

/** List the canonical-eligible policies for operator error messages. */
export function describeCanonicalEligible() {
  const eligible = COMPACTION_POLICIES.filter(isCanonicalEligible);
  if (!eligible.length) return '  (none)';
  return eligible.map((p) => `  - ${p.connectorIds[0]}/${p.stream}`).join('\n');
}

/**
 * Fail-closed gate for a canonical apply/plan. Throws a descriptive Error when
 * the policy is not canonical-eligible so the caller refuses the canonical run
 * instead of deleting retained versions. No-op when eligible.
 */
export function assertCanonicalEligible(policy, connectorId, stream) {
  if (isCanonicalEligible(policy)) return;
  const have = policy
    ? `changeModel=${JSON.stringify(policy.changeModel ?? null)}, representativePolicy=${JSON.stringify(policy.representativePolicy ?? null)}`
    : 'no registered policy';
  throw new Error(
    `canonical mode refused for connector_id="${connectorId}" stream="${stream}": ` +
      `canonical compaction requires changeModel="${CANONICAL_CHANGE_MODEL}" and ` +
      `representativePolicy="${CANONICAL_REPRESENTATIVE_POLICY}" (have: ${have}). ` +
      `Run without --mode=canonical to use conservative audit-mode retention.`,
  );
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
 * in `records`. `policy` provides `excludeKeys`. `mode` is `'audit'`
 * (the default) or `'canonical'`.
 *
 * AUDIT mode (default — design.md §Retention rule, unchanged):
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
 * CANONICAL mode (canonicalize-retained-record-history — opt-in, eligible
 * policies only; the caller MUST have already passed `assertCanonicalEligible`):
 *
 *   - keep exactly ONE survivor per maximal same-fingerprint run, where a run
 *     is bounded by a tombstone or by a fingerprint change;
 *   - the survivor for the run that contains `currentVersion` is the current
 *     row itself (authoritative-current-wins); for every other run the survivor
 *     is that run's first (lowest-version) row, which preserves the distinct
 *     canonical fingerprint boundary;
 *   - never remove `currentVersion`;
 *   - never remove a tombstone;
 *   - the resurrection boundary — the first non-tombstone immediately after a
 *     tombstone — is a HARD survivor (pinned even when it shares the current
 *     run's fingerprint and the current row is later in that run), so a
 *     tombstone→resurrection transition is never collapsed away;
 *   - surviving versions are never renumbered.
 *
 * The canonical floor is strictly lower than audit's: audit additionally pins
 * the key's first row and the most-recent-differing-prior even when they share
 * the current fingerprint, so an immutable same-fingerprint key keeps {first,
 * current} under audit but {current} under canonical.
 *
 * Returns an array of versions (numbers) that may be removed.
 */
export function selectRemovableVersions(rows, currentVersion, policy, mode = 'audit') {
  if (!rows.length) return [];

  const staticExcludeKeys = policy.excludeKeys || [];
  const resolveExcludeKeys = policy.resolveExcludeKeys;

  // Pre-compute fingerprints once per row.
  const enriched = rows.map((r) => ({
    version: Number(r.version),
    deleted: !!r.deleted,
    fingerprint: r.deleted
      ? TOMBSTONE_FP
      : recordFingerprint(
          r.record_json || {},
          resolveExcludeKeys ? resolveExcludeKeys(r.record_json || {}) : staticExcludeKeys,
        ),
  }));

  if (mode === 'canonical') {
    return selectRemovableVersionsCanonical(enriched, Number(currentVersion));
  }

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

/**
 * Canonical-mode selector. `enriched` is the per-row `{version, deleted,
 * fingerprint}` array sorted ascending (tombstones carry TOMBSTONE_FP).
 * `currentVersion` is the `records.version` for the key.
 *
 * Keeps one survivor per maximal same-fingerprint run (a run is broken by a
 * fingerprint change OR a tombstone). The survivor is the current row when the
 * current row is in the run; otherwise the run's first row — so every distinct
 * fingerprint boundary, every tombstone, and every resurrection boundary
 * survives, while redundant same-fingerprint duplicates (including the key's
 * first row when it shares the current run's fingerprint) are removed.
 *
 * The first non-tombstone immediately after a tombstone is additionally pinned
 * as a HARD survivor (it can never be displaced by a later current row in the
 * same run), so a tombstone→resurrection transition is preserved exactly.
 */
function selectRemovableVersionsCanonical(enriched, currentVersion) {
  const removable = [];

  let runFingerprint = null; // fingerprint of the run currently open
  let runSurvivor = null; // the version chosen to survive the open run
  let runHasCurrent = false; // whether the open run contains the current row
  let runSurvivorPinned = false; // survivor is a hard pin (resurrection boundary)
  let afterTombstone = false; // the next non-tombstone is a resurrection boundary

  for (const row of enriched) {
    // A tombstone is its own boundary: it always survives and closes any open
    // run. The next non-tombstone is the resurrection boundary and starts a
    // fresh, hard-pinned run, so it can never be collapsed into a survivor.
    if (row.deleted) {
      runFingerprint = null;
      runSurvivor = null;
      runHasCurrent = false;
      runSurvivorPinned = false;
      afterTombstone = true;
      continue;
    }

    const isCurrent = row.version === currentVersion;

    // New run: different fingerprint from the open run (or no open run, e.g.
    // the first row or the row right after a tombstone). This row is the run's
    // boundary survivor by default. A run that opens right after a tombstone is
    // a resurrection boundary and is pinned (never displaced by a later
    // current row in the same run).
    if (runSurvivor === null || row.fingerprint !== runFingerprint) {
      runFingerprint = row.fingerprint;
      runSurvivor = row.version;
      runHasCurrent = isCurrent;
      runSurvivorPinned = afterTombstone;
      afterTombstone = false;
      continue;
    }

    // Continuation of the same-fingerprint run. One of {prior survivor, this
    // row} must be removed so the run keeps exactly one survivor, UNLESS the
    // run's survivor is a pinned resurrection boundary — then both the boundary
    // and the current row survive and only the in-between duplicates drop.
    if (isCurrent) {
      if (runSurvivorPinned) {
        // The resurrection boundary stays pinned; the current row also survives
        // (it is never removable). Nothing to push.
        runHasCurrent = true;
      } else {
        // Current wins the run: drop the previously-chosen survivor, keep current.
        if (!runHasCurrent) {
          removable.push(runSurvivor);
        }
        runSurvivor = row.version;
        runHasCurrent = true;
      }
    } else {
      // Redundant duplicate within the run: remove it, keep the existing
      // survivor (the run's first row / pinned boundary, or the current row if
      // already seen — current is never displaced).
      removable.push(row.version);
    }
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

export async function planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys, mode = 'audit' }) {
  // Canonical mode is deny-by-default: refuse before any planning when the
  // policy is not explicitly eligible, so an ineligible stream can never have
  // its retained versions selected for canonical deletion.
  if (mode === 'canonical') {
    assertCanonicalEligible(policy, policy?.connectorIds?.[0] ?? null, stream);
  }

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
    const removable = selectRemovableVersions(history.rows, row.version, policy, mode);
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
    mode,
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
  const mode = parseMode(args.mode);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL ||
    process.env.PDPP_TEST_POSTGRES_URL ||
    null;

  if (!connectorInstanceId || !stream) {
    console.error(
      'usage: compact-record-history --connector-instance-id=<id> --stream=<name> [--connector-id=<id>] [--mode=audit|canonical] [--limit-keys=N] [--apply]',
    );
    process.exit(2);
  }
  if (limitKeys === 'invalid') {
    console.error('--limit-keys must be a positive integer');
    process.exit(2);
  }
  if (mode === 'invalid') {
    console.error(`--mode must be one of: ${COMPACTION_MODES.join('|')} (default audit)`);
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

    // Canonical mode is deny-by-default: refuse here (before opening any plan)
    // when the policy is not explicitly canonical-eligible. This is the
    // fail-closed gate the spec's "Ineligible stream fails closed" scenario
    // requires — an ineligible stream never reaches the destructive path.
    if (mode === 'canonical' && !isCanonicalEligible(policy)) {
      console.error(
        `canonical mode refused for connector_id="${connectorId}" stream="${stream}": ` +
          `canonical compaction requires changeModel="${CANONICAL_CHANGE_MODEL}" and ` +
          `representativePolicy="${CANONICAL_REPRESENTATIVE_POLICY}".\n` +
          `Canonical-eligible streams:\n${describeCanonicalEligible()}\n` +
          `Run without --mode=canonical to use conservative audit-mode retention.`,
      );
      process.exit(2);
    }

    const plan = await planCompaction({
      pool,
      connectorInstanceId,
      stream,
      policy,
      limitKeys,
      mode,
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
        `APPLIED [${mode} mode]: deleted ${result.deleted} row(s), backed up into "${result.backupTable}". retained_size_stream marked dirty for ${connectorInstanceId}/${stream}.`,
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
  const action = apply ? 'APPLY' : 'DRY-RUN';
  console.log(
    `compact-record-history: ${action} [${plan.mode || 'audit'} mode] — ${plan.connectorInstanceId}/${plan.stream}`,
  );
  console.log(`  connector_id(s) seen: ${plan.connectorIdsSeen.join(', ') || '(none)'}`);
  console.log(`  scannedKeys:           ${plan.scannedKeys}`);
  console.log(`  scannedVersions:       ${plan.scannedVersions}`);
  console.log(`  removableVersions:     ${plan.removableVersions}`);
  console.log(`  retainedVersionsAfter: ${plan.retainedVersionsAfter}`);
  console.log(`  estimatedRemovedBytes: ${plan.estimatedRemovedBytes}`);
}

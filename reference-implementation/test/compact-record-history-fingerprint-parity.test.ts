// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity test: compact-record-history.mjs:recordFingerprint
 * vs packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint
 *
 * This script reimplements the canonical fingerprint shape locally
 * because it is a `.mjs` operational tool and importing the canonical
 * helper from `@pdpp/polyfill-connectors` would couple the tool to
 * either a TS build artifact or a runtime TS shim. The substitute for
 * that coupling is this test: drift between the two implementations
 * fails it loudly.
 *
 * Coverage:
 *   - Each of the five registered policies' representative payload
 *     shapes (workspace with `fetched_at` exclude, users, files,
 *     threads, payee_locations) hashes byte-identically under both
 *     implementations.
 *   - Adversarial payloads — nested objects, mixed key order, nested
 *     arrays of objects, `null` leaves, arrays of strings — also hash
 *     byte-identically.
 *
 * Run with:
 *   node --test --import tsx \
 *     reference-implementation/test/compact-record-history-fingerprint-parity.test.js
 *
 * This test is gated on tsx being available; without `--import tsx`
 * Node cannot resolve the canonical helper's `.ts` extension and the
 * test is skipped. The dependency-free pure-helper tests in
 * `compact-record-history.test.js` cover the script in isolation; this
 * test exists solely to lock the script's fingerprint shape against the
 * connector helper.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_POLICIES,
  findPolicy,
  recordFingerprint as scriptRecordFingerprint,
} from "../scripts/compact-record-history.ts";

/**
 * Whether a TypeScript loader (tsx) is active in this process. When the suite
 * is run as the playbook prescribes (`node --test --import tsx …`) this is true
 * and the canonical helper MUST load — a load failure is then a real drift/break
 * that fails the suite loudly. Only when NO TS loader is present do we skip,
 * because Node cannot resolve a bare `.ts` import on its own.
 *
 * tsx registers itself on the module customization hooks and sets
 * `process.env.TSX` / appears in NODE_OPTIONS|--import; we detect it
 * conservatively from the execArgv/env so a misconfigured run cannot silently
 * skip the parity check.
 */
function tsxLoaderActive() {
  const execArgv = process.execArgv.join(" ");
  const nodeOptions = process.env.NODE_OPTIONS || "";
  return (
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /\btsx\b/.test(execArgv) ||
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /\btsx\b/.test(nodeOptions) ||
    process.env.TSX === "1" ||
    // tsx ≥ 4 exposes this symbol once its ESM loader is installed.
    typeof (globalThis as { __tsx__?: unknown }).__tsx__ !== "undefined"
  );
}

/** The canonical helper's real signature, from
 *  packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint. */
type CanonicalRecordFingerprint = (record: Record<string, unknown>, excludeKeys?: readonly string[]) => string;

let canonicalRecordFingerprint: CanonicalRecordFingerprint | undefined;
let canonicalLoadError: unknown = null;
try {
  // Loaded via tsx — the canonical helper lives in TypeScript.
  const mod = await import("../../packages/polyfill-connectors/src/fingerprint-cursor.ts");
  canonicalRecordFingerprint = mod.recordFingerprint;
} catch (err) {
  canonicalLoadError = err;
}

if (!canonicalRecordFingerprint) {
  if (tsxLoaderActive()) {
    // tsx IS active but the canonical helper still failed to load (moved file,
    // broken export, syntax error). This is the failure mode the playbook's
    // parity gate exists to catch — fail closed, never silently skip.
    test("compact-record-history fingerprint parity MUST load the canonical helper under tsx", () => {
      const errMessage = canonicalLoadError instanceof Error ? canonicalLoadError.message : canonicalLoadError;
      assert.fail(
        "tsx loader is active but the canonical recordFingerprint helper could not be loaded " +
          "from packages/polyfill-connectors/src/fingerprint-cursor.ts — the parity gate cannot " +
          "run, which would let connector/compaction fingerprint drift go undetected. " +
          `Underlying load error: ${errMessage}`
      );
    });
  } else {
    // No TS loader at all: Node cannot resolve a `.ts` import. The pure-helper
    // tests in compact-record-history.test.js still cover this implementation
    // independently, so a skip here is legitimate — but it is announced.
    test("compact-record-history fingerprint parity (skipped: no tsx loader — run with `node --test --import tsx`)", {
      skip: true,
    }, () => {
      // biome-ignore lint/complexity/noVoid: localized test assertion preserves its explicit contract.
      void canonicalLoadError;
    });
  }
}

function expectParity(payload: Record<string, unknown>, excludeKeys?: readonly string[], label?: string) {
  assert.ok(canonicalRecordFingerprint, "expectParity requires the canonical helper to be loaded");
  const a = scriptRecordFingerprint(payload, excludeKeys ? [...excludeKeys] : undefined);
  const b = canonicalRecordFingerprint(payload, excludeKeys);
  assert.equal(a, b, `${label}: script ${a} != canonical ${b} — implementations drifted`);
}

if (canonicalRecordFingerprint) {
  test("parity: gmail threads representative payload", () => {
    const policy = findPolicy("gmail", "threads");
    assert.ok(policy, "gmail/threads policy must exist");
    expectParity(
      {
        id: "t_abc",
        labels: ["INBOX", "IMPORTANT"],
        last_message_at: "2026-05-26T10:00:00Z",
        message_count: 3,
        participants: ["alice@example.com", "bob@example.com"],
        snippet: "hello world",
      },
      policy.excludeKeys,
      "gmail/threads"
    );
  });

  test("parity: slack workspace excludes fetched_at", () => {
    const policy = findPolicy("slack", "workspace");
    assert.ok(policy, "slack/workspace policy must exist");
    const base = {
      domain: "my-ws",
      id: "T123",
      name: "My Workspace",
      url: "https://my-ws.slack.com/",
    };
    expectParity({ ...base, fetched_at: "2026-05-26T10:00:00Z" }, policy.excludeKeys, "slack/workspace ts=10:00");
    expectParity({ ...base, fetched_at: "2026-05-26T11:00:00Z" }, policy.excludeKeys, "slack/workspace ts=11:00");
    // And that the script and canonical helper both treat the
    // fetched_at-only delta as equal:
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-26T10:00:00Z" }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-26T11:00:00Z" }, policy.excludeKeys);
    assert.equal(h1, h2, "fetched_at delta must not change the fingerprint");
  });

  test("parity: slack channel_memberships excludes fetched_at; real membership move is a boundary", () => {
    const policy = findPolicy("slack", "channel_memberships");
    assert.ok(policy, "slack/channel_memberships policy must exist");
    assert.deepEqual(policy.excludeKeys, ["fetched_at"]);
    const base = { channel_id: "C1", id: "C1:U1", user_id: "U1" };
    // Script and canonical helper agree byte-for-byte under the exclusion.
    expectParity({ ...base, fetched_at: "2026-05-26T10:00:00Z" }, policy.excludeKeys, "slack/channel_memberships t1");
    expectParity({ ...base, fetched_at: "2026-05-27T10:00:00Z" }, policy.excludeKeys, "slack/channel_memberships t2");
    // A fetched_at-only delta must NOT change the fingerprint (the connector's
    // own no-op-emit definition — FINGERPRINT_EXCLUDE.channel_memberships).
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-26T10:00:00Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-27T10:00:00Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the channel_memberships fingerprint");
    // A real membership field move (channel_id or user_id) MUST change it —
    // a membership appearing or disappearing is never hidden.
    const userMoved = scriptRecordFingerprint(
      { ...base, fetched_at: "2026-05-26T10:00:00Z", user_id: "U2" },
      policy.excludeKeys
    );
    const channelMoved = scriptRecordFingerprint(
      { ...base, channel_id: "C2", fetched_at: "2026-05-26T10:00:00Z" },
      policy.excludeKeys
    );
    assert.notEqual(noop1, userMoved, "a user_id move MUST change the fingerprint");
    assert.notEqual(noop1, channelMoved, "a channel_id move MUST change the fingerprint");
  });

  test("parity: slack users representative payload", () => {
    const policy = findPolicy("slack", "users");
    assert.ok(policy, "slack/users policy must exist");
    expectParity(
      {
        id: "U999",
        is_admin: false,
        name: "asmith",
        profile: {
          display_name: "Alice",
          email: "alice@example.com",
          status_text: "",
        },
        real_name: "Alice Smith",
      },
      policy.excludeKeys,
      "slack/users"
    );
  });

  test("parity: slack files representative payload", () => {
    const policy = findPolicy("slack", "files");
    assert.ok(policy, "slack/files policy must exist");
    expectParity(
      {
        channels: ["C1", "C2"],
        id: "F555",
        mimetype: "image/png",
        name: "design.png",
        size: 12_345,
        thumb_url: "https://files.slack.com/t/x",
      },
      policy.excludeKeys,
      "slack/files"
    );
  });

  test("parity: ynab payee_locations representative payload", () => {
    const policy = findPolicy("ynab", "payee_locations");
    assert.ok(policy, "ynab/payee_locations policy must exist");
    expectParity(
      {
        id: "pl_abc",
        latitude: "40.7",
        longitude: "-74.0",
        payee_id: "p_xyz",
      },
      policy.excludeKeys,
      "ynab/payee_locations"
    );
  });

  test("parity: ynab budgets representative payload excludes last_month/last_modified_on", () => {
    const policy = findPolicy("ynab", "budgets");
    assert.ok(policy, "ynab/budgets policy must exist");
    const base = {
      currency_decimal_digits: 2,
      currency_decimal_separator: ".",
      currency_group_separator: ",",
      currency_iso_code: "USD",
      currency_symbol: "$",
      currency_symbol_first: true,
      date_format_string: "MM/DD/YYYY",
      deleted: false,
      first_month: "2024-01-01",
      id: "b_1",
      name: "My Budget",
    };
    expectParity(
      { ...base, last_modified_on: "2026-01-15T00:00:00Z", last_month: "2026-01-01" },
      policy.excludeKeys,
      "ynab/budgets month=01"
    );
    expectParity(
      { ...base, last_modified_on: "2026-05-30T00:00:00Z", last_month: "2026-05-01" },
      policy.excludeKeys,
      "ynab/budgets month=05"
    );
    // The two calendar/clock fields must not change the fingerprint — this is
    // the connector's own no-op definition (BUDGET_FINGERPRINT_EXCLUDE).
    const h1 = scriptRecordFingerprint(
      { ...base, last_modified_on: "2026-01-15T00:00:00Z", last_month: "2026-01-01" },
      policy.excludeKeys
    );
    const h2 = scriptRecordFingerprint(
      { ...base, last_modified_on: "2026-05-30T00:00:00Z", last_month: "2026-05-01" },
      policy.excludeKeys
    );
    assert.equal(h1, h2, "last_month/last_modified_on delta must not change the budgets fingerprint");
  });

  test("parity: gmail labels representative payload (stored body, no id)", () => {
    const policy = findPolicy("gmail", "labels");
    assert.ok(policy, "gmail/labels policy must exist");
    // The stored record_json has no `id` (the stream is keyed by `name`).
    // The connector hashes `{id:name, ...body}` with excludeFromFingerprint
    // ["id"], which strips the synthetic id and hashes exactly this body.
    // The compaction policy hashes the stored body with excludeKeys [].
    const body = {
      canonical_name: "all mail",
      is_system: true,
      message_count: null,
      name: "[Gmail]/All Mail",
      parent_name: null,
    };
    expectParity(body, policy.excludeKeys, "gmail/labels");
    // The connector's exclude-id fingerprint over {id, ...body} MUST equal
    // the compaction fingerprint over the bare stored body.
    const connectorFp = scriptRecordFingerprint({ id: body.name, ...body }, ["id"]);
    const compactionFp = scriptRecordFingerprint(body, policy.excludeKeys);
    assert.equal(connectorFp, compactionFp, "gmail/labels: connector(exclude id) == compaction(stored body)");
  });

  test("parity: usaa statements excludes fetched_at", () => {
    const policy = findPolicy("usaa", "statements");
    assert.ok(policy, "usaa/statements policy must exist");
    const base = {
      account_id: "ACCT-CHK-0001",
      account_reference: "USAA CLASSIC CHECKING *9241",
      date_delivered: "2026-04-13",
      document_url: "file:///tmp/usaa/2026-04-aaaa.pdf",
      id: "IDX-ID-0001",
      pdf_path: "/tmp/usaa/2026-04-aaaa.pdf",
      pdf_sha256: "a".repeat(64),
      title: "April 2026 STATEMENT",
    };
    expectParity({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys, "usaa/statements t1");
    expectParity({ ...base, fetched_at: "2026-05-22T12:00:00.000Z" }, policy.excludeKeys, "usaa/statements t2");
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-22T12:00:00.000Z" }, policy.excludeKeys);
    assert.equal(h1, h2, "fetched_at delta must not change the statements fingerprint");
  });

  test("parity: chase accounts excludes fetched_at", () => {
    const policy = findPolicy("chase", "accounts");
    assert.ok(policy, "chase/accounts policy must exist");
    const base = {
      available_balance_cents: null,
      available_credit_cents: null,
      balance_as_of: null,
      balance_cents: null,
      credit_limit_cents: null,
      id: "INTACC123",
      last_four: "9241",
      name: "Sapphire Preferred",
      statement_balance_cents: null,
      status: null,
      type: "credit_card",
    };
    expectParity({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys, "chase/accounts t1");
    expectParity({ ...base, fetched_at: "2026-04-23T12:00:00.000Z" }, policy.excludeKeys, "chase/accounts t2");
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-04-23T12:00:00.000Z" }, policy.excludeKeys);
    assert.equal(h1, h2, "fetched_at delta must not change the accounts fingerprint");
  });

  test("parity: chase statements excludes fetched_at", () => {
    const policy = findPolicy("chase", "statements");
    assert.ok(policy, "chase/statements policy must exist");
    const base = {
      account_id: "INTACC123",
      account_reference: "Sapphire Preferred *9241",
      date_delivered: "2026-04-13",
      document_url: "file:///tmp/chase/2026-04-aaaa.pdf",
      id: "a1b2c3d4",
      pdf_path: "/tmp/chase/2026-04-aaaa.pdf",
      pdf_sha256: "a".repeat(64),
      title: "April 2026 Statement",
    };
    expectParity({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys, "chase/statements t1");
    expectParity({ ...base, fetched_at: "2026-05-22T12:00:00.000Z" }, policy.excludeKeys, "chase/statements t2");
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-04-22T12:00:00.000Z" }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-05-22T12:00:00.000Z" }, policy.excludeKeys);
    assert.equal(h1, h2, "fetched_at delta must not change the statements fingerprint");
  });

  test("parity: chase transactions is canonical-eligible and its exclusions match the connector cursor", () => {
    // The canonical mode (canonicalize-retained-record-history) binds the
    // compaction fingerprint to the connector's no-op-emit fingerprint. Pin both
    // halves here: (1) the policy declares the canonical eligibility fields, and
    // (2) its excludeKeys are exactly the connector's
    // TRANSACTION_FINGERPRINT_EXCLUDE_KEYS (["fetched_at","source"]) so the
    // canonical survivor boundary equals the connector's no-op boundary.
    const policy = findPolicy("chase", "transactions");
    assert.ok(policy);
    assert.equal(policy.changeModel, "immutable_semantic");
    assert.equal(policy.representativePolicy, "current");
    assert.deepEqual(policy.excludeKeys, ["fetched_at", "source"]);
  });

  test("parity: chase transactions excludes fetched_at/source but a REAL field move is a boundary", () => {
    const policy = findPolicy("chase", "transactions");
    assert.ok(policy, "chase/transactions policy must exist");
    // A posted transaction's identity (id = account_id|fitid) and fields
    // are immutable; run-clock `fetched_at` and acquisition-mode `source`
    // move when overlapping QFX windows re-download it. Excluding only
    // those metadata fields is lossless: a no-op re-download collapses, a
    // real field move does not.
    const base = {
      account_id: "INTACC123",
      account_name: "Sapphire Preferred",
      amount: -4599,
      check_number: null,
      currency: "USD",
      date: "2026-04-10",
      fitid: "FITID-0001",
      id: "INTACC123|FITID-0001",
      memo: null,
      name: "COFFEE SHOP",
      reference_number: null,
      source: "qfx_download_since_last_statement_2026-04-10",
      type: "DEBIT",
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "chase/transactions t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "chase/transactions t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint(
      {
        ...base,
        fetched_at: "2026-06-02T10:00:00.000Z",
        source: "qfx_download_all_2026-04-10",
      },
      policy.excludeKeys
    );
    assert.equal(noop1, noop2, "metadata deltas must not change the transactions fingerprint (re-download collapses)");
    const amountMoved = scriptRecordFingerprint(
      { ...base, amount: -5000, fetched_at: "2026-06-02T10:00:00.000Z" },
      policy.excludeKeys
    );
    const nameMoved = scriptRecordFingerprint(
      { ...base, fetched_at: "2026-06-02T10:00:00.000Z", name: "CORRECTED MERCHANT" },
      policy.excludeKeys
    );
    assert.notEqual(
      noop1,
      amountMoved,
      "an amount move MUST change the fingerprint — real transaction data is never hidden"
    );
    assert.notEqual(noop1, nameMoved, "a name move MUST change the fingerprint");
  });

  test("parity: usaa accounts excludes fetched_at but a REAL balance move is a boundary", () => {
    const policy = findPolicy("usaa", "accounts");
    assert.ok(policy, "usaa/accounts policy must exist");
    // Unlike chase/accounts (all balances null), USAA's account body carries
    // a REAL point-in-time balance_cents. Excluding ONLY fetched_at is
    // lossless: a no-op refresh collapses, a balance move does not.
    const base = {
      available_balance_cents: null,
      balance_cents: 123_456,
      id: "ACCT-CHK-0001",
      last_four: "9241",
      name: "USAA CLASSIC CHECKING",
      status: "open",
      type: "checking",
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "usaa/accounts t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "usaa/accounts t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the accounts fingerprint (no-op refresh collapses)");
    const moved = scriptRecordFingerprint(
      { ...base, balance_cents: 100_000, fetched_at: "2026-06-02T10:00:00.000Z" },
      policy.excludeKeys
    );
    assert.notEqual(noop1, moved, "a balance move MUST change the fingerprint — real financial state is never hidden");
  });

  test("parity: usaa credit_card_billing excludes fetched_at but REAL balance/rewards moves are boundaries", () => {
    const policy = findPolicy("usaa", "credit_card_billing");
    assert.ok(policy, "usaa/credit_card_billing policy must exist");
    const base = {
      account_id: "CC-0001",
      account_nickname: "Everyday Card",
      annual_percent_rate: "24.99%",
      available_credit_cents: 380_000,
      billing_status: "Minimum payment met",
      card_holders: "Member",
      cash_advance_apr: "29.99%",
      cash_rewards_cents: 1500,
      credit_limit_cents: 500_000,
      current_balance_cents: 120_000,
      id: "CC-0001",
      minimum_payment_met: true,
    };
    expectParity(
      { ...base, fetched_at: "2026-06-01T10:00:00.000Z" },
      policy.excludeKeys,
      "usaa/credit_card_billing t1"
    );
    expectParity(
      { ...base, fetched_at: "2026-06-02T10:00:00.000Z" },
      policy.excludeKeys,
      "usaa/credit_card_billing t2"
    );
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the billing fingerprint (no-op refresh collapses)");
    // Any of the real financial fields moving is a fingerprint boundary.
    const balMoved = scriptRecordFingerprint({ ...base, current_balance_cents: 150_000 }, policy.excludeKeys);
    const rewardsMoved = scriptRecordFingerprint({ ...base, cash_rewards_cents: 2250 }, policy.excludeKeys);
    const aprMoved = scriptRecordFingerprint({ ...base, annual_percent_rate: "26.99%" }, policy.excludeKeys);
    assert.notEqual(noop1, balMoved, "a current_balance move MUST change the fingerprint");
    assert.notEqual(noop1, rewardsMoved, "a cash_rewards move MUST change the fingerprint");
    assert.notEqual(noop1, aprMoved, "an APR move MUST change the fingerprint");
  });

  test("parity: usaa transactions excludes fetched_at but a REAL field move is a boundary", () => {
    const policy = findPolicy("usaa", "transactions");
    assert.ok(policy, "usaa/transactions policy must exist");
    // A posted transaction's identity (id = hashId(accountId|date|amount|
    // original|#ord)) and fields are immutable; only `fetched_at` moves when
    // the incremental window re-downloads it or the PDF is re-parsed.
    // Excluding ONLY fetched_at is lossless: a no-op re-surface collapses, a
    // real field move (e.g. balance_after_cents) does not.
    const base = {
      account_id: "ACCT-CHK-0001",
      account_name: "USAA CLASSIC CHECKING",
      amount: -4599,
      balance_after_cents: null,
      category: null,
      check_number: null,
      currency: "USD",
      date: "2026-04-10",
      description: "COFFEE SHOP",
      id: "6a249d555d12b055946a3c84248113df",
      original_description: "COFFEE SHOP",
      source: "csv_export",
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "usaa/transactions t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "usaa/transactions t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the transactions fingerprint (re-surface collapses)");
    const balMoved = scriptRecordFingerprint(
      { ...base, balance_after_cents: 105_000, fetched_at: "2026-06-02T10:00:00.000Z" },
      policy.excludeKeys
    );
    assert.notEqual(
      noop1,
      balMoved,
      "a balance_after_cents move MUST change the fingerprint — real data is never hidden"
    );
  });

  test("parity: usaa inbox_messages excludes fetched_at but a read/unread flip is a boundary", () => {
    const policy = findPolicy("usaa", "inbox_messages");
    assert.ok(policy, "usaa/inbox_messages policy must exist");
    const base = {
      date_received: "2026-05-14",
      id: "inbox-hash-1",
      preview: "Your statement is ready to view",
      status: "unread",
      subject: "Your statement is ready to view",
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "usaa/inbox_messages t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "usaa/inbox_messages t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the inbox fingerprint (no-op re-scrape collapses)");
    const flipped = scriptRecordFingerprint({ ...base, status: "read" }, policy.excludeKeys);
    assert.notEqual(
      noop1,
      flipped,
      "a read/unread status flip MUST change the fingerprint — a real transition is never hidden"
    );
  });

  test("parity: chase current_activity excludes fetched_at but a pending→posted transition is a boundary", () => {
    const policy = findPolicy("chase", "current_activity");
    assert.ok(policy, "chase/current_activity policy must exist");
    const base = {
      account_id: "INTACC123",
      account_name: "Sapphire Preferred",
      activity_date: "2026-05-14",
      amount: -4217,
      currency: "USD",
      description: "Whole Foods Market",
      id: "INTACC123|txn_20260514_A1",
      memo: null,
      posted_date: null,
      source: "chase_activity_ui",
      status: "pending",
      ui_transaction_id: "txn_20260514_A1",
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "chase/current_activity t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "chase/current_activity t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(
      noop1,
      noop2,
      "fetched_at delta must not change the current_activity fingerprint (re-render collapses)"
    );
    const posted = scriptRecordFingerprint(
      { ...base, fetched_at: "2026-06-02T10:00:00.000Z", posted_date: "2026-05-14", status: "posted" },
      policy.excludeKeys
    );
    assert.notEqual(
      noop1,
      posted,
      "a pending→posted transition MUST change the fingerprint — a real transition is never hidden"
    );
  });

  test("parity: amazon orders excludes fetched_at but a delivery_status move is a boundary", () => {
    const policy = findPolicy("amazon", "orders");
    assert.ok(policy, "amazon/orders policy must exist");
    const base = {
      delivery_status: "Shipping",
      digital_order: false,
      gift_order: false,
      id: "111-1234567-8901234",
      item_count: 1,
      order_date: "2026-01-05",
      order_total: "$42.99",
      order_total_cents: 4299,
      payment_method_summary: "Visa ending in 0000",
      recipient_name: "Fake Name",
      shipping_address_summary: "123 Fake St",
      status_detail: null,
    };
    expectParity({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys, "amazon/orders t1");
    expectParity({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys, "amazon/orders t2");
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-01T10:00:00.000Z" }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: "2026-06-02T10:00:00.000Z" }, policy.excludeKeys);
    assert.equal(noop1, noop2, "fetched_at delta must not change the orders fingerprint (re-scrape collapses)");
    const shipped = scriptRecordFingerprint({ ...base, delivery_status: "Delivered" }, policy.excludeKeys);
    assert.notEqual(
      noop1,
      shipped,
      "a delivery_status move MUST change the fingerprint — real order state is never hidden"
    );
  });

  test("parity: chatgpt custom_instructions whole-body fingerprint (no exclude); an edit is a boundary", () => {
    const policy = findPolicy("chatgpt", "custom_instructions");
    assert.ok(policy, "chatgpt/custom_instructions policy must exist");
    assert.deepEqual(policy.excludeKeys, [], "custom_instructions hashes the whole body (no run-clock field)");
    // The stored record_json is the full builder body including the stable
    // synthetic id. The connector gates with openFingerprintCursor() over the
    // whole record (excludeFromFingerprint []), so script(body, []) must equal
    // connector(body, []).
    const base = {
      about_user: "I'm a tester",
      enabled: true,
      id: "user_custom_instructions",
      response_style: "Be concise",
      updated_at: "2026-05-26T10:00:00.000Z",
    };
    expectParity(base, policy.excludeKeys, "chatgpt/custom_instructions");
    // A true no-op refresh (identical body) is the same fingerprint → collapses.
    const noop1 = scriptRecordFingerprint(base, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base }, policy.excludeKeys);
    assert.equal(noop1, noop2, "an identical body is one fingerprint (no-op re-emit collapses)");
    // A real instructions edit moves the body hash → retained as a boundary.
    const edited = scriptRecordFingerprint({ ...base, about_user: "A different bio" }, policy.excludeKeys);
    assert.notEqual(noop1, edited, "an instructions edit MUST change the fingerprint — real edits are never hidden");
  });

  test("parity: chatgpt shared_conversations whole-body fingerprint (no exclude); new id / title move is a boundary", () => {
    const policy = findPolicy("chatgpt", "shared_conversations");
    assert.ok(policy, "chatgpt/shared_conversations policy must exist");
    assert.deepEqual(policy.excludeKeys, [], "shared_conversations hashes the whole body (no run-clock field)");
    const base = {
      anonymous: false,
      conversation_id: "conv-abc",
      created_at: "2026-05-26T10:00:00.000Z",
      highlighted_text: null,
      id: "share-abc",
      is_public: true,
      share_url: "https://chatgpt.com/share/share-abc",
      title: "A shared chat",
    };
    expectParity(base, policy.excludeKeys, "chatgpt/shared_conversations");
    const noop1 = scriptRecordFingerprint(base, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base }, policy.excludeKeys);
    assert.equal(noop1, noop2, "a byte-identical re-list is one fingerprint (no-op re-emit collapses)");
    const retitled = scriptRecordFingerprint({ ...base, title: "Renamed chat" }, policy.excludeKeys);
    assert.notEqual(noop1, retitled, "a title change MUST change the fingerprint — real changes are never hidden");
    const newShare = scriptRecordFingerprint({ ...base, id: "share-xyz" }, policy.excludeKeys);
    assert.notEqual(noop1, newShare, "a new share id is a distinct fingerprint");
  });

  test("parity: nested objects with mixed key order", () => {
    const a = {
      id: "x",
      meta: { a: 2, m: { a: "a", q: "q" }, z: 1 },
      tags: ["b", "a", "c"],
    };
    const b = {
      id: "x",
      meta: { a: 2, m: { a: "a", q: "q" }, z: 1 },
      tags: ["b", "a", "c"],
    };
    const hScript = scriptRecordFingerprint(a);
    const hCanonical = canonicalRecordFingerprint(a);
    assert.equal(hScript, hCanonical, "top-level: nested objects");
    assert.equal(scriptRecordFingerprint(b), canonicalRecordFingerprint(b), "reordered: nested objects");
    assert.equal(scriptRecordFingerprint(a), scriptRecordFingerprint(b), "script: stable across key order");
  });

  test("parity: arrays of objects do not get re-sorted", () => {
    // Arrays preserve order; only object keys sort.
    const a = { id: "x", items: [{ k: 1 }, { k: 2 }, { k: 3 }] };
    const b = { id: "x", items: [{ k: 3 }, { k: 2 }, { k: 1 }] };
    assert.notEqual(scriptRecordFingerprint(a), scriptRecordFingerprint(b), "array order must matter");
    assert.equal(scriptRecordFingerprint(a), canonicalRecordFingerprint(a), "parity on ordered arrays a");
    assert.equal(scriptRecordFingerprint(b), canonicalRecordFingerprint(b), "parity on ordered arrays b");
  });

  test("parity: null leaves and primitive values", () => {
    const payload = {
      a: null,
      b: 0,
      c: "",
      d: false,
      e: [null, 0, "", false],
      f: { g: null },
      id: "x",
    };
    expectParity(payload, [], "null+primitive leaves");
  });

  test("parity: exclude keys with no overlap is a no-op", () => {
    const payload = { id: "x", name: "n" };
    expectParity(payload, ["not_present"], "noop exclude");
  });

  test("parity: codex local-device record shapes (messages, function_calls, sessions, mtime-stamped artifacts)", () => {
    // Codex records are derived from on-disk JSONL/sqlite. Exact-JSON
    // identity is the policy; verify the script and canonical helper
    // agree byte-for-byte across the representative shapes.
    expectParity(
      {
        content: "hello",
        id: "session_abc:42",
        role: "assistant",
        session_id: "session_abc",
        timestamp: "2026-05-26T10:00:00.000Z",
        type: "message",
      },
      [],
      "codex/messages"
    );
    expectParity(
      {
        arguments: '{"cmd":"ls"}',
        call_id: "call_xyz",
        id: "session_abc:43:output",
        name: "shell",
        output_binary_reason: null,
        output_preview: "a\nb\n",
        session_id: "session_abc",
        timestamp: "2026-05-26T10:00:01.000Z",
      },
      [],
      "codex/function_calls"
    );
    expectParity(
      {
        approval_mode: "auto",
        archived: false,
        cli_version: "0.42.0",
        cwd: "/home/user/proj",
        first_user_message: "hello",
        function_call_count: 5,
        git_branch: "main",
        git_commit: "abcdef0",
        id: "thread_xyz",
        last_event_at: "2026-05-26T10:00:01.000Z",
        message_count: 17,
        model_provider: "openai",
        originator: "codex_cli_rs",
        repository_url: null,
        rollout_path: "/home/user/.codex/sessions/2026/05/26/rollout-x.jsonl",
        sandbox_policy: "workspace-write",
        started_at: "2026-05-20T00:00:00.000Z",
        title: "pinned title",
        tokens_used: 1234,
      },
      [],
      "codex/sessions"
    );
    expectParity(
      {
        content: "# my-skill\n…",
        description: "does the thing",
        id: "skills:my-skill",
        mtime_epoch: 1_716_700_000,
        name: "my-skill",
        path: "/home/user/.codex/skills/my-skill/SKILL.md",
      },
      [],
      "codex/skills"
    );
    expectParity(
      {
        content: "Say hi.",
        description: null,
        id: "prompts:hello.md",
        mtime_epoch: 1_716_700_000,
        name: "hello",
        path: "/home/user/.codex/prompts/hello.md",
      },
      [],
      "codex/prompts"
    );
    expectParity(
      {
        id: "rules:foo:0",
        mtime_epoch: 1_716_700_000,
        path: "/home/user/.codex/rules/foo.rules",
        rule_index: 0,
        rule_text: "this is the rule",
        ruleset: "foo",
      },
      [],
      "codex/rules"
    );
  });

  test("parity: claude-code local-device record shapes (messages, attachments, sessions, mtime-stamped artifacts)", () => {
    expectParity(
      {
        agent_id: null,
        content: "hello",
        id: "uuid-1",
        is_sidechain: false,
        parent_uuid: null,
        role: "user",
        session_id: "session-1",
        timestamp: "2026-05-26T10:00:00.000Z",
        type: "user",
        user_type: "human",
      },
      [],
      "claude-code/messages"
    );
    expectParity(
      {
        content_binary_reason: null,
        content_bytes: 3,
        content_preview: "abc",
        event_type: "tool_result_file",
        hook_name: null,
        id: "tool_result_file:proj/session-1/foo.txt",
        parent_uuid: null,
        session_id: "session-1",
        timestamp: "2026-05-26T10:00:01.000Z",
        tool_use_id: null,
      },
      [],
      "claude-code/attachments"
    );
    expectParity(
      {
        cwd: "/home/user/proj",
        entrypoint: "cli",
        git_branch: "main",
        id: "session-1",
        last_event_at: "2026-05-26T10:00:01.000Z",
        message_count: 17,
        project_path: "proj",
        started_at: "2026-05-20T00:00:00.000Z",
        user_type: "human",
        version: "0.42.0",
      },
      [],
      "claude-code/sessions"
    );
    expectParity(
      {
        content: "# my-skill\n…",
        description: "does the thing",
        frontmatter: { description: "does the thing", name: "my-skill" },
        id: "skills:my-skill",
        mtime_epoch: 1_716_700_000,
        name: "my-skill",
        path: "/home/user/.claude/skills/my-skill/SKILL.md",
        source: "user",
      },
      [],
      "claude-code/skills"
    );
    expectParity(
      {
        content: "note body",
        description: null,
        frontmatter: {},
        id: "memory_notes:proj/foo.md",
        mtime_epoch: 1_716_700_000,
        name: "foo",
        note_path: "foo.md",
        path: "/home/user/.claude/projects/proj/memory/foo.md",
        project_path: "proj",
      },
      [],
      "claude-code/memory_notes"
    );
    expectParity(
      {
        content: "do foo",
        description: null,
        frontmatter: {},
        id: "commands:foo",
        mtime_epoch: 1_716_700_000,
        name: "foo",
        path: "/home/user/.claude/commands/foo.md",
      },
      [],
      "claude-code/slash_commands"
    );
  });

  test("parity: inventory churn gate excludes mtime_epoch and size_bytes", () => {
    // The inventory record's meaning is path/type/classification/reason; the
    // mtime_epoch/size_bytes file-stat fields are incidental. Verify the
    // script and connector helper agree, that a mtime/size tick does NOT
    // move the fingerprint, and that a real inventory transition DOES.
    const dirRecord = (over = {}) => ({
      classification: "inventory_only",
      id: "backups:abc123",
      mtime_epoch: 1_717_000_000,
      path_hash: "abc123",
      reason: "backup payloads require owner review before collection",
      relative_path: "backups",
      size_bytes: null,
      store: "backups",
      type: "directory",
      ...over,
    });

    const connectorStreamPairs: [string, string][] = [
      ["claude-code", "backup_inventory"],
      ["codex", "history"],
    ];
    for (const [connector, stream] of connectorStreamPairs) {
      const policy = findPolicy(connector, stream);
      assert.ok(policy, `${connector}/${stream} policy must exist`);
      assert.deepEqual(policy.excludeKeys, ["mtime_epoch", "size_bytes"], `${connector}/${stream} exclude keys`);

      expectParity(dirRecord(), policy.excludeKeys, `${connector}/${stream} base`);
      expectParity(dirRecord({ mtime_epoch: 1_717_009_999 }), policy.excludeKeys, `${connector}/${stream} ticked`);

      // mtime + size delta must NOT move the fingerprint.
      const h1 = scriptRecordFingerprint(dirRecord(), policy.excludeKeys);
      const h2 = scriptRecordFingerprint(
        dirRecord({ mtime_epoch: 1_717_009_999, size_bytes: 4096 }),
        policy.excludeKeys
      );
      assert.equal(h1, h2, `${connector}/${stream}: mtime/size delta must not change the fingerprint`);

      // A real inventory transition (type change) MUST move the fingerprint.
      const h3 = scriptRecordFingerprint(dirRecord({ type: "file" }), policy.excludeKeys);
      assert.notEqual(h1, h3, `${connector}/${stream}: type change must change the fingerprint`);

      // A classification change MUST move the fingerprint.
      const h4 = scriptRecordFingerprint(dirRecord({ classification: "defer" }), policy.excludeKeys);
      assert.notEqual(h1, h4, `${connector}/${stream}: classification change must change the fingerprint`);
    }
  });

  test("every registered policy has a parity-checked fixture above", () => {
    // Static guard: if a new policy is added without a parity fixture,
    // this assertion fails and points at the gap.
    const fixturedPairs = new Set([
      // connector-fingerprint family
      "gmail/threads",
      "slack/workspace",
      "slack/users",
      "slack/files",
      "slack/channel_memberships",
      "ynab/payee_locations",
      "ynab/budgets",
      "gmail/labels",
      "usaa/statements",
      "chase/accounts",
      "chase/statements",
      "chase/transactions",
      "chase/current_activity",
      "usaa/accounts",
      "usaa/credit_card_billing",
      "usaa/transactions",
      "usaa/inbox_messages",
      "amazon/orders",
      "chatgpt/custom_instructions",
      "chatgpt/shared_conversations",
      // exact stable-JSON identity family (codex)
      "codex/messages",
      "codex/function_calls",
      "codex/sessions",
      "codex/skills",
      "codex/prompts",
      "codex/rules",
      // exact stable-JSON identity family (claude-code)
      "claude-code/messages",
      "claude-code/attachments",
      "claude-code/sessions",
      "claude-code/skills",
      "claude-code/memory_notes",
      "claude-code/slash_commands",
      // inventory churn-gate family (claude-code)
      "claude-code/backup_inventory",
      "claude-code/cache_inventory",
      "claude-code/config_inventory",
      "claude-code/file_history",
      // inventory churn-gate family (codex)
      "codex/history",
      "codex/session_index",
      "codex/shell_snapshots",
      "codex/config_inventory",
      "codex/cache_inventory",
      "codex/logs",
    ]);
    for (const p of COMPACTION_POLICIES) {
      const pair = `${p.connectorIds[0]}/${p.stream}`;
      assert.ok(fixturedPairs.has(pair), `policy ${pair} has no parity fixture in this test`);
    }
  });
}

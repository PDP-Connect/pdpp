// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailGapStartEntry, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountTransactionOutcome,
  buildServedAccountTransactionGapLookup,
  type EmitDeps,
  recoverServedAccountTransactionGaps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

function makeHarness(servedAccountTransactionGaps?: ReadonlyMap<string, string>): {
  deps: EmitDeps;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  return {
    deps: {
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      ...(servedAccountTransactionGaps ? { servedAccountTransactionGaps } : {}),
    },
    messages: harness.protocolMessages,
  };
}

function servedGap(accountId: string, gapId: string): DetailGapStartEntry {
  return {
    gap_id: gapId,
    stream: "transactions",
    status: "pending",
    reference_only: true,
    record_key: accountId,
    detail_locator: { kind: "usaa.account", account_id: accountId },
  };
}

function recoveriesOf(
  messages: readonly EmittedMessage[]
): Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }>[] {
  return messages.filter(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> =>
      message.type === "DETAIL_GAP_RECOVERED"
  );
}

test("buildServedAccountTransactionGapLookup admits only exact pending USAA account identities", () => {
  const lookup = buildServedAccountTransactionGapLookup([
    servedGap("ACCT-OK", "gap-ok"),
    {
      gap_id: "gap-foreign",
      stream: "transactions",
      status: "pending",
      detail_locator: { kind: "chase.account", account_id: "ACCT-FOREIGN" },
    },
    {
      gap_id: "gap-statement",
      stream: "statements",
      status: "pending",
      detail_locator: { kind: "usaa.account", account_id: "ACCT-STMT" },
    },
    {
      gap_id: "gap-recovered",
      stream: "transactions",
      status: "recovered",
      detail_locator: { kind: "usaa.account", account_id: "ACCT-OLD" },
    },
    {
      gap_id: "gap-mismatch",
      stream: "transactions",
      status: "pending",
      record_key: "ACCT-A",
      detail_locator: { kind: "usaa.account", account_id: "ACCT-B" },
    },
    {
      gap_id: "gap-empty-key",
      stream: "transactions",
      status: "pending",
      record_key: "",
      detail_locator: { kind: "usaa.account", account_id: "ACCT-EMPTY" },
    },
    {
      gap_id: "gap-missing-key",
      stream: "transactions",
      status: "pending",
      detail_locator: { kind: "usaa.account", account_id: "ACCT-MISSING" },
    },
    { gap_id: "gap-malformed", stream: "transactions", status: "pending", detail_locator: { kind: "usaa.account" } },
  ] as readonly DetailGapStartEntry[]);

  assert.deepEqual([...lookup.entries()], [["ACCT-OK", "gap-ok"]]);
});

test("recoverServedAccountTransactionGaps closes only a served gap for a reached account", async () => {
  const { deps, messages } = makeHarness(
    new Map([
      ["ACCT-HYDRATED", "gap-hydrated"],
      ["ACCT-STILL-FAILED", "gap-still-failed"],
    ])
  );
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-HYDRATED", kind: "hydrated" },
    {
      accountId: "ACCT-STILL-FAILED",
      kind: "gap",
      reason: "temporary_unavailable",
      errorClass: "export_no_download",
    },
  ];

  await recoverServedAccountTransactionGaps(deps, outcomes);

  assert.deepEqual(recoveriesOf(messages), [
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap-hydrated",
      stream: "transactions",
      record_key: "ACCT-HYDRATED",
    },
  ]);
});

test("recoverServedAccountTransactionGaps treats a source-limited no-activity export as recovery", async () => {
  const { deps, messages } = makeHarness(new Map([["ACCT-DORMANT", "gap-dormant"]]));

  await recoverServedAccountTransactionGaps(deps, [{ accountId: "ACCT-DORMANT", kind: "no_activity" }]);

  assert.equal(recoveriesOf(messages).length, 1);
  assert.equal(recoveriesOf(messages)[0]?.gap_id, "gap-dormant");
});

test("recoverServedAccountTransactionGaps closes a served retry gap after terminal unavailable classification", async () => {
  const { deps, messages } = makeHarness(new Map([["ACCT-UNAVAILABLE", "gap-unavailable"]]));

  await recoverServedAccountTransactionGaps(deps, [
    {
      accountId: "ACCT-UNAVAILABLE",
      kind: "unavailable",
      reason: "export_affordance_disabled",
      errorClass: "export_affordance_disabled",
    },
  ]);

  assert.deepEqual(recoveriesOf(messages), [
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap-unavailable",
      stream: "transactions",
      record_key: "ACCT-UNAVAILABLE",
    },
  ]);
});

test("recoverServedAccountTransactionGaps leaves unserved or unenumerated accounts pending", async () => {
  const { deps, messages } = makeHarness(new Map([["ACCT-GONE", "gap-gone"]]));

  await recoverServedAccountTransactionGaps(deps, [{ accountId: "ACCT-OTHER", kind: "hydrated" }]);

  assert.deepEqual(recoveriesOf(messages), []);
});

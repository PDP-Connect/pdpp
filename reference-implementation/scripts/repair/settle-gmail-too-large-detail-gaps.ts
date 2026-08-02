#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settle already-pending Gmail attachment gaps whose stored evidence class is
 * exactly `too_large`.
 *
 * Safety model:
 *   - Dry-run by default; `--apply` is required to write.
 *   - The connector, stream, and evidence class are fixed exact values.
 *   - One explicit connector instance and a maximum 500-row scope are required.
 *   - Matching and mutation are delegated to the canonical detail-gap store;
 *     this command has no SQL or parallel gap representation.
 *   - The store's status/class CAS makes apply idempotent and leaves retryable
 *     evidence such as `Connection not available` pending.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/repair/settle-gmail-too-large-detail-gaps.ts \
 *     --connector-id=gmail \
 *     --connector-instance-id=cin_... \
 *     --stream=attachments \
 *     --class=too_large \
 *     [--limit=100 --apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  type PendingGapRepairResult,
  type PendingGapRepairScopeInput,
} from "../../server/stores/connector-detail-gap-store.ts";

export interface GmailTooLargeRepairArgs {
  apply: boolean;
  connectorId: string | null;
  connectorInstanceId: string | null;
  errorClass: string | null;
  limit: number;
  stream: string | null;
}

export interface GmailTooLargeRepairReceipt {
  applied: boolean;
  connector_id: "gmail";
  connector_instance_id: string;
  emitted_at: string;
  error_class: "too_large";
  gap_ids: string[];
  limit: number;
  matched: number;
  object: "gmail_too_large_gap_settlement_receipt";
  stream: "attachments";
  terminalized: number;
  version: 1;
}

interface RepairGapIdentity {
  gap_id: string;
}

interface GmailTooLargeRepairStore {
  listPendingGapsForExactScope: (scope: PendingGapRepairScopeInput) => Promise<readonly RepairGapIdentity[]>;
  terminalizePendingGapsForExactScope: (scope: PendingGapRepairScopeInput) => Promise<PendingGapRepairResult>;
}

const MAX_REPAIR_LIMIT = 500;

const STRING_ARGUMENT_FIELDS = {
  class: "errorClass",
  "connector-id": "connectorId",
  "connector-instance-id": "connectorInstanceId",
  stream: "stream",
} as const;

function applyRepairArgument(args: GmailTooLargeRepairArgs, arg: string): void {
  if (arg === "--apply") {
    args.apply = true;
    return;
  }
  const separator = arg.indexOf("=");
  if (!(arg.startsWith("--") && separator > 2)) {
    throw new Error(`unsupported repair argument: ${arg}`);
  }
  const key = arg.slice(2, separator);
  const value = arg.slice(separator + 1);
  if (!value.trim()) {
    throw new Error(`repair argument requires a value: --${key}`);
  }
  if (key === "limit") {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPAIR_LIMIT) {
      throw new Error(`--limit must be an integer from 1 to ${MAX_REPAIR_LIMIT}`);
    }
    args.limit = limit;
    return;
  }
  if (!Object.hasOwn(STRING_ARGUMENT_FIELDS, key)) {
    throw new Error(`unsupported repair argument: --${key}`);
  }
  const field = STRING_ARGUMENT_FIELDS[key as keyof typeof STRING_ARGUMENT_FIELDS];
  args[field] = value;
}

export function parseArgs(argv: readonly string[]): GmailTooLargeRepairArgs {
  const args: GmailTooLargeRepairArgs = {
    apply: false,
    connectorId: null,
    connectorInstanceId: null,
    errorClass: null,
    limit: 100,
    stream: null,
  };
  for (const arg of argv) {
    applyRepairArgument(args, arg);
  }
  return args;
}

export function validateArgs(args: GmailTooLargeRepairArgs): string | null {
  if (args.connectorId !== "gmail") {
    return "--connector-id=gmail is required";
  }
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  if (args.stream !== "attachments") {
    return "--stream=attachments is required";
  }
  if (args.errorClass !== "too_large") {
    return "--class=too_large is required";
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_REPAIR_LIMIT) {
    return `--limit must be an integer from 1 to ${MAX_REPAIR_LIMIT}`;
  }
  return null;
}

function exactScope(args: GmailTooLargeRepairArgs, now: string): PendingGapRepairScopeInput {
  if (!(args.connectorId && args.connectorInstanceId && args.stream && args.errorClass)) {
    throw new Error("repair arguments are incomplete");
  }
  return {
    connectorId: args.connectorId,
    connectorInstanceId: args.connectorInstanceId,
    errorClass: args.errorClass,
    limit: args.limit,
    now,
    stream: args.stream,
  };
}

export async function executeRepair(
  store: GmailTooLargeRepairStore,
  args: GmailTooLargeRepairArgs,
  now = new Date().toISOString()
): Promise<GmailTooLargeRepairReceipt> {
  const validationError = validateArgs(args);
  if (validationError) {
    throw new Error(validationError);
  }
  const scope = exactScope(args, now);
  if (!args.connectorInstanceId) {
    throw new Error("--connector-instance-id is required");
  }
  if (args.apply) {
    const result = await store.terminalizePendingGapsForExactScope(scope);
    return {
      applied: true,
      connector_id: "gmail",
      connector_instance_id: args.connectorInstanceId,
      emitted_at: now,
      error_class: "too_large",
      gap_ids: result.gapIds,
      limit: args.limit,
      matched: result.matched,
      object: "gmail_too_large_gap_settlement_receipt",
      stream: "attachments",
      terminalized: result.terminalized,
      version: 1,
    };
  }
  const rows = await store.listPendingGapsForExactScope(scope);
  return {
    applied: false,
    connector_id: "gmail",
    connector_instance_id: args.connectorInstanceId,
    emitted_at: now,
    error_class: "too_large",
    gap_ids: rows.map((row) => row.gap_id),
    limit: args.limit,
    matched: rows.length,
    object: "gmail_too_large_gap_settlement_receipt",
    stream: "attachments",
    terminalized: 0,
    version: 1,
  };
}

async function main(): Promise<void> {
  let args: GmailTooLargeRepairArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }

  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    const receipt = await executeRepair(createPostgresConnectorDetailGapStore(), args);
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await closePostgresStorage();
  }
}

async function closePostgresStorageBestEffort(): Promise<void> {
  try {
    await closePostgresStorage();
  } catch {
    // Keep the original command error as the useful failure.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePostgresStorageBestEffort();
    process.exitCode = 1;
  });
}

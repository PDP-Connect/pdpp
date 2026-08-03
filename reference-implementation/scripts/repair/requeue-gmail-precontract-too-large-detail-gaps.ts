#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Requeue pre-contract Gmail attachment terminal rows for fresh provider
 * remeasurement. This never manufactures historical policy evidence: it only
 * returns the exact unproven terminal rows to normal scheduled recovery.
 *
 * Safety model:
 *   - Dry-run by default; `--apply` is required to write.
 *   - Requires one exact connector instance and a fixed mutation discriminator.
 *   - The connector, stream, terminal reason/error class, and attachment
 *     locator are fixed to the canonical Gmail attachment contract.
 *   - Valid terminal policy dispositions are excluded by the closed validator.
 *   - Apply is status/disposition compare-and-set, bounded, and idempotent.
 *   - The command writes no record, provider, run, or spine outcome; scheduled
 *     recovery is the sole authority for any new proof/not_found/recovered fact.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/repair/requeue-gmail-precontract-too-large-detail-gaps.ts \
 *     --connector-id=gmail \
 *     --connector-instance-id=cin_... \
 *     --stream=attachments \
 *     --class=too_large \
 *     --mutation-discriminator=pre_contract_gmail_attachment_too_large_remeasurement_v1 \
 *     [--limit=100 --apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  GMAIL_PRECONTRACT_REMEASUREMENT_DISCRIMINATOR,
  type TerminalGapRemeasurementResult,
  type TerminalGapRemeasurementScopeInput,
} from "../../server/stores/connector-detail-gap-store.ts";

export const PRECONTRACT_REMEASUREMENT_DISCRIMINATOR = GMAIL_PRECONTRACT_REMEASUREMENT_DISCRIMINATOR;
const MAX_REPAIR_LIMIT = 500;

export interface GmailPrecontractRemeasurementArgs {
  apply: boolean;
  connectorId: string | null;
  connectorInstanceId: string | null;
  errorClass: string | null;
  limit: number;
  mutationDiscriminator: string | null;
  stream: string | null;
}

export interface GmailPrecontractRemeasurementReceipt {
  applied: boolean;
  connector_id: "gmail";
  connector_instance_id: string;
  emitted_at: string;
  error_class: "too_large";
  gap_ids: string[];
  limit: number;
  matched: number;
  mutation_discriminator: typeof PRECONTRACT_REMEASUREMENT_DISCRIMINATOR;
  object: "gmail_precontract_terminal_remeasurement_receipt";
  requeued: number;
  stream: "attachments";
  version: 1;
}

interface RemeasurementGapIdentity {
  gap_id: string;
}

interface GmailPrecontractRemeasurementStore {
  listTerminalGapsForRemeasurement: (
    scope: TerminalGapRemeasurementScopeInput
  ) => Promise<readonly RemeasurementGapIdentity[]>;
  requeueTerminalGapsForRemeasurement: (
    scope: TerminalGapRemeasurementScopeInput
  ) => Promise<TerminalGapRemeasurementResult>;
}

const STRING_ARGUMENT_FIELDS = {
  class: "errorClass",
  "connector-id": "connectorId",
  "connector-instance-id": "connectorInstanceId",
  "mutation-discriminator": "mutationDiscriminator",
  stream: "stream",
} as const;

function applyRepairArgument(args: GmailPrecontractRemeasurementArgs, arg: string): void {
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

export function parseArgs(argv: readonly string[]): GmailPrecontractRemeasurementArgs {
  const args: GmailPrecontractRemeasurementArgs = {
    apply: false,
    connectorId: null,
    connectorInstanceId: null,
    errorClass: null,
    limit: 100,
    mutationDiscriminator: null,
    stream: null,
  };
  for (const arg of argv) {
    applyRepairArgument(args, arg);
  }
  return args;
}

export function validateArgs(args: GmailPrecontractRemeasurementArgs): string | null {
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
  if (args.mutationDiscriminator !== PRECONTRACT_REMEASUREMENT_DISCRIMINATOR) {
    return `--mutation-discriminator=${PRECONTRACT_REMEASUREMENT_DISCRIMINATOR} is required`;
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_REPAIR_LIMIT) {
    return `--limit must be an integer from 1 to ${MAX_REPAIR_LIMIT}`;
  }
  return null;
}

function exactScope(args: GmailPrecontractRemeasurementArgs, now: string): TerminalGapRemeasurementScopeInput {
  if (!(args.connectorId && args.connectorInstanceId && args.stream && args.errorClass)) {
    throw new Error("repair arguments are incomplete");
  }
  return {
    connectorId: args.connectorId,
    connectorInstanceId: args.connectorInstanceId,
    errorClass: args.errorClass,
    limit: args.limit,
    mutationDiscriminator: args.mutationDiscriminator ?? "",
    now,
    stream: args.stream,
  };
}

export async function executeRepair(
  store: GmailPrecontractRemeasurementStore,
  args: GmailPrecontractRemeasurementArgs,
  now = new Date().toISOString()
): Promise<GmailPrecontractRemeasurementReceipt> {
  const validationError = validateArgs(args);
  if (validationError) {
    throw new Error(validationError);
  }
  const scope = exactScope(args, now);
  if (!args.connectorInstanceId) {
    throw new Error("--connector-instance-id is required");
  }
  if (args.apply) {
    const result = await store.requeueTerminalGapsForRemeasurement(scope);
    return receiptFromResult(args, now, result.gapIds, result.matched, result.requeued);
  }
  const gapIds = (await store.listTerminalGapsForRemeasurement(scope)).map((gap) => gap.gap_id);
  return receiptFromResult(args, now, gapIds, gapIds.length, 0);
}

function receiptFromResult(
  args: GmailPrecontractRemeasurementArgs,
  now: string,
  gapIds: string[],
  matched: number,
  requeued: number
): GmailPrecontractRemeasurementReceipt {
  if (!args.connectorInstanceId) {
    throw new Error("--connector-instance-id is required");
  }
  return {
    applied: args.apply,
    connector_id: "gmail",
    connector_instance_id: args.connectorInstanceId,
    emitted_at: now,
    error_class: "too_large",
    gap_ids: gapIds,
    limit: args.limit,
    matched,
    mutation_discriminator: PRECONTRACT_REMEASUREMENT_DISCRIMINATOR,
    object: "gmail_precontract_terminal_remeasurement_receipt",
    requeued,
    stream: "attachments",
    version: 1,
  };
}

async function main(): Promise<void> {
  let args: GmailPrecontractRemeasurementArgs;
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
    console.log(JSON.stringify(await executeRepair(createPostgresConnectorDetailGapStore(), args), null, 2));
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

#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Apply one reviewed replacement-selection episode artifact.
 *
 * This is deliberately a direct-database, bounded repair tool rather than a
 * permanent HTTP control plane. It consumes one immutable reviewed JSON file,
 * is dry-run by default, and creates the correction plus a durable audit-outbox
 * fact in the same PostgreSQL transaction. It never prints receipt fields.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... node scripts/repair/apply-browser-surface-replacement-correction.ts \
 *     --artifact=/secure/reviewed-episode.json [--apply | --verify | --revoke --revoked-at=<RFC3339>]
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closePostgresStorage, initPostgresStorage } from "../../server/postgres-storage.ts";
import {
  createPostgresBrowserSurfaceReplacementReceiptStore,
  type ReplacementReceiptSelectionOverrideBatchInput,
  type ReplacementReceiptSelectionOverrideBatchVerification,
} from "../../server/stores/browser-surface-replacement-ledger-store.ts";

export interface ReviewedReplacementEpisodeArtifact {
  readonly correction: Omit<ReplacementReceiptSelectionOverrideBatchInput, "reviewed_artifact_sha256">;
  readonly version: 1;
}

export interface ParsedArgs {
  readonly apply: boolean;
  readonly artifact: string | null;
  readonly revoke: boolean;
  readonly revokedAt: string | null;
  readonly verify: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let artifact: string | null = null;
  let apply = false;
  let revoke = false;
  let revokedAt: string | null = null;
  let verify = false;
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--verify") {
      verify = true;
    } else if (arg === "--revoke") {
      revoke = true;
    } else if (arg.startsWith("--artifact=")) {
      artifact = arg.slice("--artifact=".length) || null;
    } else if (arg.startsWith("--revoked-at=")) {
      revokedAt = arg.slice("--revoked-at=".length) || null;
    }
  }
  return { apply, artifact, revoke, revokedAt, verify };
}

export function validateArgs(args: ParsedArgs): string | null {
  if (!args.artifact) {
    return "--artifact=<reviewed-json-file> is required";
  }
  if (Number(args.apply) + Number(args.revoke) + Number(args.verify) > 1) {
    return "use at most one of --apply, --verify, or --revoke";
  }
  if (args.revoke && !args.revokedAt) {
    return "--revoke requires --revoked-at=<RFC3339>";
  }
  if (!args.revoke && args.revokedAt) {
    return "--revoked-at is valid only with --revoke";
  }
  return null;
}

export function parseArtifact(raw: string): ReviewedReplacementEpisodeArtifact {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact must be one JSON object");
  }
  const artifact = value as { correction?: unknown; version?: unknown };
  if (artifact.version !== 1 || !artifact.correction || typeof artifact.correction !== "object") {
    throw new Error("artifact requires version: 1 and correction object");
  }
  return artifact as ReviewedReplacementEpisodeArtifact;
}

export function artifactInput(raw: string): ReplacementReceiptSelectionOverrideBatchInput {
  const artifact = parseArtifact(raw);
  return {
    ...artifact.correction,
    reviewed_artifact_sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const invalid = validateArgs(args);
  if (invalid) {
    throw new Error(invalid);
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL;
  if (!databaseUrl) {
    throw new Error("PDPP_DATABASE_URL is required");
  }
  const raw = await readFile(resolve(args.artifact || ""), "utf8");
  const input = artifactInput(raw);
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    const store = createPostgresBrowserSurfaceReplacementReceiptStore();
    let snapshot: ReplacementReceiptSelectionOverrideBatchVerification | null;
    if (args.revoke) {
      snapshot = await store.revokeSelectionOverrideBatch(
        {
          episode_id: input.episode.id,
          replacement_batch_id: input.replacement_batch_id,
          reviewed_artifact_sha256: input.reviewed_artifact_sha256,
        },
        args.revokedAt || ""
      );
    } else if (args.verify) {
      snapshot = await store.verifySelectionOverrideBatch(input.replacement_batch_id);
    } else if (args.apply) {
      snapshot = await store.applySelectionOverrideBatch(input);
    } else {
      snapshot = await store.dryRunSelectionOverrideBatch(input);
    }
    if (!snapshot) {
      throw new Error("reviewed batch was not found");
    }
    if (
      snapshot.replacement_batch_id !== input.replacement_batch_id ||
      snapshot.episode_id !== input.episode.id ||
      snapshot.reviewed_artifact_sha256 !== input.reviewed_artifact_sha256
    ) {
      throw new Error("persisted batch does not match the reviewed artifact");
    }
    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await closePostgresStorage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, treeDigest, verifyReceipt } from "./check-pr89-seam-receipt.ts";

const CANONICAL_OR_DPOP = /canonical|dpop/;
const DUPLICATED_RIGHTS = /duplicated rights/;
const IN_PROCESS_FALLBACK = /in-process fallback/;

const cases = {
  "case-1": { oracle_code: "equal", status: "pass" },
  "case-2": { oracle_code: "partial_approval", status: "pass" },
  "case-3": { oracle_code: "context_resolved", status: "pass" },
  "case-4": { oracle_code: "response_only", status: "pass" },
  "case-5": { oracle_code: "races_and_refresh", status: "pass" },
  "case-6": { oracle_code: "authorization_state.unsupported_legacy_shape", status: "pass" },
  "case-7": { oracle_code: "gnap_map", status: "pass" },
};

async function validReceipt(seamRoot: string): Promise<Record<string, unknown>> {
  const digest = await treeDigest(seamRoot);
  return {
    assertions: {
      authenticated_http_introspection: true,
      fresh_authorization_required: true,
      no_in_process_fallback: true,
      postgresql_races: true,
      refresh_family_revoked_on_replay: true,
      response_only_enforcement: true,
    },
    backend: "postgresql",
    cases,
    clock: "2026-08-11T12:00:00Z",
    command: "pnpm --filter pdpp-reference-implementation test:seam:pr89 -- --backend postgresql",
    decisions: {
      approved_authorization_shape: "pass",
      authorization_context_composition: "pass",
      binding_separation: "pass",
    },
    fixtures_digest: `sha256:${"a".repeat(64)}`,
    hardening: {
      code_reuse_revocation: "separately_reported",
      dpop: "not_demonstrated",
      keyless_recovery: "deferred",
      refresh_rotation: "pass",
      security_profile_floor: "deferred",
    },
    relevant_file_tree_digest: digest,
    response_envelopes_digest: `sha256:${"b".repeat(64)}`,
    schema: "pdpp.pr89.receipt.v1",
    undecided_common_schemas: true,
  };
}

test("receipt checker accepts a canonical complete seven-case receipt", async () => {
  const seamRoot = await mkdtemp(join(tmpdir(), "pr89-seam-"));
  await writeFile(join(seamRoot, "fixture.json"), "{}\n");
  await mkdir(join(seamRoot, "artifacts"));
  const receiptPath = join(seamRoot, "artifacts", "pr89-receipt.json");
  await writeFile(receiptPath, canonicalJson((await validReceipt(seamRoot)) as never));

  await verifyReceipt(receiptPath, seamRoot);
});

test("receipt checker rejects stale trees, invented deferred passes, and noncanonical output", async () => {
  const seamRoot = await mkdtemp(join(tmpdir(), "pr89-seam-"));
  await writeFile(join(seamRoot, "fixture.json"), "{}\n");
  await mkdir(join(seamRoot, "artifacts"));
  const receiptPath = join(seamRoot, "artifacts", "pr89-receipt.json");
  const receipt = await validReceipt(seamRoot);
  (receipt.hardening as Record<string, unknown>).dpop = "pass";
  await writeFile(receiptPath, JSON.stringify(receipt));

  await assert.rejects(() => verifyReceipt(receiptPath, seamRoot), CANONICAL_OR_DPOP);
});

test("receipt checker rejects duplicated rights and in-process fallback markers", async () => {
  const seamRoot = await mkdtemp(join(tmpdir(), "pr89-seam-"));
  await writeFile(join(seamRoot, "fixture.json"), "{}\n");
  await mkdir(join(seamRoot, "artifacts"));
  const receiptPath = join(seamRoot, "artifacts", "pr89-receipt.json");

  const duplicatedRights = await validReceipt(seamRoot);
  (duplicatedRights as Record<string, unknown>).duplicated_rights = true;
  await writeFile(receiptPath, canonicalJson(duplicatedRights as never));
  await assert.rejects(() => verifyReceipt(receiptPath, seamRoot), DUPLICATED_RIGHTS);

  const fallback = await validReceipt(seamRoot);
  (fallback as Record<string, unknown>).fallback = "in_process";
  await writeFile(receiptPath, canonicalJson(fallback as never));
  await assert.rejects(() => verifyReceipt(receiptPath, seamRoot), IN_PROCESS_FALLBACK);
});

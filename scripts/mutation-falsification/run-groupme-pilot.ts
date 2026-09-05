// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executes ONE real end-to-end GroupMe pilot batch (tasks.md 2.6): the
 * clean complete `polyfill-connectors` backstop, then both registered
 * operators, within the 10-minute locked batch window. Prints the raw
 * counts and projections this decision gate needs (design.md Decision #8) —
 * it does not itself decide continue/narrow/stop; that is a human judgment
 * recorded in DECISION-MEMO.md.
 *
 * Run from the repository root: `node --experimental-strip-types
 * scripts/mutation-falsification/run-groupme-pilot.ts`
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { GROUPME_OPERATORS } from "./groupme-operators.ts";
import { aggregateOperatorAttempts, PILOT_BATCH_WALL_TIME_MS, runGroupMePilotBatch } from "./groupme-runner.ts";
import { freezeIntentPacket, INTENT_SCHEMA } from "./schemas.ts";
import { defaultWorkspacePolicy } from "./workspace.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const EVIDENCE_ROOT = resolve(REPO_ROOT, ".mutation-falsification-evidence");
const POLICY_VERSION = "groupme-cursor-frontier-pilot/v1";

function currentHeadSha(): string {
  return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const baseCommitSha = currentHeadSha();
  const operatorIds = GROUPME_OPERATORS.map((op) => op.id);

  const policy = {
    evidenceStorePolicy: {
      evidenceRoot: EVIDENCE_ROOT,
      maxAttempts: 20,
      maxRetainedBytes: 2 * 1024 * 1024 * 1024,
      retentionDeadlineDays: 30 as const,
    },
    policyVersion: POLICY_VERSION,
    sourceRepoRoot: REPO_ROOT,
    workspacePolicy: defaultWorkspacePolicy(),
  };

  const intent = freezeIntentPacket({
    schema: INTENT_SCHEMA,
    adapterId: "groupme-cursor-frontier/v1",
    adapterVersion: "1",
    baseCommitSha,
    operatorId: null,
    requestedRisk: "groupme-cursor-frontier-pilot-batch",
    requestedBudget: { wallTimeMs: PILOT_BATCH_WALL_TIME_MS, directOutputByteCap: 8 * 1024 * 1024 },
  });

  console.log(`groupme pilot: base commit ${baseCommitSha}, operators: ${operatorIds.join(", ")}`);
  const startedAt = Date.now();
  const result = await runGroupMePilotBatch(policy, intent, operatorIds);
  const totalRuntimeMs = Date.now() - startedAt;

  const verdictByOperator = Object.fromEntries(
    operatorIds.map((operatorId) => {
      const outcomes = result.operatorOutcomes.filter((o) => o.operatorId === operatorId);
      return [operatorId, aggregateOperatorAttempts(outcomes)];
    })
  );

  const summary = {
    baseCommitSha,
    totalRuntimeMs,
    cleanExecutionRawCount: result.cleanExecutionRawCount,
    operatorAttempts: result.operatorOutcomes.map((o) => ({
      operatorId: o.operatorId,
      attemptId: o.attemptId,
      projection: o.projection,
      axes: o.receipt.axes,
      runtimeMs: o.receipt.runtimeMs,
    })),
    verdictByOperator,
  };
  console.log("MUTATION_PILOT_BATCH_RESULT", JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("groupme pilot batch failed:", error);
  process.exitCode = 1;
});

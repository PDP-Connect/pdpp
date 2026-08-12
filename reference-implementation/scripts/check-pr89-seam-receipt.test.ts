// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  buildReceipt,
  fileSetDigest,
  generateReceipt,
  parseCaseOutput,
  verifyReceipt,
} from "./check-pr89-seam-receipt.ts";
import {
  CASE_DEFINITIONS,
  CASE_EVIDENCE_SCHEMA,
  CASE_IDS,
  CASE_OUTPUT_SCHEMA,
  type CaseEvidence,
  type CaseId,
  canonicalJson,
  digest,
  exactSortedValues,
  type Json,
  RECEIPT_STATIC_PATHS,
} from "./pr89-seam-evidence-contract.ts";

const MISSING_EVIDENCE = /case-4 evidence is missing/;
const STALE_RECEIPT = /receipt is stale|implementation_inputs_digest is stale/;
const STALE_BOUND_INPUT = /case_output_digest is stale|fixtures_digest is stale|test_file_digest is stale/;
const SECRET_RESPONSE = /forbidden secret-bearing key/;

async function writeRepositoryFile(root: string, path: string): Promise<void> {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${path}\n`, "utf8");
}

function caseCommand(caseId: CaseId): string[] {
  return [
    "node",
    "--test",
    "--import",
    "tsx",
    "--test-reporter",
    "scripts/test-accounting/node-reporter.ts",
    CASE_DEFINITIONS[caseId].testFile,
  ];
}

async function createEvidenceWorkspace(): Promise<{
  evidenceRoot: string;
  receiptPath: string;
  repositoryRoot: string;
}> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pr89-receipt-"));
  const evidenceRoot = resolve(repositoryRoot, "generated/evidence");
  const receiptPath = resolve(repositoryRoot, "generated/pr89-receipt.json");
  const sourcePaths = new Set<string>(RECEIPT_STATIC_PATHS);
  for (const caseId of CASE_IDS) {
    const definition = CASE_DEFINITIONS[caseId];
    sourcePaths.add(definition.testFile);
    for (const path of definition.fixturePaths) {
      sourcePaths.add(path);
    }
    for (const path of definition.implementationInputPaths) {
      sourcePaths.add(path);
    }
  }
  await Promise.all([...sourcePaths].map((path) => writeRepositoryFile(repositoryRoot, path)));
  await mkdir(evidenceRoot, { recursive: true });
  await Promise.all(
    CASE_IDS.map(async (caseId) => {
      const definition = CASE_DEFINITIONS[caseId];
      const responseEnvelopes = definition.responseEnvelopesRequired
        ? [{ error_code: null, name: `${caseId}-stable-response`, status: 200 }]
        : [];
      const caseOutput = parseCaseOutput(
        {
          case_id: caseId,
          observations: exactSortedValues(definition.observations),
          oracle_code: definition.oracleCode,
          response_envelopes: responseEnvelopes,
          schema: CASE_OUTPUT_SCHEMA,
        },
        caseId
      );
      const terminalEvents = exactSortedValues(definition.requiredTestNames).map((name) => ({
        name,
        status: "pass" as const,
      }));
      const evidence: CaseEvidence = {
        backend: "postgresql",
        case_id: caseId,
        case_output: caseOutput,
        case_output_digest: digest(canonicalJson(caseOutput as unknown as Json)),
        command: caseCommand(caseId),
        fixtures_digest: await fileSetDigest(repositoryRoot, definition.fixturePaths),
        implementation_inputs_digest: await fileSetDigest(repositoryRoot, definition.implementationInputPaths),
        oracle_code: definition.oracleCode,
        schema: CASE_EVIDENCE_SCHEMA,
        status: "pass",
        terminal_events: terminalEvents,
        terminal_events_digest: digest(canonicalJson(terminalEvents)),
        test_file_digest: await fileSetDigest(repositoryRoot, [definition.testFile]),
      };
      await writeFile(
        resolve(evidenceRoot, `${caseId}.json`),
        `${canonicalJson(evidence as unknown as Json)}\n`,
        "utf8"
      );
    })
  );
  return { evidenceRoot, receiptPath, repositoryRoot };
}

test("receipt is generated only from complete executed case evidence", async () => {
  const workspace = await createEvidenceWorkspace();
  await generateReceipt(workspace);
  await verifyReceipt(workspace);
  const receipt = await buildReceipt(workspace);
  assert.equal(receipt.schema, "pdpp.pr89.receipt.v2");
  assert.deepEqual(Object.keys(receipt.cases), CASE_IDS);
  assert.equal(receipt.assertions.postgresql_races, true);
  assert.equal(receipt.assertions.legacy_refresh_state_rejected, true);
  assert.equal(receipt.assertions.refresh_family_access_tokens_inactive_on_replay, true);
});

test("receipt generation fails when any case evidence is absent", async () => {
  const workspace = await createEvidenceWorkspace();
  await rm(resolve(workspace.evidenceRoot, "case-4.json"));
  await assert.rejects(() => generateReceipt(workspace), MISSING_EVIDENCE);
});

test("receipt verification recomputes tested implementation inputs", async () => {
  const workspace = await createEvidenceWorkspace();
  await generateReceipt(workspace);
  const [inputPath] = CASE_DEFINITIONS["case-5"].implementationInputPaths;
  await writeFile(resolve(workspace.repositoryRoot, inputPath), "changed after execution\n", "utf8");
  await assert.rejects(() => verifyReceipt(workspace), STALE_RECEIPT);
});

test("receipt verification recomputes case output, fixture, and test-file digests", async () => {
  await Promise.all([
    (async () => {
      const workspace = await createEvidenceWorkspace();
      await generateReceipt(workspace);
      const evidencePath = resolve(workspace.evidenceRoot, "case-1.json");
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
      evidence.case_output_digest = `sha256:${"0".repeat(64)}`;
      await writeFile(evidencePath, `${canonicalJson(evidence as Json)}\n`, "utf8");
      await assert.rejects(() => verifyReceipt(workspace), STALE_BOUND_INPUT);
    })(),
    (async () => {
      const workspace = await createEvidenceWorkspace();
      await generateReceipt(workspace);
      const [fixturePath] = CASE_DEFINITIONS["case-1"].fixturePaths;
      await writeFile(resolve(workspace.repositoryRoot, fixturePath), "changed fixture\n", "utf8");
      await assert.rejects(() => verifyReceipt(workspace), STALE_BOUND_INPUT);
    })(),
    (async () => {
      const workspace = await createEvidenceWorkspace();
      await generateReceipt(workspace);
      await writeFile(resolve(workspace.repositoryRoot, CASE_DEFINITIONS["case-1"].testFile), "changed test\n", "utf8");
      await assert.rejects(() => verifyReceipt(workspace), STALE_BOUND_INPUT);
    })(),
  ]);
});

test("receipt verification rejects a canonical but invented claim", async () => {
  const workspace = await createEvidenceWorkspace();
  await generateReceipt(workspace);
  const receipt = JSON.parse(await readFile(workspace.receiptPath, "utf8")) as Record<string, unknown>;
  (receipt.assertions as Record<string, unknown>).postgresql_races = false;
  await writeFile(workspace.receiptPath, `${canonicalJson(receipt as Json)}\n`, "utf8");
  await assert.rejects(() => verifyReceipt(workspace), STALE_RECEIPT);
});

test("case output rejects secret-bearing response envelopes", () => {
  const definition = CASE_DEFINITIONS["case-2"];
  for (const responseEnvelope of [
    { access_token: "tok_not_allowed" },
    { authorization_header: "Bearer not-allowed" },
    { bearer_token: "not-allowed" },
    { client_password: "not-allowed" },
    { secret: "not-allowed" },
  ]) {
    assert.throws(
      () =>
        parseCaseOutput(
          {
            case_id: "case-2",
            observations: exactSortedValues(definition.observations),
            oracle_code: definition.oracleCode,
            response_envelopes: [responseEnvelope],
            schema: CASE_OUTPUT_SCHEMA,
          },
          "case-2"
        ),
      SECRET_RESPONSE
    );
  }
});

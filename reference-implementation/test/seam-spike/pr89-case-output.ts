// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs";

import { canonicalJson, type Json } from "../../scripts/pr89-seam-evidence-contract.ts";

export interface Pr89CaseOutput {
  case_id: `case-${1 | 2 | 3 | 4}`;
  observations: string[];
  oracle_code: string;
  response_envelopes: unknown[];
  schema: "pdpp.pr89.case-output.v1";
}

export function writePr89CaseOutput(output: Pr89CaseOutput): void {
  const outputPath = process.env.PDPP_PR89_CASE_OUTPUT_PATH;
  if (!outputPath) {
    return;
  }
  const observations = [...new Set(output.observations)].sort();
  const canonical = canonicalJson({ ...output, observations } as unknown as Json);
  writeFileSync(outputPath, `${canonical}\n`, { encoding: "utf8", mode: 0o600 });
}

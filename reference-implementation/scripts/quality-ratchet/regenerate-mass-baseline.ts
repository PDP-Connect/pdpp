// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import type { MassFingerprint } from "./check-mass-ratchet.ts";
import { BASELINE_PATH, resolveCurrentFingerprint, writeBaselineFile } from "./check-mass-ratchet.ts";
import type { MassObject } from "./measure-mass.ts";
import { measureMass } from "./measure-mass.ts";

export interface RegenerateMassBaselineOptions {
  baselinePath?: string;
}

export interface RegenerateMassBaselineResult {
  files: MassObject;
  fingerprint: MassFingerprint;
}

export async function regenerateMassBaseline({
  baselinePath = BASELINE_PATH,
}: RegenerateMassBaselineOptions = {}): Promise<RegenerateMassBaselineResult> {
  const fingerprint = await resolveCurrentFingerprint();
  const { files } = await measureMass({ files: null });
  await writeBaselineFile(baselinePath, files, fingerprint);
  return { files, fingerprint };
}

async function main(): Promise<void> {
  const { fingerprint, files } = await regenerateMassBaseline();
  console.log(
    `Regenerated ${BASELINE_PATH} for ${JSON.stringify(fingerprint)} (${Object.keys(files).length} file(s) with mass).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

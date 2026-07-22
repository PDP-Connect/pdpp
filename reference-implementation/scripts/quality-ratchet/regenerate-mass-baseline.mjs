// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import { BASELINE_PATH, resolveCurrentFingerprint, writeBaselineFile } from "./check-mass-ratchet.mjs";
import { measureMass } from "./measure-mass.mjs";

export async function regenerateMassBaseline({ baselinePath = BASELINE_PATH } = {}) {
  const fingerprint = await resolveCurrentFingerprint();
  const { files } = await measureMass({ files: null });
  await writeBaselineFile(baselinePath, files, fingerprint);
  return { fingerprint, files };
}

async function main() {
  const { fingerprint, files } = await regenerateMassBaseline();
  console.log(`Regenerated ${BASELINE_PATH} for ${JSON.stringify(fingerprint)} (${Object.keys(files).length} file(s) with mass).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

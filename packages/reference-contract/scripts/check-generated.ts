#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const retiredArtifactFiles = [
  "reference-implementation/openapi/reference-public.openapi.json",
  "reference-implementation/openapi/reference-full.openapi.json",
  "reference-implementation/docs/generated/reference-routes.md",
  "reference-implementation/docs/generated/reference-ref-routes.md",
  "reference-implementation/docs/generated/query-cookbook.md",
];

const restoredArtifact = retiredArtifactFiles.find((artifact) => existsSync(resolve(repoRoot, artifact)));

if (restoredArtifact) {
  process.stderr.write(`Retired reference artifact is present: ${restoredArtifact}\n`);
  process.stderr.write(
    "Reference-implementation artifacts now belong to PDP-Connect/data-connect; remove this stale output before merging.\n"
  );
  process.exit(1);
}

process.stdout.write("Retired reference artifacts are absent.\n");

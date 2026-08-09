// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporaryRoot = mkdtempSync(join(root, ".generated-artifacts-"));
const writeArtifacts = process.argv.includes("--write");

interface ArtifactPair {
  generated: string;
  tracked: string;
}

const serviceWorker: ArtifactPair = {
  generated: join(temporaryRoot, "service-worker", "pdpp-dashboard-sw.js"),
  tracked: "apps/console/public/pdpp-dashboard-sw.js",
};
const syncScript: ArtifactPair = {
  generated: join(temporaryRoot, "sync-script", "sync-spec-docs.mjs"),
  tracked: "apps/site/scripts/sync-spec-docs.mjs",
};
const designScripts = ["data", "dispatch", "query"].map((name) => ({
  generated: join(temporaryRoot, "design", "explorer", `${name}.js`),
  tracked: `docs/design-system/ink-carbon/project/explorer/${name}.js`,
}));
const recordroomScripts = ["image-slot", "rr-data", "rr-explore-data"].map((name) => ({
  generated: join(temporaryRoot, "design", "recordroom", `${name}.js`),
  tracked: `docs/design-system/ink-carbon/project/recordroom/${name}.js`,
}));

function emit(args: string[]): void {
  execFileSync("pnpm", ["exec", "tsc", "--ignoreConfig", "--noCheck", ...args], {
    cwd: root,
    stdio: "inherit",
  });
}

function compare(pair: ArtifactPair): void {
  const generated = readFileSync(pair.generated);
  const trackedPath = join(root, pair.tracked);
  if (writeArtifacts) {
    copyFileSync(pair.generated, trackedPath);
  }
  const tracked = readFileSync(trackedPath);
  if (!generated.equals(tracked)) {
    throw new Error(`generated artifact drift: ${pair.tracked}`);
  }
}

try {
  emit([
    "--target",
    "ES2022",
    "--module",
    "ES2022",
    "--lib",
    "ES2022,WebWorker",
    "--outDir",
    join(temporaryRoot, "service-worker"),
    "apps/console/public/pdpp-dashboard-sw.ts",
  ]);
  emit([
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--lib",
    "ES2022",
    "--types",
    "node",
    "--outDir",
    join(temporaryRoot, "sync-script"),
    "apps/site/scripts/sync-spec-docs.mts",
  ]);
  emit([
    "--target",
    "ES2022",
    "--module",
    "ES2022",
    "--lib",
    "ES2022,DOM",
    "--outDir",
    join(temporaryRoot, "design"),
    "docs/design-system/ink-carbon/project/explorer/data.ts",
    "docs/design-system/ink-carbon/project/explorer/dispatch.ts",
    "docs/design-system/ink-carbon/project/explorer/query.ts",
    "docs/design-system/ink-carbon/project/recordroom/image-slot.ts",
    "docs/design-system/ink-carbon/project/recordroom/rr-data.ts",
    "docs/design-system/ink-carbon/project/recordroom/rr-explore-data.ts",
  ]);

  // packages/cli/src/ref/list-envelope.ts is a plain generated .ts-to-.ts
  // copy of packages/list-envelope/src/index.ts (no tsc emit needed — both
  // are already TypeScript source); see
  // packages/cli/scripts/generate-list-envelope.ts for why the CLI cannot
  // just import the shared package directly.
  const cliListEnvelope: ArtifactPair = {
    generated: join(temporaryRoot, "cli-list-envelope", "list-envelope.ts"),
    tracked: "packages/cli/src/ref/list-envelope.ts",
  };
  execFileSync("node", ["--import", "tsx", "scripts/generate-list-envelope.ts", cliListEnvelope.generated], {
    cwd: join(root, "packages/cli"),
    stdio: "inherit",
  });

  // reference-implementation/server/connector-key.ts and
  // connection-setup-plan.ts are imported by apps/console (browser/edge
  // bundling) and must stay node:fs-free, so they cannot scan
  // packages/polyfill-connectors/manifests/ at load time. The connector-id
  // allowlists they'd otherwise hand-maintain are generated instead — see
  // reference-implementation/scripts/generate-connector-registry.ts.
  const connectorRegistry: ArtifactPair = {
    generated: join(temporaryRoot, "connector-registry", "connector-registry.generated.ts"),
    tracked: "reference-implementation/server/generated/connector-registry.generated.ts",
  };
  execFileSync(
    "node",
    ["--experimental-strip-types", "scripts/generate-connector-registry.ts", connectorRegistry.generated],
    { cwd: join(root, "reference-implementation"), stdio: "inherit" }
  );

  const pairs = [serviceWorker, syncScript, ...designScripts, ...recordroomScripts, cliListEnvelope, connectorRegistry];
  for (const pair of pairs) {
    compare(pair);
  }
  console.log(`generated-artifacts: ${pairs.length} byte-identical artifacts`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

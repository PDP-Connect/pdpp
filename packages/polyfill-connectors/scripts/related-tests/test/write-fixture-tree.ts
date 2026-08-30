// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies a checked-in minimal package-tree fixture into a real temp
 * directory and stamps a real tsconfig.json next to it, so
 * `buildDependencyGraph` can run an unmodified, real `cruise()` call
 * against it — no graph mocking anywhere in this test suite.
 *
 * Checked-in fixture "test" files are stored as `*.test.ts.fixture`, not
 * `*.test.ts`: this repo's global test-accounting inventory
 * (scripts/test-accounting/inventory.ts) classifies ANY tracked `*.test.ts`
 * path as an executable test requiring manifest accounting, with no
 * exception for a file that only exists to be copied elsewhere as fixture
 * data and is never itself executed. Restoring the real `.test.ts` name only
 * at copy time keeps the git-tracked template outside that scan while the
 * ephemeral temp-dir copy — which is what dependency-cruiser and node:test
 * actually see — has the exact real name the selector's logic depends on.
 */

import { cpSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_TEMPLATE_SUFFIX = ".fixture";

function restoreFixtureNames(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      restoreFixtureNames(fullPath);
    } else if (entry.endsWith(FIXTURE_TEMPLATE_SUFFIX)) {
      renameSync(fullPath, fullPath.slice(0, -FIXTURE_TEMPLATE_SUFFIX.length));
    }
  }
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ["**/*.ts"],
  exclude: ["node_modules"],
});

export function writeFixtureTree(destinationRoot: string, sourceTreeDir: string): void {
  mkdirSync(destinationRoot, { recursive: true });
  cpSync(sourceTreeDir, destinationRoot, { recursive: true });
  restoreFixtureNames(destinationRoot);
  writeFileSync(join(destinationRoot, "tsconfig.json"), TSCONFIG);
}

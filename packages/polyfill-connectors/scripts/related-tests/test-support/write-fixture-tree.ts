// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Copies a checked-in minimal package-tree fixture into a real temp
 * directory and stamps a real tsconfig.json next to it, so
 * `buildDependencyGraph` can run an unmodified, real `cruise()` call
 * against it — no graph mocking anywhere in this test suite.
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  writeFileSync(join(destinationRoot, "tsconfig.json"), TSCONFIG);
}

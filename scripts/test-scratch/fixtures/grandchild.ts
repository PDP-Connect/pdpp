// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
const name = process.argv.find((arg) => arg.startsWith("--name="))?.slice("--name=".length) ?? "node";
await writeFile(join(root, `grandchild-${name}.txt`), `${process.pid}\n`);
await writeFile(join(root, `grandchild-${name}-root.txt`), `${root}\n`);
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {
    // Intentional fixture: wrapper must escalate a group member that ignores TERM.
  });
}
if (process.argv.includes("--ignore-term") || process.argv.includes("--wait")) {
  await new Promise(() => {
    // Intentional fixture hang for signal tests.
    setInterval(() => undefined, 1000);
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
await writeFile(join(root, "grandchild.txt"), `${process.pid}\n`);
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {
    // Intentional fixture: wrapper must escalate a group member that ignores TERM.
  });
  await new Promise(() => {
    // Intentional fixture hang for signal tests.
  });
}

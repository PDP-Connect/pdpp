// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
await writeFile(join(root, "participant-root.txt"), `${root}\n`);
const worker = new URL("./worker.ts", import.meta.url).pathname;
for (const [name, leaf] of [
  ["one", "--node-leaf"],
  ["two", "--shell-leaf"],
]) {
  spawn(process.execPath, ["--import", "tsx", worker, `--name=${name}`, leaf], {
    detached: false,
    env: process.env,
    stdio: "ignore",
  });
}

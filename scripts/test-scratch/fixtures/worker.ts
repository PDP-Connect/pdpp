// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
const name = process.argv.find((arg) => arg.startsWith("--name="))?.slice("--name=".length);
if (!name) {
  throw new Error("missing worker name");
}
const scratch = await mkdtemp(join(tmpdir(), "worker-"));
await writeFile(join(root, `worker-${name}-root.txt`), `${root}\n`);
await writeFile(join(root, `worker-${name}-path.txt`), `${scratch}\n`);
const grandchild = new URL("./grandchild.ts", import.meta.url).pathname;
const args = ["--import", "tsx", grandchild, `--name=${name}-leaf`];
spawn(
  process.argv.includes("--shell-leaf") ? "sh" : process.execPath,
  process.argv.includes("--shell-leaf") ? ["-c", 'exec "$@"', "sh", process.execPath, ...args] : args,
  { detached: false, env: process.env, stdio: "ignore" }
);

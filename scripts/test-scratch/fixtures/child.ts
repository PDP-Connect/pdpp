// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
await writeFile(join(tmpdir(), "child.txt"), `${process.pid}\n`);
if (process.argv.includes("--print-root")) {
  process.stdout.write(`${root}\n`);
}
if (process.argv.includes("--grandchild")) {
  const grandchildArgs = process.argv.includes("--grandchild-ignore-term") ? ["--ignore-term"] : [];
  spawn(
    process.execPath,
    ["--import", "tsx", new URL("./grandchild.ts", import.meta.url).pathname, ...grandchildArgs],
    {
      detached: false,
      env: process.env,
      stdio: "ignore",
    }
  );
}
const signal = process.argv.find((arg) => arg.startsWith("--self-signal="));
if (signal) {
  process.kill(process.pid, signal.slice("--self-signal=".length) as NodeJS.Signals);
}
const exit = process.argv.find((arg) => arg.startsWith("--exit="));
if (exit) {
  process.exitCode = Number.parseInt(exit.slice("--exit=".length), 10);
}
if (process.argv.includes("--wait")) {
  await new Promise(() => {
    // Intentional fixture hang for signal tests.
  });
}

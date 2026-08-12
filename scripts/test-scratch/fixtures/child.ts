// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.PDPP_TEST_SCRATCH_ROOT;
if (!root) {
  throw new Error("missing PDPP_TEST_SCRATCH_ROOT");
}
await writeFile(join(tmpdir(), "child.txt"), `${process.pid}\n`);
await writeFile(join(root, "child-root.txt"), `${root}\n`);
if (process.argv.includes("--print-root")) {
  process.stdout.write(`${root}\n`);
}
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {
    // Intentional fixture: both the direct child and descendant can require KILL.
  });
}
if (process.argv.includes("--record-signals")) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      writeSync(process.stdout.fd, `child-signal:${signal}\n`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}
function startGrandchild(name: string, throughShell = false): void {
  const grandchildArgs = process.argv.includes("--grandchild-ignore-term") ? ["--ignore-term"] : [];
  const grandchild = new URL("./grandchild.ts", import.meta.url).pathname;
  const args = ["--import", "tsx", grandchild, `--name=${name}`, ...grandchildArgs];
  spawn(
    throughShell ? "sh" : process.execPath,
    throughShell ? ["-c", 'exec "$@"', "sh", process.execPath, ...args] : args,
    { detached: false, env: process.env, stdio: "ignore" }
  );
}

if (process.argv.includes("--grandchild") || process.argv.includes("--node-grandchild")) {
  startGrandchild("node");
}
if (process.argv.includes("--shell-grandchild")) {
  startGrandchild("shell", true);
}
if (process.argv.includes("--nested-participant")) {
  spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("../run-command.ts", import.meta.url).pathname,
      "--",
      process.execPath,
      "--import",
      "tsx",
      new URL("./participant.ts", import.meta.url).pathname,
    ],
    { detached: false, env: process.env, stdio: "ignore" }
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
    setInterval(() => {
      // Keep an active handle so SIGKILL leaves a real orphaned group.
    }, 1000);
  });
}

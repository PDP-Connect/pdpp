// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test double for ../sandbox-child.ts: runs the real sidecar, then SIGKILLs it
// the moment it has spawned the command, whatever it has or has not published
// by then. The command (and its group) keeps running. Before the kill it records
// `<pid> <scratch root>` of the command at the path in KILL_AFTER_SPAWN_RECORD, so
// a test can find the command without depending on the command's own progress.

import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const { spawn } = childProcess;
const patched = childProcess as { spawn: typeof childProcess.spawn };
patched.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  const child = spawn(...args);
  const record = process.env.KILL_AFTER_SPAWN_RECORD;
  if (record) {
    writeFileSync(record, `${child.pid} ${process.env.PDPP_TEST_SCRATCH_ROOT}\n`);
  }
  process.kill(process.pid, "SIGKILL");
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();

await import("../sandbox-child.ts");

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test double for ../sandbox-child.ts: runs the real sidecar, then SIGKILLs it
// the moment it has spawned the command, whatever it has or has not published
// by then. The command (and its group) keeps running.

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const { spawn } = childProcess;
const patched = childProcess as { spawn: typeof childProcess.spawn };
patched.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  const child = spawn(...args);
  process.kill(process.pid, "SIGKILL");
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();

await import("../sandbox-child.ts");

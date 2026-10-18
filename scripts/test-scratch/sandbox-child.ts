// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Second process hop between test-sandbox and the test command. The sandbox and
// its cgroup scope hide two facts from the launcher: the command's process
// group and its terminating signal. This sidecar spawns the command in its own
// group, publishes that group to `groupPath` (so the launcher can stop exactly
// that group), and records a terminating signal at `signalPath` (so the
// launcher can restore signal status instead of a bare 128+N exit code).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { constants } from "node:os";

const [signalPath, groupPath, file, ...args] = process.argv.slice(2);
if (!(signalPath && groupPath && file)) {
  process.exit(74);
}

const child = spawn(file, args, { detached: true, stdio: "inherit", env: process.env });
child.once("error", () => {
  process.exitCode = 74;
});
child.once("close", (code, signal) => {
  if (signal) {
    writeFileSync(signalPath, signal);
    process.exitCode = 128 + constants.signals[signal];
  } else if (process.exitCode !== 74) {
    process.exitCode = code ?? 74;
  }
});

// A failed spawn has no command group; publish that fact for cleanup.
writeFileSync(groupPath, `${child.pid ?? 0}\n`, { mode: 0o600 });

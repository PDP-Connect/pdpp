// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Second process hop between test-sandbox and the test command. test-sandbox
// hides two facts from the launcher: the process group that holds the command
// (without a systemd user manager it runs the command under `setsid`, so that
// group is not the one the launcher spawned) and the command's terminating
// signal (its shell wrapper reports only 128+N).
//
// The sidecar publishes its own process group at `groupPath` BEFORE it spawns
// the command, then runs the command in that same group. So a published group
// always covers the command and its descendants, and "nothing published" means
// the command never started. The launcher records and stops that group; the
// sidecar waits for the command and records a terminating signal at
// `signalPath`, so the launcher can restore signal status.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

function ownProcessGroup(): number {
  try {
    // Field 5 of /proc/<pid>/stat; the command name (field 2) may contain spaces, so parse after its ")".
    const stat = readFileSync("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
  }
}

const [signalPath, groupPath, file, ...args] = process.argv.slice(2);
if (!(signalPath && groupPath && file)) {
  process.exit(74);
}

// A signal sent to the whole group also reaches the command. Stay alive to report its status.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => undefined);
}

const pgid = ownProcessGroup();
if (!(Number.isSafeInteger(pgid) && pgid > 0)) {
  process.exit(74);
}
// Publish atomically; a failure here exits before any command exists.
writeFileSync(`${groupPath}.tmp`, `${pgid}\n`, { mode: 0o600 });
renameSync(`${groupPath}.tmp`, groupPath);

const child = spawn(file, args, { stdio: "inherit", env: process.env });
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

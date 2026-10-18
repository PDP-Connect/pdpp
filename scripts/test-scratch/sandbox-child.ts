// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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

if (child.pid) {
  const barrier = process.env.PDPP_TEST_SANDBOX_GROUP_PUBLISH_BARRIER === "1" ? `${groupPath}.barrier` : undefined;
  const barrierDeadline = Date.now() + 10_000;
  if (barrier) {
    writeFileSync(`${barrier}.spawned`, `${child.pid}\n`);
  }
  const publishGroup = () => {
    if (barrier && !existsSync(`${barrier}.release`) && Date.now() < barrierDeadline) {
      setTimeout(publishGroup, 25);
      return;
    }
    writeFileSync(groupPath, `${child.pid}\n`, { mode: 0o600 });
  };
  publishGroup();
} else {
  // A failed spawn has no command group; publish that fact for cleanup.
  writeFileSync(groupPath, "0\n", { mode: 0o600 });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runScratchCommand } from "../run-command.ts";

const child = new URL("./child.ts", import.meta.url).pathname;

await runScratchCommand(["--", process.execPath, "--import", "tsx", child, "--print-root", "--wait"], {
  // The parent test kills this wrapper only after it observes the durable launching marker.
  afterSpawnBeforeRunning: () => new Promise(() => undefined),
});

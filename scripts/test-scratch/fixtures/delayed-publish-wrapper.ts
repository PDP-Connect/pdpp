// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runScratchCommand } from "../run-command.ts";

const child = new URL("./child.ts", import.meta.url).pathname;
const sandboxChild = new URL("./delayed-publish-sandbox-child.ts", import.meta.url).pathname;

const result = await runScratchCommand(
  ["--", process.execPath, "--import", "tsx", child, "--print-root", "--record-signals", "--wait"],
  { sandboxChild }
);
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.code ?? 74;
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs `runScratchCommand` with a replacement sidecar:
// `sandbox-child-wrapper.ts <sidecar script> <command...>`.

import { runScratchCommand } from "../run-command.ts";

const [sandboxChild, ...argv] = process.argv.slice(2);
const result = await runScratchCommand(["--", ...argv], sandboxChild ? { sandboxChild } : {});
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.code ?? 74;
}

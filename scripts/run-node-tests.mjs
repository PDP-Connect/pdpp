// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function localNodeTestArgs(args, isCi = Boolean(process.env.CI)) {
  if (
    isCi ||
    !args.includes("--test") ||
    args.some((argument) => argument === "--test-concurrency" || argument.startsWith("--test-concurrency="))
  ) {
    return [...args];
  }
  const bounded = [...args];
  bounded.splice(bounded.indexOf("--test") + 1, 0, "--test-concurrency=2");
  return bounded;
}

function main() {
  const result = spawnSync(process.execPath, localNodeTestArgs(process.argv.slice(2)), { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

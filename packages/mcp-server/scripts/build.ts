// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");

await rm(distRoot, { force: true, recursive: true });
await execFileAsync("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], {
  cwd: packageRoot,
});
await chmod(join(distRoot, "bin", "pdpp-mcp-server.js"), 0o755);

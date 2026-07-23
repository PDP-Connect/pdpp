// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");

await rm(distRoot, { force: true, recursive: true });
await cp(join(packageRoot, "src"), join(distRoot, "src"), { recursive: true });
await mkdir(join(distRoot, "bin"), { recursive: true });

const sourceBin = join(packageRoot, "bin", "pdpp-mcp-server.js");
const emittedBin = join(distRoot, "bin", "pdpp-mcp-server.js");
const source = await readFile(sourceBin, "utf8");
const output = source;

if (!source.includes("'../src/index.js'")) {
  throw new Error("MCP bin does not import the source entrypoint expected by the emitted-artifact transform");
}

await writeFile(emittedBin, output);
await chmod(emittedBin, 0o755);

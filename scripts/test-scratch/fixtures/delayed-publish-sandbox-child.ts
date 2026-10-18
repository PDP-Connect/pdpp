// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test double for ../sandbox-child.ts: runs the real sidecar but holds back the
// command-group publication until `<groupPath>.release` exists, so a test can
// signal the launcher inside the spawn-to-publish window.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [, , , groupPath] = process.argv;
const { writeFileSync } = fs;
const patchedFs = fs as { writeFileSync: typeof fs.writeFileSync };
patchedFs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: never, options?: never) => {
  if (path === groupPath) {
    writeFileSync(`${groupPath}.spawned`, data);
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(`${groupPath}.release`) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return writeFileSync(path, data, options);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();

await import("../sandbox-child.ts");

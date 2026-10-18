// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test double for ../sandbox-child.ts: runs the real sidecar but holds back the
// group publication until `<groupPath>.release` exists, so a test can signal the
// launcher before the group exists. The sidecar publishes before it spawns, so no
// command exists while the publication is held; the held group is copied to
// `<groupPath>.held`.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [, , , groupPath] = process.argv;
const { renameSync } = fs;
const patchedFs = fs as { renameSync: typeof fs.renameSync };
patchedFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
  if (to === groupPath) {
    fs.writeFileSync(`${groupPath}.held`, fs.readFileSync(from));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(`${groupPath}.release`) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return renameSync(from, to);
}) as typeof fs.renameSync;
syncBuiltinESMExports();

await import("../sandbox-child.ts");

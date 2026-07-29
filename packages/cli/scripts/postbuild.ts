// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { chmod, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// package-info's declaration is deliberately hand-authored: its literal
// values are part of the public command-discovery contract. Keep it beside the
// emitted JS instead of publishing the source tree merely for this one type.
await copyFile(resolve(packageRoot, "src/package-info.d.ts"), resolve(packageRoot, "dist/src/package-info.d.ts"));

// TypeScript preserves the shebang text but does not promise the executable
// mode across all build hosts. The npm bin target must be executable before it
// is packed, so normalize that build artifact explicitly.
await chmod(resolve(packageRoot, "dist/bin/pdpp.js"), 0o755);

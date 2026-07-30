// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `src/ref/list-envelope.ts` from the single hand-authored
 * source, `packages/list-envelope/src/index.ts`. `@pdpp/cli` is a publicly
 * published npm package with zero runtime dependencies; it cannot depend on
 * `@pdpp/list-envelope` (a private, unpublished workspace package —
 * `workspace:*` has no resolvable version at publish time). This script
 * makes the CLI's copy a generated artifact of the shared source instead of
 * a second hand-maintained implementation that can silently drift.
 *
 * Runs before `tsc` in `pnpm build` (the compiled output needs the copy to
 * exist as source first). `scripts/check-generated-artifacts.ts` at the repo
 * root separately regenerates into a scratch path and byte-compares against
 * the tracked `src/ref/list-envelope.ts`, failing CI on any drift — that
 * check never mutates the tracked file itself (unlike this script, which
 * always writes it, by design, when run directly as part of `pnpm build`).
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked `src/ref/list-envelope.ts` (used by the drift check to render into
 * a scratch directory without touching the real file).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(packageRoot, "../list-envelope/src/index.ts");
const targetPath = process.argv[2] ? resolve(process.argv[2]) : resolve(packageRoot, "src/ref/list-envelope.ts");

const HEADER = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced verbatim from
// packages/list-envelope/src/index.ts by
// packages/cli/scripts/generate-list-envelope.ts (part of \`pnpm build\`).
// packages/cli publishes publicly with zero runtime deps, so it cannot
// import the private @pdpp/list-envelope workspace package directly; this
// generated copy is the CLI's only version of that validator, never a
// second hand-maintained implementation. scripts/check-generated-artifacts.ts
// fails CI if this file and the shared source ever diverge.

`;

const source = await readFile(sourcePath, "utf8");
const withoutOwnHeader = source.replace(/^\/\/ Copyright.*\n\/\/ SPDX-License-Identifier.*\n\n/, "");
await mkdir(dirname(targetPath), { recursive: true });
await writeFile(targetPath, HEADER + withoutOwnHeader);

#!/usr/bin/env node
// Fails when the committed dist/ does not match a fresh build of src/.
//
// Why this exists: `verify` rebuilds dist/ before validating it, so a source
// change committed WITHOUT rebuilding dist/ still passes verify while leaving
// stale committed artifacts behind. This guard rebuilds dist/ and asserts the
// working tree is unchanged afterward, making source/dist drift visible in CI
// and locally. See openspec/changes/republish-remote-surface-as-opendatalabs.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// git commands run with cwd: packageRoot; the pathspec is resolved relative to
// that directory while `git status` reports paths relative to the repo root.
const distPathspec = "dist";
const distRelative = "packages/remote-surface/dist";

async function git(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: packageRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

// Rebuild dist/ from src/. A clean, deterministic tsc build of unchanged source
// must reproduce the committed artifacts byte-for-byte.
await execFileAsync("pnpm", ["build"], { cwd: packageRoot, maxBuffer: 8 * 1024 * 1024 });

// Limit the drift comparison to the package's dist/ so an unrelated dirty file
// elsewhere in the worktree never trips this gate. Porcelain v1 lines are
// `XY PATH`, where XY is exactly two status columns — never trim before
// slicing, or a leading status space corrupts the first path.
const status = await git(["status", "--porcelain", "--", distPathspec]);

const drifted = status
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => line.slice(3));

if (drifted.length === 0) {
  process.stdout.write(`OK: ${distRelative} matches a fresh build of src/\n`);
  process.exit(0);
}

process.stderr.write(
  [
    `dist drift detected: ${distRelative} does not match a fresh build of src/.`,
    "",
    "A source change was committed without rebuilding dist/, or generated",
    "artifacts were hand-edited. Rebuild and commit the regenerated dist/:",
    "",
    "  pnpm --filter @opendatalabs/remote-surface build",
    `  git add ${distRelative}`,
    "",
    "Drifted files:",
    ...drifted.map((file) => `  ${file}`),
    "",
  ].join("\n"),
);
process.exit(1);

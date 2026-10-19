// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Per-checkout caches that outlive one test run.
//
// A test run gets a fresh scratch root, and `TMPDIR` points to it. tsx keeps its
// transform cache in `$TMPDIR/tsx-<uid>`, so every run started with an empty
// cache and every child process re-ran esbuild on the same files. Node's compile
// cache is off unless `NODE_COMPILE_CACHE` is set. Both caches live under
// `node_modules/.cache/pdpp-test/` in the checkout: they are removed with the
// checkout, never shared with another checkout, and keyed by file content:
// an edited file misses and is rebuilt. tsx and Node both also key on the file
// path, which is why a cache shared between checkouts would never hit.
//
// tsx drops entries after about eight days. Node never drops its own, so
// `pruneCompileCache` removes entries older than `COMPILE_CACHE_MAX_AGE_MS`.
// Concurrent runs may share a cache: Node writes entries through a rename, and
// tsx treats an unreadable (half-written) entry as a miss.
import { mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultCacheRoot = fileURLToPath(new URL("../../node_modules/.cache/pdpp-test", import.meta.url));
const COMPILE_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function compileCacheDirectory(cacheRoot = defaultCacheRoot): string {
  return join(cacheRoot, "node-compile");
}

// tsx names its cache directory `tsx-<effective uid>` under `os.tmpdir()`.
function tsxDirectoryName(): string {
  return `tsx-${process.geteuid?.() ?? userInfo().username}`;
}

/** Point the tsx cache of a scratch root at the checkout's persistent copy. Best effort. */
export function linkTransformCache(scratchRoot: string, cacheRoot = defaultCacheRoot): void {
  try {
    const target = join(cacheRoot, "tsx");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(scratchRoot, tsxDirectoryName()), "dir");
  } catch {
    // A missing cache costs time, never correctness.
  }
}

/** Remove compile-cache entries that no run has written for two weeks. Best effort. */
export function pruneCompileCache(now = Date.now(), cacheRoot = defaultCacheRoot): void {
  const root = compileCacheDirectory(cacheRoot);
  try {
    for (const generation of readdirSync(root, { withFileTypes: true })) {
      if (!generation.isDirectory()) {
        continue;
      }
      const directory = join(root, generation.name);
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (now - statSync(path).mtimeMs > COMPILE_CACHE_MAX_AGE_MS) {
          rmSync(path, { force: true });
        }
      }
    }
  } catch {
    // The directory may not exist yet, or a concurrent prune may have removed an entry.
  }
}

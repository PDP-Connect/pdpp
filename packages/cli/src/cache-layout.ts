// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PdppCacheLayout {
  clientsDir: string;
  credentialFile: (providerUrl: string) => string;
  gitignoreFile: string;
  root: string;
}

export function getPdppCacheLayout(cacheRoot = ".pdpp"): PdppCacheLayout {
  return {
    root: cacheRoot,
    clientsDir: join(cacheRoot, "clients"),
    gitignoreFile: join(cacheRoot, ".gitignore"),
    credentialFile: (providerUrl: string) => join(cacheRoot, "clients", `${providerCacheKey(providerUrl)}.json`),
  };
}

function providerCacheKey(providerUrl: string): string {
  const host = providerUrl.includes("://") ? new URL(providerUrl).host : providerUrl;
  return host.replace(/[^a-zA-Z0-9.-]/g, "_");
}

export function writePdppSecretFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export function getFileMode(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bitmask, not a && typo.
  return statSync(path).mode & 0o777;
}

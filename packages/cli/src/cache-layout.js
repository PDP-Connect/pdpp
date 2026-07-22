// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function getPdppCacheLayout(cacheRoot = '.pdpp') {
  return {
    root: cacheRoot,
    clientsDir: join(cacheRoot, 'clients'),
    gitignoreFile: join(cacheRoot, '.gitignore'),
    credentialFile: (providerUrl) => join(cacheRoot, 'clients', `${providerCacheKey(providerUrl)}.json`),
  };
}

function providerCacheKey(providerUrl) {
  const host = providerUrl.includes('://') ? new URL(providerUrl).host : providerUrl;
  return host.replace(/[^a-zA-Z0-9.-]/g, '_');
}

export function writePdppSecretFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export function getFileMode(path) {
  return statSync(path).mode & 0o777;
}

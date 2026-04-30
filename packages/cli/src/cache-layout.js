import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function getPdppCacheLayout(cacheRoot = '.pdpp') {
  return {
    root: cacheRoot,
    clientsDir: join(cacheRoot, 'clients'),
    grantsDir: join(cacheRoot, 'grants'),
    secretsDir: join(cacheRoot, 'secrets'),
    accessFile: join(cacheRoot, 'agent-access.json'),
    secretFile: (name) => join(cacheRoot, 'secrets', `${name}.secret`),
  };
}

export function writePdppSecretFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export function getFileMode(path) {
  return statSync(path).mode & 0o777;
}

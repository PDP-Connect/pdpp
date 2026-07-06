import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const temporaryDirs = new Set();

export function makeTemporaryDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.add(dir);
  return dir;
}

export function makeTemporaryDbPath(prefix) {
  return join(makeTemporaryDir(prefix), 'pdpp.sqlite');
}

export function removeTemporaryDir(dir) {
  temporaryDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

after(() => {
  for (const dir of [...temporaryDirs].reverse()) {
    removeTemporaryDir(dir);
  }
});

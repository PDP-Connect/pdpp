import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PDPP_REFERENCE_REVISION_HEADER = 'PDPP-Reference-Revision';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(SERVER_DIR, '..', 'package.json');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).trim();
  } catch {
    return '';
  }
}

function readGitRevision() {
  const sha = gitOutput(['rev-parse', '--short=12', 'HEAD']);
  if (!sha) {
    return 'unknown';
  }

  const dirty = gitOutput(['status', '--porcelain']) ? '.dirty' : '';
  return `${sha}${dirty}`;
}

function normalizeHeaderValue(value) {
  return String(value)
    .trim()
    .replace(/[^\t\x20-\x7e]/g, '')
    .replace(/\s+/g, '-');
}

export function resolveReferenceRevision(opts = {}) {
  const explicit = opts.referenceRevision || process.env.PDPP_REFERENCE_REVISION;
  if (typeof explicit === 'string' && explicit.trim()) {
    const normalized = normalizeHeaderValue(explicit);
    if (normalized) {
      return normalized;
    }
  }

  const packageVersion = readPackageVersion();
  const gitRevision = readGitRevision();
  return `pdpp-reference@${packageVersion}+${gitRevision}`;
}

export function setReferenceRevisionHeader(res, referenceRevision) {
  res.setHeader(PDPP_REFERENCE_REVISION_HEADER, referenceRevision);
}

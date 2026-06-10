import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const OPENSPEC_ROOT = path.join(REPO_ROOT, 'openspec');
const OUTPUT_DIR = path.join(APP_ROOT, '.generated');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'openspec-git-metadata.json');

async function walkMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkMarkdownFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(absolutePath);
    }
  }

  return results.sort();
}

async function runGit(args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function statIso(repoRelativePath) {
  try {
    const stat = await fs.stat(path.join(REPO_ROOT, repoRelativePath));
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function gitDatesFor(repoRelativePath) {
  const [createdLog, updatedLog] = await Promise.all([
    runGit(['log', '--follow', '--diff-filter=A', '--format=%aI', '--', repoRelativePath]),
    runGit(['log', '-1', '--format=%aI', '--', repoRelativePath]),
  ]);

  const createdAt = createdLog
    ? createdLog.split('\n').filter(Boolean).at(-1) ?? null
    : null;
  const updatedAt = updatedLog || null;
  const tracked = Boolean(createdAt || updatedAt);

  if (tracked) {
    return { createdAt, updatedAt, tracked: true, source: 'git' };
  }

  const fallback = await statIso(repoRelativePath);
  return {
    createdAt: fallback,
    updatedAt: fallback,
    tracked: false,
    source: 'filesystem',
  };
}

async function main() {
  const markdownFiles = await walkMarkdownFiles(OPENSPEC_ROOT);
  const repoRelativePaths = markdownFiles.map((absolutePath) =>
    path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/'),
  );

  const files = {};
  for (const repoRelativePath of repoRelativePaths) {
    files[repoRelativePath] = await gitDatesFor(repoRelativePath);
  }

  const shallow = (await runGit(['rev-parse', '--is-shallow-repository'])) === 'true';

  const manifest = {
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    shallow,
    files,
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

await main();

import { readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const testDir = join(repoRoot, 'test');
const forwardedArgs = process.argv.slice(2);
const effectiveArgs = forwardedArgs.includes('--test-force-exit')
  ? forwardedArgs
  : ['--test-force-exit', ...forwardedArgs];
const requestedConcurrency = Number.parseInt(process.env.PDPP_TEST_CONCURRENCY || '', 10);

function runNodeTest(filePath, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...extraArgs, filePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PDPP_RUNTIME_QUIET: process.env.PDPP_RUNTIME_QUIET || '1',
      },
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Test process for ${filePath} exited via signal ${signal}`));
        return;
      }
      resolve({
        filePath,
        exitCode: code ?? 1,
        output: `\n==> ${filePath}\n${output}`,
      });
    });
  });
}

const entries = await readdir(testDir, { withFileTypes: true });
const topLevelTests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => join('test', entry.name));

// Co-located unit tests for focused server modules. The discovery is
// intentionally narrow (one directory) to keep the runner deterministic and
// fast; broaden if more co-located tests appear.
const COLOCATED_TEST_DIRS = [join('server', 'streaming')];
const colocatedTests = [];
for (const relDir of COLOCATED_TEST_DIRS) {
  const absDir = join(repoRoot, relDir);
  let dirEntries;
  try {
    dirEntries = await readdir(absDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of dirEntries) {
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      colocatedTests.push(join(relDir, entry.name));
    }
  }
}

const testFiles = [...topLevelTests, ...colocatedTests].sort();
const defaultConcurrency = Math.max(
  1,
  Math.min(2, availableParallelism?.() ?? 1, testFiles.length || 1),
);
const fileConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? requestedConcurrency
  : defaultConcurrency;

const queue = [...testFiles];
const results = [];

async function worker() {
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) return;
    const result = await runNodeTest(file, effectiveArgs);
    results.push(result);
    process.stdout.write(result.output);
  }
}

await Promise.all(Array.from({ length: fileConcurrency }, () => worker()));

const failed = results.find((result) => result.exitCode !== 0);
if (failed) {
  process.exit(failed.exitCode);
}

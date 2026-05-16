import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COLLECTOR_HELP, runCollector } from '../src/collector/commands.js';
import { CollectorUsageError } from '../src/collector/errors.js';
import { resolveCollectorRunnerScript, resolveTsxBinary, spawnCollectorRunner } from '../src/collector/runner.js';

const binPath = fileURLToPath(new URL('../bin/pdpp.js', import.meta.url));

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test('collector help lists the three subcommands and operator flow', async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  assert.match(io.stdout, /pdpp collector advertise/);
  assert.match(io.stdout, /pdpp collector enroll/);
  assert.match(io.stdout, /pdpp collector run/);
  assert.match(io.stdout, /Suggested operator flow/);
  assert.match(io.stdout, /device-scoped/);
});

test('collector help states the monorepo requirement and Distribution follow-up', async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // Operators must know the runner is not in the @pdpp/cli tarball.
  assert.match(io.stdout, /Distribution requirement/);
  assert.match(io.stdout, /requires a PDPP monorepo checkout/);
  assert.match(io.stdout, /not in the @pdpp\/cli npm/);
  assert.match(io.stdout, /Distribution follow-up/);
  assert.match(io.stdout, /openspec\/changes\/introduce-local-collector-runner\/design\.md/);
});

test('collector help names device_id, device_token, and source_instance_id from enroll', async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // Enrollment returns three values; help must surface all three so
  // operators don't hit "<source_instance_id>" later with no provenance.
  assert.match(io.stdout, /device_id/);
  assert.match(io.stdout, /device_token/);
  assert.match(io.stdout, /source_instance_id/);
});

test('top-level help advertises the collector namespace', async () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pdpp collector advertise/);
  assert.match(result.stdout, /pdpp collector enroll/);
});

test('unknown collector subcommand exits 64 with help', async () => {
  const io = makeIo();
  const code = await runCollector(['frobnicate'], io.io);
  assert.equal(code, 64);
  assert.match(io.stderr, /Unknown collector subcommand: frobnicate/);
  assert.match(io.stderr, /pdpp collector run/);
});

test('runner resolver walks up to the workspace root', () => {
  // From inside the CLI src, the resolver must find packages/polyfill-connectors/bin/collector-runner.ts.
  const cliSrcDir = fileURLToPath(new URL('../src/collector/', import.meta.url));
  const script = resolveCollectorRunnerScript(cliSrcDir);
  assert.ok(script, 'expected to resolve a collector-runner script from inside the workspace');
  assert.match(script, /packages\/polyfill-connectors\/bin\/collector-runner\.ts$/);
});

test('runner resolver returns null outside any workspace', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'pdpp-collector-isolated-'));
  const script = resolveCollectorRunnerScript(tmp);
  assert.equal(script, null);
});

test('spawnCollectorRunner throws actionable error when runner is missing', async () => {
  await assert.rejects(
    () =>
      spawnCollectorRunner('advertise', [], {
        runnerScript: null,
        tsxBinary: '/fake/tsx',
        spawnFn: () => {
          throw new Error('should not spawn');
        },
      }),
    (err) => {
      assert.ok(err instanceof CollectorUsageError);
      // Names the distribution-contract follow-up so operators know it's intentional.
      assert.match(err.message, /Distribution follow-up/);
      assert.match(err.message, /introduce-local-collector-runner/);
      // Walks the operator through the remote-deployment monorepo flow.
      assert.match(err.message, /git clone https:\/\/github.com\/vana-com\/pdpp\.git/);
      assert.match(err.message, /pnpm install/);
      assert.match(err.message, /pdpp collector advertise/);
      assert.match(err.message, /pdpp collector enroll/);
      assert.match(err.message, /pdpp collector run --connector claude_code/);
      // Enrollment returns three values, not two — name all of them so
      // the later <source_instance_id> placeholder has provenance.
      assert.match(err.message, /device_id/);
      assert.match(err.message, /device_token/);
      assert.match(err.message, /source_instance_id/);
      return true;
    },
  );
});

test('spawnCollectorRunner throws actionable error when tsx is missing', async () => {
  await assert.rejects(
    () =>
      spawnCollectorRunner('advertise', [], {
        runnerScript: '/some/runner.ts',
        tsxBinary: null,
        spawnFn: () => {
          throw new Error('should not spawn');
        },
      }),
    /Could not locate tsx alongside the collector runner/,
  );
});

test('spawnCollectorRunner forwards subcommand, args, env, and exit code', async () => {
  const spawned = [];
  const fakeSpawn = (binary, args, options) => {
    spawned.push({ binary, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 7, null));
    return child;
  };

  const code = await spawnCollectorRunner(
    'run',
    ['--base-url', 'http://x', '--connector', 'codex'],
    {
      runnerScript: '/runner.ts',
      tsxBinary: '/tsx',
      spawnFn: fakeSpawn,
      env: { PDPP_LOCAL_DEVICE_TOKEN: 'tok' },
      stdio: 'pipe',
    },
  );

  assert.equal(code, 7);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, '/tsx');
  assert.deepEqual(spawned[0].args, ['/runner.ts', 'run', '--base-url', 'http://x', '--connector', 'codex']);
  assert.equal(spawned[0].options.env.PDPP_LOCAL_DEVICE_TOKEN, 'tok');
  assert.equal(spawned[0].options.stdio, 'pipe');
});

test('spawnCollectorRunner rejects when child terminates by signal', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return child;
  };

  await assert.rejects(
    () =>
      spawnCollectorRunner('advertise', [], {
        runnerScript: '/runner.ts',
        tsxBinary: '/tsx',
        spawnFn: fakeSpawn,
      }),
    /terminated by signal SIGTERM/,
  );
});

test('runCli dispatches `collector` to the runner', async () => {
  const calls = [];
  const fakeSpawn = (binary, args) => {
    calls.push({ binary, args });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };

  // Hijack the resolver via env: we know they exist in the workspace.
  const runnerScript = resolveCollectorRunnerScript();
  const tsxBinary = resolveTsxBinary();
  assert.ok(runnerScript, 'expected workspace collector-runner script to exist');
  assert.ok(tsxBinary, 'expected workspace tsx to exist');

  // Drive via runCollector directly to inject spawnFn.
  const io = makeIo();
  const code = await runCollector(['advertise'], io.io).catch((err) => {
    throw err;
  });
  // The default flow really spawns tsx + the runner; we only assert exit code
  // and that the help string was not mistakenly emitted.
  assert.equal(code, 0);
  assert.equal(io.stdout, '');

  // Sanity-check the spawn-injection contract through the lower-level entry.
  const injectedCode = await spawnCollectorRunner('advertise', [], {
    runnerScript,
    tsxBinary,
    spawnFn: fakeSpawn,
    stdio: 'pipe',
  });
  assert.equal(injectedCode, 0);
  assert.equal(calls[0].binary, tsxBinary);
  assert.equal(calls[0].args[0], runnerScript);
  assert.equal(calls[0].args[1], 'advertise');
});

test('pdpp collector advertise (real subprocess) emits the capability profile', () => {
  // End-to-end: spawn the published bin, let it spawn the workspace runner,
  // verify the JSON profile reaches stdout.
  const result = spawnSync(process.execPath, [binPath, 'collector', 'advertise'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runtime, 'collector');
  assert.deepEqual(parsed.bindings.sort(), ['browser', 'filesystem', 'local_device', 'network']);
});

test('pdpp collector enroll missing --code surfaces collector-runner usage error', () => {
  const result = spawnSync(
    process.execPath,
    [binPath, 'collector', 'enroll', '--base-url', 'http://127.0.0.1:1'],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enroll requires --code/);
});

test('COLLECTOR_HELP names the openspec design doc as source of truth', () => {
  assert.match(COLLECTOR_HELP, /openspec\/changes\/introduce-local-collector-runner/);
});

test('runner resolver prefers the nearest workspace, not a stray ancestor', async () => {
  // If `pdpp` is checked out as a nested submodule, the resolver should find
  // packages/polyfill-connectors/bin/collector-runner.ts in the NEAREST workspace
  // root, not the outer one.
  const outer = await mkdtemp(join(tmpdir(), 'pdpp-collector-outer-'));
  await mkdir(join(outer, 'packages', 'polyfill-connectors', 'bin'), { recursive: true });
  await writeFile(join(outer, 'packages', 'polyfill-connectors', 'bin', 'collector-runner.ts'), '');
  const inner = join(outer, 'nested-app', 'packages', 'polyfill-connectors', 'bin');
  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, 'collector-runner.ts'), '');

  const startDir = join(outer, 'nested-app', 'src');
  await mkdir(startDir, { recursive: true });
  const resolved = resolveCollectorRunnerScript(startDir);
  assert.equal(resolved, join(inner, 'collector-runner.ts'));
});

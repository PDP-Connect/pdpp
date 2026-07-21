// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import {
  resolveCollectorRunnerScript,
  resolveLocalCollectorPackage,
  resolveTsxBinary,
  spawnCollectorRunner,
} from '../src/collector/runner.js';

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

test('collector help advertises the published @pdpp/local-collector path', async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // The supported public path is the npm-installable runner, not a monorepo clone.
  assert.match(io.stdout, /@pdpp\/local-collector/);
  assert.match(io.stdout, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
  assert.doesNotMatch(io.stdout, /monorepo only/i);
  assert.doesNotMatch(io.stdout, /git clone/);
});

test('collector help names device_id, device_token, and connection id from enroll', async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // Enrollment still returns source_instance_id, but operator-facing run
  // commands should name it as the local connection id.
  assert.match(io.stdout, /device_id/);
  assert.match(io.stdout, /device_token/);
  assert.match(io.stdout, /source_instance_id/);
  assert.match(io.stdout, /PDPP_CONNECTION_ID/);
  assert.match(io.stdout, /--connection-id/);
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

test('@pdpp/local-collector resolver resolves the workspace package', () => {
  const cliSrcDir = fileURLToPath(new URL('../src/collector/', import.meta.url));
  const resolved = resolveLocalCollectorPackage(cliSrcDir);
  assert.ok(resolved, 'expected to resolve @pdpp/local-collector via workspace deps');
  // Either Node-resolved (@pdpp/local-collector under node_modules) or the
  // monorepo workspace fallback (packages/local-collector) is acceptable.
  assert.match(
    resolved.manifestPath,
    /(?:@pdpp[\\/]+local-collector|packages[\\/]+local-collector)[\\/]+package\.json$/,
  );
  assert.ok(resolved.packageDir.endsWith('local-collector'));
});

test('spawnCollectorRunner throws actionable install hint when nothing resolves', async () => {
  await assert.rejects(
    () =>
      spawnCollectorRunner('advertise', [], {
        runnerScript: null,
        localCollector: null,
        tsxBinary: '/fake/tsx',
        spawnFn: () => {
          throw new Error('should not spawn');
        },
      }),
    (err) => {
      assert.ok(err instanceof CollectorUsageError);
      assert.match(err.message, /@pdpp\/local-collector/);
      assert.match(err.message, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
      return true;
    },
  );
});

test('spawnCollectorRunner throws actionable error when tsx is missing', async () => {
  await assert.rejects(
    () =>
      spawnCollectorRunner('advertise', [], {
        runnerScript: '/some/runner.ts',
        localCollector: null,
        tsxBinary: null,
        spawnFn: () => {
          throw new Error('should not spawn');
        },
      }),
    /Could not locate tsx/,
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
      localCollector: null,
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

test('spawnCollectorRunner prefers monorepo runner over @pdpp/local-collector', async () => {
  const spawned = [];
  const fakeSpawn = (binary, args, options) => {
    spawned.push({ binary, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };

  await spawnCollectorRunner('advertise', [], {
    runnerScript: '/monorepo/runner.ts',
    localCollector: { manifestPath: '/lc/package.json', packageDir: '/lc' },
    tsxBinary: '/tsx',
    spawnFn: fakeSpawn,
    stdio: 'pipe',
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], '/monorepo/runner.ts');
});

test('spawnCollectorRunner falls back to @pdpp/local-collector when monorepo runner is absent', async () => {
  // Create a fake local-collector package on disk so existsSync in the
  // resolver finds its bin file.
  const dir = await mkdtemp(join(tmpdir(), 'pdpp-fake-local-collector-'));
  await mkdir(join(dir, 'dist', 'local-collector', 'bin'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ bin: { 'pdpp-local-collector': 'dist/local-collector/bin/pdpp-local-collector.js' } }),
  );
  await writeFile(join(dir, 'dist', 'local-collector', 'bin', 'pdpp-local-collector.js'), '');

  const spawned = [];
  const fakeSpawn = (binary, args, options) => {
    spawned.push({ binary, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };

  await spawnCollectorRunner('advertise', [], {
    runnerScript: null,
    localCollector: { manifestPath: join(dir, 'package.json'), packageDir: dir },
    tsxBinary: '/tsx',
    spawnFn: fakeSpawn,
    stdio: 'pipe',
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, process.execPath);
  assert.equal(spawned[0].args[0], join(dir, 'dist', 'local-collector', 'bin', 'pdpp-local-collector.js'));
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
        localCollector: null,
        tsxBinary: '/tsx',
        spawnFn: fakeSpawn,
      }),
    /terminated by signal SIGTERM/,
  );
});

test('runCli dispatches `collector` to the runner', async () => {
  const runnerScript = resolveCollectorRunnerScript();
  const tsxBinary = resolveTsxBinary();
  assert.ok(runnerScript, 'expected workspace collector-runner script to exist');
  assert.ok(tsxBinary, 'expected workspace tsx to exist');

  const io = makeIo();
  const code = await runCollector(['advertise'], io.io);
  assert.equal(code, 0);
  assert.equal(io.stdout, '');
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
  assert.match(COLLECTOR_HELP, /openspec\/changes\/publish-pdpp-local-collector/);
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

test('@pdpp/cli does not declare a runtime dependency on @pdpp/local-collector', async () => {
  // The shim resolves the runner lazily; declaring it as a runtime dependency
  // would re-couple slim @pdpp/cli to the runner's release cadence.
  const manifest = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    ),
  );
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (manifest[field] && '@pdpp/local-collector' in manifest[field]) {
      assert.fail(
        `@pdpp/cli must not declare @pdpp/local-collector in ${field}; the shim resolves it lazily.`,
      );
    }
  }
});

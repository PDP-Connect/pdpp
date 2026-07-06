/**
 * Mutation-killing coverage for `runtime/scheduler-readiness.ts`, which had no
 * test importing it. `defaultReadinessChecker` gates whether the scheduler may
 * dispatch an unattended automatic run; each early-return `{ ready: false }`
 * branch is a real fail-closed decision worth pinning:
 *
 *   - external tool detect-command fails      -> missing-tool reason (+ hint)
 *   - external tool detect-command passes / no detect command -> ready
 *   - slackdump binary probe (SLACKDUMP_BIN) fails -> missing-tool reason
 *   - browser binding required but no surface configured -> not ready
 *   - browser opt-in env (PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES=1) -> ready
 *   - first-party local-source (codex / claude-code) path missing -> not ready
 *   - filesystem binding not required -> local-source check is skipped
 *
 * The tool-detect branches use portable `exit N` shell commands; every test
 * saves and restores the exact env vars it manipulates so the checks stay
 * deterministic regardless of ambient environment.
 *
 * No grant/auth/token/consent logic is touched — this is dispatch-readiness
 * gating only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultReadinessChecker } from '../runtime/scheduler-readiness.ts';

const BROWSER_ENV_KEYS = [
  'PDPP_BROWSER_SURFACE_REMOTE_CDP_URL',
  'PDPP_NEKO_CDP_HTTP_URL',
  'PDPP_NEKO_MANAGED_CONNECTORS',
  'PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES',
];

const LOCAL_SOURCE_ENV_KEYS = [
  'CODEX_HOME',
  'CODEX_SESSIONS_DIR',
  'CODEX_STATE_DB',
  'CLAUDE_CODE_HOME',
  'CLAUDE_CODE_PROJECTS_DIR',
  'SLACKDUMP_BIN',
];

function withEnv(overrides, fn) {
  const keys = [...new Set([...BROWSER_ENV_KEYS, ...LOCAL_SOURCE_ENV_KEYS, ...Object.keys(overrides)])];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  // Clear all managed keys, then apply the overrides for this scenario.
  for (const k of keys) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function schedule(connectorId, runtimeRequirements) {
  return { connectorId, manifest: { runtime_requirements: runtimeRequirements } };
}

// ─── external_tools detect ───────────────────────────────────────────────

test('defaultReadinessChecker is ready for a manifest with no requirements', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker({ connectorId: 'gmail', manifest: {} });
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker reports the missing-tool reason with the install hint', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker(
      schedule('gmail', {
        external_tools: [
          {
            name: 'faketool',
            detect: { executable: 'pdpp-faketool-that-should-not-exist', exit_code: 0 },
            install_hint: 'brew install faketool',
          },
        ],
      }),
    );
    assert.equal(result.ready, false);
    assert.match(result.reason, /required external tool faketool is not available\./);
    assert.match(result.reason, /brew install faketool/);
  }));

test('defaultReadinessChecker is ready when the detect command exits with the expected code', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker(
      schedule('gmail', {
        external_tools: [
          { name: 'faketool', detect: { executable: process.execPath, args: ['-e', 'process.exit(0)'], exit_code: 0 } },
        ],
      }),
    );
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker treats a tool with no detect command as available', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker(schedule('gmail', { external_tools: [{ name: 'x' }] }));
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker probes SLACKDUMP_BIN and reports it missing when the binary is absent', () =>
  withEnv({ SLACKDUMP_BIN: '/nonexistent/pdpp-test/slackdump-xyz' }, async () => {
    const result = await defaultReadinessChecker(
      schedule('slack', {
        external_tools: [
          { name: 'slackdump', detect: { command: 'exit 0', exit_code: 0 }, install_hint: 'install slackdump' },
        ],
      }),
    );
    assert.equal(result.ready, false);
    assert.match(result.reason, /slackdump is not available/);
  }));

// ─── browser surface ─────────────────────────────────────────────────────

test('defaultReadinessChecker fails closed when a browser binding is required but no surface is configured', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker(schedule('gmail', { bindings: { browser: { required: true } } }));
    assert.equal(result.ready, false);
    assert.match(result.reason, /required browser runtime is not configured/);
  }));

test('defaultReadinessChecker accepts a required browser binding under the unmanaged opt-in', () =>
  withEnv({ PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES: '1' }, async () => {
    const result = await defaultReadinessChecker(schedule('gmail', { bindings: { browser: { required: true } } }));
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker accepts a required browser binding when a remote CDP surface is set', () =>
  withEnv({ PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: 'http://127.0.0.1:9222' }, async () => {
    const result = await defaultReadinessChecker(schedule('gmail', { bindings: { browser: { required: true } } }));
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker ignores a browser binding that is not required', () =>
  withEnv({}, async () => {
    const result = await defaultReadinessChecker(schedule('gmail', { bindings: { browser: { required: false } } }));
    assert.deepEqual(result, { ready: true });
  }));

// ─── first-party local-source readiness ──────────────────────────────────

test('defaultReadinessChecker reports missing Codex local source paths when filesystem is required', () =>
  withEnv(
    {
      CODEX_SESSIONS_DIR: '/nonexistent/pdpp-test/sessions-xyz',
      CODEX_STATE_DB: '/nonexistent/pdpp-test/state-xyz.sqlite',
    },
    async () => {
      const result = await defaultReadinessChecker(schedule('codex', { bindings: { filesystem: { required: true } } }));
      assert.equal(result.ready, false);
      assert.match(result.reason, /Codex local source path\(s\) are missing or unreadable/);
      assert.match(result.reason, /sessions-xyz/);
    },
  ));

test('defaultReadinessChecker is ready for Codex when its local source paths exist', () =>
  withEnv({ CODEX_SESSIONS_DIR: '/tmp', CODEX_STATE_DB: '/tmp' }, async () => {
    const result = await defaultReadinessChecker(schedule('codex', { bindings: { filesystem: { required: true } } }));
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker reports a missing Claude Code projects dir when filesystem is required', () =>
  withEnv({ CLAUDE_CODE_PROJECTS_DIR: '/nonexistent/pdpp-test/projects-xyz' }, async () => {
    const result = await defaultReadinessChecker(
      schedule('claude-code', { bindings: { filesystem: { required: true } } }),
    );
    assert.equal(result.ready, false);
    assert.match(result.reason, /Claude Code local source path is missing or unreadable/);
  }));

test('defaultReadinessChecker skips the local-source check when filesystem is not required', () =>
  withEnv({ CODEX_SESSIONS_DIR: '/nonexistent/pdpp-test/sessions-xyz' }, async () => {
    // filesystem binding absent -> checkFirstPartyLocalSourceReadiness returns null.
    const result = await defaultReadinessChecker(schedule('codex', {}));
    assert.deepEqual(result, { ready: true });
  }));

test('defaultReadinessChecker returns ready for a non-first-party connector even with filesystem required', () =>
  withEnv({}, async () => {
    // gmail is not codex/claude-code, so the local-source branch returns null.
    const result = await defaultReadinessChecker(schedule('gmail', { bindings: { filesystem: { required: true } } }));
    assert.deepEqual(result, { ready: true });
  }));

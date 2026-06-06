// Offline tests for the Fly.io deploy env-contract preflight.
// Zero external dependencies. Run: node --test scripts/check-flyio-deploy-env.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPlaceholder,
  isFlyInternalUrl,
  parseEnv,
  evaluateFlyioDeployEnv,
} from './check-flyio-deploy-env.mjs';

// ---------------------------------------------------------------------------
// isPlaceholder
// ---------------------------------------------------------------------------
describe('isPlaceholder', () => {
  it('returns true for undefined', () => assert.equal(isPlaceholder(undefined), true));
  it('returns true for null', () => assert.equal(isPlaceholder(null), true));
  it('returns true for empty string', () => assert.equal(isPlaceholder(''), true));
  it('returns true for whitespace', () => assert.equal(isPlaceholder('   '), true));
  it('returns true for angle-bracket placeholder', () =>
    assert.equal(isPlaceholder('<app-name>'), true));
  it('returns false for a real HTTPS origin', () =>
    assert.equal(isPlaceholder('https://myapp.fly.dev'), false));
  it('returns false for a real password', () =>
    assert.equal(isPlaceholder('s3cr3t!'), false));
});

// ---------------------------------------------------------------------------
// isFlyInternalUrl
// ---------------------------------------------------------------------------
describe('isFlyInternalUrl', () => {
  it('accepts *.internal with correct port', () =>
    assert.equal(isFlyInternalUrl('http://pdpp-reference.internal:7662', 7662), true));
  it('accepts *.internal RS port', () =>
    assert.equal(isFlyInternalUrl('http://pdpp-reference.internal:7663', 7663), true));
  it('rejects wrong port', () =>
    assert.equal(isFlyInternalUrl('http://pdpp-reference.internal:7662', 7663), false));
  it('rejects https', () =>
    assert.equal(isFlyInternalUrl('https://pdpp-reference.internal:7662', 7662), false));
  it('rejects public hostname', () =>
    assert.equal(isFlyInternalUrl('http://pdpp-reference.fly.dev:7662', 7662), false));
  it('rejects localhost', () =>
    assert.equal(isFlyInternalUrl('http://localhost:7662', 7662), false));
  it('rejects placeholder', () =>
    assert.equal(isFlyInternalUrl('<reference-app>.internal:7662', 7662), false));
  it('rejects Railway private domain syntax', () =>
    assert.equal(
      isFlyInternalUrl('http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7662', 7662),
      false,
    ));
});

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------
describe('parseEnv', () => {
  it('parses KEY=value lines', () => {
    const env = parseEnv('FOO=bar\nBAZ=qux\n');
    assert.deepEqual(env, { FOO: 'bar', BAZ: 'qux' });
  });
  it('strips # comments', () => {
    const env = parseEnv('# comment\nFOO=bar\n');
    assert.deepEqual(env, { FOO: 'bar' });
  });
  it('strips double quotes', () => {
    const env = parseEnv('FOO="bar baz"\n');
    assert.equal(env.FOO, 'bar baz');
  });
  it('strips single quotes', () => {
    const env = parseEnv("FOO='bar baz'\n");
    assert.equal(env.FOO, 'bar baz');
  });
  it('ignores blank lines', () => {
    const env = parseEnv('\nFOO=bar\n\n');
    assert.deepEqual(env, { FOO: 'bar' });
  });
  it('handles values with equals signs', () => {
    const env = parseEnv('FOO=postgres://user:pass@host/db?sslmode=require\n');
    assert.equal(env.FOO, 'postgres://user:pass@host/db?sslmode=require');
  });
});

// ---------------------------------------------------------------------------
// evaluateFlyioDeployEnv — valid config
// ---------------------------------------------------------------------------

function validConsoleEnv() {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp-console.fly.dev',
    PDPP_AS_URL: 'http://pdpp-reference.internal:7662',
    PDPP_RS_URL: 'http://pdpp-reference.internal:7663',
    PDPP_OWNER_PASSWORD: 'supersecret',
    PDPP_DATABASE_URL: 'postgres://user:pass@localhost/pdpp',
  };
}

function validReferenceEnv() {
  return {
    PDPP_REFERENCE_ORIGIN: 'https://pdpp-console.fly.dev',
    PDPP_OWNER_PASSWORD: 'supersecret',
    PDPP_DATABASE_URL: 'postgres://user:pass@localhost/pdpp',
  };
}

describe('evaluateFlyioDeployEnv — valid config', () => {
  it('returns no violations for a fully valid config', () => {
    const violations = evaluateFlyioDeployEnv(validConsoleEnv(), validReferenceEnv());
    assert.deepEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// evaluateFlyioDeployEnv — PDPP_REFERENCE_ORIGIN
// ---------------------------------------------------------------------------
describe('evaluateFlyioDeployEnv — PDPP_REFERENCE_ORIGIN', () => {
  it('violations when missing on console', () => {
    const env = validConsoleEnv();
    delete env.PDPP_REFERENCE_ORIGIN;
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_REFERENCE_ORIGIN') && s.includes('console app')));
  });

  it('violations when missing on reference', () => {
    const env = validReferenceEnv();
    delete env.PDPP_REFERENCE_ORIGIN;
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), env);
    assert.ok(v.some((s) => s.includes('PDPP_REFERENCE_ORIGIN') && s.includes('reference app')));
  });

  it('violations when not HTTPS on console', () => {
    const env = validConsoleEnv();
    env.PDPP_REFERENCE_ORIGIN = 'http://pdpp-console.fly.dev';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('https://')));
  });

  it('violations when not HTTPS on reference', () => {
    const refEnv = validReferenceEnv();
    refEnv.PDPP_REFERENCE_ORIGIN = 'http://pdpp-console.fly.dev';
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), refEnv);
    assert.ok(v.some((s) => s.includes('https://')));
  });

  it('violations when origins mismatch', () => {
    const refEnv = validReferenceEnv();
    refEnv.PDPP_REFERENCE_ORIGIN = 'https://different-app.fly.dev';
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), refEnv);
    assert.ok(v.some((s) => s.includes('must match')));
  });
});

// ---------------------------------------------------------------------------
// evaluateFlyioDeployEnv — PDPP_OWNER_PASSWORD
// ---------------------------------------------------------------------------
describe('evaluateFlyioDeployEnv — PDPP_OWNER_PASSWORD', () => {
  it('violations when empty on console', () => {
    const env = validConsoleEnv();
    env.PDPP_OWNER_PASSWORD = '';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_OWNER_PASSWORD') && s.includes('console app')));
  });

  it('violations when empty on reference', () => {
    const refEnv = validReferenceEnv();
    refEnv.PDPP_OWNER_PASSWORD = '';
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), refEnv);
    assert.ok(v.some((s) => s.includes('PDPP_OWNER_PASSWORD') && s.includes('reference app')));
  });

  it('violations when passwords differ', () => {
    const refEnv = validReferenceEnv();
    refEnv.PDPP_OWNER_PASSWORD = 'different-secret';
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), refEnv);
    assert.ok(v.some((s) => s.includes('PDPP_OWNER_PASSWORD') && s.includes('differ')));
  });
});

// ---------------------------------------------------------------------------
// evaluateFlyioDeployEnv — PDPP_AS_URL / PDPP_RS_URL
// ---------------------------------------------------------------------------
describe('evaluateFlyioDeployEnv — AS/RS URLs', () => {
  it('violations when PDPP_AS_URL missing', () => {
    const env = validConsoleEnv();
    delete env.PDPP_AS_URL;
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_AS_URL')));
  });

  it('violations when PDPP_RS_URL missing', () => {
    const env = validConsoleEnv();
    delete env.PDPP_RS_URL;
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_RS_URL')));
  });

  it('violations when PDPP_AS_URL uses public hostname', () => {
    const env = validConsoleEnv();
    env.PDPP_AS_URL = 'http://pdpp-reference.fly.dev:7662';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_AS_URL') && s.includes('*.internal')));
  });

  it('violations when PDPP_RS_URL uses localhost', () => {
    const env = validConsoleEnv();
    env.PDPP_RS_URL = 'http://localhost:7663';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_RS_URL') && s.includes('*.internal')));
  });

  it('violations when PDPP_AS_URL uses Railway private domain syntax', () => {
    const env = validConsoleEnv();
    env.PDPP_AS_URL = 'http://${{reference.RAILWAY_PRIVATE_DOMAIN}}:7662';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_AS_URL') && s.includes('*.internal')));
  });
});

// ---------------------------------------------------------------------------
// evaluateFlyioDeployEnv — PDPP_DATABASE_URL
// ---------------------------------------------------------------------------
describe('evaluateFlyioDeployEnv — PDPP_DATABASE_URL', () => {
  it('violations when missing on console', () => {
    const env = validConsoleEnv();
    delete env.PDPP_DATABASE_URL;
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_DATABASE_URL') && s.includes('console app')));
  });

  it('violations when missing on reference', () => {
    const refEnv = validReferenceEnv();
    delete refEnv.PDPP_DATABASE_URL;
    const v = evaluateFlyioDeployEnv(validConsoleEnv(), refEnv);
    assert.ok(v.some((s) => s.includes('PDPP_DATABASE_URL') && s.includes('reference app')));
  });

  it('violations when set to placeholder on console', () => {
    const env = validConsoleEnv();
    env.PDPP_DATABASE_URL = '<postgres-connection-string>';
    const v = evaluateFlyioDeployEnv(env, validReferenceEnv());
    assert.ok(v.some((s) => s.includes('PDPP_DATABASE_URL') && s.includes('console app')));
  });
});

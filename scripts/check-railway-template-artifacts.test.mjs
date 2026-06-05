import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('Railway service configs use template-safe Dockerfile paths', () => {
  const consoleConfig = readJson('deploy/railway/railway.console.json');
  const referenceConfig = readJson('deploy/railway/railway.reference.json');

  assert.equal(consoleConfig.build.builder, 'DOCKERFILE');
  assert.equal(consoleConfig.build.dockerfilePath, 'Dockerfile');
  assert.equal(referenceConfig.build.builder, 'DOCKERFILE');
  assert.equal(referenceConfig.build.dockerfilePath, 'deploy/railway/reference.Dockerfile');
});

test('private reference Dockerfile is a final-stage service image, not a target-stage instruction', () => {
  const dockerfile = read('deploy/railway/reference.Dockerfile');

  assert.match(dockerfile, /Railway templates\/config-as-code expose a Dockerfile path/);
  assert.match(dockerfile, /FROM browsers AS reference/);
  assert.match(dockerfile, /CMD \["node", "reference-implementation\/server\/index\.js"\]/);
  assert.doesNotMatch(dockerfile, /FROM .* AS console/);
  assert.doesNotMatch(dockerfile, /pnpm --filter pdpp-console build/);
});

test('Railway runbook and template handoff do not require manual Docker target-stage setup', () => {
  const readme = read('deploy/railway/README.md');
  const handoff = read('deploy/railway/template.md');

  assert.match(readme, /https:\/\/railway\.com\/new\/template\/<template-code>/);
  assert.match(readme, /deploy\/railway\/reference\.Dockerfile/);
  assert.doesNotMatch(readme, /Settings\s*->\s*Build\s*->\s*Docker\s*->\s*Target Stage/i);

  assert.match(handoff, /https:\/\/railway\.com\/button\.svg/);
  assert.match(handoff, /https:\/\/railway\.com\/new\/template\/<template-code>/);
  assert.match(handoff, /PDPP_REFERENCE_ORIGIN=https:\/\/\$\{\{console\.RAILWAY_PUBLIC_DOMAIN\}\}/);
  assert.match(handoff, /PDPP_DATABASE_URL=\$\{\{Postgres\.DATABASE_URL\}\}/);
  assert.match(handoff, /reference\.railway\.internal:7662/);
  assert.match(handoff, /reference\.railway\.internal:7663/);
  assert.match(handoff, /Source accessibility gate/);
  assert.match(handoff, /railway up/);
  assert.match(handoff, /public container images/);
  assert.doesNotMatch(handoff, /Settings\s*->\s*Build\s*->\s*Docker\s*->\s*Target Stage/i);
});

test('Railway upload context excludes machine-local agent symlinks', () => {
  const ignore = read('.railwayignore');

  assert.match(ignore, /^skills$/m);
  assert.match(ignore, /^\.agents$/m);
  assert.match(ignore, /^\.claude$/m);
  assert.match(ignore, /^\.codex$/m);
});

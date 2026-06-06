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
  assert.match(dockerfile, /FROM base AS reference/);
  assert.match(dockerfile, /\nEXPOSE 7662\n/);
  assert.doesNotMatch(dockerfile, /EXPOSE 7662 7663/);
  assert.match(dockerfile, /export AS_PORT=\\"?\$\{PORT:-\$\{AS_PORT:-7662\}\}\\"?/);
  assert.match(dockerfile, /exec node reference-implementation\/server\/index\.js/);
  assert.doesNotMatch(dockerfile, /FROM browsers AS reference/);
  assert.doesNotMatch(dockerfile, /patchright install/);
  assert.doesNotMatch(dockerfile, /FROM .* AS console/);
  assert.doesNotMatch(dockerfile, /pnpm --filter pdpp-console build/);
  assert.doesNotMatch(dockerfile, /ENV[\s\S]*?\n\s+PORT=/);
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
  assert.match(handoff, /PDPP_OWNER_PASSWORD=\$\{\{reference\.PDPP_OWNER_PASSWORD\}\}/);
  assert.match(handoff, /PDPP_AS_URL=http:\/\/\$\{\{reference\.RAILWAY_PRIVATE_DOMAIN\}\}:\$\{\{reference\.PORT\}\}/);
  assert.match(handoff, /PDPP_RS_URL=http:\/\/\$\{\{reference\.RAILWAY_PRIVATE_DOMAIN\}\}:7663/);
  assert.match(handoff, /PDPP_DATABASE_URL=\$\{\{Postgres\.DATABASE_URL\}\}/);
  assert.match(handoff, /PGDATA=\$\{\{RAILWAY_VOLUME_MOUNT_PATH\}\}\/pgdata/);
  assert.match(handoff, /DATABASE_URL=postgresql:\/\/postgres:\$\{\{POSTGRES_PASSWORD\}\}@\$\{\{RAILWAY_PRIVATE_DOMAIN\}\}:5432\/postgres/);
  assert.match(handoff, /Source accessibility gate/);
  assert.match(handoff, /railway up/);
  assert.match(handoff, /public container images/);
  assert.doesNotMatch(handoff, /PDPP_AS_URL=http:\/\/\$\{\{reference\.RAILWAY_PRIVATE_DOMAIN\}\}:7662/);
  assert.doesNotMatch(handoff, /Settings\s*->\s*Build\s*->\s*Docker\s*->\s*Target Stage/i);
});

test('Railway handoff documents the public GHCR image-source template shape', () => {
  const handoff = read('deploy/railway/template.md');

  // Exact image URIs, mapped to the correct service.
  assert.match(handoff, /ghcr\.io\/vana-com\/pdpp\/web/);
  assert.match(handoff, /ghcr\.io\/vana-com\/pdpp\/reference/);

  // The image source supersedes the Dockerfile-path build, and the committed
  // Dockerfile-path artifacts are explicitly off the image deploy path.
  assert.match(handoff, /supersedes\*{0,2}\s*`?build\.dockerfilePath`?/i);

  // A concrete version tag must be pinned; latest/moving tags are disallowed.
  assert.match(handoff, /never\s+`?latest`?/i);
  assert.match(handoff, /<version-tag>/);
});

test('Railway runbook documents the public GHCR image-source mapping', () => {
  const readme = read('deploy/railway/README.md');

  assert.match(readme, /ghcr\.io\/vana-com\/pdpp\/web/);
  assert.match(readme, /ghcr\.io\/vana-com\/pdpp\/reference/);
  // The README must record which published image is which stage.
  assert.match(readme, /`web` image is the[\s\S]*?`console` stage/);
  assert.match(readme, /`reference` image is the[\s\S]*?`reference` stage/);
});

test('Railway handoff wires the runnable GHCR public-image probe into the publish gate', () => {
  const handoff = read('deploy/railway/template.md');

  // The Source accessibility gate points at the committed probe, not only the
  // copy-paste heredoc, and the probe gates the live publish step.
  assert.match(handoff, /pnpm railway:ghcr-public/);
  assert.match(handoff, /scripts\/check-railway-ghcr-public\.test\.mjs/);
  // The probe is a real package script, not just prose.
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['railway:ghcr-public'], 'node scripts/check-railway-ghcr-public.mjs');
  assert.equal(
    pkg.scripts['railway:ghcr-public:test'],
    'node --test scripts/check-railway-ghcr-public.test.mjs',
  );
});

test('Railway handoff carries a <template-code> replacement checklist', () => {
  const handoff = read('deploy/railway/template.md');

  assert.match(handoff, /`?<template-code>`? replacement checklist/i);
  assert.match(handoff, /utm_medium=integration&utm_source=button&utm_campaign=pdpp-core/);
});

test('Railway upload context excludes machine-local agent symlinks', () => {
  const ignore = read('.railwayignore');

  assert.match(ignore, /^skills$/m);
  assert.match(ignore, /^\.agents$/m);
  assert.match(ignore, /^\.claude$/m);
  assert.match(ignore, /^\.codex$/m);
});

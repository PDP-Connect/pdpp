// Offline unit tests for the pure core of check-railway-ghcr-public.mjs.
//
// These run with zero network (node --test), exactly like the other railway:*
// unit tests. They pin the GHCR status -> visibility classifier, the per-image
// pass/fail logic (including the --tag pin), and the readiness summary that
// gates the pushbutton publish path. The live HTTP probe itself runs against
// real GHCR by the operator (see deploy/railway/template.md), not in CI.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEMPLATE_IMAGES,
  classifyTokenStatus,
  classifyProbeResult,
  summarizePublishReadiness,
  parseArgs,
} from './check-railway-ghcr-public.mjs';

test('TEMPLATE_IMAGES maps the app service to the documented GHCR path', () => {
  const byService = Object.fromEntries(TEMPLATE_IMAGES.map((i) => [i.service, i]));
  assert.equal(byService.core.image, 'vana-com/pdpp/railway-core');
  assert.equal(byService.core.stage, 'railway-core');
});

test('classifyTokenStatus: 200 public, 401 private, 403 absent, else unknown', () => {
  assert.deepEqual(classifyTokenStatus(200), { visibility: 'public', tokenGranted: true });
  assert.deepEqual(classifyTokenStatus(401), { visibility: 'private', tokenGranted: false });
  assert.deepEqual(classifyTokenStatus(403), { visibility: 'absent', tokenGranted: false });
  assert.deepEqual(classifyTokenStatus(500), { visibility: 'unknown', tokenGranted: false });
});

test('classifyProbeResult: public image with readable tags is ok', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ['0.1.0-beta.7', 'latest'],
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /public/);
  assert.equal(result.visibility, 'public');
});

test('classifyProbeResult: private image (401) is blocked with the owner-flip reason', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 401,
  });
  assert.equal(result.ok, false);
  assert.equal(result.visibility, 'private');
  assert.match(result.reason, /private/);
  assert.match(result.reason, /Public/);
});

test('classifyProbeResult: absent path (403) is blocked and names the cause', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/nope',
    service: 'console',
    stage: 'console',
    tokenStatus: 403,
  });
  assert.equal(result.ok, false);
  assert.equal(result.visibility, 'absent');
  assert.match(result.reason, /absent/);
});

test('classifyProbeResult: token granted but tags/list fails is not ok', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 500,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /tags\/list/);
});

test('classifyProbeResult: --tag pin must be present even when public', () => {
  const missing = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ['latest'],
    requiredTag: '0.1.0-beta.7',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /0\.1\.0-beta\.7/);

  const present = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ['latest', '0.1.0-beta.7'],
    requiredTag: '0.1.0-beta.7',
  });
  assert.equal(present.ok, true);
});

test('classifyProbeResult: --tag pin can pass by direct manifest when tags/list lags', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ['latest'],
    requiredTag: 'sha-1088045',
    manifestStatus: 200,
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /manifest/);
});

test('classifyProbeResult: --tag pin fails when neither tags/list nor manifest exposes it', () => {
  const result = classifyProbeResult({
    image: 'vana-com/pdpp/railway-core',
    service: 'console',
    stage: 'console',
    tokenStatus: 200,
    tagsStatus: 200,
    tags: ['latest'],
    requiredTag: 'sha-missing',
    manifestStatus: 404,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest status 404/);
});

test('summarizePublishReadiness: ready only when every image is ok', () => {
  const allOk = summarizePublishReadiness([{ ok: true }, { ok: true }]);
  assert.equal(allOk.ready, true);
  assert.equal(allOk.blocked.length, 0);
  assert.equal(allOk.ownerAction, null);

  const oneBlocked = summarizePublishReadiness([{ ok: true }, { ok: false, image: 'x' }]);
  assert.equal(oneBlocked.ready, false);
  assert.equal(oneBlocked.blocked.length, 1);
  assert.match(oneBlocked.ownerAction, /Public/);
});

test('summarizePublishReadiness: private template image is not ready', () => {
  const results = TEMPLATE_IMAGES.map((i) =>
    classifyProbeResult({ ...i, tokenStatus: 401 }),
  );
  const summary = summarizePublishReadiness(results);
  assert.equal(summary.ready, false);
  assert.equal(summary.blocked.length, 1);
});

test('parseArgs: --json, --tag, --help, and unknown', () => {
  assert.equal(parseArgs(['node', 's', '--json']).json, true);
  assert.equal(parseArgs(['node', 's', '--tag', '0.1.0-beta.7']).tag, '0.1.0-beta.7');
  assert.equal(parseArgs(['node', 's', '--help']).help, true);
  assert.equal(parseArgs(['node', 's', '-h']).help, true);
  assert.equal(parseArgs(['node', 's', '--bogus']).unknown, '--bogus');
});

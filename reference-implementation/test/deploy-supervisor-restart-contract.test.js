import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Proves the coupling the production guard in search-semantic.js relies on:
// PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1 asserts that a
// supervisor will restart this process after its confirmed fail-stop
// (local-transformer-executor.ts's #failStop -> process.exit(1); see
// openspec/changes/correct-local-collector-ingest-throughput/specs/
// reference-implementation-runtime/spec.md, "Local transformer execution
// SHALL be killable and fenced"). Setting the flag without a real restart
// policy behind it is a false assertion to the runtime guard. Every
// production deployment surface that ships this flag MUST also ship a real
// restart policy for the same service/target, and vice versa — a restart
// policy with no flag would silently leave production on the deterministic
// stub backend (resolveSemanticBackendFromEnv's default-mode fallback) rather
// than fail loudly, which is a product regression this test does not police,
// but the flag-without-restart direction is a lie the runtime guard exists to
// prevent and is what this test proves stays impossible in committed config.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESTART_FLAG = 'PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT';

async function read(relPath) {
  return readFile(`${REPO_ROOT}${relPath}`, 'utf8');
}

// Assert a REAL restart directive (a YAML key line), not a comment that merely
// mentions `restart:`. Without this, a `# ... restart: unless-stopped ...`
// comment in the block would vacuously satisfy a bare /restart:/ regex even if
// the actual directive were deleted (verified: an Opus gate mutation that
// removed the directive line while leaving the explanatory comment passed the
// old bare-regex assertion). Only lines whose first non-space char is `restart`
// count.
function assertRealRestartPolicy(block, label) {
  const hasDirective = block
    .split('\n')
    .some((line) => /^\s*restart:\s*(unless-stopped|on-failure)\b/.test(line));
  assert.ok(
    hasDirective,
    `${label}: expected a real \`restart: unless-stopped|on-failure\` directive line (not a comment)`,
  );
}

test('root docker-compose.yml pairs the restart-contract flag with a real restart policy on reference', async () => {
  const compose = await read('docker-compose.yml');

  // Non-vacuous pre-fix reproduction: the flag line must exist at all (this
  // is the change under test — PR #334 shipped the guard with neither the
  // flag nor a restart policy wired into this file).
  assert.match(compose, new RegExp(`${RESTART_FLAG}:\\s*"1"`));

  // The flag must appear inside the `reference` service block, and that same
  // block must declare a real Docker restart policy — `unless-stopped` or
  // `on-failure`, not `no` and not an absent key (Compose's default is `no`,
  // which would NOT restart the container after the guard's process.exit(1)).
  const referenceBlockMatch = compose.match(/^\s*reference:\n([\s\S]*?)(?=\n {2}\S|\nvolumes:)/m);
  assert.ok(referenceBlockMatch, 'could not isolate the reference service block');
  const referenceBlock = referenceBlockMatch[1];

  assert.match(referenceBlock, new RegExp(`${RESTART_FLAG}:\\s*"1"`));
  assertRealRestartPolicy(referenceBlock, 'root docker-compose.yml reference');
});

test('deploy/docker/docker-compose.yml (quickstart) pairs the restart-contract flag with restart: unless-stopped', async () => {
  const compose = await read('deploy/docker/docker-compose.yml');
  const referenceBlockMatch = compose.match(/^\s*reference:\n([\s\S]*?)(?=\n {2}\S|\nvolumes:)/m);
  assert.ok(referenceBlockMatch, 'could not isolate the reference service block');
  const referenceBlock = referenceBlockMatch[1];

  assert.match(referenceBlock, new RegExp(`${RESTART_FLAG}:\\s*"1"`));
  assertRealRestartPolicy(referenceBlock, 'deploy/docker/docker-compose.yml reference');
});

test('.env.docker.example documents the restart-contract flag with its rationale', async () => {
  const envExample = await read('.env.docker.example');
  assert.match(envExample, new RegExp(`^${RESTART_FLAG}=1$`, 'm'));
  // The comment above it must reference the actual restart policy backing it,
  // not just assert the flag in isolation.
  assert.match(envExample, /restart: unless-stopped/);
});

test('Railway railway-core/platform-core Dockerfile stage bakes the flag only alongside a committed ON_FAILURE restart policy', async () => {
  const dockerfile = await read('Dockerfile');
  const consoleConfig = await read('deploy/railway/railway.console.json');

  const railwayCoreStageMatch = dockerfile.match(/FROM base AS railway-core\n([\s\S]*?)(?=\nFROM )/);
  assert.ok(railwayCoreStageMatch, 'could not isolate the railway-core Dockerfile stage');
  const railwayCoreStage = railwayCoreStageMatch[1];

  // railway.console.json builds the Dockerfile's default (final) stage,
  // which is platform-core (FROM railway-core AS platform-core) — the same
  // baked ENV block. Non-vacuous: fails if the flag is baked without a real
  // restart policy in the Railway service config that deploys it, and fails
  // if the flag is simply missing (the pre-fix state).
  const hasFlag = new RegExp(`${RESTART_FLAG}=1`).test(railwayCoreStage);
  assert.equal(hasFlag, true, 'expected the railway-core Dockerfile stage to assert the restart contract');
  assert.match(consoleConfig, /"restartPolicyType":\s*"ON_FAILURE"/);
  assert.match(consoleConfig, /"restartPolicyMaxRetries":\s*[1-9]/);
});

test('Railway split-service reference.Dockerfile bakes the flag only alongside railway.reference.json ON_FAILURE', async () => {
  const referenceDockerfile = await read('deploy/railway/reference.Dockerfile');
  const referenceConfig = await read('deploy/railway/railway.reference.json');

  const hasFlag = new RegExp(`${RESTART_FLAG}=1`).test(referenceDockerfile);
  assert.equal(hasFlag, true, 'expected the split-service reference.Dockerfile to assert the restart contract');
  assert.match(referenceConfig, /"restartPolicyType":\s*"ON_FAILURE"/);
  assert.match(referenceConfig, /"restartPolicyMaxRetries":\s*[1-9]/);
});

test('root Dockerfile plain reference/reference-browser stages do NOT bake the restart-contract flag', async () => {
  // These stages are consumed by docker-compose.yml (root) and
  // deploy/docker/docker-compose.yml, whose `restart:` policy is a compose-
  // layer choice, not an image-layer constant — an operator can run either
  // image with `docker run` and no restart policy at all. Baking the flag
  // into the image itself would make it lie in that path. The flag belongs
  // at the compose layer (see the docker-compose.yml tests above), and the
  // guard in search-semantic.js is what catches an operator who runs the
  // bare image without a supervisor.
  const dockerfile = await read('Dockerfile');
  const referenceStageMatch = dockerfile.match(/FROM base AS reference\n([\s\S]*?)(?=\nFROM )/);
  const referenceBrowserStageMatch = dockerfile.match(/FROM browsers AS reference-browser\n([\s\S]*?)(?=\nFROM )/);
  assert.ok(referenceStageMatch);
  assert.ok(referenceBrowserStageMatch);

  assert.doesNotMatch(referenceStageMatch[1], new RegExp(`${RESTART_FLAG}=1`));
  assert.doesNotMatch(referenceBrowserStageMatch[1], new RegExp(`${RESTART_FLAG}=1`));
});

test('Fly.io platform-core deploy has no explicit restart override that would contradict the baked flag', async () => {
  const flyToml = await read('deploy/flyio/fly.toml');
  // fly.toml intentionally carries no [[restart]] block, so Fly's platform
  // default (restart on machine exit) applies. If a future edit adds an
  // explicit [[restart]] block with policy = "no", that would falsify the
  // flag baked into the platform-core Dockerfile stage this app builds.
  assert.match(flyToml, /target = "platform-core"/);
  assert.doesNotMatch(flyToml, /policy\s*=\s*"no"/);
});

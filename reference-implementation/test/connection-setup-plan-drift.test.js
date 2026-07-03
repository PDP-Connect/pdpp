import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FILES = {
  cliSetup: new URL('../../packages/cli/src/owner-agent/setup.js', import.meta.url),
  consoleCatalog: new URL('../../apps/console/src/app/(console)/lib/connection-catalog.ts', import.meta.url),
  ownerIntentRoute: new URL('../server/routes/owner-connection-intent.ts', import.meta.url),
  setupPlanner: new URL('../server/connection-setup-plan.ts', import.meta.url),
};

function read(url) {
  return readFileSync(url, 'utf8');
}

test('setup surfaces consume the shared setup planner instead of defining connector matrices', () => {
  const planner = read(FILES.setupPlanner);
  assert.match(planner, /SUPPORTED_LOCAL_COLLECTOR_CONNECTORS/);
  assert.match(planner, /staticSecretCredentialCaptureFromManifest/);
  assert.match(planner, /SUPPORTED_BROWSER_COLLECTOR_CONNECTORS/);

  const consoleCatalog = read(FILES.consoleCatalog);
  assert.match(consoleCatalog, /buildConnectionSetupPlan/);
  assert.doesNotMatch(consoleCatalog, /const\s+SUPPORTED_[A-Z_]+_CONNECTORS\s*=/);
  assert.doesNotMatch(consoleCatalog, /STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR\s*=/);

  const ownerIntentRoute = read(FILES.ownerIntentRoute);
  assert.match(ownerIntentRoute, /buildConnectionSetupPlan/);
  assert.doesNotMatch(ownerIntentRoute, /STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR\s*=/);
  assert.doesNotMatch(ownerIntentRoute, /SUPPORTED_BROWSER_COLLECTOR_CONNECTORS\s*=/);

  const cliSetup = read(FILES.cliSetup);
  assert.match(cliSetup, /\/v1\/owner\/connections\/intents/);
  assert.doesNotMatch(cliSetup, /\b(gmail|github|amazon|claude-code|claude_code|codex)\b/);
});

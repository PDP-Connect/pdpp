// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const REGEXP_1 = /const\s+SUPPORTED_[A-Z_]+_CONNECTORS\s*=/;
const REGEXP_2 = /SUPPORTED_BROWSER_COLLECTOR_CONNECTORS\s*=/;
const REGEXP_3 = /\/v1\/owner\/connections\/intents/;
const REGEXP_4 = /\b(gmail|github|amazon|claude-code|claude_code|codex)\b/;
const REGEXP_5 = /SUPPORTED_LOCAL_COLLECTOR_CONNECTORS/;
const REGEXP_6 = /STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR\s*=/;
const REGEXP_7 = /SUPPORTED_BROWSER_COLLECTOR_CONNECTORS/;
const REGEXP_8 = /buildConnectionSetupPlan/;
const REGEXP_9 = /STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR\s*=/;
const REGEXP_10 = /buildConnectionSetupPlan/;
const REGEXP_11 = /staticSecretCredentialCaptureFromManifest/;

const FILES = {
  cliSetup: new URL("../../packages/cli/src/owner-agent/setup.ts", import.meta.url),
  consoleCatalog: new URL("../../apps/console/src/app/(console)/lib/connection-catalog.ts", import.meta.url),
  ownerIntentRoute: new URL("../server/routes/owner-connection-intent.ts", import.meta.url),
  setupPlanner: new URL("../server/connection-setup-plan.ts", import.meta.url),
};

function read(url: URL) {
  return readFileSync(url, "utf8");
}

test("setup surfaces consume the shared setup planner instead of defining connector matrices", () => {
  const planner = read(FILES.setupPlanner);
  assert.match(planner, REGEXP_5);
  assert.match(planner, REGEXP_11);
  assert.match(planner, REGEXP_7);

  const consoleCatalog = read(FILES.consoleCatalog);
  assert.match(consoleCatalog, REGEXP_10);
  assert.doesNotMatch(consoleCatalog, REGEXP_1);
  assert.doesNotMatch(consoleCatalog, REGEXP_6);

  const ownerIntentRoute = read(FILES.ownerIntentRoute);
  assert.match(ownerIntentRoute, REGEXP_8);
  assert.doesNotMatch(ownerIntentRoute, REGEXP_9);
  assert.doesNotMatch(ownerIntentRoute, REGEXP_2);

  const cliSetup = read(FILES.cliSetup);
  assert.match(cliSetup, REGEXP_3);
  assert.doesNotMatch(cliSetup, REGEXP_4);
});

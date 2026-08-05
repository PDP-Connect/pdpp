// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RAILWAY_TEMPLATES_CONFIG_AS_CODE_PATTERN = /Railway templates\/config-as-code expose a Dockerfile path/;
const FROM_BASE_AS_REFERENCE_PATTERN = /FROM base AS reference/;
const EXPOSE_7662_7663_PATTERN = /\nEXPOSE 7662 7663\n/;
const AS_PORT_EXPORT_PATTERN = /export AS_PORT=\\"?\$\{PORT:-\$\{AS_PORT:-7662\}\}\\"?/;
const EXEC_NODE_REFERENCE_INDEX_PATTERN = /exec node reference-implementation\/server\/index\.ts/;
const FROM_BROWSERS_AS_REFERENCE_PATTERN = /FROM browsers AS reference/;
const PATCHRIGHT_INSTALL_PATTERN = /patchright install/;
const FROM_ANY_AS_CONSOLE_PATTERN = /FROM .* AS console/;
const PNPM_FILTER_CONSOLE_BUILD_PATTERN = /pnpm --filter pdpp-console build/;
const ENV_PORT_PATTERN = /ENV[\s\S]*?\n\s+PORT=/;
const FROM_BASE_AS_INTERNAL_COMPATIBILITY_TARGET_PATTERN = /FROM core AS railway-core/;
const CORE_BROWSER_STAGE_PATTERN = /FROM browsers AS core-browser/;
const CMD_CORE_SUPERVISOR_PATTERN = /CMD \["node", "--import", "tsx", "\/app\/deploy\/railway\/core-supervisor\.ts"\]/;
const EXPOSE_3000_PATTERN = /\nEXPOSE 3000\n/;
const LOOPBACK_7662_PATTERN = /127\.0\.0\.1:7662/;
const LOOPBACK_7663_PATTERN = /127\.0\.0\.1:7663/;
const APP_REFERENCE_INDEX_PATTERN = /\/app\/reference-implementation\/server\/index\.ts/;
const CONSOLE_SERVER_JS_PATTERN = /\/console\/apps\/console\/server\.js/;
const REFERENCE_ORIGIN_LOCALHOST_PATTERN = /PDPP_REFERENCE_ORIGIN=http:\/\/localhost:3000/;
const DB_PATH_SQLITE_PATTERN = /PDPP_DB_PATH=\/var\/lib\/pdpp\/pdpp\.sqlite/;
const CORE_INHERITS_BROWSER_PATTERN = /FROM browsers AS core-browser[\s\S]*FROM core-browser AS core/;
const CORE_SEMANTIC_DOWNLOAD_PATTERN = /PDPP_EMBEDDING_DOWNLOAD_ALLOWED=1/;
const CORE_SEMANTIC_CACHE_PATTERN = /PDPP_EMBEDDING_CACHE_DIR=\/var\/lib\/pdpp\/transformers/;
const PATCHRIGHT_MANIFEST_DERIVATION_PATTERN = /PATCHRIGHT_VERSION=.*polyfill-connectors-package\.json/;
const PATCHRIGHT_EXACT_VERSION_ASSERTION_PATTERN = /Patchright dependency must be exact/;
const CORE_FIRST_BOOT_IMPORT_PATTERN = /from "\.\/core-first-boot\.ts"/;
const PREPARE_FIRST_BOOT_CALL_PATTERN = /prepareFirstBoot\(\)/;
const FIRST_BOOT_ENV_SPREAD_PATTERN = /\.\.\.firstBoot\.env/g;
const FIRST_BOOT_BANNER_LINES_PATTERN = /firstBoot\.bannerLines/;
const RAILWAY_TEMPLATE_URL_PATTERN = /https:\/\/railway\.com\/new\/template\/pdpp-core-template-source/;
const GHCR_PDP_CONNECT_CORE_PATTERN = /ghcr\.io\/pdp-connect\/pdpp\/core(?::|`)/;
const ONE_PUBLIC_CORE_APP_SERVICE_PATTERN = /one public Core app service/i;
const SETTINGS_BUILD_DOCKER_TARGET_STAGE_PATTERN = /Settings\s*->\s*Build\s*->\s*Docker\s*->\s*Target Stage/i;
const RAILWAY_BUTTON_SVG_PATTERN = /https:\/\/railway\.com\/button\.svg/;
const REFERENCE_ORIGIN_CORE_DOMAIN_TEMPLATE_PATTERN =
  /PDPP_REFERENCE_ORIGIN=https:\/\/\$\{\{core\.RAILWAY_PUBLIC_DOMAIN\}\}/;
const DATABASE_URL_TEMPLATE_PATTERN = /PDPP_DATABASE_URL=\$\{\{Postgres\.DATABASE_URL\}\}/;
const CREDENTIAL_ENCRYPTION_KEY_TEMPLATE_PATTERN = /PDPP_CREDENTIAL_ENCRYPTION_KEY=\$\{\{\s*secret\(64\)\s*\}\}/;
const PGDATA_TEMPLATE_PATTERN = /PGDATA=\$\{\{RAILWAY_VOLUME_MOUNT_PATH\}\}\/pgdata/;
const POSTGRES_DATABASE_URL_TEMPLATE_PATTERN =
  /DATABASE_URL=postgresql:\/\/postgres:\$\{\{POSTGRES_PASSWORD\}\}@\$\{\{RAILWAY_PRIVATE_DOMAIN\}\}:5432\/postgres/;
const SOURCE_ACCESSIBILITY_GATE_PATTERN = /Source accessibility gate/;
const CORE_OWNER_PASSWORD_PATTERN = /core\.PDPP_OWNER_PASSWORD/;
const CORE_CREDENTIAL_ENCRYPTION_KEY_PATTERN = /core\.PDPP_CREDENTIAL_ENCRYPTION_KEY/;
const AS_URL_REFERENCE_PRIVATE_DOMAIN_PATTERN = /PDPP_AS_URL=http:\/\/\$\{\{reference\.RAILWAY_PRIVATE_DOMAIN\}\}/;
const REFERENCE_PORT_PATTERN = /reference\.PORT/;
const ONE_APPLICATION_SERVICE_POSTGRES_PLUGIN_PATTERN = /one application service plus a Postgres plugin/i;
const NEVER_LATEST_PATTERN = /never\s+`?latest`?/i;
const VERSION_TAG_PLACEHOLDER_PATTERN = /<version-tag>/;
const CONSOLE_RAILWAY_PORT_PATTERN = /console[\s\S]*Railway[\s\S]*\$PORT/i;
const RAILWAY_GHCR_PUBLIC_COMMAND_PATTERN = /pnpm railway:ghcr-public/;
const CHECK_RAILWAY_GHCR_PUBLIC_TEST_TS_PATTERN = /scripts\/check-railway-ghcr-public\.test\.ts/;
const TEMPLATE_CODE_REPLACEMENT_CHECKLIST_PATTERN = /Template-code replacement checklist/i;
const PDPP_CORE_TEMPLATE_SOURCE_PATTERN = /pdpp-core-template-source/;
const UTM_CAMPAIGN_PATTERN = /utm_medium=integration&utm_source=button&utm_campaign=pdpp-core/;
const SKILLS_IGNORE_LINE_PATTERN = /^skills$/m;
const AGENTS_IGNORE_LINE_PATTERN = /^\.agents$/m;
const CLAUDE_IGNORE_LINE_PATTERN = /^\.claude$/m;
const CODEX_IGNORE_LINE_PATTERN = /^\.codex$/m;

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath: string): unknown {
  return JSON.parse(read(relativePath));
}

test("Railway service configs use template-safe Dockerfile paths", () => {
  const consoleConfig = readJson("deploy/railway/railway.console.json") as {
    build: { builder: string; dockerfilePath: string };
  };
  const referenceConfig = readJson("deploy/railway/railway.reference.json") as {
    build: { builder: string; dockerfilePath: string };
  };

  assert.equal(consoleConfig.build.builder, "DOCKERFILE");
  assert.equal(consoleConfig.build.dockerfilePath, "Dockerfile");
  assert.equal(referenceConfig.build.builder, "DOCKERFILE");
  assert.equal(referenceConfig.build.dockerfilePath, "deploy/railway/reference.Dockerfile");
});

test("manual split-service reference Dockerfile remains a final-stage service image", () => {
  const dockerfile = read("deploy/railway/reference.Dockerfile");

  assert.match(dockerfile, RAILWAY_TEMPLATES_CONFIG_AS_CODE_PATTERN);
  assert.match(dockerfile, FROM_BASE_AS_REFERENCE_PATTERN);
  assert.match(dockerfile, EXPOSE_7662_7663_PATTERN);
  assert.match(dockerfile, AS_PORT_EXPORT_PATTERN);
  assert.match(dockerfile, EXEC_NODE_REFERENCE_INDEX_PATTERN);
  assert.doesNotMatch(dockerfile, FROM_BROWSERS_AS_REFERENCE_PATTERN);
  assert.doesNotMatch(dockerfile, PATCHRIGHT_INSTALL_PATTERN);
  assert.doesNotMatch(dockerfile, FROM_ANY_AS_CONSOLE_PATTERN);
  assert.doesNotMatch(dockerfile, PNPM_FILTER_CONSOLE_BUILD_PATTERN);
  assert.doesNotMatch(dockerfile, ENV_PORT_PATTERN);
});

test("Railway core image runs console plus loopback reference AS/RS", () => {
  const dockerfile = read("Dockerfile");
  const supervisor = read("deploy/railway/core-supervisor.ts");

  assert.match(dockerfile, FROM_BASE_AS_INTERNAL_COMPATIBILITY_TARGET_PATTERN);
  assert.match(dockerfile, CORE_BROWSER_STAGE_PATTERN);
  assert.match(dockerfile, CMD_CORE_SUPERVISOR_PATTERN);
  assert.match(dockerfile, EXPOSE_3000_PATTERN);
  assert.match(supervisor, LOOPBACK_7662_PATTERN);
  assert.match(supervisor, LOOPBACK_7663_PATTERN);
  assert.match(supervisor, APP_REFERENCE_INDEX_PATTERN);
  assert.match(supervisor, CONSOLE_SERVER_JS_PATTERN);
});

test("Core image carries the Docker quickstart defaults and first-boot bootstrap", () => {
  const dockerfile = read("Dockerfile");
  const supervisor = read("deploy/railway/core-supervisor.ts");

  // Standalone `docker run -p 3000:3000 -v pdpp_data:/var/lib/pdpp` must work
  // with no -e flags: localhost origin default + SQLite on the mountable data
  // dir (deploy/docker/README.md). Managed platforms override both per deploy.
  assert.match(dockerfile, REFERENCE_ORIGIN_LOCALHOST_PATTERN);
  assert.match(dockerfile, DB_PATH_SQLITE_PATTERN);

  // The supervisor wires the first-boot owner-credential bootstrap into BOTH
  // children (the reference gates owner data; the console hosts the login).
  assert.match(supervisor, CORE_FIRST_BOOT_IMPORT_PATTERN);
  assert.match(supervisor, PREPARE_FIRST_BOOT_CALL_PATTERN);
  assert.equal(
    supervisor.match(FIRST_BOOT_ENV_SPREAD_PATTERN)?.length,
    2,
    "first-boot env additions reach both supervised children"
  );
  assert.match(supervisor, FIRST_BOOT_BANNER_LINES_PATTERN);
});

test("public Core inherits browser support and persists semantic search downloads", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, CORE_INHERITS_BROWSER_PATTERN);
  assert.match(dockerfile, CORE_SEMANTIC_DOWNLOAD_PATTERN);
  assert.match(dockerfile, CORE_SEMANTIC_CACHE_PATTERN);
  assert.match(dockerfile, PATCHRIGHT_MANIFEST_DERIVATION_PATTERN);
  assert.match(dockerfile, PATCHRIGHT_EXACT_VERSION_ASSERTION_PATTERN);
  assert.doesNotMatch(dockerfile, /ARG PATCHRIGHT_VERSION=/);
});

test("n.eko derives Patchright from the workspace manifest", () => {
  const dockerfile = read("docker/neko/Dockerfile");
  const installer = read("docker/neko/install-patchright-chromium.sh");
  assert.match(dockerfile, /COPY packages\/polyfill-connectors\/package\.json/);
  assert.match(dockerfile, /PATCHRIGHT_VERSION=.*polyfill-connectors-package\.json/);
  assert.match(dockerfile, /Patchright dependency must be exact/);
  assert.doesNotMatch(dockerfile, /patchright@1\.59\.4|Chromium 1217|ARG PATCHRIGHT_VERSION=/);
  assert.match(installer, /require\.resolve\("patchright-core\/package\.json"\)/);
  assert.match(installer, /chromium\.revision/);
  assert.match(installer, /chromium\.browserVersion/);
  assert.doesNotMatch(installer, /1217|147\.0\.7727\.15/);
});

test("Railway runbook and template handoff use the one-service core button shape", () => {
  const readme = read("deploy/railway/README.md");
  const handoff = read("deploy/railway/template.md");

  assert.match(readme, RAILWAY_TEMPLATE_URL_PATTERN);
  assert.match(readme, GHCR_PDP_CONNECT_CORE_PATTERN);
  assert.match(readme, ONE_PUBLIC_CORE_APP_SERVICE_PATTERN);
  assert.doesNotMatch(readme, SETTINGS_BUILD_DOCKER_TARGET_STAGE_PATTERN);

  assert.match(handoff, RAILWAY_BUTTON_SVG_PATTERN);
  assert.match(handoff, RAILWAY_TEMPLATE_URL_PATTERN);
  assert.match(handoff, REFERENCE_ORIGIN_CORE_DOMAIN_TEMPLATE_PATTERN);
  assert.match(handoff, DATABASE_URL_TEMPLATE_PATTERN);
  assert.match(handoff, CREDENTIAL_ENCRYPTION_KEY_TEMPLATE_PATTERN);
  assert.match(handoff, PGDATA_TEMPLATE_PATTERN);
  assert.match(handoff, POSTGRES_DATABASE_URL_TEMPLATE_PATTERN);
  assert.match(handoff, SOURCE_ACCESSIBILITY_GATE_PATTERN);
  assert.match(handoff, CORE_OWNER_PASSWORD_PATTERN);
  assert.match(handoff, CORE_CREDENTIAL_ENCRYPTION_KEY_PATTERN);
  assert.doesNotMatch(handoff, AS_URL_REFERENCE_PRIVATE_DOMAIN_PATTERN);
  assert.doesNotMatch(handoff, REFERENCE_PORT_PATTERN);
  assert.doesNotMatch(handoff, SETTINGS_BUILD_DOCKER_TARGET_STAGE_PATTERN);
});

test("Railway handoff documents the public core image-source template shape", () => {
  const handoff = read("deploy/railway/template.md");

  assert.match(handoff, GHCR_PDP_CONNECT_CORE_PATTERN);
  assert.match(handoff, ONE_APPLICATION_SERVICE_POSTGRES_PLUGIN_PATTERN);

  // A concrete version tag must be pinned; latest/moving tags are disallowed.
  assert.match(handoff, NEVER_LATEST_PATTERN);
  assert.match(handoff, VERSION_TAG_PLACEHOLDER_PATTERN);
});

test("Railway runbook documents the public core image-source mapping", () => {
  const readme = read("deploy/railway/README.md");

  assert.match(readme, GHCR_PDP_CONNECT_CORE_PATTERN);
  assert.match(readme, CONSOLE_RAILWAY_PORT_PATTERN);
  assert.match(readme, LOOPBACK_7662_PATTERN);
  assert.match(readme, LOOPBACK_7663_PATTERN);
});

test("release matrices publish Core and do not expose compatibility aliases", () => {
  const dockerWorkflow = read(".github/workflows/docker-images.yml");
  const releaseWorkflow = read(".github/workflows/semantic-release.yml");
  for (const workflow of [dockerWorkflow, releaseWorkflow]) {
    assert.match(workflow, /image: core\n\s+target: core/);
    assert.doesNotMatch(workflow, /image: core-browser\n\s+target: core-browser/);
    assert.doesNotMatch(workflow, /image: railway-core/);
  }
  const template = read("deploy/railway/template.md");
  const historicalMarker = "## 2026-06-06 scratch proof (legacy historical record)";
  const [currentInstructions, historicalRecord] = template.split(historicalMarker);
  assert.ok(historicalRecord, "template must retain the explicitly labeled legacy record");
  assert.doesNotMatch(currentInstructions, /ghcr\.io\/pdp-connect\/pdpp\/railway-core/);
  assert.match(historicalRecord, /ghcr\.io\/pdp-connect\/pdpp\/railway-core/);
  for (const publicPath of ["deploy/railway/README.md", "deploy/docker/README.md"]) {
    assert.doesNotMatch(read(publicPath), /ghcr\.io\/pdp-connect\/pdpp\/railway-core/);
    assert.doesNotMatch(read(publicPath), /ghcr\.io\/pdp-connect\/pdpp\/core-browser/);
  }
  assert.doesNotMatch(read("deploy/railway/template.md").split(historicalMarker)[0], /core-browser/);
});

test("Railway handoff wires the runnable GHCR public-image probe into the publish gate", () => {
  const handoff = read("deploy/railway/template.md");

  // The Source accessibility gate points at the committed probe, not only the
  // copy-paste heredoc, and the probe gates the live publish step.
  assert.match(handoff, RAILWAY_GHCR_PUBLIC_COMMAND_PATTERN);
  assert.match(handoff, CHECK_RAILWAY_GHCR_PUBLIC_TEST_TS_PATTERN);
  // The probe is a real package script, not just prose.
  const pkg = readJson("package.json") as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["railway:ghcr-public"], "node --import tsx scripts/check-railway-ghcr-public.ts");
  assert.equal(
    pkg.scripts["railway:ghcr-public:test"],
    "node --test --import tsx scripts/check-railway-ghcr-public.test.ts"
  );
});

test("Railway handoff carries a template-code replacement checklist", () => {
  const handoff = read("deploy/railway/template.md");

  assert.match(handoff, TEMPLATE_CODE_REPLACEMENT_CHECKLIST_PATTERN);
  assert.match(handoff, PDPP_CORE_TEMPLATE_SOURCE_PATTERN);
  assert.match(handoff, UTM_CAMPAIGN_PATTERN);
});

test("Railway upload context excludes machine-local agent symlinks", () => {
  const ignore = read(".railwayignore");

  assert.match(ignore, SKILLS_IGNORE_LINE_PATTERN);
  assert.match(ignore, AGENTS_IGNORE_LINE_PATTERN);
  assert.match(ignore, CLAUDE_IGNORE_LINE_PATTERN);
  assert.match(ignore, CODEX_IGNORE_LINE_PATTERN);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const REFERENCE_READY_FILE_PATTERN = /PDPP_REFERENCE_READY_FILE/;
const CONSOLE_REFERENCE_READY_FILE_PATTERN = /const consoleEnv = \{[\s\S]*?PDPP_REFERENCE_READY_FILE: readyFile/;
const REFERENCE_READINESS_PUBLISH_PATTERN = /reference services ready/;
const APP_REFERENCE_INDEX_PATTERN = /\/app\/reference-implementation\/server\/index\.ts/;
const CONSOLE_SERVER_JS_PATTERN = /\/console\/apps\/console\/server\.js/;
const REFERENCE_ORIGIN_LOCALHOST_PATTERN = /PDPP_REFERENCE_ORIGIN=http:\/\/localhost:3000/;
const DB_PATH_SQLITE_PATTERN = /PDPP_DB_PATH=\/var\/lib\/pdpp\/pdpp\.sqlite/;
const CORE_INHERITS_BROWSER_PATTERN = /FROM browsers AS core-browser[\s\S]*FROM core-browser AS core/;
const RUNTIME_BROWSER_MARKER_PATTERN = /PDPP_RUNTIME_BROWSER=1/;
const BROWSER_STAGE_CAPTURE_PATTERN = /FROM base AS browsers\n([\s\S]*?)(?=\nFROM browsers AS reference-browser)/;
const REFERENCE_STAGE_CAPTURE_PATTERN = /FROM base AS reference\n([\s\S]*?)(?=\nFROM base AS browsers)/;
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
const NEVER_MOVING_TAG_PATTERN = /never a moving tag/i;
const CORE_LATEST_PATTERN = /ghcr\.io\/pdp-connect\/pdpp\/core:latest/;
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
  assert.match(supervisor, REFERENCE_READY_FILE_PATTERN);
  assert.match(supervisor, CONSOLE_REFERENCE_READY_FILE_PATTERN);
  assert.match(supervisor, REFERENCE_READINESS_PUBLISH_PATTERN);
  assert.match(supervisor, APP_REFERENCE_INDEX_PATTERN);
  assert.match(supervisor, CONSOLE_SERVER_JS_PATTERN);
});

test("Core image carries the Docker quickstart defaults and first-boot bootstrap", () => {
  const dockerfile = read("Dockerfile");
  const supervisor = read("deploy/railway/core-supervisor.ts");

  // Standalone `docker run -p 3000:3000 -v pdpp_data:/var/lib/pdpp` must work
  // with no -e flags: SQLite on the mountable data dir (deploy/docker/README.md).
  // PDPP_REFERENCE_ORIGIN is intentionally left unset so the RS/AS derive
  // their own base from the live request's Host header, which always matches
  // the port a client actually used to connect (see Dockerfile comment).
  assert.doesNotMatch(dockerfile, REFERENCE_ORIGIN_LOCALHOST_PATTERN);
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

test("browser capability is declared once on the shared browser stage", () => {
  const dockerfile = read("Dockerfile");
  const browserStageMatch = dockerfile.match(BROWSER_STAGE_CAPTURE_PATTERN);
  const referenceStageMatch = dockerfile.match(REFERENCE_STAGE_CAPTURE_PATTERN);
  assert.ok(browserStageMatch, "could not isolate the shared browser stage");
  assert.ok(referenceStageMatch, "could not isolate the non-browser reference stage");
  assert.match(browserStageMatch[1] ?? "", RUNTIME_BROWSER_MARKER_PATTERN);
  assert.equal(
    (dockerfile.match(new RegExp(RUNTIME_BROWSER_MARKER_PATTERN.source, "g")) ?? []).length,
    1,
    "the image-owned browser capability must have one packaging declaration"
  );
  assert.doesNotMatch(referenceStageMatch[1] ?? "", RUNTIME_BROWSER_MARKER_PATTERN);
  assert.match(dockerfile, CORE_INHERITS_BROWSER_PATTERN);
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

test("streaming launcher publishes a real Chromium TCP endpoint", () => {
  const launcher = read("packages/polyfill-connectors/src/browser-launch.ts");
  assert.match(launcher, /baseArgs\.push\("--remote-debugging-port=0"\)/);
  assert.match(launcher, /publishCdpEndpointFromLaunch\(\{ isolatedDir \}\)/);
  assert.match(launcher, /PDPP_BROWSER_CDP_HOST/);
  assert.doesNotMatch(launcher, /cdpPort: 0/);
});

test("deploy Docker Compose uses one Core service plus Postgres and durable data", () => {
  const compose = read("deploy/docker/docker-compose.yml");
  assert.match(compose, /^  core:/m);
  // Onboarding names the released channel, never the default-branch tag.
  // `:main` tracks main ahead of any release; pointing a self-host quickstart
  // at it ships operators unreleased code.
  assert.match(compose, /ghcr\.io\/pdp-connect\/pdpp\/core:latest/);
  assert.doesNotMatch(compose, /ghcr\.io\/pdp-connect\/pdpp\/core:main/);
  assert.match(compose, /^  postgres:/m);
  assert.match(compose, /pdpp-data:\/var\/lib\/pdpp/);
  assert.match(compose, /PDPP_EMBEDDING_CACHE_DIR: \/var\/lib\/pdpp\/transformers/);
  assert.doesNotMatch(compose, /^  reference:|^  web:/m);
});

test("Docker quickstart supplies the restart policy required by the Core image", () => {
  const readme = read("deploy/docker/README.md");
  assert.match(readme, /docker run -d --name pdpp --restart unless-stopped/);
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

  // Both paths must stay documented and distinguishable: `core:latest` as the
  // moving public image path, and a concrete immutable `<version-tag>` for a
  // reproducible template revision. The reproducibility rule survives as
  // "pin one, never a moving tag" — it now scopes the pin instead of banning
  // `latest` outright, which the release pipeline publishes deliberately.
  assert.match(handoff, CORE_LATEST_PATTERN);
  assert.match(handoff, NEVER_MOVING_TAG_PATTERN);
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

// The defect this guards: `publish-images` used to run AFTER `release`, so an
// image build that failed left a published GitHub release and git tag naming a
// version whose images were never pushed. Repairing that meant deleting a
// public release. The ordering below makes the failure mode "no release
// happened" instead. `latest` and the version tag are both created only after
// the release exists, from the exact digest publish-candidate-images recorded
// - not from re-resolving a mutable tag, which a concurrent run, a rerun, or
// an operator action could have moved between candidate publication and
// promotion.
test("release publishes a non-release-looking candidate before semantic-release, then promotes from its recorded digest", () => {
  const workflow = read(".github/workflows/semantic-release.yml");
  const jobs = workflow.split(/\n {2}(?=[a-z-]+:\n)/);
  const jobNamed = (name: string): string => {
    const job = jobs.find((entry) => entry.trimStart().startsWith(`${name}:`));
    assert.ok(job, `workflow must define the ${name} job`);
    return job;
  };

  const candidate = jobNamed("publish-candidate-images");
  const release = jobNamed("release");
  const promote = jobNamed("promote-release-images");
  const verify = jobNamed("verify-release-channel");

  // semantic-release cannot create the tag until the images are pushed.
  assert.match(release, /needs:\s*\[[^\]]*publish-candidate-images[^\]]*\]/);

  // The candidate publish writes a staging tag that cannot be mistaken for a
  // released semver tag, plus the immutable commit-sha tag. It never writes
  // the bare version or `latest`: those are release-channel aliases that only
  // exist once semantic-release has committed to the release.
  assert.match(
    candidate,
    /type=raw,value=candidate-\$\{\{ needs\.resolve-version\.outputs\.new-release-version \}\}-sha-\$\{\{ github\.sha \}\}/
  );
  assert.match(candidate, /type=sha,prefix=sha-/);
  assert.doesNotMatch(candidate, /type=raw,value=\$\{\{ needs\.resolve-version\.outputs\.new-release-version \}\}\n/);
  assert.doesNotMatch(candidate, /type=raw,value=latest/);
  assert.doesNotMatch(candidate, /needs\.release\.outputs/);

  // Multi-arch, SBOM and provenance stay on the candidate publish.
  assert.match(candidate, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(candidate, /provenance: mode=max/);
  assert.match(candidate, /sbom: true/);

  // The build step is identified and its digest recorded to a durable
  // artifact, so promotion has a content address to consume instead of a tag.
  assert.match(candidate, /- name: Build and push image\n\s+id: build/);
  assert.match(candidate, /DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(candidate, /uses: actions\/upload-artifact@/);
  assert.match(candidate, /name: candidate-digest-\$\{\{ matrix\.image \}\}/);

  // Promotion runs only after a real release, downloads the recorded digest,
  // and copies that exact manifest rather than rebuilding or re-resolving a
  // tag. Both the version tag and latest are created from it.
  assert.match(promote, /needs:\s*\[[^\]]*release[^\]]*\]/);
  assert.match(promote, /needs\.release\.outputs\.published == 'true'/);
  assert.match(promote, /uses: actions\/download-artifact@/);
  assert.match(promote, /name: candidate-digest-\$\{\{ matrix\.image \}\}/);
  assert.match(promote, /docker buildx imagetools create/);
  assert.match(promote, /imagetools inspect[\s\S]*\$\{PDPP_IMAGE\}@\$\{CANDIDATE_DIGEST\}/);
  assert.match(promote, /--tag "\$\{PDPP_IMAGE\}:\$\{VERSION\}"[\s\S]*"\$\{PDPP_IMAGE\}@\$\{CANDIDATE_DIGEST\}"/);
  assert.match(promote, /--tag "\$\{PDPP_IMAGE\}:latest"[\s\S]*"\$\{PDPP_IMAGE\}@\$\{CANDIDATE_DIGEST\}"/);
  assert.doesNotMatch(promote, /docker\/build-push-action/);

  // An aggregate job re-verifies all four images against their recorded
  // digests after the promotion matrix, so a partial promotion (permitted by
  // promote-release-images' fail-fast: false) fails the run as a whole.
  assert.match(verify, /needs:\s*\[[^\]]*promote-release-images[^\]]*\]/);
  // always() is required, not just the published check: promote-release-images
  // runs fail-fast: false, and a failed matrix leg would otherwise skip this
  // gate entirely under the default needs.*.result == 'success' condition -
  // exactly when a partial promotion needs it to run.
  assert.match(verify, /if:\s*always\(\)\s*&&\s*needs\.release\.outputs\.published == 'true'/);
  assert.match(verify, /reference reference-browser web core/);
  assert.match(verify, /for alias in "\$\{VERSION\}" latest/);
  assert.doesNotMatch(verify, /docker buildx imagetools create/);
});

// The defect this guards: semantic-release creates a `v<version>` git tag, and
// docker-images.yml was ALSO triggered by `tags: ["v*"]` with a publish job
// gated on `startsWith(github.ref, 'refs/tags/v')` that wrote
// `type=raw,value=latest`. That made two independent publishers of `latest` for
// one release — promote-release-images copying the immutable candidate manifest,
// and docker-images.yml rebuilding from source. Whichever finished last won, so
// `latest` could end up as freshly-built bytes that no immutable tag points at,
// silently breaking the "latest is the same bytes as the version tag" contract.
//
// Today the tag push happens to come from GITHUB_TOKEN, which GitHub does not
// let trigger new workflow runs — so the race is currently masked. That is a
// token-suppression side effect, not a design guarantee: a hand-pushed tag, a
// re-tag, or swapping in a PAT/GitHub App token unmasks it immediately. This
// asserts the single-owner property structurally instead of relying on it.
//
// Scoped to every workflow, not just docker-images.yml, so a NEW workflow can't
// reintroduce an independent v*-triggered publisher either.
test("no workflow other than semantic-release can publish the latest channel tag", () => {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const workflowNames = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(workflowNames.includes("semantic-release.yml"), "release workflow must exist");
  assert.ok(workflowNames.includes("docker-images.yml"), "docker-images workflow must exist");

  // Comments in these workflows legitimately DISCUSS `latest`, `type=semver`
  // and the old tag gate to explain why they're forbidden. Strip comment lines
  // so the assertions below read real configuration, not prose about it.
  const withoutComments = (workflow: string): string =>
    workflow
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  for (const name of workflowNames) {
    const config = withoutComments(read(path.join(".github", "workflows", name)));

    // A `v*` tag trigger is what wired the tag push into a second publisher.
    // Not even the release workflow may carry one: it would re-enter itself on
    // the very tag it creates. It drives everything from its own `main` push.
    assert.doesNotMatch(config, /^\s*tags:\s*\[?\s*["']?v\*/m, `${name} must not be triggered by v* tags`);

    if (name === "semantic-release.yml") continue;

    // No non-release workflow may name `latest` as a tag to write, whether as a
    // raw metadata-action tag or a literal registry reference.
    assert.doesNotMatch(config, /type=raw,value=latest/, `${name} must not write the latest tag`);
    assert.doesNotMatch(config, /:latest\b/, `${name} must not reference a latest image tag`);

    // `type=semver` only ever resolves on a tag ref. Its presence means someone
    // is reintroducing tag-driven release publishing here.
    assert.doesNotMatch(config, /type=semver/, `${name} must not derive semver release tags`);

    // The stale gate that made the tag-triggered publish job run at all.
    assert.doesNotMatch(
      config,
      /startsWith\(github\.ref, 'refs\/tags\/v'\)/,
      `${name} must not gate work on a v* tag ref`,
    );
  }

  // docker-images.yml keeps its useful PR/main validation and an explicit
  // manual diagnostic publish - the point is that neither can touch `latest`.
  const dockerWorkflow = withoutComments(read(".github/workflows/docker-images.yml"));
  assert.match(dockerWorkflow, /pull_request:/, "PR validation must survive");
  assert.match(dockerWorkflow, /branches: \[main\]/, "main-push validation must survive");
  assert.match(dockerWorkflow, /^\s+publish:$/m, "the manual diagnostic publish path must survive");
  assert.match(
    dockerWorkflow,
    /^\s+publish:\n(?:.*\n)*?\s+if: github\.event_name == 'workflow_dispatch'\n/m,
    "the diagnostic publish must be reachable only by manual dispatch",
  );
  // Its one published tag is immutable and namespaced away from release tags.
  assert.match(dockerWorkflow, /type=sha,prefix=dispatch-sha-/);
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
    "pnpm test:scratch -- node --test --import tsx scripts/check-railway-ghcr-public.test.ts"
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

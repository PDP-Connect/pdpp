import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Independent review (2026-07-14, commit eea1689ab) found two durability-fix
// regressions this file exists to lock down:
//  1. docker-neko-network-durability-smoke.sh inherited COMPOSE_PROJECT_NAME
//     / PDPP_NEKO_DOCKER_NETWORK from the caller's shell, so a caller whose
//     environment already pointed at the live project could make the
//     "throwaway" smoke tear down and force-remove the LIVE stack.
//  2. reference-stack.sh's ensure_dynamic_surface_network used a plain
//     `inspect || create` pattern, which is not race-tolerant: a concurrent
//     creator (a parallel deploy invocation, or the allocator's own startup
//     check) creating the network between the inspect and the create makes
//     the create fail even though the network now correctly exists, and
//     `set -euo pipefail` would abort the whole deploy on that failure.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SMOKE_SCRIPT = join(ROOT, "scripts", "docker-neko-network-durability-smoke.sh");
const MIGRATION_SMOKE_SCRIPT = join(ROOT, "scripts", "docker-neko-network-migration-smoke.sh");
const REFERENCE_STACK_SCRIPT = join(ROOT, "scripts", "reference-stack.sh");

function makeFakeDockerBin(dir, behaviorScript) {
  const dockerPath = join(dir, "docker");
  writeFileSync(dockerPath, `#!/usr/bin/env bash\n${behaviorScript}\n`);
  chmodSync(dockerPath, 0o755);
  return dir;
}

test("docker-neko-network-durability-smoke.sh never honors an inherited COMPOSE_PROJECT_NAME or PDPP_NEKO_DOCKER_NETWORK", () => {
  // A fake `docker` that fails on `docker info` is enough here: the smoke
  // script exits (via fail()) right after resolving PROJECT_NAME/
  // DYNAMIC_NETWORK and attempting an initial cleanup() pass — which itself
  // calls `docker ps` / `compose down` / `docker network rm` — so every
  // invocation the fake docker would have received from a live-project
  // teardown is captured before the script gives up. None of those captured
  // invocations may reference the poisoned identifiers injected via
  // inherited env, proving they were never read.
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-"));
  const logPath = join(fakeDockerDir, "calls.log");
  makeFakeDockerBin(fakeDockerDir, `echo "$*" >> '${logPath}'\nif [[ "$1" == "info" ]]; then exit 1; fi\nexit 0`);

  const poisonedProject = "pdpp-live-production";
  const poisonedNetwork = "pdpp_default";

  const result = spawnSync("bash", [SMOKE_SCRIPT], {
    env: {
      ...process.env,
      PATH: `${fakeDockerDir}:${process.env.PATH}`,
      PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE: "1",
      COMPOSE_PROJECT_NAME: poisonedProject,
      PDPP_NEKO_DOCKER_NETWORK: poisonedNetwork,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "smoke should fail fast once the fake docker reports unreachable");

  const calls = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  assert.doesNotMatch(
    calls,
    new RegExp(poisonedProject),
    "no docker invocation should ever reference the inherited (poisoned) COMPOSE_PROJECT_NAME"
  );
  assert.doesNotMatch(
    calls,
    new RegExp(poisonedNetwork),
    "no docker invocation should ever reference the inherited (poisoned) PDPP_NEKO_DOCKER_NETWORK"
  );
  rmSync(fakeDockerDir, { recursive: true, force: true });
});

test("docker-neko-network-durability-smoke.sh synthesizes a fresh, non-live project/network name on every invocation", () => {
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-names-"));
  const logPath = join(fakeDockerDir, "calls.log");
  makeFakeDockerBin(fakeDockerDir, `echo "$*" >> '${logPath}'\nif [[ "$1" == "info" ]]; then exit 1; fi\nexit 0`);

  const runOnce = () => {
    writeFileSync(logPath, "");
    spawnSync("bash", [SMOKE_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${fakeDockerDir}:${process.env.PATH}`,
        PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE: "1",
      },
      encoding: "utf8",
    });
    return readFileSync(logPath, "utf8");
  };

  const firstRunCalls = runOnce();
  const secondRunCalls = runOnce();

  // `network rm <name>` is the one call in this flow whose argument IS the
  // synthesized dynamic-network name verbatim (unlike the label filters,
  // which legitimately contain the fixed literal "pdpp-reference" as a
  // Docker label value, not a project/network identifier). Assert on that
  // line specifically to avoid a false positive on the unrelated label text.
  const extractNetworkRmArg = (calls) => {
    const match = calls.match(/^network rm (\S+)$/m);
    assert.ok(match, `expected a "network rm <name>" call in: ${calls}`);
    return match[1];
  };
  const firstNetworkName = extractNetworkRmArg(firstRunCalls);
  const secondNetworkName = extractNetworkRmArg(secondRunCalls);

  const liveOrDefaultRe = /^(pdpp|pdpp_default|pdpp-reference)$/;
  assert.doesNotMatch(firstNetworkName, liveOrDefaultRe, "must never resolve to a live/default identifier");
  assert.doesNotMatch(secondNetworkName, liveOrDefaultRe, "must never resolve to a live/default identifier");
  assert.notEqual(firstNetworkName, secondNetworkName, "two invocations must synthesize distinct throwaway identifiers, not a fixed name");

  rmSync(fakeDockerDir, { recursive: true, force: true });
});

test("reference-stack.sh ensure_dynamic_surface_network tolerates a concurrent creator racing the same network name", () => {
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-race-"));
  const logPath = join(fakeDockerDir, "calls.log");
  const inspectCountPath = join(fakeDockerDir, "inspect-count");
  makeFakeDockerBin(
    fakeDockerDir,
    `echo "$*" >> '${logPath}'
if [[ "\$1" == "network" && "\$2" == "inspect" ]]; then
  n=$(cat '${inspectCountPath}' 2>/dev/null || echo 0)
  n=$((n+1))
  echo "$n" > '${inspectCountPath}'
  # First inspect: not found (network does not exist yet).
  # Second inspect (after our create loses the race): now exists.
  [[ "$n" -eq 1 ]] && exit 1 || exit 0
fi
if [[ "\$1" == "network" && "\$2" == "create" ]]; then
  # Simulate losing a create race to a concurrent creator: Docker reports a
  # name-conflict failure even though the network now correctly exists.
  exit 1
fi
exit 0`
  );

  const result = spawnSync(
    "bash",
    ["-c", `source "${REFERENCE_STACK_SCRIPT}" && ensure_dynamic_surface_network && echo REGRESSION_TEST_ENSURE_NETWORK_OK`],
    {
      env: {
        ...process.env,
        PATH: `${fakeDockerDir}:${process.env.PATH}`,
        PDPP_REFERENCE_STACK_TEST_SOURCE_ONLY: "1",
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, `expected success despite a losing create race; stderr: ${result.stderr}`);
  assert.match(result.stdout, /REGRESSION_TEST_ENSURE_NETWORK_OK/);

  const calls = readFileSync(logPath, "utf8");
  assert.match(calls, /network inspect/);
  assert.match(calls, /network create/);
  rmSync(fakeDockerDir, { recursive: true, force: true });
});

test("reference-stack.sh ensure_dynamic_surface_network fails closed when the network can neither be found nor created", () => {
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-hard-fail-"));
  makeFakeDockerBin(
    fakeDockerDir,
    `if [[ "\$1" == "network" ]]; then exit 1; fi\nexit 0`
  );

  const result = spawnSync(
    "bash",
    ["-c", `source "${REFERENCE_STACK_SCRIPT}" && ensure_dynamic_surface_network && echo SHOULD_NOT_PRINT`],
    {
      env: {
        ...process.env,
        PATH: `${fakeDockerDir}:${process.env.PATH}`,
        PDPP_REFERENCE_STACK_TEST_SOURCE_ONLY: "1",
      },
      encoding: "utf8",
    }
  );

  assert.notEqual(result.status, 0, "a genuine (non-race) failure to create or confirm the network must still fail closed");
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
  rmSync(fakeDockerDir, { recursive: true, force: true });
});

test("docker-neko-network-durability-smoke.sh cleanup scopes container removal to this run's own synthesized deployment_id, never a fixed literal", () => {
  // Owner static-read finding (2026-07-14): cleanup() previously filtered
  // only by the generic owner label + a FIXED surface_id literal shared by
  // every invocation of this script, so a concurrent run (or an unrelated
  // live container that happened to reuse that literal surface_id) could be
  // removed by a run that does not own it. This locks down the fix: the
  // `docker ps --filter` call must reference this run's own synthesized
  // deployment_id (unique per invocation, embedded in PDPP_NEKO_DEPLOYMENT_ID
  // by construction), never the fixed surface_id string alone, and every
  // resulting `docker rm` must be preceded by a `docker inspect` verifying
  // the label value before removal.
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-cleanup-scope-"));
  const logPath = join(fakeDockerDir, "calls.log");
  // Fake `docker ps -aq --filter ...` returns one fabricated container id so
  // the cleanup path actually reaches rm_if_labeled_exactly's `docker
  // inspect` call, which we can then assert happened before any `docker rm`.
  makeFakeDockerBin(
    fakeDockerDir,
    `echo "$*" >> '${logPath}'
if [[ "\$1" == "ps" ]]; then echo "fabricated-container-id"; exit 0; fi
if [[ "\$1" == "inspect" ]]; then echo "some-label-value"; exit 0; fi
if [[ "\$1" == "info" ]]; then exit 1; fi
exit 0`
  );

  const result = spawnSync("bash", [SMOKE_SCRIPT], {
    env: {
      ...process.env,
      PATH: `${fakeDockerDir}:${process.env.PATH}`,
      PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE: "1",
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "smoke should fail fast once the fake docker reports unreachable, after cleanup() has already run");

  const calls = readFileSync(logPath, "utf8");
  const psCall = calls.split("\n").find((line) => line.startsWith("ps "));
  assert.ok(psCall, `expected a "docker ps" call in: ${calls}`);
  assert.match(psCall, /label=org\.pdpp\.reference\.neko\.deployment_id=pdppnetdurasmoke-/, "cleanup's docker ps filter must reference this run's own synthesized deployment_id");
  assert.doesNotMatch(psCall, /label=org\.pdpp\.reference\.neko\.surface_id=net-durability-smoke-surface$/, "cleanup must not filter solely by the fixed, cross-invocation-shared surface_id literal");

  const psIndex = calls.indexOf(psCall);
  const inspectIndex = calls.indexOf("inspect -f");
  assert.ok(inspectIndex > psIndex, "a docker inspect verification call must happen after docker ps and before any docker rm");
  const rmIndex = calls.indexOf("\nrm -f fabricated-container-id");
  if (rmIndex !== -1) {
    assert.ok(inspectIndex < rmIndex, "docker inspect must be called BEFORE docker rm, never after or instead of");
  }

  rmSync(fakeDockerDir, { recursive: true, force: true });
});

test("docker-neko-network-durability-smoke.sh uses a project-scoped PROFILE_ROOT, not a fixed shared path", () => {
  // Owner static-read finding: a fixed default PROFILE_ROOT
  // (/tmp/pdpp-neko-profiles-net-durability-smoke) meant two concurrent
  // invocations of this script would write to the SAME host directory,
  // risking corrupted or racing Chromium profile state. The fix makes the
  // default path include this run's own synthesized PROJECT_NAME.
  const scriptSource = readFileSync(SMOKE_SCRIPT, "utf8");
  assert.match(
    scriptSource,
    /PROFILE_ROOT="\/tmp\/pdpp-neko-profiles-\$\{PROJECT_NAME\}"/,
    "default PROFILE_ROOT must be scoped by this run's own synthesized PROJECT_NAME, not a fixed shared path"
  );
  assert.doesNotMatch(
    scriptSource,
    /PROFILE_ROOT="\$\{PDPP_NEKO_PROFILE_STORAGE_ROOT/,
    "PROFILE_ROOT must never fall back to an inherited PDPP_NEKO_PROFILE_STORAGE_ROOT — see the inherited-profile-root test below"
  );
});

test("docker-neko-network-durability-smoke.sh never honors an inherited PDPP_NEKO_PROFILE_STORAGE_ROOT", () => {
  // Independent review (2026-07-14) finding 3: the smoke scripts synthesized
  // a unique default profile root, but a caller shell that already exported
  // PDPP_NEKO_PROFILE_STORAGE_ROOT (e.g. one pointed at a live deployment's
  // profile directory) could still override it, letting this throwaway,
  // destructive harness read/write/clobber a live deployment's Chromium
  // profile state. The fix makes PROFILE_ROOT always synthesized, never
  // inherited from the environment at all — same treatment as
  // COMPOSE_PROJECT_NAME / PDPP_NEKO_DOCKER_NETWORK above.
  //
  // Lets `docker info` succeed (unlike the other inherited-env tests) so
  // the script reaches its real `mkdir -p "$PROFILE_ROOT"` line, then fails
  // fast at the next docker call (`network create`) via a poisoned exit
  // code — this observes the actual directory the script created on disk,
  // which is the one thing that can prove PROFILE_ROOT's resolved value,
  // rather than inferring it from docker CLI arguments that never carry it.
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-profileroot-"));
  const logPath = join(fakeDockerDir, "calls.log");
  makeFakeDockerBin(
    fakeDockerDir,
    `echo "$*" >> '${logPath}'\nif [[ "$1" == "info" ]]; then exit 0; fi\nif [[ "$1" == "network" && "$2" == "create" ]]; then exit 1; fi\nexit 0`
  );

  const poisonedProfileRoot = join(mkdtempSync(join(tmpdir(), "pdpp-poisoned-profile-root-")), "live-production-profiles");

  const result = spawnSync("bash", [SMOKE_SCRIPT], {
    env: {
      ...process.env,
      PATH: `${fakeDockerDir}:${process.env.PATH}`,
      PDPP_DOCKER_NEKO_NETWORK_DURABILITY_SMOKE: "1",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: poisonedProfileRoot,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "smoke should fail fast once docker network create is poisoned to fail");
  assert.equal(
    existsSync(poisonedProfileRoot),
    false,
    "the inherited (poisoned) PDPP_NEKO_PROFILE_STORAGE_ROOT directory must never be created — PROFILE_ROOT must always be synthesized fresh"
  );

  rmSync(fakeDockerDir, { recursive: true, force: true });
  rmSync(dirname(poisonedProfileRoot), { recursive: true, force: true });
});

test("docker-neko-network-migration-smoke.sh uses a project-scoped PROFILE_ROOT, not a fixed shared path", () => {
  const scriptSource = readFileSync(MIGRATION_SMOKE_SCRIPT, "utf8");
  assert.match(
    scriptSource,
    /PROFILE_ROOT="\/tmp\/pdpp-neko-profiles-\$\{PROJECT_NAME\}"/,
    "default PROFILE_ROOT must be scoped by this run's own synthesized PROJECT_NAME, not a fixed shared path"
  );
  assert.doesNotMatch(
    scriptSource,
    /PROFILE_ROOT="\$\{PDPP_NEKO_PROFILE_STORAGE_ROOT/,
    "PROFILE_ROOT must never fall back to an inherited PDPP_NEKO_PROFILE_STORAGE_ROOT — see the inherited-profile-root test below"
  );
});

test("docker-neko-network-migration-smoke.sh never honors an inherited PDPP_NEKO_PROFILE_STORAGE_ROOT", () => {
  // Same class of bug as the durability smoke's equivalent test above: this
  // destructive migration smoke must always synthesize its own profile root
  // rather than trusting a caller-inherited PDPP_NEKO_PROFILE_STORAGE_ROOT,
  // which could point at a live deployment's Chromium profile directory.
  //
  // Lets `docker info` succeed so the script reaches its real
  // `mkdir -p "$PROFILE_ROOT"` line, then fails fast at the next docker call
  // (`network create`) via a poisoned exit code — this observes the actual
  // directory the script created on disk.
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-migprofileroot-"));
  const logPath = join(fakeDockerDir, "calls.log");
  makeFakeDockerBin(
    fakeDockerDir,
    `echo "$*" >> '${logPath}'\nif [[ "$1" == "info" ]]; then exit 0; fi\nif [[ "$1" == "network" && "$2" == "create" ]]; then exit 1; fi\nexit 0`
  );

  const poisonedProfileRoot = join(mkdtempSync(join(tmpdir(), "pdpp-poisoned-profile-root-")), "live-production-profiles");

  const result = spawnSync("bash", [MIGRATION_SMOKE_SCRIPT], {
    env: {
      ...process.env,
      PATH: `${fakeDockerDir}:${process.env.PATH}`,
      PDPP_DOCKER_NEKO_NETWORK_MIGRATION_SMOKE: "1",
      PDPP_NEKO_PROFILE_STORAGE_ROOT: poisonedProfileRoot,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, "smoke should fail fast once docker network create is poisoned to fail");
  assert.equal(
    existsSync(poisonedProfileRoot),
    false,
    "the inherited (poisoned) PDPP_NEKO_PROFILE_STORAGE_ROOT directory must never be created — PROFILE_ROOT must always be synthesized fresh"
  );

  rmSync(fakeDockerDir, { recursive: true, force: true });
  rmSync(dirname(poisonedProfileRoot), { recursive: true, force: true });
});

test("reference-stack.sh ensure_dynamic_surface_network is a no-op when the network already exists", () => {
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "pdpp-fake-docker-noop-"));
  const logPath = join(fakeDockerDir, "calls.log");
  makeFakeDockerBin(fakeDockerDir, `echo "$*" >> '${logPath}'\nexit 0`);

  const result = spawnSync(
    "bash",
    ["-c", `source "${REFERENCE_STACK_SCRIPT}" && ensure_dynamic_surface_network && echo REGRESSION_TEST_ENSURE_NETWORK_OK`],
    {
      env: {
        ...process.env,
        PATH: `${fakeDockerDir}:${process.env.PATH}`,
        PDPP_REFERENCE_STACK_TEST_SOURCE_ONLY: "1",
      },
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /REGRESSION_TEST_ENSURE_NETWORK_OK/);
  const calls = readFileSync(logPath, "utf8");
  assert.match(calls, /network inspect/);
  assert.doesNotMatch(calls, /network create/, "must not attempt to create a network that already exists");
  rmSync(fakeDockerDir, { recursive: true, force: true });
});

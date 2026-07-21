// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NekoSurfaceAllocatorClient } from "../runtime/neko-surface-allocator.ts";
import {
  NekoSurfaceAllocatorService,
  NekoSurfaceAllocatorServiceError,
  readNekoSurfaceAllocatorOptionsFromEnv,
  startNekoSurfaceAllocatorServer,
} from "../server/neko-surface-allocator-server.ts";

const LABEL = "org.pdpp.reference.neko";
const DEPLOYMENT_ID = "test-deployment";
const BASE_OPTIONS = Object.freeze({
  image: "ghcr.io/m1k1o/neko/chromium:pdpp-pinned",
  network: "pdpp-neko",
  deploymentId: DEPLOYMENT_ID,
  profileRoot: "/var/lib/pdpp/neko-profiles",
  webrtcHostPortStart: 59000,
  webrtcHostPortEnd: 59002,
  streamBaseUrlTemplate: "http://127.0.0.1:{host_port}/neko",
  cdpBaseUrlTemplate: "http://127.0.0.1:{host_port}/cdp/{surface_id}/",
  now: () => new Date("2026-05-13T12:00:00.000Z"),
  profileFilesystem: noopProfileFilesystem(),
});

test("creates and starts an owned n.eko container with sanitized profile storage and readiness metadata", async () => {
  const docker = new FakeDocker();
  const profileFilesystem = recordingProfileFilesystem();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    profileFilesystem,
    extraEnv: { NEKO_PASSWORD: "dev-password" },
  });

  const surface = await service.ensureSurface({
    surfaceId: "surface:https://chatgpt.example/profile 1",
    connectorId: "chatgpt",
    profileKey: "https://registry.pdpp.org/connectors/chatgpt?owner=the owner@example.com",
    accountKey: "account_1",
  });

  assert.equal(surface.health, "ready");
  assert.equal(surface.backend, "neko");
  assert.equal(surface.container_id, "container_1");
  assert.equal(surface.account_key, "account_1");
  assert.equal(surface.allocator_metadata.readiness, "ready");
  assert.equal(surface.allocator_metadata.host_port, "59000");
  assert.equal(surface.stream_base_url, "http://127.0.0.1:59000/neko");
  assert.match(surface.cdp_url, /^http:\/\/127\.0\.0\.1:59000\/cdp\//);
  assert.equal(surface.window_settle_endpoint, "http://127.0.0.1:59000/pdpp/window-settle");
  assert.equal(surface.allocator_metadata.window_settle_endpoint, "http://127.0.0.1:59000/pdpp/window-settle");

  const create = docker.calls.find((call) => call.path === "/containers/create");
  assert.equal(create.init.method, "POST");
  assert.equal(create.init.body.Image, BASE_OPTIONS.image);
  assert.equal(create.init.body.HostConfig.NetworkMode, BASE_OPTIONS.network);
  assert.deepEqual(create.init.body.HostConfig.PortBindings["59000/tcp"], [{ HostPort: "59000" }]);
  assert.deepEqual(create.init.body.HostConfig.PortBindings["59000/udp"], [{ HostPort: "59000" }]);
  assert.equal(create.init.body.Labels[`${LABEL}.owner`], "pdpp-reference");
  assert.equal(create.init.body.Labels[`${LABEL}.surface_id`], "surface:https://chatgpt.example/profile 1");
  assert.equal(create.init.body.Labels[`${LABEL}.profile_key`], "https://registry.pdpp.org/connectors/chatgpt?owner=the owner@example.com");
  assert.match(create.init.query.name, /^pdpp-neko-chatgpt-[a-f0-9]{16}$/);
  assert.match(create.init.body.Labels[`${LABEL}.profile_slug`], /^chatgpt-[a-f0-9]{16}$/);
  assert.match(create.init.body.Labels[`${LABEL}.profile_path`], /^\/var\/lib\/pdpp\/neko-profiles\/chatgpt-[a-f0-9]{16}$/);
  const profilePath = create.init.body.Labels[`${LABEL}.profile_path`];
  assert.deepEqual(profileFilesystem.calls, [
    { method: "mkdir", path: profilePath, options: { mode: 0o700, recursive: true } },
    { method: "chown", path: profilePath, uid: 1000, gid: 1000 },
    { method: "chmod", path: profilePath, mode: 0o700 },
  ]);
  assert.doesNotMatch(create.init.query.name, /https|the owner|example\.com|registry/);
  assert.doesNotMatch(create.init.body.Labels[`${LABEL}.profile_slug`], /https|the owner|example\.com|registry/);
  assert.ok(create.init.body.Env.includes("NEKO_PASSWORD=dev-password"));
  assert.ok(create.init.body.Env.includes("NEKO_SERVER_BIND=0.0.0.0:8080"));
  assert.ok(create.init.body.Env.includes("NEKO_SERVER_PATH_PREFIX=/neko"));
  assert.ok(create.init.body.Env.includes("PDPP_NEKO_CDP_PROXY_PORT=9223"));
  assert.ok(create.init.body.Env.includes("NEKO_WEBRTC_UDPMUX=59000"));
  assert.ok(create.init.body.Env.includes("NEKO_WEBRTC_TCPMUX=59000"));
  assert.deepEqual(create.init.body.Healthcheck, {
    Test: [
      "CMD-SHELL",
      "wget -q -O /dev/null http://127.0.0.1:8080/neko/health && wget -q -O /dev/null http://127.0.0.1:9223/json/version && supervisorctl status chromium | grep -q RUNNING",
    ],
    Interval: 10_000_000_000,
    Timeout: 5_000_000_000,
    StartPeriod: 20_000_000_000,
    Retries: 12,
  });
  assert.ok(!create.init.body.Env.some((entry) => entry.startsWith("NEKO_BIND=")));
  assert.ok(!create.init.body.Env.some((entry) => entry.startsWith("NEKO_CHROME_FLAGS=")));
  assert.equal(docker.calls.some((call) => call.path === "/containers/container_1/start"), true);
});

test("parses env-driven HTTP listen config and allocator defaults", () => {
  const options = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_default",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
    PDPP_NEKO_ALLOCATOR_PORT: "7331",
    NEKO_DESKTOP_SCREEN: "1440x900@30",
    NEKO_MEMBER_PROVIDER: "multiuser",
    NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: "admin-pass",
    NEKO_MEMBER_MULTIUSER_USER_PASSWORD: "user-pass",
    NEKO_PASSWORD_ADMIN: "admin-pass",
  });

  assert.equal(options.image, "pdpp-neko:local");
  assert.equal(options.network, "pdpp_default");
  assert.equal(options.profileRoot, "/srv/pdpp/neko-profiles");
  assert.equal(options.listenHost, "0.0.0.0");
  assert.equal(options.listenPort, 7331);
  assert.equal(options.profileOwnerUid, 1000);
  assert.equal(options.profileOwnerGid, 1000);
  assert.equal(options.streamBaseUrlTemplate, "http://{container_name}:8080/neko");
  assert.equal(options.cdpBaseUrlTemplate, "http://{container_name}:9223/");
  assert.equal(options.extraEnv.NEKO_DESKTOP_SCREEN, "1440x900@30");
  assert.equal(options.extraEnv.NEKO_MEMBER_PROVIDER, "multiuser");
  assert.equal(options.extraEnv.NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD, "admin-pass");
  assert.equal(options.extraEnv.NEKO_MEMBER_MULTIUSER_USER_PASSWORD, "user-pass");
  assert.equal(options.extraEnv.NEKO_PASSWORD_ADMIN, "admin-pass");
});

test("dynamic surface network default does not derive from COMPOSE_PROJECT_NAME", () => {
  const withProjectName = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
    COMPOSE_PROJECT_NAME: "some-other-project",
  });
  const withoutProjectName = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
  });

  assert.equal(withProjectName.network, "pdpp_neko_dynamic");
  assert.equal(withoutProjectName.network, "pdpp_neko_dynamic");
  assert.equal(withProjectName.network, withoutProjectName.network);
});

test("readNekoSurfaceAllocatorOptionsFromEnv requires PDPP_NEKO_DEPLOYMENT_ID with no default value", () => {
  // No default is deliberate: see NekoSurfaceAllocatorServerOptions#deploymentId
  // — two independently configured allocator instances on the same Docker
  // host must never be able to collide on a shared default.
  assert.throws(
    () =>
      readNekoSurfaceAllocatorOptionsFromEnv({
        NEKO_IMAGE: "pdpp-neko:local",
        PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
        PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
      }),
    (error) => error instanceof NekoSurfaceAllocatorServiceError && error.code === "bad_request",
  );
});

test("readNekoSurfaceAllocatorOptionsFromEnv parses deploymentId", () => {
  const options = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
    PDPP_NEKO_DEPLOYMENT_ID: "prod-2026-07-14",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
  });

  assert.equal(options.deploymentId, "prod-2026-07-14");
});

test("ensureNetworkExists creates the network only when it does not already exist", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });

  await service.ensureNetworkExists();

  const createCalls = docker.calls.filter((call) => call.path === "/networks/create");
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].init.body.Name, BASE_OPTIONS.network);
  assert.ok(docker.networks.has(BASE_OPTIONS.network));

  await service.ensureNetworkExists();

  assert.equal(
    docker.calls.filter((call) => call.path === "/networks/create").length,
    1,
    "a second ensureNetworkExists call must not attempt to recreate an already-existing network",
  );
});

test("ensureNetworkExists tolerates a concurrent creator racing the same network name", async () => {
  const docker = new FakeDocker();
  docker.networkCreateConflict = true;
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });

  await assert.doesNotReject(() => service.ensureNetworkExists());
});

test("ensureSurface migrates a legacy-network-only owned container to the expected network and detaches the legacy one", async () => {
  // Fixture shape verified against live Docker (2026-07-14, independent
  // review of commit 43249a265): `docker inspect` on real pre-change
  // pdpp-neko-* containers confirms Docker Compose itself sets
  // com.docker.compose.project on every container it creates, matching this
  // instance's own project/deploymentId — addLegacyNetworkOwnedContainer's
  // default `composeProject: DEPLOYMENT_ID` models exactly that observed
  // shape, not a synthetic best-case. #isOwnedByThisDeployment therefore
  // recognizes real legacy containers without needing the allocator's own
  // container-create path to write com.docker.compose.project (it never
  // could — that label belongs to Compose, not this allocator's code).
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.container_id, "container_1", "the same container must survive the migration, never be replaced");
  assert.equal(surface.health, "ready");
  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has(BASE_OPTIONS.network), "expected network must be attached");
  assert.equal(migrated.networks.has("pdpp_default"), false, "legacy network must be detached after successful migration");
  const connectCall = docker.calls.find((call) => call.path === `/networks/${BASE_OPTIONS.network}/connect`);
  assert.equal(connectCall.init.body.Container, "container_1");
  const disconnectCall = docker.calls.find((call) => call.path === "/networks/pdpp_default/disconnect");
  assert.equal(disconnectCall.init.body.Container, "container_1");
});

test("ensureSurface does NOT detach the legacy network until the expected network is proven reachable by direct IP probe, not just attached", async () => {
  // hasNetwork() proves Docker created the endpoint, not that the neko
  // process is actually reachable over it yet. This proves the allocator
  // gates the legacy detach on an explicit reachability probe against the
  // expected network's own IP address (never container-name DNS, which
  // could silently succeed via the still-attached legacy network instead).
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  const expectedNetworkIp = docker.ipAddressFor("container_1", BASE_OPTIONS.network);
  const requestedHosts = [];
  let expectedNetworkReachable = false;
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    legacyNetwork: "pdpp_default",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === expectedNetworkIp) {
        // The expected-network IP specifically is unreachable — legacy
        // must stay attached even though the attach step itself succeeded.
        return expectedNetworkReachable
          ? new Response("ok", { status: 200 })
          : new Response("unreachable", { status: 503 });
      }
      // Container-name-DNS-routed probes (neko HTTP / CDP) always succeed,
      // simulating the exact risk the commit calls out: the container is
      // fully reachable via the still-attached legacy network path, so if
      // readiness ever fell through to these probes while the expected
      // network is unproven, it would misreport "ready".
      if (url.pathname.includes("/json/version")) {
        return Response.json({ Browser: "Chrome/126.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/1" });
      }
      return new Response("ok", { status: 200 });
    },
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has(BASE_OPTIONS.network), "the expected network attach step itself must still have succeeded");
  assert.ok(migrated.networks.has("pdpp_default"), "legacy network must remain attached because reachability on the expected network was never proven");
  assert.equal(
    docker.calls.some((call) => call.path === "/networks/pdpp_default/disconnect"),
    false,
    "no detach call may ever be issued before the expected-network reachability probe succeeds",
  );
  assert.ok(requestedHosts.includes(expectedNetworkIp), "the allocator must probe the container's IP address on the expected network directly");
  assert.equal(surface.container_id, "container_1", "a still-pending migration must never replace the container");
  // The core of this bug: attach succeeded but the direct-IP reachability
  // probe failed. That state must be surfaced as a bounded, retryable
  // "pending" result — never "ready" via the container-name-DNS probes that
  // would otherwise be silently satisfied through the still-attached legacy
  // network.
  assert.equal(surface.health, "starting", "attach-success + reachability-fail must never report ready");
  assert.equal(
    surface.allocator_metadata.readiness,
    "legacy_network_migration_pending",
    "the specific reason must identify the pending migration, not a generic probe-unready reason",
  );

  // Retry: a later access with the same still-unreachable expected network
  // must keep reporting the same bounded pending state, not flap to some
  // other reason or health.
  const retried = await service.getSurfaceStatus("surface_1");
  assert.equal(retried.health, "starting");
  assert.equal(retried.allocator_metadata.readiness, "legacy_network_migration_pending");
  assert.ok(docker.containers.get("container_1").networks.has("pdpp_default"), "legacy network still must not be detached on a retry that keeps failing reachability");

  // Eventual success: once the expected network actually becomes reachable,
  // the next access must complete the migration and detach the legacy
  // network, converging on a normal ready surface.
  expectedNetworkReachable = true;
  const recovered = await service.getSurfaceStatus("surface_1");
  assert.equal(recovered.health, "ready");
  assert.equal(recovered.allocator_metadata.readiness, "ready");
  const recoveredContainer = docker.containers.get("container_1");
  assert.ok(recoveredContainer.networks.has(BASE_OPTIONS.network));
  assert.equal(recoveredContainer.networks.has("pdpp_default"), false, "legacy network must be detached once reachability is finally proven");
});

test("ensureSurface migration is idempotent when the container is already attached to the expected network", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  docker.calls.length = 0;

  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(docker.calls.some((call) => call.path.includes("/connect")), false);
  assert.equal(docker.calls.some((call) => call.path.includes("/disconnect")), false);
});

test("ensureSurface never detaches a network other than the explicitly configured legacy network", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  const id = "container_1";
  docker.addLegacyNetworkOwnedContainer(id, { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  // A second, unrelated user network the container happens to also be on.
  // Nothing in this migration is allowed to touch it, configured or not.
  docker.containers.get(id).networks.add("some-other-user-network");
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  const migrated = docker.containers.get(id);
  assert.ok(migrated.networks.has("some-other-user-network"), "unrelated user networks must never be touched");
  assert.equal(migrated.networks.has("pdpp_default"), false);
  assert.equal(
    docker.calls.some((call) => call.path === "/networks/some-other-user-network/disconnect"),
    false,
  );
});

test("ensureSurface does not detach the legacy network when legacyNetwork is not configured", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.container_id, "container_1");
  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has(BASE_OPTIONS.network), "network attach must still happen without legacyNetwork config");
  assert.ok(migrated.networks.has("pdpp_default"), "without an explicit legacyNetwork, nothing is ever detached");
});

test("ensureSurface preserves the container and reports a bounded pending state when the network attach fails", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  docker.networkConnectFailFor.add("container_1");
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.container_id, "container_1", "a failed migration must never replace the existing container");
  assert.equal(surface.health, "starting");
  assert.equal(surface.allocator_metadata.readiness, "legacy_network_migration_pending");
  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has("pdpp_default"), "legacy network must remain attached when migration fails");
  assert.equal(migrated.networks.has(BASE_OPTIONS.network), false);
});

test("ensureSurface keeps the legacy network attached when detach fails, but still reports the surface as reachable", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  docker.networkDisconnectFailFor.add("container_1");
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.container_id, "container_1");
  assert.equal(surface.health, "ready", "the container is already reachable on the new network, so detach failure is not a health problem");
  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has(BASE_OPTIONS.network));
  assert.ok(migrated.networks.has("pdpp_default"), "legacy network stays attached until a later detach attempt succeeds");
});

test("ensureSurface retries a previously failed legacy detach on the next access", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  docker.networkDisconnectFailFor.add("container_1");
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  docker.networkDisconnectFailFor.delete("container_1");

  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(docker.containers.get("container_1").networks.has("pdpp_default"), false);
});

test("getSurfaceStatus migrates a legacy-network-only container without going through ensureSurface", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const status = await service.getSurfaceStatus("surface_1");

  assert.equal(status?.container_id, "container_1");
  assert.equal(status?.health, "ready");
  const migrated = docker.containers.get("container_1");
  assert.ok(migrated.networks.has(BASE_OPTIONS.network));
  assert.equal(migrated.networks.has("pdpp_default"), false);
});

test("listSurfaces migrates every legacy-network-only owned container it discovers", async () => {
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default", hostPort: 59000 });
  docker.addLegacyNetworkOwnedContainer("container_2", { surfaceId: "surface_2", legacyNetwork: "pdpp_default", hostPort: 59001 });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surfaces = await service.listSurfaces();

  assert.deepEqual(
    surfaces.map((surface) => [surface.surface_id, surface.health]),
    [
      ["surface_1", "ready"],
      ["surface_2", "ready"],
    ],
  );
  assert.equal(docker.containers.get("container_1").networks.has("pdpp_default"), false);
  assert.equal(docker.containers.get("container_2").networks.has("pdpp_default"), false);
});

test("ensureSurface migrates a container being restarted from an exited-but-not-replaceable state", async () => {
  // Mirrors the "restart into new config" race: the container was stopped
  // cleanly (not exited/dead) and only needs a start, not a replace — the
  // network migration must still run on that path.
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("container_1", { surfaceId: "surface_1", legacyNetwork: "pdpp_default" });
  docker.containers.get("container_1").running = false;
  docker.containers.get("container_1").state = "created";
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.container_id, "container_1");
  assert.equal(docker.containers.get("container_1").running, true);
  assert.equal(docker.containers.get("container_1").networks.has(BASE_OPTIONS.network), true);
  assert.equal(docker.containers.get("container_1").networks.has("pdpp_default"), false);
});

test("an unnamespaced legacy container from a DIFFERENT Compose project is invisible and untouched", async () => {
  // A genuinely unnamespaced legacy container (no deployment_id label at
  // all) is only recognized when its Docker-Compose-assigned
  // com.docker.compose.project label matches THIS instance's deploymentId.
  // A container from an unrelated Compose project must never be reused,
  // migrated, or otherwise touched, even though it carries the same generic
  // owner label — this is the actual isolation boundary, not an opt-in flag.
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("preexisting_legacy_container", {
    surfaceId: "surface_1",
    legacyNetwork: "pdpp_default",
    composeProject: "some-other-compose-project",
  });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.notEqual(surface.container_id, "preexisting_legacy_container", "a legacy container from a different Compose project must never be reused");
  assert.equal(docker.containers.get("preexisting_legacy_container").networks.has("pdpp_default"), true, "the foreign-project container itself must be left completely untouched");
  assert.equal(
    docker.calls.some((call) => call.init?.body?.Container === "preexisting_legacy_container"),
    false,
    "no network connect/disconnect call may ever reference a container from a different Compose project",
  );
});

test("a container belonging to a DIFFERENT deployment id is never enumerated, migrated, or otherwise touched", async () => {
  // This is the regression guard for the isolation failure: two allocator
  // instances (e.g. a throwaway smoke run and a real deployment) sharing a
  // Docker daemon and the same generic owner label must never be able to
  // see or mutate each other's containers. Recognition of a genuinely
  // unnamespaced legacy container (Compose-project match, no explicit
  // opt-in flag) is exclusively for containers with NO deployment_id label
  // at all — never for resolving a conflict between two EXPLICITLY named
  // deployments, which is what this test covers.
  const docker = new FakeDocker();
  docker.networks.add(BASE_OPTIONS.network);
  docker.addLegacyNetworkOwnedContainer("foreign_deployment_container", {
    surfaceId: "surface_1",
    legacyNetwork: "pdpp_default",
  });
  docker.containers.get("foreign_deployment_container").labels[`${LABEL}.deployment_id`] = "some-other-deployment";
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    legacyNetwork: "pdpp_default",
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const listed = await service.listSurfaces();
  const status = await service.getSurfaceStatus("surface_1");

  assert.notEqual(surface.container_id, "foreign_deployment_container");
  assert.equal(
    listed.some((s) => s.container_id === "foreign_deployment_container"),
    false,
    "listSurfaces must never enumerate a container belonging to a different deployment id",
  );
  assert.equal(status?.container_id, surface.container_id, "getSurfaceStatus for this surface_id must resolve to this deployment's own new container, never the foreign one");
  assert.equal(
    docker.containers.get("foreign_deployment_container").networks.has("pdpp_default"),
    true,
    "the foreign-deployment container's network attachment must be completely unchanged",
  );
  assert.equal(
    docker.calls.some((call) => call.init?.body?.Container === "foreign_deployment_container"),
    false,
    "no network connect/disconnect call may ever reference a different deployment's container",
  );
});

test("readNekoSurfaceAllocatorOptionsFromEnv defaults legacyNetwork to the Compose default network name", () => {
  const withProjectName = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
    COMPOSE_PROJECT_NAME: "pdpp",
  });
  const withExplicitOverride = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_neko_dynamic",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
    PDPP_NEKO_LEGACY_DOCKER_NETWORK: "custom_legacy_net",
  });

  assert.equal(withProjectName.legacyNetwork, "pdpp_default");
  assert.equal(withExplicitOverride.legacyNetwork, "custom_legacy_net");
});

test("startNekoSurfaceAllocatorServer ensures the dynamic surface network exists before listening", async () => {
  const docker = new FakeDocker();
  const server = await startNekoSurfaceAllocatorServer({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  try {
    assert.ok(docker.networks.has(BASE_OPTIONS.network));
  } finally {
    await server.close();
  }
});

test("compose dynamic allocator command and stream template match reference image layout", async () => {
  const compose = await readFile(new URL("../../docker-compose.neko.yml", import.meta.url), "utf8");

  assert.match(compose, /command: \["node", "reference-implementation\/server\/neko-surface-allocator-server\.ts"\]/);
  assert.match(
    compose,
    /PDPP_NEKO_STREAM_BASE_URL_TEMPLATE: \$\{PDPP_NEKO_STREAM_BASE_URL_TEMPLATE:-http:\/\/\{container_name\}:8080\/neko\}/,
  );
  assert.match(compose, /PDPP_NEKO_PROFILE_OWNER_UID: \$\{PDPP_NEKO_PROFILE_OWNER_UID:-1000\}/);
  assert.match(compose, /PDPP_NEKO_PROFILE_OWNER_GID: \$\{PDPP_NEKO_PROFILE_OWNER_GID:-1000\}/);
  assert.match(
    compose,
    /\$\{PDPP_NEKO_PROFILE_STORAGE_ROOT:-\/var\/lib\/pdpp\/neko-profiles\}:\$\{PDPP_NEKO_PROFILE_STORAGE_ROOT:-\/var\/lib\/pdpp\/neko-profiles\}/,
  );
  assert.doesNotMatch(compose, /command: \["node", "server\/neko-surface-allocator-server\.ts"\]/);
  assert.doesNotMatch(compose, /8080\/neko\/\{surface_id\}/);
});

test("compose declares the dynamic surface network as externally managed, not Compose-owned", async () => {
  const compose = await readFile(new URL("../../docker-compose.neko.yml", import.meta.url), "utf8");

  assert.match(compose, /pdpp_neko_dynamic:\s*\n\s*external: true/);
  assert.match(compose, /PDPP_NEKO_DOCKER_NETWORK: \$\{PDPP_NEKO_DOCKER_NETWORK:-pdpp_neko_dynamic\}/);
  // Regression guard for the fixed durability defect: the network must not
  // be interpolated from COMPOSE_PROJECT_NAME, which would tie its identity
  // back to one Compose project and reintroduce the teardown race this
  // change fixes (docker compose down unconditionally removes every network
  // it created for its own project).
  assert.doesNotMatch(compose, /PDPP_NEKO_DOCKER_NETWORK:.*COMPOSE_PROJECT_NAME/);
});

test("compose declares an explicit legacy network for in-place migration of pre-existing surfaces", async () => {
  const compose = await readFile(new URL("../../docker-compose.neko.yml", import.meta.url), "utf8");

  assert.match(
    compose,
    /PDPP_NEKO_LEGACY_DOCKER_NETWORK: \$\{PDPP_NEKO_LEGACY_DOCKER_NETWORK:-\$\{COMPOSE_PROJECT_NAME:-pdpp\}_default\}/,
  );
});

test("managed n.eko Chrome policy restores prior browser session", async () => {
  const policies = JSON.parse(await readFile(new URL("../../docker/neko/policies.json", import.meta.url), "utf8"));

  assert.equal(
    policies.RestoreOnStartup,
    1,
    "session-cookie auth must survive managed browser container restarts"
  );
});

test("parses explicit n.eko profile owner uid and gid overrides", () => {
  const options = readNekoSurfaceAllocatorOptionsFromEnv({
    NEKO_IMAGE: "pdpp-neko:local",
    PDPP_NEKO_DOCKER_NETWORK: "pdpp_default",
    PDPP_NEKO_DEPLOYMENT_ID: "test-deployment",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/srv/pdpp/neko-profiles",
    PDPP_NEKO_PROFILE_OWNER_UID: "1001",
    PDPP_NEKO_PROFILE_OWNER_GID: "1002",
  });

  assert.equal(options.profileOwnerUid, 1001);
  assert.equal(options.profileOwnerGid, 1002);
});

test("does not create a Docker container when profile directory preparation fails", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    profileFilesystem: {
      async mkdir() {},
      async chown() {
        throw new Error("chown failed");
      },
      async chmod() {},
    },
  });

  await assert.rejects(
    () => service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" }),
    /chown failed/,
  );
  assert.equal(docker.calls.some((call) => call.path === "/containers/create"), false);
});

test("rejects relative profile roots because Docker bind mounts resolve on the host", () => {
  assert.throws(
    () =>
      new NekoSurfaceAllocatorService({
        ...BASE_OPTIONS,
        profileRoot: "./tmp/neko-profiles",
        docker: new FakeDocker(),
        fetchImpl: readyFetch(),
      }),
    (error) => error instanceof NekoSurfaceAllocatorServiceError && error.code === "bad_request",
  );
});

test("preserves base URL paths when joining readiness probe paths", async () => {
  const requestedPaths = [];
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker: new FakeDocker(),
    cdpVersionPath: "/json/version",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith("/json/version")) {
        return Response.json({ Browser: "Chrome/126.0.0.0" });
      }
      return new Response("ok", { status: 200 });
    },
  });

  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.ok(requestedPaths.includes("/neko/health"));
  assert.ok(requestedPaths.includes("/cdp/surface_1/json/version"));
});

test("reports ready when stream image endpoints are unauthorized or unavailable", async () => {
  const requestedPaths = [];
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker: new FakeDocker(),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith("/json/version")) {
        return Response.json({ Browser: "Chrome/126.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/1" });
      }
      if (url.pathname.endsWith("/api/room/screen/cast.jpg")) {
        return new Response("screencast pipeline is not enabled", { status: 400 });
      }
      if (url.pathname.endsWith("/api/room/screen/shot.jpg")) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("ok", { status: 200 });
    },
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.readiness, "ready");
  assert.deepEqual(
    requestedPaths.filter((path) => path.includes("/api/room/screen/")),
    [],
  );
});

test("gets, lists, and stops only PDPP-owned surfaces", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  docker.addForeignContainer("foreign_1", { [`${LABEL}.surface_id`]: "surface_foreign" });

  const status = await service.getSurfaceStatus("surface_1");
  assert.equal(status?.surface_id, "surface_1");
  assert.deepEqual(
    (await service.listSurfaces()).map((surface) => surface.surface_id),
    ["surface_1"],
  );

  const stopped = await service.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" });
  assert.equal(stopped?.health, "stopping");
  assert.equal(docker.containers.get("container_1").running, false);
});

test("stopSurface tolerates post-stop inspect without Docker host port bindings", async () => {
  const docker = new FakeDocker();
  docker.omitPortBindingsWhenStopped = true;
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  const stopped = await service.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" });

  assert.equal(stopped?.surface_id, "surface_1");
  assert.equal(stopped?.health, "stopping");
  assert.equal(stopped?.allocator_metadata.host_port, "59000");
});

test("getSurfaceStatus and listSurfaces tolerate stopped containers without Docker host port bindings", async () => {
  const docker = new FakeDocker();
  docker.omitPortBindingsWhenStopped = true;
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  await service.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" });

  const status = await service.getSurfaceStatus("surface_1");
  const listed = await service.listSurfaces();

  assert.equal(status?.surface_id, "surface_1");
  assert.equal(status?.health, "stopping");
  assert.equal(status?.allocator_metadata.readiness, "container_not_running");
  assert.equal(status?.allocator_metadata.host_port, "59000");
  assert.deepEqual(
    listed.map((surface) => [surface.surface_id, surface.health, surface.allocator_metadata.host_port]),
    [["surface_1", "stopping", "59000"]],
  );
});

test("getSurfaceStatus keeps rejecting running containers without Docker host port bindings", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  docker.containers.get("container_1").hostPort = undefined;

  await assert.rejects(
    () => service.getSurfaceStatus("surface_1"),
    (error) => error instanceof NekoSurfaceAllocatorServiceError && error.code === "docker_malformed_response",
  );
});

test("HTTP DELETE returns a stopped surface when Docker removes the owned container before post-stop inspect", async () => {
  const docker = new FakeDocker();
  docker.removeOnStop = true;
  const server = await startNekoSurfaceAllocatorServer({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  try {
    const client = new NekoSurfaceAllocatorClient({ baseUrl: server.url });
    await client.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

    const stopped = await client.stopSurface({ surfaceId: "surface_1", reason: "operator" });

    assert.equal(stopped?.surface_id, "surface_1");
    assert.equal(stopped?.health, "stopping");
    assert.equal(stopped?.allocator_metadata.readiness, "container_removed");
  } finally {
    await server.close();
  }
});

test("HTTP GET and list return a stopped surface when Docker omits post-stop host port bindings", async () => {
  const docker = new FakeDocker();
  docker.omitPortBindingsWhenStopped = true;
  const server = await startNekoSurfaceAllocatorServer({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  try {
    const client = new NekoSurfaceAllocatorClient({ baseUrl: server.url });
    await client.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
    await client.stopSurface({ surfaceId: "surface_1", reason: "operator" });

    const status = await client.getSurfaceStatus("surface_1");
    const listed = await client.listSurfaces();

    assert.equal(status?.surface_id, "surface_1");
    assert.equal(status?.health, "stopping");
    assert.equal(status?.allocator_metadata.readiness, "container_not_running");
    assert.equal(status?.allocator_metadata.host_port, "59000");
    assert.deepEqual(
      listed.map((surface) => [surface.surface_id, surface.health, surface.allocator_metadata.host_port]),
      [["surface_1", "stopping", "59000"]],
    );
  } finally {
    await server.close();
  }
});

test("rejects an inspected unlabeled or foreign Docker resource", async () => {
  const docker = new FakeDocker();
  docker.addOwnedSummaryForForeignInspect("foreign_inspect", "surface_1");
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });

  await assert.rejects(
    () => service.getSurfaceStatus("surface_1"),
    (error) => error instanceof NekoSurfaceAllocatorServiceError && error.code === "foreign_resource",
  );
});

test("does not create beyond the configured host port range", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    webrtcHostPortStart: 59000,
    webrtcHostPortEnd: 59000,
  });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  await assert.rejects(
    () => service.ensureSurface({ surfaceId: "surface_2", connectorId: "chatgpt", profileKey: "profile_2" }),
    (error) => error instanceof NekoSurfaceAllocatorServiceError && error.code === "port_capacity_exhausted",
  );
});

test("reclaims stopped containers when the dynamic host port range is otherwise full", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    webrtcHostPortStart: 59000,
    webrtcHostPortEnd: 59001,
  });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  await service.ensureSurface({ surfaceId: "surface_2", connectorId: "reddit", profileKey: "profile_2" });
  await service.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" });
  await service.stopSurface({ surfaceId: "surface_2", reason: "idle_ttl" });
  const stoppedContainerIds = [...docker.containers.keys()];
  docker.calls.length = 0;

  const surface = await service.ensureSurface({
    surfaceId: "surface_3",
    connectorId: "amazon",
    profileKey: "profile_3",
  });

  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.host_port, "59000");
  assert.equal(docker.containers.has(stoppedContainerIds[0]), false);
  assert.equal(docker.containers.has(stoppedContainerIds[1]), true);
  assert.ok(
    docker.calls.some((call) => call.path === `/containers/${stoppedContainerIds[0]}` && call.init.method === "DELETE"),
    "the stopped container occupying the selected port must be removed before creating the new surface",
  );
});

test("reclaims every stopped container sharing the selected labeled host port", async () => {
  const docker = new FakeDocker();
  docker.addStoppedOwnedContainerWithoutPublishedPorts("stopped_a", {
    [`${LABEL}.owner`]: "pdpp-reference",
    [`${LABEL}.surface_id`]: "old_surface_a",
    [`${LABEL}.webrtc_host_port`]: "59000",
  });
  docker.addStoppedOwnedContainerWithoutPublishedPorts("stopped_b", {
    [`${LABEL}.owner`]: "pdpp-reference",
    [`${LABEL}.surface_id`]: "old_surface_b",
    [`${LABEL}.webrtc_host_port`]: "59000",
  });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    webrtcHostPortStart: 59000,
    webrtcHostPortEnd: 59000,
  });

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "chatgpt",
    profileKey: "profile_1",
  });

  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.host_port, "59000");
  assert.equal(docker.containers.has("stopped_a"), false);
  assert.equal(docker.containers.has("stopped_b"), false);
  assert.ok(docker.calls.some((call) => call.path === "/containers/stopped_a" && call.init.method === "DELETE"));
  assert.ok(docker.calls.some((call) => call.path === "/containers/stopped_b" && call.init.method === "DELETE"));
});

test("retries the next host port when Docker reports a start-time port collision", async () => {
  const docker = new FakeDocker();
  docker.failStartForHostPort(59000);
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    webrtcHostPortStart: 59000,
    webrtcHostPortEnd: 59001,
  });

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "amazon",
    profileKey: "amazon:connection_1",
  });

  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.host_port, "59001");
  assert.equal(docker.containers.size, 1);
  assert.equal([...docker.containers.values()][0].hostPort, 59001);
  assert.ok(
    docker.calls.some((call) => call.path === "/containers/container_1" && call.init.method === "DELETE"),
    "the failed created container must be removed before retrying another port",
  );
  assert.deepEqual(
    docker.calls
      .filter((call) => call.path === "/containers/create")
      .map((call) => call.init.body.Labels[`${LABEL}.webrtc_host_port`]),
    ["59000", "59001"],
  );
});

test("host port allocation treats labeled created containers without published ports as used", async () => {
  const docker = new FakeDocker();
  docker.addOwnedContainerWithoutPublishedPorts("created_1", {
    [`${LABEL}.owner`]: "pdpp-reference",
    [`${LABEL}.surface_id`]: "other_surface",
    [`${LABEL}.webrtc_host_port`]: "59000",
  });
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
    webrtcHostPortStart: 59000,
    webrtcHostPortEnd: 59001,
  });

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "amazon",
    profileKey: "amazon:connection_1",
  });

  assert.equal(surface.health, "ready");
  assert.equal(surface.allocator_metadata.host_port, "59001");
});

test("reports starting until n.eko, CDP, and Chromium probes pass", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: selectiveFetch((url) => !url.pathname.includes("/json/version")),
  });

  const surface = await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });

  assert.equal(surface.health, "starting");
  assert.equal(surface.allocator_metadata.readiness, "cdp_unready");
});

test("HTTP handler matches NekoSurfaceAllocatorClient contract", async () => {
  const docker = new FakeDocker();
  const server = await startNekoSurfaceAllocatorServer({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  try {
    const client = new NekoSurfaceAllocatorClient({ baseUrl: server.url });
    const created = await client.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
    assert.equal(created.health, "ready");
    assert.equal((await client.getSurfaceStatus("surface_1"))?.surface_id, "surface_1");
    assert.deepEqual(
      (await client.listSurfaces()).map((surface) => surface.surface_id),
      ["surface_1"],
    );
    assert.equal((await client.stopSurface({ surfaceId: "surface_1", reason: "operator" }))?.health, "stopping");
    assert.equal(await client.getSurfaceStatus("missing"), null);
  } finally {
    await server.close();
  }
});

test("ensureSurface removes a stale exited container and creates a fresh one (no silent restart of a dead carcass)", async () => {
  // Regression: USAA run_1779900509276 leased a surface whose underlying
  // container had exited (255) hours earlier and was detached from the
  // Docker network. The previous ensureSurface() path called /start on the
  // exited container and treated it as healthy. Replace the carcass instead.
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  // Seed the FakeDocker with an existing exited managed container for the
  // requested surface id.
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const firstContainerId = [...docker.containers.keys()][0];
  // Simulate the container exiting after the previous run (the bug scenario).
  docker.containers.get(firstContainerId).running = false;
  docker.calls.length = 0;

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "chatgpt",
    profileKey: "profile_1",
  });

  assert.equal(surface.health, "ready");
  // The exited container should have been removed (DELETE call seen).
  const deleteCall = docker.calls.find(
    (call) => call.init.method === "DELETE" && call.path === `/containers/${firstContainerId}`,
  );
  assert.ok(deleteCall, "exited container must be removed before a fresh container is created");
  // A new container should have been created.
  assert.ok(docker.calls.some((call) => call.path === "/containers/create"));
  assert.notEqual(surface.container_id, firstContainerId);
});

test("stopSurface(surface_failed) removes the container so the next ensureSurface gets a clean slate", async () => {
  // Regression: with reason=idle_ttl/operator the container is left exited;
  // with reason=surface_failed the controller has direct CDP evidence that
  // the container is unrecoverable. The next acquire must NOT restart the
  // carcass, so the allocator removes it.
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const containerId = [...docker.containers.keys()][0];
  docker.calls.length = 0;

  const stopped = await service.stopSurface({ surfaceId: "surface_1", reason: "surface_failed" });

  assert.equal(stopped?.health, "stopping");
  assert.equal(stopped?.allocator_metadata.readiness, "container_removed");
  // DELETE was called.
  const deleteCall = docker.calls.find(
    (call) => call.init.method === "DELETE" && call.path === `/containers/${containerId}`,
  );
  assert.ok(deleteCall, "stopSurface(surface_failed) must DELETE the container");
  // And the container is gone from docker state.
  assert.equal(docker.containers.has(containerId), false);
});

test("stopSurface(idle_ttl) preserves the container so it can be restarted cheaply (no DELETE)", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const containerId = [...docker.containers.keys()][0];
  docker.calls.length = 0;

  await service.stopSurface({ surfaceId: "surface_1", reason: "idle_ttl" });

  const deleteCall = docker.calls.find((call) => call.init.method === "DELETE");
  assert.equal(deleteCall, undefined, "idle_ttl must NOT delete the container");
  assert.equal(docker.containers.has(containerId), true);
});

test("ensureSurface replaces a RUNNING container that Docker marks unhealthy (wedged CDP carcass, never exits)", async () => {
  // Recurrence (ri-browser-surface-recurrence-v2): a dynamic ChatGPT/Amazon
  // surface can be leased + probed healthy, run, release, then have its CDP /
  // Chromium wedge while idle and unleased. The container keeps RUNNING, so it
  // never hits the exited-carcass branch; Docker's healthcheck flips it to
  // `unhealthy` (observed live: 500+ failing streak, Up 19h). Returning that
  // carcass would hand the next acquire a dead CDP socket and burn an owner OTP
  // cycle. The allocator must replace it, exactly as it replaces an exited one.
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const firstContainerId = [...docker.containers.keys()][0];
  // The container is still running, but Docker's healthcheck has marked it
  // unhealthy after its retry budget — the wedged-but-running scenario.
  docker.containers.get(firstContainerId).health = "unhealthy";
  docker.calls.length = 0;

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "chatgpt",
    profileKey: "profile_1",
  });

  // The wedged running container was removed (DELETE) and a fresh one created.
  const deleteCall = docker.calls.find(
    (call) => call.init.method === "DELETE" && call.path === `/containers/${firstContainerId}`,
  );
  assert.ok(deleteCall, "unhealthy running container must be removed before a fresh container is created");
  assert.ok(docker.calls.some((call) => call.path === "/containers/create"));
  assert.notEqual(surface.container_id, firstContainerId);
  assert.equal(docker.containers.has(firstContainerId), false);
  assert.equal(surface.health, "ready");
});

test("getSurfaceStatus advertises the exact RI pre-claim replacement intent", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({ ...BASE_OPTIONS, docker, fetchImpl: readyFetch() });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const container = docker.containers.get("container_1");

  container.health = "unhealthy";
  const unhealthy = await service.getSurfaceStatus("surface_1");
  assert.equal(unhealthy.allocator_metadata.ensure_disposition, "replace");

  container.health = undefined;
  container.running = false;
  const stopped = await service.getSurfaceStatus("surface_1");
  assert.equal(stopped.allocator_metadata.ensure_disposition, "replace");
});

test("ensureSurface does NOT replace a running container that is cold-starting (no boot loop)", async () => {
  // Boot-loop safety: a freshly launched surface legitimately reports
  // cdp_unready ("starting") while Chromium boots, and Docker reports
  // Health.Status="starting" inside the StartPeriod. The allocator must key on
  // Docker's debounced "unhealthy" verdict, never on the transient cold-start
  // signal, or every acquire during boot would destroy the booting container.
  const docker = new FakeDocker();
  // CDP /json/version not yet answering -> allocator #readiness = cdp_unready.
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: selectiveFetch((url) => !url.pathname.includes("/json/version")),
  });
  await service.ensureSurface({ surfaceId: "surface_1", connectorId: "chatgpt", profileKey: "profile_1" });
  const firstContainerId = [...docker.containers.keys()][0];
  // Docker still inside StartPeriod: health "starting", not "unhealthy".
  docker.containers.get(firstContainerId).health = "starting";
  docker.calls.length = 0;

  const surface = await service.ensureSurface({
    surfaceId: "surface_1",
    connectorId: "chatgpt",
    profileKey: "profile_1",
  });

  const deleteCall = docker.calls.find((call) => call.init.method === "DELETE");
  assert.equal(deleteCall, undefined, "a cold-starting container must NOT be removed");
  assert.ok(!docker.calls.some((call) => call.path === "/containers/create"), "no fresh container during cold-start");
  assert.equal(surface.container_id, firstContainerId);
  // It is returned with honest non-ready health so the caller waits/probes.
  assert.equal(surface.health, "starting");
});

class FakeDocker {
  calls = [];
  containers = new Map();
  networks = new Set();
  nextId = 1;
  foreignInspectIds = new Set();
  startFailurePorts = new Set();
  omitPortBindingsWhenStopped = false;
  removeOnStop = false;
  networkCreateConflict = false;
  networkConnectFailFor = new Set();
  networkDisconnectFailFor = new Set();
  ipAssignments = new Map();

  async requestJson(path, init = {}) {
    this.calls.push({ path, init });
    const networkInspectMatch = path.match(/^\/networks\/([^/]+)$/);
    if (networkInspectMatch && (init.method ?? "GET") === "GET") {
      const name = decodeURIComponent(networkInspectMatch[1]);
      if (!this.networks.has(name)) {
        throw new NekoSurfaceAllocatorServiceError(
          "docker_http_error",
          `Docker GET /networks/${name} returned HTTP 404: network ${name} not found`,
        );
      }
      return { Name: name };
    }
    if (path === "/networks/create") {
      if (this.networkCreateConflict) {
        // A real 409 from a concurrent creator is still an okStatus for this
        // call (see ensureNetworkExists), so the transport resolves rather
        // than rejects — it does not add the network here, mirroring "someone
        // else already created it".
        return { message: `network with name ${init.body.Name} already exists` };
      }
      this.networks.add(init.body.Name);
      return { Id: init.body.Name };
    }
    const connectMatch = path.match(/^\/networks\/([^/]+)\/connect$/);
    if (connectMatch) {
      const network = decodeURIComponent(connectMatch[1]);
      const containerId = init.body.Container;
      if (this.networkConnectFailFor.has(containerId)) {
        throw new NekoSurfaceAllocatorServiceError(
          "docker_http_error",
          `Docker POST /networks/${network}/connect returned HTTP 500: simulated connect failure`,
        );
      }
      const container = this.containers.get(containerId);
      container?.networks.add(network);
      return null;
    }
    const disconnectMatch = path.match(/^\/networks\/([^/]+)\/disconnect$/);
    if (disconnectMatch) {
      const network = decodeURIComponent(disconnectMatch[1]);
      const containerId = init.body.Container;
      if (this.networkDisconnectFailFor.has(containerId)) {
        throw new NekoSurfaceAllocatorServiceError(
          "docker_http_error",
          `Docker POST /networks/${network}/disconnect returned HTTP 500: simulated disconnect failure`,
        );
      }
      const container = this.containers.get(containerId);
      container?.networks.delete(network);
      return null;
    }
    if (path === "/containers/json") {
      return [...this.containers.values()]
        .filter((container) => container.listAsOwned)
        .map((container) => ({
          Id: container.id,
          Labels: container.labels,
          State: container.state ?? (container.running ? "running" : "exited"),
          Ports:
            container.hostPort === undefined
              ? []
              : [
                  { PrivatePort: container.hostPort, PublicPort: container.hostPort, Type: "tcp" },
                  { PrivatePort: container.hostPort, PublicPort: container.hostPort, Type: "udp" },
                ],
        }));
    }
    if (path === "/containers/create") {
      const id = `container_${this.nextId++}`;
      const hostPort = Number(init.body.Labels[`${LABEL}.webrtc_host_port`]);
      this.containers.set(id, {
        id,
        labels: init.body.Labels,
        name: init.query.name,
        running: false,
        hostPort,
        networks: new Set([init.body.HostConfig.NetworkMode]),
        listAsOwned: true,
      });
      return { Id: id };
    }
    const startMatch = path.match(/^\/containers\/([^/]+)\/start$/);
    if (startMatch) {
      const container = this.containers.get(startMatch[1]);
      if (this.startFailurePorts.has(container.hostPort)) {
        throw new NekoSurfaceAllocatorServiceError(
          "docker_http_error",
          `Docker POST /containers/${startMatch[1]}/start returned HTTP 500: failed to bind host port 0.0.0.0:${container.hostPort}/tcp: address already in use`,
        );
      }
      container.running = true;
      return null;
    }
    const stopMatch = path.match(/^\/containers\/([^/]+)\/stop$/);
    if (stopMatch) {
      const container = this.containers.get(stopMatch[1]);
      if (this.removeOnStop) {
        this.containers.delete(stopMatch[1]);
      } else {
        container.running = false;
      }
      return null;
    }
    const removeMatch = path.match(/^\/containers\/([^/]+)$/);
    if (removeMatch && init.method === "DELETE") {
      this.containers.delete(removeMatch[1]);
      return null;
    }
    const inspectMatch = path.match(/^\/containers\/([^/]+)\/json$/);
    if (inspectMatch) {
      const id = inspectMatch[1];
      const container = this.containers.get(id);
      if (container === undefined) {
        throw new NekoSurfaceAllocatorServiceError(
          "docker_http_error",
          `Docker GET /containers/${id}/json returned HTTP 404`,
        );
      }
      const ports =
        this.omitPortBindingsWhenStopped && !container.running
          ? {}
          : { [`${String(container.hostPort)}/tcp`]: [{ HostPort: String(container.hostPort) }] };
      return {
        Id: id,
        Name: `/${container.name}`,
        Config: { Labels: this.foreignInspectIds.has(id) ? { "other.owner": "someone-else" } : container.labels },
        State: {
          Running: container.running,
          Status: container.running ? "running" : "exited",
          ...(container.health === undefined
            ? {}
            : { Health: { Status: container.health, FailingStreak: container.health === "unhealthy" ? 12 : 0 } }),
        },
        NetworkSettings: {
          Ports: ports,
          Networks: Object.fromEntries(
            [...container.networks].map((name) => [name, { IPAddress: this.ipAddressFor(container.id, name) }]),
          ),
        },
      };
    }
    throw new Error(`unexpected docker path ${path}`);
  }

  addForeignContainer(id, labels) {
    this.containers.set(id, {
      id,
      labels,
      name: "foreign",
      running: true,
      hostPort: 59001,
      networks: new Set([BASE_OPTIONS.network]),
      listAsOwned: false,
    });
  }

  addOwnedContainerWithoutPublishedPorts(id, labels) {
    this.containers.set(id, {
      id,
      labels: { [`${LABEL}.deployment_id`]: DEPLOYMENT_ID, ...labels },
      name: "created-without-published-ports",
      running: false,
      hostPort: undefined,
      networks: new Set([BASE_OPTIONS.network]),
      listAsOwned: true,
      state: "created",
    });
  }

  addStoppedOwnedContainerWithoutPublishedPorts(id, labels) {
    this.containers.set(id, {
      id,
      labels: { [`${LABEL}.deployment_id`]: DEPLOYMENT_ID, ...labels },
      name: "stopped-without-published-ports",
      running: false,
      hostPort: undefined,
      networks: new Set([BASE_OPTIONS.network]),
      listAsOwned: true,
      state: "exited",
    });
  }

  failStartForHostPort(port) {
    this.startFailurePorts.add(port);
  }

  ipAddressFor(containerId, network) {
    const key = `${containerId}:${network}`;
    let index = this.ipAssignments.get(key);
    if (index === undefined) {
      index = this.ipAssignments.size + 10;
      this.ipAssignments.set(key, index);
    }
    return `10.99.0.${index}`;
  }

  addOwnedSummaryForForeignInspect(id, surfaceId) {
    this.containers.set(id, {
      id,
      labels: {
        [`${LABEL}.owner`]: "pdpp-reference",
        [`${LABEL}.deployment_id`]: DEPLOYMENT_ID,
        [`${LABEL}.surface_id`]: surfaceId,
      },
      name: "foreign-inspect",
      running: true,
      hostPort: 59000,
      networks: new Set([BASE_OPTIONS.network]),
      listAsOwned: true,
    });
    this.foreignInspectIds.add(id);
  }

  // Simulates a container created before pdpp_neko_dynamic existed: running,
  // owned, healthy, but attached only to the legacy network — never the
  // allocator's expected network.
  // composeProject defaults to this test file's own deployment id, matching
  // the real-world case: a legacy container created by THIS SAME Compose
  // project before deployment_id existed. Pass a different value to
  // simulate a container from an unrelated Compose project, which must
  // never be recognized regardless of the generic owner label matching.
  addLegacyNetworkOwnedContainer(id, { surfaceId, legacyNetwork, hostPort = 59000, composeProject = DEPLOYMENT_ID }) {
    this.containers.set(id, {
      id,
      labels: {
        [`${LABEL}.owner`]: "pdpp-reference",
        [`${LABEL}.backend`]: "neko",
        [`${LABEL}.surface_id`]: surfaceId,
        [`${LABEL}.connector_id`]: "chatgpt",
        [`${LABEL}.profile_key`]: "profile_1",
        [`${LABEL}.webrtc_host_port`]: String(hostPort),
        "com.docker.compose.project": composeProject,
      },
      name: `pdpp-neko-chatgpt-${id}`,
      running: true,
      hostPort,
      networks: new Set([legacyNetwork]),
      listAsOwned: true,
    });
  }
}

function readyFetch() {
  return selectiveFetch(() => true);
}

function selectiveFetch(predicate) {
  return async (input) => {
    const url = new URL(String(input));
    if (!predicate(url)) {
      return new Response("not ready", { status: 503 });
    }
    if (url.pathname.includes("/json/version")) {
      return Response.json({ Browser: "Chrome/126.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/1" });
    }
    return new Response("ok", { status: 200 });
  };
}

function noopProfileFilesystem() {
  return {
    async mkdir() {},
    async chown() {},
    async chmod() {},
  };
}

function recordingProfileFilesystem() {
  const calls = [];
  return {
    calls,
    async mkdir(path, options) {
      calls.push({ method: "mkdir", path, options });
    },
    async chown(path, uid, gid) {
      calls.push({ method: "chown", path, uid, gid });
    },
    async chmod(path, mode) {
      calls.push({ method: "chmod", path, mode });
    },
  };
}

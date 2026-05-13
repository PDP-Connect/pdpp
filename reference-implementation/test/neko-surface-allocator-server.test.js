import assert from "node:assert/strict";
import test from "node:test";

import { NekoSurfaceAllocatorClient } from "../runtime/neko-surface-allocator.ts";
import {
  NekoSurfaceAllocatorService,
  NekoSurfaceAllocatorServiceError,
  startNekoSurfaceAllocatorServer,
} from "../server/neko-surface-allocator-server.ts";

const LABEL = "org.pdpp.reference.neko";
const BASE_OPTIONS = Object.freeze({
  image: "ghcr.io/m1k1o/neko/chromium:pdpp-pinned",
  network: "pdpp-neko",
  profileRoot: "/var/lib/pdpp/neko-profiles",
  webrtcHostPortStart: 59000,
  webrtcHostPortEnd: 59002,
  streamBaseUrlTemplate: "http://127.0.0.1:{host_port}/neko/{surface_id}/",
  cdpBaseUrlTemplate: "http://127.0.0.1:{host_port}/cdp/{surface_id}/",
  now: () => new Date("2026-05-13T12:00:00.000Z"),
});

test("creates and starts an owned n.eko container with sanitized profile storage and readiness metadata", async () => {
  const docker = new FakeDocker();
  const service = new NekoSurfaceAllocatorService({
    ...BASE_OPTIONS,
    docker,
    fetchImpl: readyFetch(),
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
  assert.match(surface.stream_base_url, /^http:\/\/127\.0\.0\.1:59000\/neko\//);
  assert.match(surface.cdp_url, /^http:\/\/127\.0\.0\.1:59000\/cdp\//);

  const create = docker.calls.find((call) => call.path === "/containers/create");
  assert.equal(create.init.method, "POST");
  assert.equal(create.init.body.Image, BASE_OPTIONS.image);
  assert.equal(create.init.body.HostConfig.NetworkMode, BASE_OPTIONS.network);
  assert.deepEqual(create.init.body.HostConfig.PortBindings["8080/tcp"], [{ HostPort: "59000" }]);
  assert.equal(create.init.body.Labels[`${LABEL}.owner`], "pdpp-reference");
  assert.equal(create.init.body.Labels[`${LABEL}.surface_id`], "surface:https://chatgpt.example/profile 1");
  assert.equal(create.init.body.Labels[`${LABEL}.profile_key`], "https://registry.pdpp.org/connectors/chatgpt?owner=the owner@example.com");
  assert.match(create.init.query.name, /^pdpp-neko-chatgpt-[a-f0-9]{16}$/);
  assert.match(create.init.body.Labels[`${LABEL}.profile_slug`], /^chatgpt-[a-f0-9]{16}$/);
  assert.match(create.init.body.Labels[`${LABEL}.profile_path`], /^\/var\/lib\/pdpp\/neko-profiles\/chatgpt-[a-f0-9]{16}$/);
  assert.doesNotMatch(create.init.query.name, /https|the owner|example\.com|registry/);
  assert.doesNotMatch(create.init.body.Labels[`${LABEL}.profile_slug`], /https|the owner|example\.com|registry/);
  assert.ok(create.init.body.Env.includes("NEKO_PASSWORD=dev-password"));
  assert.equal(docker.calls.some((call) => call.path === "/containers/container_1/start"), true);
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
  assert.equal(stopped?.health, "starting");
  assert.equal(docker.containers.get("container_1").running, false);
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

test("reports starting until n.eko, CDP, Chromium, and stream probes pass", async () => {
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
    assert.equal((await client.stopSurface({ surfaceId: "surface_1", reason: "operator" }))?.health, "starting");
    assert.equal(await client.getSurfaceStatus("missing"), null);
  } finally {
    await server.close();
  }
});

class FakeDocker {
  calls = [];
  containers = new Map();
  nextId = 1;
  foreignInspectIds = new Set();

  async requestJson(path, init = {}) {
    this.calls.push({ path, init });
    if (path === "/containers/json") {
      return [...this.containers.values()]
        .filter((container) => container.listAsOwned)
        .map((container) => ({
          Id: container.id,
          Labels: container.labels,
          State: container.running ? "running" : "exited",
          Ports: container.hostPort === undefined ? [] : [{ PrivatePort: 8080, PublicPort: container.hostPort, Type: "tcp" }],
        }));
    }
    if (path === "/containers/create") {
      const id = `container_${this.nextId++}`;
      const hostPort = Number(init.body.HostConfig.PortBindings["8080/tcp"][0].HostPort);
      this.containers.set(id, {
        id,
        labels: init.body.Labels,
        name: init.query.name,
        running: false,
        hostPort,
        network: init.body.HostConfig.NetworkMode,
        listAsOwned: true,
      });
      return { Id: id };
    }
    const startMatch = path.match(/^\/containers\/([^/]+)\/start$/);
    if (startMatch) {
      this.containers.get(startMatch[1]).running = true;
      return null;
    }
    const stopMatch = path.match(/^\/containers\/([^/]+)\/stop$/);
    if (stopMatch) {
      this.containers.get(stopMatch[1]).running = false;
      return null;
    }
    const inspectMatch = path.match(/^\/containers\/([^/]+)\/json$/);
    if (inspectMatch) {
      const id = inspectMatch[1];
      const container = this.containers.get(id);
      return {
        Id: id,
        Name: `/${container.name}`,
        Config: { Labels: this.foreignInspectIds.has(id) ? { "other.owner": "someone-else" } : container.labels },
        State: { Running: container.running, Status: container.running ? "running" : "exited" },
        NetworkSettings: {
          Ports: { "8080/tcp": [{ HostPort: String(container.hostPort) }] },
          Networks: { [container.network]: {} },
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
      network: BASE_OPTIONS.network,
      listAsOwned: false,
    });
  }

  addOwnedSummaryForForeignInspect(id, surfaceId) {
    this.containers.set(id, {
      id,
      labels: { [`${LABEL}.owner`]: "pdpp-reference", [`${LABEL}.surface_id`]: surfaceId },
      name: "foreign-inspect",
      running: true,
      hostPort: 59000,
      network: BASE_OPTIONS.network,
      listAsOwned: true,
    });
    this.foreignInspectIds.add(id);
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

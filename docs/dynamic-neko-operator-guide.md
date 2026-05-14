# Dynamic n.eko Operator Guide

Dynamic n.eko allocation is opt-in. The default Docker path remains static
single-surface mode so a local operator does not accidentally grant Docker
Engine control or start multiple browser containers.

Use dynamic mode when browser-backed connectors need isolated persistent
profiles, for example ChatGPT first and Chase/USAA only after ChatGPT passes a
real dynamic smoke.

## Resource And Security Tradeoff

The allocator sidecar is the only reference component that should receive
Docker Engine access. It needs that access because dynamic mode creates,
inspects, and stops sibling n.eko containers on behalf of the reference
controller. Treat access to `/var/run/docker.sock` as privileged host-adjacent
access: a compromised allocator can control sibling containers and may be able
to affect the host through Docker APIs.

Keep the blast radius narrow:

- Run dynamic mode only on an operator-controlled Docker host.
- Keep the main reference server away from the Docker socket.
- Pin and review `NEKO_IMAGE`; dynamic mode assumes the n.eko image is trusted
  because every connector login and browser profile runs inside it.
- Keep allocator operations label-scoped. It must reject unlabeled or foreign
  Docker resources rather than acting as a general Docker control plane.
- Keep `PDPP_NEKO_SURFACE_CAP` small until host CPU, memory, WebRTC, and
  connector concurrency have been proven under load.

Profile storage is an explicit host bind. In dynamic mode,
`PDPP_NEKO_PROFILE_STORAGE_ROOT` must be an absolute path on the Docker host,
and Compose bind-mounts the same path into the allocator sidecar. The allocator
derives per-profile directories from sanitized/hashed profile keys; idle
container cleanup must not delete those directories. Set
`PDPP_NEKO_PROFILE_OWNER_UID` and `PDPP_NEKO_PROFILE_OWNER_GID` to the UID/GID
that should own Chromium profile files on the host. If these do not match the
container user, Chromium can fail to write profiles or leave root-owned files
behind.

Each dynamic surface consumes a WebRTC host port from
`PDPP_NEKO_WEBRTC_HOST_PORT_START` through `PDPP_NEKO_WEBRTC_HOST_PORT_END`.
The range must be at least as large as the maximum expected live surfaces and
must be allowed through the local firewall for both TCP and UDP when clients
connect directly. For LAN-only validation, `NEKO_WEBRTC_NAT1TO1` can point at a
LAN-reachable host address and `NEKO_WEBRTC_ICESERVERS=[]` is acceptable. For
off-LAN or mobile networks, configure public host candidates only when they are
actually reachable; otherwise advertise authenticated TURN servers through
`NEKO_WEBRTC_ICESERVERS`. TURN is a relay fallback, not a substitute for sizing
bandwidth: expect higher latency and host/relay bandwidth use when it is
selected.

## Safe Enablement Sequence

Start with ChatGPT only. Do not add Chase or USAA until the dynamic allocator,
profile persistence, WebRTC stream, and one managed connector run have passed.

Use this shape in `.env.docker` without secrets:

```dotenv
# Dynamic mode is explicit. Static remains the default when this is unset.
PDPP_NEKO_SURFACE_MODE=dynamic
PDPP_NEKO_ALLOCATOR_URL=http://neko-allocator:7331

# Absolute host path. Create it before starting Compose and verify ownership.
PDPP_NEKO_PROFILE_STORAGE_POLICY=persistent
PDPP_NEKO_PROFILE_STORAGE_ROOT=/absolute/host/path/to/neko-profiles
PDPP_NEKO_PROFILE_OWNER_UID=1000
PDPP_NEKO_PROFILE_OWNER_GID=1000

# Dynamic mode must not keep static surface wiring.
PDPP_NEKO_BASE_URL=
PDPP_NEKO_CDP_HTTP_URL=
PDPP_NEKO_STATIC_PROFILE_KEY=

# Keep capacity conservative for the first smoke.
PDPP_NEKO_SURFACE_CAP=1
PDPP_NEKO_WEBRTC_HOST_PORT_START=59001
PDPP_NEKO_WEBRTC_HOST_PORT_END=59010

# ChatGPT first. Add Chase/USAA only after the dynamic smoke passes.
PDPP_NEKO_MANAGED_CONNECTORS=https://registry.pdpp.org/connectors/chatgpt
```

After ChatGPT passes, expand the managed connector list in one edit:

```dotenv
PDPP_NEKO_MANAGED_CONNECTORS=https://registry.pdpp.org/connectors/chatgpt,https://registry.pdpp.org/connectors/chase,https://registry.pdpp.org/connectors/usaa
```

Only then raise `PDPP_NEKO_SURFACE_CAP` above `1`, and only to a value covered
by the configured WebRTC host port range and the Docker host's resource budget.

## Validation Order

Validate in this order so configuration mistakes fail before connector runs
consume account sessions:

1. Render Compose configuration:

   ```bash
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml config
   ```

   Confirm `reference` receives dynamic mode plus blank static
   `PDPP_NEKO_BASE_URL`, `PDPP_NEKO_CDP_HTTP_URL`, and
   `PDPP_NEKO_STATIC_PROFILE_KEY`. Confirm `neko-allocator` has the Docker
   socket, the absolute profile root bind, the intended UID/GID, and the WebRTC
   host port range.

2. Smoke the allocator against Docker before running connectors:

   ```bash
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml up -d neko-allocator
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml ps neko-allocator
   docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml logs --tail=100 neko-allocator
   ```

   The allocator must start cleanly, see the Docker network, and not report
   profile-root or Docker-socket errors. If there is an allocator HTTP smoke
   command available in the current branch, run it here before continuing.

3. Run one live managed connector: ChatGPT only. Complete any manual browser
   login or challenge through the n.eko stream and verify the run leases a
   dynamic surface rather than using a static CDP URL.

4. Inspect the host profile root. A connector-scoped profile directory should
   persist after the run and after idle container cleanup.

5. Broaden to Chase and USAA only after the ChatGPT dynamic run passes. Run
   them one at a time before increasing the cap or allowing concurrent runs.

Rollback is to return `PDPP_NEKO_SURFACE_MODE=static`, restore the static
`PDPP_NEKO_BASE_URL`, `PDPP_NEKO_CDP_HTTP_URL`, and
`PDPP_NEKO_STATIC_PROFILE_KEY`, and narrow
`PDPP_NEKO_MANAGED_CONNECTORS` back to ChatGPT. Do not delete profile storage as
part of rollback unless intentionally resetting trusted-device state.

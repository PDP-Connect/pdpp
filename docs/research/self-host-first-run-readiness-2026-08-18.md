# Self-Hosted First Run and Readiness

**Status:** design requirement
**Scope:** the standalone Docker Core quickstart and equivalent self-hosted
launch paths.

## Problem

The quickstart currently has two separate operator gaps:

1. On a new volume, Core generates an owner password and prints it to the
   container log. The site command must tell the operator to follow that log;
   otherwise `docker run -d` returns only a container ID and the credential is
   easy to miss.
2. On an existing volume, Core loads the saved password without displaying it.
   If the operator missed the original first-boot banner, there is no normal,
   user-facing recovery path. Reading `/var/lib/pdpp/owner-password` with
   `docker exec` is an emergency operator escape hatch, not the product flow.

There is a second, independent readiness problem. The console can accept a
request before the internal Authorization Server and Resource Server are ready.
On a large existing SQLite volume, startup work such as index preparation can
take minutes. During that window the proxy returns a generic
`reference_unreachable` 502 even though the node is starting normally. A
first-time operator cannot distinguish startup from a broken deployment.

The existing deployment proposal already identified `docker logs -f pdpp` as
part of password onboarding. It did not specify a readiness contract or a
recovery ceremony, so this gap is an implementation/design omission rather
than an unresolved product choice.

## Terminal ideal

The self-hosting path should be one copyable terminal block with an explicit,
bounded handoff to the browser:

1. Start the node with local-only binding by default.
2. Wait until Core reports that the console, Authorization Server, and
   Resource Server are ready.
3. Print or expose a one-time bootstrap credential through the terminal.
4. Open the local dashboard, require the owner to choose a permanent password,
   and invalidate the bootstrap credential.
5. Persist the password and provide a supported owner-password rotation/reset
   command for the volume owner.

The first-run page must never be an unauthenticated "choose any password"
form when the port is reachable from the network. A generated bootstrap
credential or an explicitly configured deployment secret establishes control
of the node before the permanent password is changed. Public deployments
must require their platform secret before exposing the owner plane.

## Readiness contract

The process must not present a normal dashboard or API failure while its
internal services are still starting. One of these equivalent implementations
is required:

- delay the public console until the internal services pass their readiness
  checks; or
- serve a startup screen and a machine-readable readiness response while the
  services initialize, with automatic retry and an honest elapsed/progress
  indication.

A transient internal failure should remain distinguishable from normal cold
start. The response must not be a generic 502 with no retry guidance. Readiness
must cover both a fresh volume and an existing volume whose indexes or
projections need repair; the latter is the case most likely to expose a
multi-minute startup.

## Copy and recovery requirements

- The Docker quickstart must include `docker logs -f pdpp` or an equivalent
  command in the same copyable block. “One command” must not hide the only
  place the initial credential is shown.
- Documentation must say that the password is shown once, is tied to the
  named data volume, and is not reprinted on later boots.
- Existing-volume operators must have a supported password rotation/recovery
  command. Directly reading the secret file may remain documented for break-
  glass recovery, but it must not be the ordinary answer.
- The quickstart should bind to loopback by default. Public reachability is a
  deliberate deployment choice requiring an origin and HTTPS-aware setup.
- Startup status, password setup, and recovery must be tested against a
  volume containing enough retained data to exercise the slow-start path; a
  fresh empty-volume test alone is insufficient.

## Explicit non-goals

- Do not put the owner password in a URL, query string, or page source.
- Do not print the saved password on every restart.
- Do not silently disable owner authentication when no password is supplied.
- Do not treat a successful process start as proof that the internal services
  are ready.


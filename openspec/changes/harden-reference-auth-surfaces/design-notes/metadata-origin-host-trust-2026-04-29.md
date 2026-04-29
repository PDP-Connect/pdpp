# Metadata Origin Host Trust

Status: sprint-needed
Owner: reference owner
Created: 2026-04-29
Updated: 2026-04-29
Related: openspec/changes/harden-reference-auth-surfaces

## Question

Should the reference AS/RS fail closed, warn, or continue dynamic Host-derived metadata when no explicit public origin is configured?

## Context

The 2026-04-29 P0/P1 surface bug hunt found that live AS/RS metadata can be influenced by `Host` / `X-Forwarded-Host` when the reference is started without explicit public-origin configuration.

Current behavior is two-tier:

- When an explicit origin is configured (`AS_PUBLIC_URL`, `RS_PUBLIC_URL`, `AS_ISSUER`, `PDPP_REFERENCE_ORIGIN`, or equivalent startup options), metadata pins to that configured origin and does not trust arbitrary request hosts.
- When no explicit origin is configured, metadata falls back to request/forwarded host so local self-host and LAN discovery work without pre-baked hostnames.

The sandbox route bug was narrower and has been fixed separately: `/sandbox` metadata no longer advertises `0.0.0.0` when the web server binds with `next dev --hostname 0.0.0.0`.

## Stakes

OAuth / protected-resource metadata is a bootstrap trust surface. Incorrect issuer/resource values can mislead cold clients and agents. At the same time, PDPP's reference implementation is commonly run as a personal local server, sometimes behind tunnels or LAN hostnames that are not known before startup.

Hardening this incorrectly would either:

- break local / LAN discovery by requiring operators to configure public origins before the reference is usable; or
- preserve a host-header injection seam in deployments that accidentally expose the reference without explicit origins.

## Current Leaning

Keep dynamic Host-derived metadata for local/dev mode, but make production and exposed deployments explicit:

- If `NODE_ENV=production` or a deployment-mode env marks the instance as public, require explicit AS/RS public origins or fail startup.
- Add an operator diagnostic warning when metadata is Host-derived and no explicit public origin is configured.
- Consider a `PDPP_TRUSTED_HOSTS` allowlist for deployments that intentionally remain dynamically hosted but want to reject unknown hosts with `421 Misdirected Request`.

Do not silently switch all unconfigured references to fail-closed until we have validated the local-device, Docker, LAN, and tunnel workflows.

## Promotion Trigger

Promote this to normative OpenSpec requirements before changing live AS/RS metadata resolution, adding fail-closed production startup behavior, or introducing trusted-host allowlisting.

## Decision Log

- 2026-04-29: Captured from `tmp/workstreams/p01-surface-bughunt-report.md` and the owner-reviewed follow-up `fix-p01-metadata-and-head-semantics`. Sandbox `0.0.0.0` metadata was fixed. Live AS/RS Host-derived metadata remains a deliberate hardening question, not a same-slice patch.

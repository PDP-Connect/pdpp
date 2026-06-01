# n.eko Encapsulation Follow-Ups

Status: captured
Owner: reference implementation maintainer
Created: 2026-05-06
Updated: 2026-05-06
Related: openspec/changes/add-run-interaction-streaming-companion

## Question

Which n.eko integration seams should be cleaned up before treating the alternate backend as a long-lived reference implementation boundary?

## Context

The n.eko path is intentionally isolated behind the run-interaction streaming companion contract and selected through `server/streaming/companion-factory.js`. It is good enough for the first native remote-browser UX test, but a few seams remain more coupled than ideal:

- `server/streaming/routes.js` owns the n.eko HTTP proxy, stream-token cookie, and WebSocket upgrade forwarding.
- `server/index.js` exposes the streaming upgrade handler through an internal app property.
- `apps/web/src/proxy.ts` knows that `/neko` must route to the reference AS in composed mode.

## Stakes

Leaving these seams inline is acceptable while n.eko is experimental, but future backends or productionized n.eko support should not require more streaming-route or server-startup special cases.

## Current Leaning

Defer extraction until the native n.eko UX has passed a real end-to-end smoke. If the path survives, split `routes.js` proxy mechanics into `server/streaming/neko-proxy.js`, add a formal transport-level upgrade registration hook, and centralize composed-origin proxy path registration.

## Promotion Trigger

Promote this to an OpenSpec change if n.eko becomes more than an alternate reference backend, if a second upgrade-based backend appears, or if the composed dashboard origin is expected to carry native n.eko sessions outside local/operator smoke testing.

## Decision Log

- 2026-05-06: Captured after the first n.eko alternate backend implementation. Current implementation is intentionally pragmatic, with extraction deferred until after manual UX validation.

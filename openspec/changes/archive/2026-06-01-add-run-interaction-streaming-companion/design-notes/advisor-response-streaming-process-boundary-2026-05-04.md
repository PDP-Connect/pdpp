# Advisor Response — Streaming Process-Boundary Question

**Date**: 2026-05-04
**Advisor**: external architecture/design reviewer for PDPP (protocol
coherence, normative-vs-reference boundaries, Collection Profile scope).
**Memo this responds to**: `advisor-memo-streaming-process-boundary-2026-05-04.md`

## Verdict

**Proceed with Option A.**

The architectural assumptions in §3 of the memo (manual_action is the
protocol concept; the fulfillment mechanism is reference behavior;
importing browser-automation libraries into streaming/operator code is
acceptable but not into AS/RS protocol code) are confirmed correct.

Option C rejected outright (reverses the local-collector-runner
boundary, drags toward collector lifecycle / capability semantics
that should remain open). Option B avoided for now (couples streaming
to whatever topology happens to host the connector runtime).

## Naming and framing correction

Posting a CDP WebSocket URL from the connector runtime to the reference
server **is** a new cross-process reference-runtime contract — not a
PDPP protocol contract, but a real local interface that should be
treated deliberately. The advisor's recommended framing:

> "Reference-internal run target registration for owner-authorized
> manual-action streaming."

The endpoint should be admin/reference-internal, not placed near PDPP
ingest routes conceptually. `POST /admin/runs/:runId/streaming-target`
or similar is fine if it is clearly admin-scoped.

## Six implementation constraints to respect

1. **Reference-runtime registration, not protocol registration.** Test:
   if it does not affect wire-level interoperability between independently
   built PDPP implementations, it is runtime/orchestrator surface, not
   spec surface.

2. **No `cdp_streaming` or any capability vocabulary in this tranche.**
   Capability advertisement is how reference behavior hardens into spec
   vocabulary. Internal feature flags / config-gating are fine; manifest
   or runtime capability terms are not.

3. **Target is ephemeral and run-scoped.** Store only `{ runId, target
   URL, expiry, owner/session authorization context }`. Clear on run
   completion, cancellation, revocation, timeout, and process exit
   where possible. Never let the CDP target become a durable
   browser-session registry by accident.

4. **Treat the loopback CDP URL as a bearer secret.** Loopback-only is
   necessary but not sufficient:
   - bind to `127.0.0.1` only
   - random port
   - never log the full URL
   - short TTL
   - explicit unregister on run end
   - reject registration from anything other than the local
     collector/runtime authority
   - restrict the streaming CDP client to the minimal method allowlist:
     Page + Input + Emulation

   The spike result is a stealth/regression check, not a security model.

5. **Patchright/Playwright stay out of AS/RS protocol paths.** Importing
   browser tooling in streaming/operator code is fine; importing it
   into grant issuance or field projection code is not. Keep the
   separation visible in module layout and comments.

6. **Document as reference architecture.** A short implementation-decision
   note stating: this does not define a PDPP binding, does not add
   Collection Profile conformance requirements, and exists only to
   fulfill `manual_action` ergonomically in the reference. Prevents
   future agents from treating the route as a protocol seed.

## Direct answers to the three questions

1. **Does posting a WebSocket URL cross into protocol surface?** No,
   not if it remains admin/internal, run-scoped, and undocumented as
   a PDPP conformance requirement. Reference-runtime orchestration
   surface.

2. **Should streaming-target exposure be advertised as a runtime
   capability now?** No. Internal feature flags/config are fine;
   manifest/capability vocabulary is not.

3. **Is there a fourth option?** Not one preferred for this tranche.
   A broker/relay process is just Option A with more moving parts;
   may become attractive later for remote collectors, multi-tenant
   isolation, or auditable streaming relays. Premature for now.

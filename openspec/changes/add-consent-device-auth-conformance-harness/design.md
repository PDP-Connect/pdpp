## Context

The reference auth substrate currently stores two related but distinct approval flows in SQLite:

- `pending_consents`: staged third-party data grants, addressed publicly by `request_uri` / approval indirection and completed through owner approval or denial.
- `owner_device_auth`: owner-token device authorization, addressed by `device_code` / `user_code` and completed through owner approval, denial, expiry, and token exchange.

These flows are good first candidates for storage conformance because they are security-meaningful but do not involve record pagination, FTS, vector search, blob bytes, or connector execution.

## Goals / Non-Goals

Goals:

- Define reusable, test-only conformance scenarios for pending consent and owner-device authorization storage semantics.
- Exercise the current SQLite-backed auth implementation through exported auth functions or narrow test drivers.
- Prove falsifiability with a broken driver or equivalent negative proof.
- Preserve existing route-level tests as end-to-end evidence.
- Keep the harness narrow enough that it does not become a premature production store contract.

Non-goals:

- Do not introduce production `ConsentStore`, `OwnerDeviceAuthStore`, Postgres, Kysely, or generic repositories.
- Do not change OAuth/PAR/device-flow wire behavior.
- Do not change consent UI, grant shape, token shape, or owner auth policy.
- Do not archive or rewrite existing auth/security tests.

## Required Semantics To Inventory

The worker must inventory current tests and implementation before writing scenarios. Candidate obligations include:

- Pending consent creation produces a durable pending row with request lookup and approval-id indirection.
- Approval and denial are terminal state transitions; completed consent cannot be re-approved or re-denied.
- Expired pending consent becomes unavailable and reports the correct error shape through the public flow.
- Owner-device authorization creation produces `device_code`, `user_code`, verification URIs, expiry, and polling interval.
- Poll-before-approval returns pending and records/updates polling state without minting a token.
- Polling too quickly is rejected according to the current reference semantics.
- Approval mints an owner token, exchange returns it through the device-code flow, and revoked/expired/denied states cannot exchange.
- Approval-id lookup does not expose live `device_code` / `user_code` secrets through dashboard/control-plane surfaces.
- Trace context and redaction behavior remain covered by existing route/security tests.

The final harness may choose a smaller set if some obligations are only route-level today, but deferrals must be explicit in `tasks.md`.

## Harness Shape

The harness should define semantic driver methods, not table operations. Example shape:

```js
{
  async setup()
  async teardown()
  async startPendingConsent(input)
  async lookupPendingConsent(ref)
  async approvePendingConsent(ref)
  async denyPendingConsent(ref)
  async startOwnerDeviceAuth(input)
  async lookupOwnerDeviceAuth(ref)
  async approveOwnerDeviceAuth(ref)
  async denyOwnerDeviceAuth(ref)
  async exchangeOwnerDeviceCode(ref)
}
```

Exact names are implementation details. The driver must not expose raw SQL, table names, or a generic repository surface as the conformance API.

## Evidence Standard

This change is ready only if:

- the SQLite-backed driver passes all conformance scenarios;
- the negative proof fails for at least one meaningful lifecycle/security invariant;
- nearby existing auth/security route tests still pass;
- OpenSpec strict validation passes;
- tasks clearly mark any intentionally deferred scenario.

## Risks / Trade-offs

- Harness overfits exported auth functions instead of storage semantics. Mitigation: keep scenarios semantic and document driver responsibilities.
- Harness duplicates route tests. Mitigation: route tests stay for HTTP/security evidence; conformance harness pins adapter-ready obligations.
- Worker discovers current semantics are inconsistent. Mitigation: stop with a blocker if the correct behavior is ambiguous or protocol-shaped.

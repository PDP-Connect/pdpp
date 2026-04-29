## Context

The reference operation refactor is complete: route semantics now live behind
operation modules and explicit capability dependencies. Prior Postgres work
landed a profile-gated Compose service and a test-only Postgres
connector-state/scheduler driver. The remaining first-slice Postgres work is to
prove the other low-risk security storage family, consent/device auth, against
Postgres without changing runtime defaults.

This is slice 1 of 2 for Postgres:

1. Low-risk storage adapter proof.
2. Records/search runtime storage.

## Goals / Non-Goals

**Goals:**

- Prove selected storage capability contracts can run on Postgres through
  executable conformance, not architecture assertions.
- Keep SQLite as the default runtime backend and default test backend.
- Keep Postgres opt-in through `PDPP_TEST_POSTGRES_URL` and the existing
  profile-gated service.
- Cover `ConnectorStateStore`, scheduler active-run semantics,
  `ConsentStore`, and `OwnerDeviceAuthStore` class behavior.
- Preserve operation modules as storage-driver agnostic.

**Non-Goals:**

- No records, blobs, disclosure spine, lexical, semantic, or hybrid retrieval
  migration.
- No default `PDPP_STORAGE_BACKEND=postgres` runtime mode.
- No production dependency on `pg`; it remains dev/test scoped for this slice.
- No broad generic repository abstraction.

## Decisions

1. **Treat this as a proof adapter slice, not runtime migration.**

   Postgres code in this slice runs under conformance tests and explicit env
   gates. This gives evidence without creating an operator-facing storage
   contract before records/search semantics are ready.

2. **Use conformance harnesses as the contract boundary.**

   The connector-state/scheduler harness already pins owner/grant isolation,
   schedule upsert behavior, active-run uniqueness, and restart reconciliation.
   The consent/device-auth harness pins approval-id indirection, terminal
   states, expiry, polling precedence, and slow-down behavior. Postgres adapters
   must satisfy those same scenarios.

3. **Keep DDL local and isolated for proof drivers.**

   Postgres drivers create uniquely named schemas per scenario and drop them in
   teardown. This avoids migration churn, lets tests run concurrently, and
   keeps proof data isolated from any future runtime database.

4. **Do not promote `pg` to a runtime dependency.**

   Existing `pg` usage is dev-scoped. This slice SHALL NOT import `pg` from
   production server paths. A later runtime slice can decide whether `pg` moves
   to dependencies.

5. **Use the two-slice stop rule.**

   If records/search cannot be expressed as backend-independent obligations in
   slice 2, stop and redesign. Do not mint a third Postgres slice to work
   around missing semantics.

## Risks / Trade-offs

- **Proof driver drifts from production shape** -> Mitigate by keeping the
  harness scenario-owned and by requiring SQLite/memory/Postgres to pass the
  same tests.
- **Postgres becomes required for normal development** -> Mitigate with skipped
  env-gated tests when `PDPP_TEST_POSTGRES_URL` is unset.
- **Runtime expectations get overstated** -> Mitigate by documenting this as a
  proof/test backend and keeping SQLite default.
- **Records/search complexity leaks into slice 1** -> Mitigate by explicitly
  excluding those surfaces in the spec and task list.

## Migration Plan

1. Add or promote Postgres proof drivers for the low-risk storage families.
2. Add env-gated tests that run when `PDPP_TEST_POSTGRES_URL` is set and skip
   otherwise.
3. Run SQLite, memory, broken-driver, and Postgres conformance evidence.
4. Keep runtime docs explicit that this is not full Postgres storage support.
5. Leave records/search for the second and final Postgres slice.

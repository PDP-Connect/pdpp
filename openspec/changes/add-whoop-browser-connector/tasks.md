## 1. Contract

- [x] 1.1 Bound the change to the WHOOP connector and existing package
  registries; exclude runtime and Desktop changes.
- [x] 1.2 Define manual owner login, session reuse, stream boundaries, and
  fail-closed behavior.
- [x] 1.3 Validate this change with `openspec validate
  add-whoop-browser-connector --strict`.

## 2. Implementation

- [x] 2.1 Add the WHOOP manifest, browser collector, typed parsers, schemas,
  and package registry entries.
- [x] 2.2 Add credentialless session probing and bounded manual owner handoff
  using the existing browser profile primitives.
- [x] 2.3 Add all-history pagination/range collection for profile, body,
  cycles, recoveries, sleeps, and workouts with durable post-record cursors.
- [x] 2.4 Add synthetic scrubbed fixtures without personal data or secrets.

## 3. Verification

- [x] 3.1 Prove all six streams, filtering, pagination, cursor ordering, and
  schema validation in hermetic tests.
- [x] 3.2 Prove 401/403, 429, other HTTP failure, invalid JSON, response drift,
  and incomplete login fail loudly without cursor advancement.
- [x] 3.3 Pass focused WHOOP tests, package verification, stream-evidence
  checks, and `openspec validate add-whoop-browser-connector --strict`.
- [ ] 3.4 Re-run the full package suite and repository-wide OpenSpec validation
  after their unrelated baseline failures are repaired. With `TZ=UTC`, the
  package suite passes 2,771 tests and has one unrelated macOS `/private/var`
  symlink-path failure; repository-wide OpenSpec has ten unrelated invalid
  active changes. WHOOP-specific tests and the WHOOP change validate.
- [x] 3.5 Prove the owner-only live authenticated path: the full run emitted 44
  records across all six streams, and a second checkpointed run reused the
  saved session without prompting and emitted 27 incremental updates.

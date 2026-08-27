## 1. Credential provenance

- [x] Add the additive credential state-change field and both-backend writers.
- [x] Thread closed cause, optional actor, and correlation through the revoke cascade.

## 2. Connection evidence

- [x] Stamp a closed revocation reason in every production revoke path.
- [x] Log successful shell retirement ids, count, and TTL cause.

## 3. Verification

- [x] Add real-PostgreSQL regression and negative provenance tests.
- [x] Run focused tests, TypeScript, Biome, and guard mutants.

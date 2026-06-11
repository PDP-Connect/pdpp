## 1. Reference Read Scope

- [x] 1.1 Resolve canonical `connection_id` in the owner-bearer polyfill read scope.
- [x] 1.2 Preserve `connector_id` and deprecated `connector_instance_id` behavior.
- [x] 1.3 Reject conflicting connection selectors with a typed request error.

## 2. Tests

- [x] 2.1 Add owner REST coverage for records reads using only discovered `connection_id`.
- [x] 2.2 Keep existing connector-scoped owner REST coverage green.

## 3. Validation

- [x] 3.1 Run `openspec validate owner-connection-id-records-parity --strict`.
- [x] 3.2 Run `node --test reference-implementation/test/trusted-owner-agent-rest-boundary.test.js`.

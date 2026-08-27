# Tasks

## Runtime

- [x] Add the durable terminal supersession ledger and idempotent outbox
  operation.
- [x] Exclude only ledger-retired terminal rows from active-work decisions.
- [x] Retire matching old terminal rows after replacement acknowledgement.
- [x] Keep ordinary dead-letter requeue behavior unchanged.

## Tests

- [x] Add a fail-before regression for the exact permanent terminal dead-letter
  queue shape.
- [x] Add pass-after coverage for accepted replacement and retained evidence.
- [x] Preserve and run ordinary retryable dead-letter recovery coverage.

## Validation

- [x] Run focused local-collector/polyfill runner tests.
- [x] Run typecheck, package validation, and packed artifact smoke as available.
- [x] Run strict OpenSpec validation.

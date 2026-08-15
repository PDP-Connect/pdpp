## 1. Contract

- [x] Specify multi-parent detail coverage and the terminal-unavailable
      evidence threshold.
- [x] Validate the OpenSpec change strictly.

## 2. Runtime

- [x] Track all declared parent state streams for a detail stream.
- [x] Gate each parent checkpoint from its own coverage entry.
- [x] Withhold a staged parent that omits its required coverage report.
- [x] Map a stream-scoped failure to every parent declared in the run.
- [x] Require each `gap_keys` claim to be backed by matching durable retry work.
- [x] Add discriminating multi-parent commit and failure tests.

## 3. GroupMe

- [x] Partition attachment coverage by the actual parent message stream.
- [x] Parse only bounded, exact GroupMe CDN terminal error envelopes as
      unavailable; leave every ambiguous failure uncovered.
- [x] Preserve the legacy null-uploader behavior.
- [x] Keep transient attachment URLs out of durable metadata and re-enumerate
      their parent after withholding its cursor.
- [x] Add connector two-invocation retry, provider-neutral two-run checkpoint,
      schema, security, and coverage tests.

## 4. Verification

- [x] Run focused lint, typecheck, connector, and runtime tests.
- [x] Run the full connector suite (4,390 passed, 0 failed, 10 skipped).
- [x] Obtain an independent checker verdict on the final diff (PASS).

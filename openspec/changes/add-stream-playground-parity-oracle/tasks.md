## 1. Phone-surface contract

- [x] 1.1 Exercise the controlling stream attachment through portrait and rotated phone viewport POSTs.
- [x] 1.2 Assert n.eko screen-selection and window-control acknowledgements for `412x915` and `915x412`.
- [x] 1.3 Assert terminal restoration of the required `1440x900` baseline.

## 2. Restore and keyboard contracts

- [x] 2.1 Assert controller acknowledgement remains pending until restoration completes.
- [x] 2.2 Assert restore failure cancels rather than resumes, and boot recycles unresolved presentation surfaces.
- [x] 2.3 Add injected-clock expiry terminalization through the restore barrier.
- [x] 2.4 Assert keyboard state-machine invalidation and viewer navigation, geometry, and remount wiring.

## 3. Gate and validation

- [x] 3.1 Remove marker/readiness and direct-target checks from the green path.
- [x] 3.2 Make `stream:parity:oracle` run only behavior-backed contracts.
- [x] 3.3 Run strict OpenSpec validation and the parity gate.

## Acceptance checks

- [x] `pnpm stream:parity:oracle`
- [x] `pnpm exec openspec validate add-stream-playground-parity-oracle --strict`

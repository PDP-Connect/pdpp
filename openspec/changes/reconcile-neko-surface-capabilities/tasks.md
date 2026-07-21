## 1. Required-behavior contract

- [x] 1.1 Rebuild and converge the static n.eko image with the canonical application deployment.
- [x] 1.2 Probe the required window-settle behavior before attaching a managed n.eko stream and return a typed retryable error on failure.

## 2. Safe reconciliation

- [x] 2.1 Recreate idle incompatible dynamic surfaces while preserving their profile storage.
- [x] 2.2 Defer active incompatible dynamic surfaces until terminal release, then retire them through the existing lifecycle.
- [x] 2.3 Make the reference stack rebuild the n.eko image as part of the capability rollout.

## 3. Regression evidence

- [x] 3.1 Add stale-behavior, active-run deferral, profile-preservation, and deploy-order regressions.
- [x] 3.2 Add a calibrated pixel-content black-frame assertion to the public manual-action smoke.

## 4. Acceptance checks

- [x] 4.1 Run strict OpenSpec validation and focused allocator, lifecycle, route, proxy, adapter, and oracle tests.
- [ ] 4.2 Owner watched public canary: rebuild/converge the application and n.eko image together; run the exact public manual-action smoke with the calibrated screenshot assertion; roll back immediately on a typed failure, 404, or black/error signature. The isolated stack cannot validly close this visual gate because local WebRTC routing did not deliver a decoded frame.

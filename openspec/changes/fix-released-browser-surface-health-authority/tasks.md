## 1. Spec and implementation

- [x] 1.1 Add the OpenSpec delta for lifecycle-scoped browser-surface health
  authority.
- [x] 1.2 Update the browser-surface selector so retired/unleased unhealthy
  history cannot become current connection-health evidence.
- [x] 1.3 Add regressions for released-then-unhealthy, current leased
  unhealthy, newer ready, and no-current-evidence cases.

## 2. Verification

- [x] 2.1 Run focused reference-implementation typecheck and test coverage
  for the browser-surface projection path.
- [x] 2.2 Run `openspec validate fix-released-browser-surface-health-authority --strict`.
- [x] 2.3 Run `openspec validate --all --strict`.
- [x] 2.4 Run the relevant repository checks for the touched files. Biome
  passes on the touched files, and the spec check passes.

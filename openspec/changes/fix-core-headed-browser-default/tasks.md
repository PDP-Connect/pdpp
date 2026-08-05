## 1. Runtime policy

- [x] Make browser visibility deployment-owned with headed Core default and one headless override.
- [x] Allow headed local launch only when the packaged browser runtime has a managed display; preserve the operator escape hatch and n.eko remote-CDP path.

## 2. Core image/startup

- [x] Install/check Xvfb in the browser image stage.
- [x] Supervise Xvfb and pass the ready display to Core children.

## 3. Verification

- [x] Update focused runtime tests and remove connector-specific visibility declarations.
- [x] Add and run the production-image/runtime oracle for browser identity, profile persistence, stream registration, cleanup, and restart.
- [x] Run relevant typecheck/lint/tests and strict OpenSpec validation.

## Acceptance checks

```sh
pnpm docker:core:headed-oracle:test
pnpm railway:template:test
pnpm --dir packages/polyfill-connectors run typecheck
pnpm --dir packages/polyfill-connectors run test
pnpm docker:core:headed-oracle
openspec validate fix-core-headed-browser-default --strict
```

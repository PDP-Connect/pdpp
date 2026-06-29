## 1. Credential registry

- [x] 1.1 Add Amazon, Chase, and USAA username/password env mappings.
- [x] 1.2 Change Reddit's primary mapping to username/password.
- [x] 1.3 Preserve Reddit compatibility for old sealed bundle rows.
- [x] 1.4 Keep browser-session/browser-collector connections launchable when
      they have no optional stored static login credential.

## 2. Runtime and migration tests

- [x] 2.1 Prove pure env-fragment construction for Amazon, Chase, Reddit, and
      USAA.
- [x] 2.2 Prove scheduled runs inject store credentials for every static-secret
      registry connector.
- [x] 2.3 Prove manual controller runs inject Amazon stored credentials.
- [x] 2.4 Prove env-to-store migration mapping stays aligned with the runtime
      registry.
- [x] 2.5 Prove a ChatGPT browser-collector connection with no stored static
      credential still reaches the run path instead of failing before browser
      repair.

## 3. Acceptance checks

- [x] 3.1 Run `openspec validate repair-browser-credential-injection --strict`.
- [x] 3.2 Run `node --test --import tsx packages/polyfill-connectors/src/static-secret-injection.test.ts`.
- [x] 3.3 Run `node --test reference-implementation/test/scheduler-static-secret-injection.test.js`.
- [x] 3.4 Run `node --test reference-implementation/test/static-secret-controller-run-injection.test.js`.
- [x] 3.5 Run `node --test reference-implementation/scripts/migrate-env-credentials.test.mjs`.
- [x] 3.6 Run `node --test reference-implementation/test/static-secret-run-credentials.test.js`.
- [x] 3.7 Run `node --test --import tsx reference-implementation/test/static-secret-controller-run-injection.test.js`.

# Next Helper Route Cut Memo

Date: 2026-04-16  
Status: Audit of remaining helper/compat seams in `e2e/` and `apps/web` bridge code

## Bottom line

The cleanest next compat-debt reduction is:

- **remove `POST /consent/:deviceCode/approve-api`**
- cut its remaining callers over to `POST /consent/:deviceCode/approve`
- leave `/grants/poll/:deviceCode`, `/grants/:grantId/tokens`, and `/connectors` alone for now

That removes the purest remaining helper route without harming current testability.

## 1. Exact remaining usages

## `POST /owner-token`

### Live route status

- **No live route remains** in [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:1)

### Remaining code references

These are **helper functions using the real device flow**, not route callers:

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:123)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:74)
- [e2e/test/cli.test.js](/home/user/code/pdpp/e2e/test/cli.test.js:69)
- [e2e/test/event-spine.test.js](/home/user/code/pdpp/e2e/test/event-spine.test.js:25)
- [e2e/test/collection-profile.test.js](/home/user/code/pdpp/e2e/test/collection-profile.test.js:676)
- [apps/web/src/app/api/setup/route.ts](/home/user/code/pdpp/apps/web/src/app/api/setup/route.ts:20)

### Judgment

- `/owner-token` itself is **already retired**
- the remaining debt is **stale docs/memos that still talk about it as live**

## `POST /consent/:deviceCode/approve-api`

### Live route

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:458)

### Remaining callers

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:265)
- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:316)
- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:473)
- [e2e/test/cli.test.js](/home/user/code/pdpp/e2e/test/cli.test.js:134)
- [e2e/test/event-spine.test.js](/home/user/code/pdpp/e2e/test/event-spine.test.js:109)
- [apps/web/src/app/api/grant/approve/route.ts](/home/user/code/pdpp/apps/web/src/app/api/grant/approve/route.ts:16)

Also still referenced in helper wrappers:

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:10)

### Judgment

- **Pure transitional debt**
- no unique reference value now that `POST /consent/:deviceCode/approve` exists and is already exercised in:
  - [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:189)
  - [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:251)

## `POST /grants/:grantId/tokens`

### Live route

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:484)

### Remaining callers

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:275)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:650)
- [e2e/cli/commands/grant.js](/home/user/code/pdpp/e2e/cli/commands/grant.js:32)
- [apps/web/src/app/api/grant/[grantId]/token/route.ts](/home/user/code/pdpp/apps/web/src/app/api/grant/[grantId]/token/route.ts:12)

CLI help still exposes it explicitly:

- [e2e/cli/index.js](/home/user/code/pdpp/e2e/cli/index.js:27)

### Judgment

- **Helper-only, but still has narrow reference value**
- it currently proves `single_use` token issuance behavior in a black-box way
- not a clean long-term public surface, but not the first cut to make

## `GET /grants/poll/:deviceCode`

### Live route

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:471)

### Remaining callers

- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:186)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:198)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:248)

### Judgment

- **Compat-only, still legitimate**
- it still carries restart-safe pending-consent lifecycle coverage
- not the next route to cut unless those tests are redesigned

## `POST /connectors`

### Live route

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:337)

### Remaining callers

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:177)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:35)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:157)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:215)
- [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:323)
- [e2e/test/cli.test.js](/home/user/code/pdpp/e2e/test/cli.test.js:38)
- [e2e/test/event-spine.test.js](/home/user/code/pdpp/e2e/test/event-spine.test.js:60)
- [e2e/test/collection-profile.test.js](/home/user/code/pdpp/e2e/test/collection-profile.test.js:620)
- [e2e/test/collection-profile.test.js](/home/user/code/pdpp/e2e/test/collection-profile.test.js:621)
- [e2e/test/collection-profile.test.js](/home/user/code/pdpp/e2e/test/collection-profile.test.js:665)
- [apps/web/src/app/api/setup/route.ts](/home/user/code/pdpp/apps/web/src/app/api/setup/route.ts:155)

### Judgment

- **Compat-only with real remaining reference value**
- this is still the polyfill/runtime manifest-registration seam
- not a good next cut

## `POST /grants/initiate`

### Live route

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:358)

### Remaining bridge usage

- [apps/web/src/app/api/grant/route.ts](/home/user/code/pdpp/apps/web/src/app/api/grant/route.ts:15)

Also many test/demo consumers remain, but this is not the most helper-like remaining seam.

### Judgment

- **Compat-only but still load-bearing**
- not the next cut

## 2. Route-by-route value summary

- `/owner-token`
  - **already removed as a route**
  - remaining debt is documentation lag, not code surface

- `/consent/:deviceCode/approve-api`
  - **pure transitional debt**
  - best removal target

- `/grants/:grantId/tokens`
  - **helper-only with narrow current proof value**
  - keep until `single_use` issuance proof has a cleaner harness path

- `/grants/poll/:deviceCode`
  - **compat-only with real current lifecycle-test value**
  - keep for now

- `/connectors`
  - **compat-only with real polyfill value**
  - keep for now

- `/grants/initiate`
  - **compat-only but still load-bearing**
  - not the next cut

## 3. Single best next cut

### Recommendation

Cut **`POST /consent/:deviceCode/approve-api`** next.

### Why this is the best cut

- it has the weakest remaining justification
- it duplicates a live sibling route: `POST /consent/:deviceCode/approve`
- removing it does not require redesigning auth, native mode, or polyfill mode
- it reduces helper debt in:
  - demo client
  - one website bridge
  - two test suites

### Minimal replacement path

Update these callers to use `POST /consent/:deviceCode/approve` instead:

- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:265)
- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:316)
- [e2e/client/demo.js](/home/user/code/pdpp/e2e/client/demo.js:473)
- [e2e/test/cli.test.js](/home/user/code/pdpp/e2e/test/cli.test.js:134)
- [e2e/test/event-spine.test.js](/home/user/code/pdpp/e2e/test/event-spine.test.js:109)
- [apps/web/src/app/api/grant/approve/route.ts](/home/user/code/pdpp/apps/web/src/app/api/grant/approve/route.ts:16)

After those are cut over, delete:

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:458)

### What not to cut in the same patch

- `/grants/poll/:deviceCode`
- `/grants/:grantId/tokens`
- `/connectors`
- `/grants/initiate`

Those all still carry more legitimate value or broader coupling than `approve-api`.

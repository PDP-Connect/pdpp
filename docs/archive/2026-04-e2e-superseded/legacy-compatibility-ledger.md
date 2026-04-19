# Legacy Compatibility Ledger for `e2e/server`

**Date:** 2026-04-16  
**Purpose:** Classify the current legacy / demo / auth-helper routes still present in `e2e/server`, identify who consumes them today, and define what must be true before each route can be removed or demoted.

## Bottom line

The current `e2e/server` surface mixes three kinds of routes:

- **primary reference surfaces** that should survive
- **compat/reference-architecture surfaces** that can remain temporarily but should no longer be treated as the target contract
- **pure helper/demo shortcuts** that should be explicitly demoted and eventually removed

The most important cleanup rule is:

> do not remove helper routes just because they are ugly; remove them only after their real consumers have a cleaner path.

The current route debt clusters around one legacy auth seam:

- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/approve-api`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`
- `POST /owner-token`
- `POST /grants/:grantId/tokens`

Those routes are not all equal. Some are real transitional seams. Others are pure helpers and should be treated that way now.

---

## Classification legend

- `Primary`
  - keep as part of the reference surface
- `Compat-only`
  - allowed temporarily for transition or reference-world operation, but not the target contract
- `Helper-only`
  - demo/dev shortcut, not a real protocol/profile surface

---

## Ledger

| Route | Current purpose | Current consumers | Status | Removal preconditions | Risk if removed now |
|---|---|---|---|---|---|
| `POST /introspect` | RFC 7662-style token introspection with PDPP extensions | `e2e/cli/commands/auth.js`, CLI planning docs, future event spine/control plane work | `Primary` | none for conformance; only evolve if AS/RS contract changes intentionally | high: breaks a legitimate AS/RS reference surface and current CLI command |
| `POST /connectors` | register a manifest/schema contract in the current personal-server/polyfill world | `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, `e2e/test/collection-profile.test.js`, `apps/web/src/app/api/setup/route.ts`, legacy demo/docs | `Compat-only` | native-provider path exists separately; personal-server path has a clearly scoped manifest/source registry story; tests and demos that need it are explicitly polyfill-scoped | medium-high: breaks all current polyfill demo/test setup if removed immediately |
| `GET /connectors/:connectorId` | retrieve registered manifest metadata | primarily docs/plans and potential future tooling; currently less exercised than POST | `Compat-only` | same as `POST /connectors`; any remaining consumers can read provider/source metadata through a cleaner contract | medium: fewer direct code consumers, but still part of the current polyfill registry story |
| `POST /grants/initiate` | current legacy AS front door for starting a request and creating pending consent | `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, `apps/web/src/app/api/grant/route.ts`, multiple implementation plans | `Compat-only` | canonical request adapter or cleaner request surface exists; all tests/demos use the new internal canonical shape through a stable adapter; no critical consumer relies on the flat body shape directly | high: breaks the main current request flow across tests, demo, and website bridge |
| `GET /consent/:deviceCode` | HTML consent display for the current device-code-style pending consent seam | browser/manual approval flow in tests, `verification_uri` returned by initiate route, transitional reference flow | `Compat-only` | pending-consent seam replaced or clearly wrapped by newer auth/profile flow; manual approval/debug path has an alternative | medium-high: breaks verification URI and manual approval path; less critical than API helpers for automated flows |
| `POST /consent/:deviceCode/approve` | form-post approval for the HTML consent page | manual browser flow only | `Compat-only` | if HTML consent display goes away or becomes an explicit compat shell over a newer consent subsystem | low-medium: manual browser approval stops working, but automated/reference flows can still proceed |
| `POST /consent/:deviceCode/deny` | deny a pending consent request | manual HTML flow and pending-consent lifecycle | `Compat-only` | same as approval/display seam; terminal denial semantics available elsewhere or no longer needed | medium: denial path disappears from current compat flow |
| `POST /consent/:deviceCode/approve-api` | programmatic approval shortcut that bypasses the HTML consent form | `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, `apps/web/src/app/api/grant/approve/route.ts`, route-planning docs | `Helper-only` | tests and demos approve through a cleaner request/consent seam or explicit test harness helper; website bridge no longer depends on it | very high: breaks most automated approval in tests/demo/website today |
| `GET /grants/poll/:deviceCode` | poll pending consent state for device-code-style flow | `e2e/test/pdpp.test.js`, pending-consent plans, legacy auth flow | `Compat-only` | newer auth/profile flow removes need for device-code polling, or compat flow becomes fully internalized to test harness | medium-high: breaks current pending-consent lifecycle tests and the current device-code story |
| `POST /owner-token` | demo/dev shortcut to mint an owner token without a real owner-auth flow | `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, `e2e/test/collection-profile.test.js`, `apps/web/src/app/api/setup/route.ts`, many planning docs | `Helper-only` | a real or profile-appropriate owner-token acquisition path exists for reference use; tests and setup can bootstrap owners without this public shortcut | very high: breaks nearly every current owner bootstrap path immediately |
| `POST /grants/:grantId/revoke` | revoke a grant and invalidate tokens | `e2e/cli/commands/grant.js`, `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, website API bridge, CLI/docs plans | `Primary` | none, unless the revocation contract itself changes intentionally | high: revocation is a real reference behavior and current CLI consumer |
| `POST /grants/:grantId/tokens` | issue another client token for an existing grant; formerly used to prove `single_use` issuance rules | removed from the active reference surface on 2026-04-16; historical callers were `e2e/client/demo.js`, `e2e/test/pdpp.test.js`, `e2e/cli/commands/grant.js`, and a website API bridge | `Removed helper-only seam` | route deleted; `single_use` behavior is now proved through first-token issuance plus token reuse semantics instead of a second-issuance helper | low for current reference, historical note only |

---

## Route-by-route notes

## 1. `POST /introspect`

This should stay.

Why:

- it is not a demo shortcut
- it is a legitimate AS/RS boundary
- the current CLI already uses it as `pdpp auth introspect`

Do not lump it into “legacy helper” cleanup just because it lives on the same AS server as the helper routes.

## 2. `POST /connectors` and `GET /connectors/:connectorId`

These are not auth helpers, but they are still part of the legacy/compat surface because they make the whole system look connector-native.

They should remain only for the personal-server/polyfill realization.

Execution implication:

- do not remove them before the native-provider path exists separately
- do stop treating them as universal PDPP surfaces

## 3. `POST /grants/initiate`

This is the most important compat route.

It is still the live front door for:

- the demo client
- the main E2E test harness
- website grant-initiation bridge

It should not be removed early.

It should instead be:

- retained as a thin adapter
- moved toward one canonical internal request object
- eventually demoted once the cleaner auth/profile surface is ready

## 4. `GET /consent/:deviceCode`, `POST /consent/:deviceCode/approve`, `POST /consent/:deviceCode/deny`

These are transitional consent-shell routes.

They are not the future of PDPP auth/profile design, but they are also not mere junk:

- they provide manual visibility into the request/approval seam
- they still matter for restart-safe pending consent behavior

So they are `Compat-only`, not `Helper-only`.

## 5. `POST /consent/:deviceCode/approve-api`

This is the clearest pure helper route.

Why:

- it exists to skip the manual consent UI
- most automated tests and demos use it
- it is not a credible final public surface

It should remain for now only because replacing it requires coordinated changes across:

- `e2e/test/pdpp.test.js`
- `e2e/client/demo.js`
- `apps/web/src/app/api/grant/approve/route.ts`

## 6. `GET /grants/poll/:deviceCode`

This is part of the device-code-style compat seam.

It is more legitimate than `approve-api`, but still not the end-state generic auth/profile contract.

It can stay until:

- provider-connect/auth profile work defines the real client interaction model
- the current pending-consent lifecycle is no longer the primary flow

## 7. `POST /owner-token`

This is the single most dangerous helper to leave mentally normalized.

It is useful today, but it is absolutely not a real interoperable contract.

It exists because:

- owner self-export is already real at the RS boundary
- owner authentication / token acquisition is not yet fully profiled

That means:

- the route is useful as a bootstrap helper
- but it must be treated as `Helper-only`

Execution implication:

- keep it for now
- do not let new CLI or docs treat it as the final way owner tokens work

## 8. `POST /grants/:grantId/revoke`

Keep this as primary.

It is part of a real lifecycle behavior:

- revoke grant
- invalidate tokens
- fail future access with `grant_revoked`

This is not demo debt.

## 9. `POST /grants/:grantId/tokens`

This is a helper route, but it is not arbitrary.

It currently helps prove one useful behavior:

- `single_use` constrains token issuance

Still, it is not a clean long-term public surface.

The current CLI already warns that it is reference-only:

- [e2e/cli/commands/grant.js](/home/user/code/pdpp/e2e/cli/commands/grant.js:19)

So the right classification is:

- `Helper-only`

not because it is worthless, but because it should not survive as part of the “real” contract after better test/debug seams exist.

---

## Practical execution order for cleanup

### 1. Reclassify in docs and CLI help now

Immediately and explicitly treat these as helper/compat surfaces:

- `POST /owner-token`
- `POST /consent/:deviceCode/approve-api`
- `POST /grants/:grantId/tokens`

This reduces architectural drift even before code changes.

### 2. Keep the device-code consent shell until the request/auth cutover is real

Do not remove yet:

- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`

These should be demoted only after:

- canonical internal request normalization lands
- provider-connect/auth profile work clarifies the next front door
- tests have an alternative approval path

### 3. Split native and polyfill app composition before killing connector-facing routes

Do not remove or hide:

- `/connectors`

globally until:

- native-provider composition exists separately
- polyfill runtime still has the registry it needs

### 4. Replace helper consumers before deleting helper routes

Current heavy helper consumers are:

- `e2e/test/pdpp.test.js`
- `e2e/client/demo.js`
- `apps/web/src/app/api/grant/approve/route.ts`
- `apps/web/src/app/api/setup/route.ts`

They must be migrated before helper-route deletion.

---

## Recommended owner call

Treat the routes as follows now:

### Keep as primary

- `POST /introspect`
- `POST /grants/:grantId/revoke`

### Keep as compat-only

- `POST /connectors`
- `GET /connectors/:connectorId`
- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`

### Keep temporarily as helper-only

- `POST /owner-token`
- `POST /consent/:deviceCode/approve-api`
- `POST /grants/:grantId/tokens`

That is the cleanest current ledger because it matches:

- how the code is actually used
- how risky immediate removal would be
- how the reference should evolve without pretending the helper routes are harmless or pretending they can be dropped today

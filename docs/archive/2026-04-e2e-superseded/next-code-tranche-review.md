# Next Code Tranche Review

Date: 2026-04-16  
Status: Working recommendation  
Scope: Best coding sequence after the pending-consent seam and initial CLI tranche

## Bottom line

After the pending-consent seam and the initial owner-path CLI are in place, the next tranche should be:

- `native-path honesty + legacy-route demotion`

Not:

- control plane
- event/trace spine
- landing-page integration
- full provider-connect implementation

The immediate job after the first tranche is to prove that the reference really has two realization paths, not one connector-centric path with better names.

## Recommended next tranche

### Tranche 2: Native-path proof and legacy-boundary cleanup

This tranche should do four things only.

#### 1. Make the native path real in the engine

Deliver:

- one native HR deployment or engine mode that does not depend on connector lifecycle semantics
- seeded native streams:
  - `pay_statements`
  - `equity_grants`
  - optionally `benefits_enrollments`
- native-path tests proving:
  - grant issuance works from the current request object
  - owner self-export works
  - client query projection works
  - `changes_since` works
  - no `connector_id` is required in the native query path

Why this is next:

- it resolves the sharpest architectural doubt left by the red-team memo
- it prevents the whole reference from collapsing back into a dressed-up personal server

#### 2. Demote legacy auth/demo routes from primary to compat

Deliver:

- an explicit compat layer for:
  - `/grants/initiate` flat request shape
  - device-code-style demo consent routes
  - `/owner-token`
  - `/grants/:grantId/tokens`
- tests and docs updated so these routes are no longer the primary reference path
- one written compatibility ledger in the repo saying:
  - why each compat route still exists
  - who still uses it
  - what would let it be removed later

Why this is next:

- if this does not happen now, every new tool and test will keep using the old MVP seams because they are convenient

#### 3. Pin the first provider-discovery decision in code-facing docs

Deliver:

- one explicit first discovery anchor for the reference:
  - either RS-first or AS-first
- one narrow statement of what the reference implementation does and does not support yet
- enough code-level shape to avoid accidental custom assumptions leaking into clients

Why this is next:

- the provider-connect work cannot stay elegant in prose forever
- the next tranche should freeze the first real assumption before more consumers appear

Important constraint:

- this is not the full provider-connect implementation
- it is the minimal decision that keeps future code from drifting

#### 4. Tighten the CLI against the new truth

Deliver:

- CLI commands updated to prefer the non-legacy path where possible
- CLI docs/examples reflect the actual current reference contract
- no new auth-flow ambitions added yet

Why this is next:

- the CLI is the first real non-website consumer
- it should be used as the canary for whether the engine contract is becoming cleaner or murkier

## What should still be deferred

### 1. Control plane / console

Still defer:

- topology UI
- run timeline UI
- artifact inspector UI
- reseed/reset operator surface

Reason:

- until the native path is proven and legacy routes are clearly demoted, the console will codify the wrong architecture

### 2. Full event/trace spine

Still defer:

- append-only canonical event model
- replay compiler
- scenario registry beyond what tests minimally need

Reason:

- this is still one abstraction too early if the system’s “real path” is not yet settled

### 3. Full provider-connect profile implementation

Still defer:

- generic discovery across arbitrary providers
- device-flow support matrix
- registration policy matrix
- polished provider metadata publication

Reason:

- only the first reference assumption needs to be pinned now
- the full profile should wait until the native path and compat boundary are honest

### 4. Website and landing-page integration

Still defer:

- illustrated-flow replay from live traces
- website-facing runtime hooks
- any coupling from `apps/web` into `e2e/`

Reason:

- the website should consume stable outputs, not help define them

### 5. Native-provider product polish

Still defer:

- Northstar HR UI
- native-provider brand polish
- productized admin surfaces

Reason:

- none of that matters if the native path still leaks connector assumptions

## Verification strategy for tranche 2

### 1. One explicit native-vs-polyfill test matrix

Add a small matrix that proves the same client-facing behavior across:

- native provider
- personal-server polyfill

At minimum:

- request acceptance
- grant issuance
- owner self-export
- projected query
- incremental sync

If the matrix cannot be written without special-casing the native path awkwardly, the shared-engine story is not yet honest.

### 2. Compatibility audit must go green

Before tranche 2 is called done:

- every remaining legacy route is listed
- every CLI example and test is reviewed against that list
- no new code path should be introduced that silently depends on a compat route

### 3. Grep and reread discipline

For this tranche specifically:

- grep for `connector_id` assumptions in native-path code
- grep for legacy auth/demo routes in tests and CLI examples
- reread every touched engine, test, and CLI file after changes

### 4. One hard failure test

Add at least one test that fails if the native path still requires connector semantics.

The point is not just to prove success. It is to prove the architecture would catch regression back into the old worldview.

## Biggest ways this tranche could still overbuild

### 1. Turning “native path” into a second product codebase

Wrong move:

- separate server implementation
- separate auth stack
- separate query semantics

Right move:

- same engine, stricter acceptance tests, minimal deployment-specific wrapper

### 2. Turning compat cleanup into a rewrite

Wrong move:

- ripping out every old route immediately
- breaking local dev and test ergonomics before the replacement path is actually stable

Right move:

- demote, label, ledger, and stop treating them as primary

### 3. Letting provider-connect scope expand too early

Wrong move:

- solving discovery, registration, native-app UX, CLI UX, and capability metadata all at once

Right move:

- pin one discovery anchor and one reference assumption only

### 4. Sneaking console work in through “debug helpers”

Wrong move:

- adding new endpoints “just for inspection”
- calling them temporary

Right move:

- if the CLI and tests do not need it, be suspicious of it

## Recommended sequence after tranche 1

1. native-path acceptance tests
2. minimal native HR deployment/mode
3. compat-route demotion and compatibility ledger
4. first provider-discovery decision written and reflected in examples
5. CLI tightened to the cleaner path

Only after that:

6. revisit event/trace spine
7. revisit provider-connect implementation
8. start console work

## Final judgment

The best next tranche is the one that makes the two-realization-path story true in code, not just persuasive in docs.

If tranche 2 is chosen well, it will remove the last major ambiguity about whether PDPP’s reference is:

- a real protocol with two honest deployment paths

or

- the old MVP stack with a better explanation layer

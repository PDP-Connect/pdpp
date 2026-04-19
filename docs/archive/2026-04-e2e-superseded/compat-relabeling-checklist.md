# Compat Relabeling Checklist

Date: 2026-04-16  
Status: Immediate execution checklist for relabeling helper / compat routes without removing them yet

## Why this exists

The current reference stack still exposes several legacy/demo/auth-helper routes. The immediate problem is not that they exist. The problem is that some code comments, CLI help text, website bridges, and tests still teach them as if they were the target contract.

This checklist is for the **relabeling pass only**:

- add clearer warnings and classifications
- stop mentally normalizing helper routes
- do not remove the routes yet
- do not start a large API cleanup in the same pass

The compatibility ledger already classifies the routes. This checklist turns that into concrete edits.

## Routes to relabel now

Use these exact classifications from the ledger:

### Primary

- `POST /introspect`
- `POST /grants/:grantId/revoke`

### Compat-only

- `POST /connectors`
- `GET /connectors/:connectorId`
- `POST /grants/initiate`
- `GET /consent/:deviceCode`
- `POST /consent/:deviceCode/approve`
- `POST /consent/:deviceCode/deny`
- `GET /grants/poll/:deviceCode`

### Helper-only

- `POST /owner-token`
- `POST /consent/:deviceCode/approve-api`
- `POST /grants/:grantId/tokens`

## Labeling standard

Use the same vocabulary everywhere:

- `Primary reference surface`
- `Compat-only transitional surface`
- `Helper-only demo/dev shortcut`

Do not invent many synonyms. The point is to make the warnings recognizable and mechanically greppable.

Recommended warning text patterns:

- `Compat-only transitional surface. Keep for current reference flow; not the target provider-connect contract.`
- `Helper-only demo/dev shortcut. Do not treat as a generic PDPP/provider-connect surface.`
- `Primary reference surface.`

## Exact files to touch

### 1. `e2e/server/index.js`

Purpose:

- relabel route comments at the actual source of the legacy surfaces

Routes/comments to update:

- above `POST /connectors`
  - add: `Compat-only transitional surface for the current personal-server/polyfill world.`
- above `GET /connectors/:connectorId`
  - same compat note
- above `POST /grants/initiate`
  - change comment from “Initiate grant request (device code style)” to something like:
    - `Compat-only transitional request front door for the current reference grant flow.`
    - `Not the final provider-connect owner-auth surface.`
- above `GET /consent/:deviceCode`
  - add:
    - `Compat-only consent shell for the current pending-grant flow.`
- above `POST /consent/:deviceCode/approve`
  - add:
    - `Compat-only manual approval route for the transitional consent shell.`
- above `POST /consent/:deviceCode/approve-api`
  - replace “API auto-approve (for programmatic demo use)” with stronger wording:
    - `Helper-only demo/dev shortcut that bypasses the manual consent UI.`
    - `Do not treat as a generic PDPP or provider-connect surface.`
- above `GET /grants/poll/:deviceCode`
  - add:
    - `Compat-only polling route for the current pending-grant seam.`
    - `Not the RFC 8628 device-flow polling contract.`
- above `POST /owner-token`
  - strengthen to:
    - `Helper-only demo/dev shortcut for minting owner tokens.`
    - `Not the final owner-token acquisition surface.`
- above `POST /grants/:grantId/tokens`
  - strengthen to:
    - `Helper-only demo/admin shortcut for issuing another client token.`
    - `Used only for reference proofs such as single_use issuance behavior.`

What not to do here:

- do not rename routes yet
- do not alter behavior
- do not mix in device-flow implementation changes

### 2. `e2e/server/auth.js`

Purpose:

- relabel helper functions and compat seams in their docblocks/comments

Functions/comments to update:

- `initiateGrant()`
  - make clear it is grant-flow-specific and transitional, not a general device-flow helper
- `approveGrant()`
  - add note that it creates a grant + client token and must not be confused with owner auth
- `pollGrant()`
  - add note that it is pending-grant polling, not RFC 8628 token polling
- `issueGrantToken()`
  - strengthen the existing comment to `Helper-only demo/admin helper`
- `issueOwnerToken()`
  - if documented, add note that direct issuance is a reference/dev shortcut until a real owner-auth/profile flow exists

What not to do:

- do not refactor function names yet
- do not split storage or semantics yet

### 3. `e2e/cli/index.js`

Purpose:

- tighten the top-level help so it doesn’t make helper commands look peer-normal

Current state:

- `pdpp grant token` is marked `# reference-only`

Changes:

- expand the help header slightly, for example:
  - `PDPP CLI (reference e2e surface; some commands are compat/reference-only)`
- keep `pdpp grant token <grant-id> ... # reference-only demo/admin helper`

If `auth issue-owner` exists later, it should be similarly labeled, but do not invent it now just for this pass.

### 4. `e2e/cli/commands/grant.js`

Purpose:

- make the stderr warning stronger and more consistent with the ledger

Current state:

- `Reference-only command: issuing another client token is a demo/admin helper, not core PDPP.`

Recommended replacement:

- `Helper-only demo/admin shortcut: issuing another client token is not a generic PDPP or provider-connect surface.`

This is better because it uses the same classification vocabulary as the ledger.

### 5. `e2e/cli/commands/auth.js`

Purpose:

- if any compat auth shortcut is added later, enforce warning discipline

For this pass:

- no behavior change needed
- add no new command
- optionally add a short comment that `introspect` is a primary reference surface, not a compat helper

Keep this light.

### 6. `apps/web/src/app/api/grant/approve/route.ts`

Purpose:

- make the bridge comment and error context explicit that this is a bridge to a helper route

Current state:

- `Approves a pending consent request.`

Recommended update:

- `Bridge to helper-only demo/dev approval shortcut for the legacy grant flow.`
- `Not the target provider-connect or final consent contract.`

Also consider adding one inline comment above the fetch:

- `Bridges to /consent/:deviceCode/approve-api until the current automated demo/test path has a cleaner approval seam.`

### 7. `apps/web/src/app/api/grant/[grantId]/token/route.ts`

Purpose:

- strengthen the existing “Demo helper” wording

Current state:

- `Demo helper: attempts to mint another client token for an existing grant.`

Recommended replacement:

- `Helper-only demo/dev bridge for a legacy reference proof.`
- `Not a generic PDPP or provider-connect token surface.`

### 8. `apps/web/src/app/api/setup/route.ts`

Purpose:

- make the setup bridge honest about `/owner-token`

Current state:

- `Registers the Instagram manifest and issues an owner token.`

Recommended updates:

- top-of-file comment:
  - `Uses helper-only bootstrap routes for the legacy Instagram demo world.`
  - `Not part of the target provider-connect contract.`
- inline comment above the owner-token fetch:
  - `Reference/dev bootstrap only; replace with real owner-auth/profile flow when available.`
- same for the DELETE path’s owner-token fetch

Do not rewrite the whole setup route in this pass.

### 9. `apps/web/src/components/DemoPage.tsx`

Purpose:

- stop the in-app log text from teaching `/owner-token` as normal

Current log text:

- `Owner token issued for instagram_demo_user`

Recommended replacement:

- `Reference bootstrap owner token issued for instagram_demo_user`

Current source line annotation:

- `POST /owner-token`

Recommended replacement:

- `POST /owner-token · helper-only bootstrap`

This is small, but it matters because visible logs are teaching material.

### 10. `e2e/client/demo.js`

Purpose:

- make the script’s own narration honest where it uses helper routes

Specific places to touch:

- before `POST /owner-token`
  - add comment like:
    - `// Helper-only bootstrap for the reference demo; not a generic owner-auth contract`
- before `POST /consent/:deviceCode/approve-api`
  - add:
    - `// Helper-only approval shortcut used to automate the demo`
- before `POST /grants/:grantId/tokens`
  - add:
    - `// Helper-only issuance shortcut used to prove single_use behavior`

What not to do:

- do not rewrite the demo flow yet
- do not convert it to the future device-flow path in this pass

### 11. Tests that mention the helper routes explicitly

Likely files:

- `e2e/test/pdpp.test.js`
- `e2e/test/collection-profile.test.js`

What to add:

- small comments where helper routes are used, e.g.:
  - `// Reference bootstrap helper; replace when real owner-auth flow exists`
  - `// Helper-only approval shortcut for automated tests`

What not to do:

- do not litter every test assertion with prose
- only annotate helper-route call sites

### 12. Ledger-adjacent docs and implementation plans

Files worth aligning lightly if they still use softer wording:

- `docs/inbox/pdpp-cli-surface-memo.md`
- `docs/inbox/cli-implementation-plan.md`
- `docs/inbox/device-flow-cutline-memo.md`
- `docs/inbox/provider-metadata-route-plan.md`

Only add or tighten language if needed for consistency with:

- `Compat-only transitional surface`
- `Helper-only demo/dev shortcut`

Do not do a broad wording sweep outside directly relevant paragraphs.

## Exact warning text to reuse

Use these verbatim or near-verbatim where possible:

### For `/owner-token`

- `Helper-only demo/dev shortcut for bootstrapping an owner token. Not the final provider-connect owner-auth surface.`

### For `/consent/:deviceCode/approve-api`

- `Helper-only demo/dev shortcut that bypasses the manual consent UI. Not a generic PDPP or provider-connect surface.`

### For `/grants/:grantId/tokens`

- `Helper-only demo/admin shortcut used for reference proofs such as single_use issuance behavior.`

### For `/grants/poll/:deviceCode`

- `Compat-only transitional polling route for the pending-grant seam. Not the RFC 8628 device-flow polling contract.`

### For `/grants/initiate`

- `Compat-only transitional request front door for the current reference grant flow.`

## What not to overdo

This pass should stay small and high-signal.

Do not:

- add giant warning banners everywhere
- introduce new route prefixes or feature flags
- rename files or functions
- change HTTP behavior
- rewrite the website copy broadly
- duplicate the whole compatibility ledger inside many files

The goal is:

- a future reader can tell immediately which surfaces are helper-only or compat-only
- without making the code unreadable or drowning it in ceremony

## Suggested execution order

1. Relabel `e2e/server/index.js` route comments.
2. Relabel `e2e/server/auth.js` helper/grant function comments.
3. Tighten `e2e/cli/index.js` help text and `e2e/cli/commands/grant.js` warning text.
4. Relabel website bridge route headers/comments:
   - `apps/web/src/app/api/grant/approve/route.ts`
   - `apps/web/src/app/api/grant/[grantId]/token/route.ts`
   - `apps/web/src/app/api/setup/route.ts`
5. Update the visible log wording in `apps/web/src/components/DemoPage.tsx`.
6. Add only minimal helper-route comments in `e2e/client/demo.js` and the direct test call sites.
7. Grep for:
   - `owner-token`
   - `approve-api`
   - `grantId/tokens`
   - `reference-only`
   - `helper-only`
   - `compat-only`
8. Read every touched file once before calling the pass done.

## Completion standard

This pass is done when:

- helper routes no longer read like normal protocol surfaces
- compat routes are explicitly named as transitional seams
- the CLI help and warnings match the ledger classification
- website bridge code clearly admits when it is bridging to a helper route
- no route behavior has changed yet

That is enough to reduce architectural drift immediately without blocking the larger cleanup sequence.

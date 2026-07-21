# Design — introspection fail-closed

## Context

`introspect()` (`reference-implementation/server/auth.js`) builds a `result`
object initialized to `active: true`, then for `token_kind === 'client'` validates
the persisted grant against its manifest. The pre-fix control flow:

```js
try {
  const { grant, storageBinding } = requirePersistedGrantState(row);   // throws grant_invalid on parse failure
  try {
    const manifest = await getManifestForStorageBinding(storageBinding);
    if (manifest) { requireGrantContractAgainstManifest(grant, manifest); }
  } catch (err) {
    if (err?.code === 'grant_invalid') return inactive(...);
    // fall through — ANY other error is swallowed
  }
  result.grant_id = ...;      // fall-through marks active
} catch {
  return inactive(...);       // outer catch masks EVERY throw as inactive
}
```

Two problems:
1. Inner catch swallows any non-`grant_invalid` error and falls through to
   `active: true`.
2. Outer catch masks every throw — including a genuine infrastructure error — as
   a clean `grant_invalid` inactive projection, hiding the fault.

## Decision

Make both catches distinguish a semantic grant-invalid (project inactive) from an
unexpected error (propagate). Minimal, `introspect()`-only:

- Inner catch: `if (err?.code === 'grant_invalid') return inactive; throw err;`
- Outer catch: `if (err?.code !== 'grant_invalid') throw err; return inactive;`

Now a manifest-store outage propagates out of `introspect()`, so a caller can
never read the result as `active: true`. `requirePersistedGrantState`'s
grant-parse failure still surfaces as `grant_invalid` → inactive (preserved).

## What is deliberately NOT changed (scope discipline)

The first implementation pass over-reached in two ways that a full test run caught:

1. **Missing manifest → inactive.** Treating a `null` manifest (an UNREGISTERED
   connector) as `grant_invalid` flipped `pdpp.test.js`'s "polyfill client reads
   fail connector-first …" from its asserted 404 (`not_found`, "Unknown
   connector", resolved at the read layer) to 403 (inactive token at auth). Main
   deliberately keeps that read connector-first. Reverted: `if (manifest)` still
   skips validation when the manifest is absent; the token stays active and the
   read fails connector-first as before.
2. **`connector_invalid` → inactive.** A corrupt registered manifest raises
   `connector_invalid`; main lets it flow to the read layer, not introspection.
   Adding it to the inactive set would have changed the same read precedence.
   Excluded — only `grant_invalid` projects inactive.

The security-relevant fix is exactly and only the fail-open-on-unexpected-error
path. The two behaviors above are main's intentional design and are out of scope.

## Acceptance checks

- New regression test asserts: a valid grant introspects active; after an
  injected manifest-store fault (drop the `connectors` table), `introspect()`
  rejects with a non-`grant_invalid` error (fails closed, never active). Proven
  falsifying: on unpatched main the fault case swallows and the assert.rejects
  fails.
- `pdpp.test.js` returns to 118/118 (the connector-first read stays 404).
- Auth suites stay green: security-auth-surfaces 10/10, consent-token-handoff
  6/6, introspection-conformance 5/5, hosted-mcp-oauth 37/37,
  introspect-redaction 4/4.
- `pnpm typecheck` green; `openspec validate fix-introspection-fail-closed --strict` green.

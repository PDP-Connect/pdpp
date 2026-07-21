# Tasks — introspection fail-closed

## 1. Implement

- [x] 1.1 In `introspect()`'s client branch inner catch, rethrow non-`grant_invalid`
      errors (was: swallow-and-fall-through-to-active).
- [x] 1.2 In the outer catch, rethrow non-`grant_invalid` errors (was: mask every
      throw as inactive `grant_invalid`).
- [x] 1.3 Preserve `if (manifest)` skip when the manifest is absent (unregistered
      connector stays active → read fails connector-first).

## 2. Prove it

- [x] 2.1 Regression test `introspection-manifest-fail-closed.test.js`: valid grant
      introspects active; injected manifest-store fault propagates (never active).
- [x] 2.2 Proven falsifying: on unpatched main the fault case fails (swallowed).
- [x] 2.3 `pdpp.test.js` back to 118/118 — connector-first read stays 404.
- [x] 2.4 Auth suites green: security-auth-surfaces 10/10, consent-token-handoff
      6/6, introspection-conformance 5/5, hosted-mcp-oauth 37/37,
      introspect-redaction 4/4.

## 3. Gate

- [x] 3.1 `pnpm typecheck` green.
- [x] 3.2 `openspec validate fix-introspection-fail-closed --strict` green.
- [ ] 3.3 Independent diff + behavior verification (maker ≠ judge) — delegated.

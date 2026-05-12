# remote-surface scaffold report

## Files created

- `packages/remote-surface/package.json`
- `packages/remote-surface/tsconfig.json`
- `packages/remote-surface/README.md`
- `packages/remote-surface/src/index.ts`
- `packages/remote-surface/src/types.ts`
- `packages/remote-surface/src/adapters/index.ts`
- `packages/remote-surface/src/adapters/neko-surface-adapter.ts`
- `packages/remote-surface/src/adapters/cdp-surface-adapter.ts`
- `packages/remote-surface/src/ime/index.ts`
- `packages/remote-surface/src/ime/mobile-text-input-controller.ts`
- `packages/remote-surface/src/ime/keysym.ts`

`pnpm-workspace.yaml` already globs `packages/*`; no edit required.
Root `package.json` untouched.

## pnpm install

Clean. No errors. Only pre-existing deprecation warnings (boolean, node-domexception, prebuild-install, vue) unrelated to this package. Package registered as `@pdpp/remote-surface`.

## Typecheck

`pnpm tsc --noEmit` in `packages/remote-surface/`: **No errors found.**

Initial run surfaced 12 TS6133 (unused private field) errors because the scaffold declares fields that real implementations will populate. Resolved by adding `void this.<field>` references in each constructor — keeps strict-plus tsconfig honest without disabling flags.

## Outstanding TODOs in the scaffold

- `NekoSurfaceAdapter`: all 6 RemoteSurface methods throw not-implemented. `neko` field typed as `unknown` until `@demodesk/neko` is added.
- `CdpSurfaceAdapter`: all 6 methods throw not-implemented. `cdp` field typed as `unknown` until BrowserSurface/cdp-adapter is imported.
- `MobileTextInputController.attach/detach/setComposing`: throw not-implemented; need beforeinput / input / composition* wiring per `docs/mobile-ime-prior-art-research.md`.
- `src/ime/keysym.ts`: only exports `type Keysym = number;`. Decision deferred: depend on `guacamole-common-js` vs hand-port the printable-ASCII subset.
- No runtime deps installed (`@demodesk/neko`, `guacamole-common-js`) — intentionally deferred to the wiring step.
- No tests yet — scaffold has no behavior to test.
- Dashboard integration (`apps/web/.../stream-viewer.tsx`, `neko-client.ts`) deliberately untouched per anti-requirements.

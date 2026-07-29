## Why

Four release-policy packages publishable to npm currently expose source paths or
lack an emitted-package execution contract. Local source loading does not prove
that an installed package works at the supported Node floor.

## What Changes

- Add emitted JavaScript, declaration, export/bin, pack, and installed-closure gates for `@pdpp/read-core`, `@pdpp/cli`, `@pdpp/local-collector`, and `@pdpp/mcp-server`.
- Prove packages in dependency order, including CLI/local-collector and MCP subprocess boundaries.
- Define runtime-class migration and retention rules for JS/MJS without requiring mass conversion.
- Keep test migration after discovery parity and after the owning production closure is stable.

## Capabilities

- Added: `publishable-package-artifacts`

## Impact

The change affects the four publishable package manifests/builds and their release
verification. Private app-transpiled packages, private RI, generated data, and
host-required MJS remain out of the dist contract unless a separate runtime reason
is accepted. No remote or live state is mutated.

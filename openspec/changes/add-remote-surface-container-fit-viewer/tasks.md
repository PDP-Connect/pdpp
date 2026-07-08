## 1. Package primitive

- [ ] 1.1 Add a DOM-only container-fit viewer primitive under `packages/remote-surface/src/client/`.
- [ ] 1.2 Reuse `containedStreamRect`, `streamViewportRectToClientBox`, `pointToStreamViewport`, and `buildViewportPayload` instead of reimplementing fit math.
- [ ] 1.3 Export the primitive from `packages/remote-surface/src/client/index.ts` and the package root entry.
- [ ] 1.4 Add unit tests covering geometry derivation and pointer mapping across portrait, landscape, tiny, and extreme aspect ratios.

## 2. Playground demo

- [ ] 2.1 Remove the bespoke fullscreen/viewer chrome and the fake viewport-sizing control from the playground UI.
- [ ] 2.2 Mount the stream through the new primitive.
- [ ] 2.3 Add container modes that visibly change the viewer container without changing the primitive.
- [ ] 2.4 Keep telemetry, overlay controls, action strip, and existing test selectors working.

## 3. Validation

- [ ] 3.1 Update package README client docs for the new primitive.
- [ ] 3.2 Run `openspec validate add-remote-surface-container-fit-viewer --strict`.
- [ ] 3.3 Run package and playground verification, then update dist artifacts.

## Acceptance checks

1. `pnpm --filter @opendatalabs/remote-surface playground:test`
2. `pnpm --filter @opendatalabs/remote-surface verify`
3. Headed Playwright smoke on desktop and Pixel 5 proving inline, modal, and odd-shaped container modes fit and map correctly.

## Context

Fumadocs currently emits one server collection that imports every documentation body. Development bundlers compile that graph eagerly, so the large `spec-core.md` module can exhaust the Node.js heap before `/specification` renders.

## Decision

Enable Fumadocs dynamic document mode. Navigation metadata remains available synchronously through the generated collection, while the selected page body and table of contents load through `page.data.load()`.

The generated `.source` artifacts remain tracked because the repository already tracks Fumadocs generation output. `@fumadocs/mdx-remote` is an explicit site dependency because it is the runtime used by Fumadocs dynamic collections.

## Alternatives

- Raising the Node.js heap limit leaves eager compilation in place and moves the failure threshold.
- Splitting the protocol document changes its source shape for a build-tool limitation.
- Loading all document bodies through the browser collection still builds the complete MDX graph eagerly.

## Scope

In scope: specification MDX loading, generated source artifacts, and the required runtime dependency.

Out of scope: document content, specification navigation, styling, theme behavior, and other site dependency cleanup.

## Acceptance checks

- The OpenSpec change validates strictly.
- Site type checking and tests pass.
- The production site build completes.
- `/specification` and a nested specification page render their document body and table of contents.

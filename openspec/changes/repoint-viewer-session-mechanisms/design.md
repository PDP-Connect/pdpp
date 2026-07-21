## Context

The viewer session is the mounted-path mechanism boundary. The console retains product policy: #347 decides when a trusted local gesture may request focus, and the clipboard sheet decides direction, manual fallback, and sensitive-text presentation.

## Decisions

- Use `session.focusKeyboard()` only in synchronous keyboard activation paths. The installed remote-surface distribution delegates it directly to the injected adapter's `focusTextInput()` method.
- Treat the session as available only when both the viewer and its injected adapter report `mounted`; the viewer can publish its session before the adapter's asynchronous mount resolves.
- Use `session.copyRemoteSelection()` for mounted browser-selection copy. Keep the sheet's typed-text send on the adapter because `pasteLocalClipboard()` cannot accept user-entered text; replacing it would drop manual and sensitive-text paste.
- Treat either a viewer diagnostic with `getViewportState() === "error"` or mount rejection as the existing inline retryable error state.

## Acceptance Checks

- Existing keyboard policy tests remain unmodified and pass.
- A focused trusted-tap path invokes the session method synchronously.
- Mounted selection copy uses the session; typed sheet paste remains policy-preserving.
- A viewport error renders the existing retry affordance.

# Remote Surface mobile trusted-input research

Access date: 2026-07-17

Scope: durable record of the platform research used for the bounded Remote Surface
mobile fix. This note adds no implementation scope.

## Sources and conclusions

| Source | Exact URL | Relevant conclusion |
| --- | --- | --- |
| “Transient activation - Glossary | MDN” | https://developer.mozilla.org/en-US/docs/Glossary/Transient_activation | Transient activation comes from a meaningful user interaction, is time-limited/consumable, and is available to the event handler for the originating pointer or touch gesture. A delayed transport callback cannot be treated as that activation. |
| “User activation - Security | MDN” | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation | Browser capabilities can be gated by user activation; code should invoke the gated operation from the trusted interaction path rather than an arbitrary asynchronous callback. |
| “HTMLElement: focus() method - Web APIs | MDN” | https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus | Source fact: `focus()` moves focus to an element. Project inference: the proxy call belongs in the trusted local affordance handler, while the remote event only reports confirmed focus state; this timing requirement is supported by the engine evidence below, not by this MDN page alone. |
| “VisualViewport - Web APIs | MDN” | https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport | Mobile layout and visual viewports can differ; the visual viewport can change when an on-screen keyboard appears. Layout fitting must therefore preserve the existing viewport negotiation and coordinate mapping while constraining the visible surface. |
| “`<meta name=\"viewport\">` HTML attribute value - HTML | MDN” | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport | Source fact: viewport metadata affects mobile layout sizing. Project inference: keep the existing page/remote viewport contract and address landscape overflow through local stream containment. |
| W3C, “CSS Viewport Module Level 1” | https://www.w3.org/TR/css-viewport-1/ | Source fact: the specification defines viewport sizing and the initial containing block. Project inference: the stream dialog can use bounded `100%` sizing without changing remote dimensions; the specification does not prove that project-specific remedy. |
| W3C, “VirtualKeyboard API” | https://www.w3.org/TR/virtual-keyboard/ | Source fact: virtual-keyboard behavior and visible geometry can be distinct from layout viewport behavior. Project inference: preserve the existing keyboard-overlay and safe-area policy and do not infer editability locally. |
| WebKit Bugzilla, “195884 – Autofocus on text input does not show keyboard” | https://bugs.webkit.org/show_bug.cgi?id=195884 | Engine evidence: WebKit documents that programmatic focus outside touch/user-gesture handling can focus an input without displaying the software keyboard, with behavior varying by platform/version. This is evidence for the project’s observed compatibility constraint, not a universal web-platform guarantee. |
| Chromium Blink source, `third_party/blink/renderer/core/dom/element.cc` | https://chromium.googlesource.com/chromium/src/%2B/f983be2fa84b1d8aeb5e7714d0ce82db5711c1f8/third_party/blink/renderer/core/dom/element.cc | Engine evidence: Blink’s focus path distinguishes script focus, checks transient activation for restricted script focus, and invokes virtual-keyboard display on focused elements in an activation context. This supports keeping the proxy focus call in the local gesture stack while treating emulation as proxy-focus evidence only. |

## Design consequences

- The transport-confirmed remote `keyboard_focus` event remains the only editable-state authority; no remote editable element is guessed.
- If confirmation already exists when a trusted coarse-pointer touch is released, the existing one-tap fast path synchronously calls the package-owned `focusTextInput()` primitive.
- If touch wins the race, the asynchronous event only exposes the existing corner keyboard control as an accessible, non-modal `Tap to type` affordance. Its trusted local tap synchronously focuses the proxy and then clears the affordance; SSE never opens the keyboard.
- The VisualViewport/layout-viewport distinction informed `100%`/`max-width: 100%` dialog sizing and stream-surface containment, while leaving remote viewport negotiation, coordinates, rotation settling, and safe-area behavior unchanged.

The AGENTS-referenced `ai/research/INDEX.md` was absent in this worktree; this file is the requested durable corpus artifact for the consulted primary sources.

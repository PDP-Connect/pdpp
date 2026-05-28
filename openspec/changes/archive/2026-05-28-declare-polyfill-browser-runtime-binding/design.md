## Context

The host-browser bridge change intentionally avoided durable `browser_automation` subfields such as profile persistence, owner-visible interaction, and headless sufficiency. That larger semantics question remains separate.

There is still a smaller honesty gap: a connector that imports the browser runtime is materially different from a network-only connector. Reviewers and operators should be able to see that requirement in the manifest before spawning the connector or approving a deployment.

## Decision

Use the existing `runtime_requirements.bindings` grammar and add a coarse `browser` binding:

```json
{
  "runtime_requirements": {
    "bindings": {
      "network": { "required": true },
      "browser": { "required": true }
    }
  }
}
```

This says only that the connector requires browser automation. It does not specify how the runtime satisfies it. Native host launches, headless Chromium, and the local host-browser bridge remain deployment choices.

## Non-Goals

- No `browser_automation` subfields in this slice.
- No conformance requirement for profile persistence, headed/headless sufficiency, stealth posture, or daily-profile policy.
- No connector UI redesign beyond making the requirement visible in manifests and runtime START bindings.

## Acceptance

- Every polyfill connector whose code declares a browser runtime config also declares `runtime_requirements.bindings.browser.required === true`.
- Non-browser connectors do not need the browser binding.
- The reference runtime advertises a `browser` available binding in START envelopes.
- The reference registry rejects malformed runtime requirement binding declarations.

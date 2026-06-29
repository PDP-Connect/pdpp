## 1. USAA source-unavailable classification

- [x] 1.1 Classify the observed USAA login source-unavailable state separately from selector drift.
- [x] 1.2 Mark that class retryable for the USAA runtime.
- [x] 1.3 Add focused tests for the classifier.

## 2. Patchright local install guard

- [x] 2.1 Skip optional Patchright Chromium download on known unsupported local hosts.
- [x] 2.2 Preserve strict failure when browser-download proof is required.

## 3. Validation

- [x] 3.1 Run the focused USAA test.
- [x] 3.2 Run the Patchright postinstall script on this host.
- [x] 3.3 Run `openspec validate harden-polyfill-operational-recovery --strict`.

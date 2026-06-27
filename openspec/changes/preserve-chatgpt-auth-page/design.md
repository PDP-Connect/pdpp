## Context

Live ChatGPT verification showed two consecutive runs in the same managed browser/profile. The first run requested app approval, authenticated, collected, and succeeded. The immediate follow-up run reused the same container and profile but requested app approval again. The Chromium cookie database stayed empty after success, while ChatGPT origin storage and run-page state existed during collection.

That makes a profile-only fix insufficient. The runtime must allow a connector to keep a successful authenticated page alive when the page itself is the durable browser-auth surface.

## Decision

Add `BrowserConfig.preservePageOnSuccess`.

When the flag is absent or false, the runtime keeps the current behavior: create a fresh page for the run and close it in `finally`.

When the flag is true:

- before creating a page, the runtime looks for an existing open page with a non-blank URL;
- remote-CDP acquisition skips its pre-attach page-target cleanup so the preserved page is not deleted before reuse;
- the runtime closes other stale pages as it does today;
- after a successful run, the runtime releases the browser lease but leaves the working page open;
- after a failed run, the runtime still closes the working page.

The ChatGPT connector opts in. Other browser connectors retain the default disposable-page lifecycle.

## Alternatives

### Store ChatGPT app-approval tokens outside the browser

Rejected for this tranche. The source-side app approval flow currently exposes run-page state, not a stable credential contract we should serialize.

### Keep every browser connector page open

Rejected. Banking, retail, and other browser connectors should not inherit a longer-lived page lifecycle without source-specific proof that it improves auth durability.

### Re-run the app approval automatically

Rejected. Repeated owner app-approval prompts are the user-visible failure. Automating the retry would hide, not fix, the lifecycle bug.

## Acceptance Checks

- Unit tests prove default browser connectors still create and close pages.
- Unit tests prove opted-in connectors reuse a non-blank existing page.
- Unit tests prove opted-in connectors close the page on failure.
- ChatGPT connector configuration includes the opt-in policy.
- A live ChatGPT follow-up run after one approved run does not emit another app-approval request.

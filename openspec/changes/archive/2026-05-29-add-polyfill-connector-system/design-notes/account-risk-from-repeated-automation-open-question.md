# Open question: account risk from repeated automation — how does the protocol protect the owner's account from being locked out of their own bank?

**Status:** open
**Raised:** 2026-04-21
**Trigger:** During USAA debugging this session, repeated failed login attempts from the connector triggered a USAA-side protection that locked the owner out entirely. The human owner, visiting usaa.com in a normal browser, was met with:

> "We are unable to complete your request. Our system is currently unavailable. Please try again later."

This is not a Playwright issue. It's not even a PDPP-specific issue. It's an inherent consequence of **"automate access to an account with failure tolerance"** — if the protocol lets a connector retry on failure (and it must, for transient errors), and the upstream has failure-count protection (and banks always do), then an aggressive retry policy can lock the owner out of critical surfaces.

**Important follow-up datapoint (2026-04-21 08:45):** mobile login still works. The account itself is not frozen; only the web-browser context is blocked. This matches the pattern documented in `chase-anti-bot.md` — upstreams differentiate per-device/per-fingerprint, not per-account. That doesn't make this harmless (the owner loses the ability to manage their money via web banking for the duration, and cross-device fingerprint-sharing IS possible), but it changes the severity and the recovery playbook significantly. A fresh browser fingerprint may recover web access; waiting for an "account thaw" is unnecessary if mobile still works.

**Framing:** This note is about the owner-protection dimension of `partial-run-semantics-open-question.md`'s retry discussion, but it's a distinct concern: not "how does the protocol know what was skipped" (production/retry side) but "how does the protocol avoid converting an ingest failure into a lockout of the owner's human account."

## Why this is a spec-level question, not a per-connector concern

Any reasonable connector for a protected site implements some form of retry logic:

- Login failed with a timeout? Probably transient — retry.
- Export dialog didn't produce a download? Shorten the range and try again.
- Session expired mid-run? Re-auth and continue.

Each of those retries is individually defensible. Stacked together across a debugging session, across multiple connector runs, across multiple concurrent connectors — they add up. And the threshold where "defensible retry policy" becomes "triggered lockout" is:

1. **Set by the upstream**, not PDPP (USAA, Chase, etc.)
2. **Undocumented**, typically — banks don't publish their lockout thresholds
3. **Variable by account**, per risk signals (new device, new geography, recent password change, etc.)
4. **Asymmetric**: a few failed logins might just trigger CAPTCHA; a few more might force password reset; a few more might flag the account for manual review with SLAs measured in business days.

The consequences scale similarly:

| Severity | Symptom | Recovery |
|---|---|---|
| Low | CAPTCHA challenge on next login | Solve once |
| Medium | Temporary cooldown (hours) | Wait, or call support |
| High | Forced password reset | Reset flow, SMS/email verification |
| Severe | Account flagged for fraud review | Manual review, potentially days-to-weeks |
| Catastrophic | Account frozen, cards blocked | In-person branch visit, legal documentation |

(Note: the 2026-04-21 USAA incident appears to be at the "Medium" level, constrained to the web-browser fingerprint — mobile login continued to work throughout. Banks differentiate per-device routing as a matter of course. Still owner-harm, but not account-level lockout.)

**A protocol that makes data portable cannot make the account inaccessible.** That would be the opposite of owner agency.

## Real-world severity surfaced by this session

Today's USAA cooldown is probably "Medium" — user is locked out of their own account while debugging was happening. If the owner had urgent banking needs, this would be a meaningful harm caused by the automation.

A careless future connector author could trivially escalate this. Imagine:

- A scheduled job that runs the USAA connector hourly
- A credential rotation triggers a password mismatch
- The connector retries on every schedule
- Within 12 hours, the owner has 12 failed logins tripping USAA's fraud-detection threshold
- The account is now "flagged for manual review" — severe consequences

The protocol has no mechanism to prevent this today.

## What the spec could require

### Option A — Per-connector declared failure budget in manifest

The manifest declares, per failure reason class, the maximum retries allowed in a time window before the connector MUST stop and emit an owner-visible alert:

```json
{
  "connector_id": "https://registry.pdpp.org/connectors/usaa",
  "failure_budget": {
    "auth_failed": { "max_attempts": 3, "window": "p1d" },
    "captcha_required": { "max_attempts": 1, "window": "p1d" },
    "download_timeout": { "max_attempts": 10, "window": "p1h" }
  }
}
```

- Pro: connector-author makes the risk trade-off explicit; runtime enforces mechanically.
- Con: the author is the wrong person to make this call for the owner — the author optimizes for "our connector works" not "owner's account stays healthy."

### Option B — Runtime-enforced circuit breaker with spec-defined classes

The spec defines failure classes (`auth_attempt`, `captcha_challenge`, `rate_limit_hit`, `download_failure`, etc.) and mandates runtime-level circuit breakers at conservative defaults:

- Auth attempts: max 2 per hour per connector, max 5 per day per connector
- Any `captcha_challenge` or `rate_limit_hit` signal: immediate pause for 4+ hours
- Cross-connector coordination: if Connector A hits a captcha, Connector B for the same platform must not run

Owner can raise limits per-connector via manifest config, but runtime defaults protect by default.

- Pro: safe-by-default; owner opts into higher risk consciously; runtime is the enforcer, not the connector.
- Con: defaults will be wrong for some connectors (YNAB's public API doesn't have lockout risk, so its budget should be infinite). Over-conservative defaults become a usability problem.

### Option C — Explicit owner consent for high-risk retries

Before any retry that might materially escalate risk (e.g., the third failed login in a run), the connector must emit an INTERACTION kind=`retry_authorization` that surfaces:
- What failed
- What retry would do
- What the known/suspected upstream risk is ("USAA may lock you out after 3 more attempts")
- A yes/no question

Owner explicitly authorizes each high-risk retry.

- Pro: honest; owner-agency first; forces risk to be surfaced.
- Con: friction spike during debugging; owner may rubber-stamp; some risk thresholds are invisible to the connector (USAA's actual lockout count is unknowable from the outside).

### Option D — Per-platform risk catalog in the PDPP registry

registry.pdpp.org maintains a shared catalog of known upstream protection behaviors:

```json
{
  "https://registry.pdpp.org/connectors/usaa": {
    "known_lockout_thresholds": {
      "failed_logins_per_hour": { "estimated": 3, "confidence": "medium" },
      "captcha_trigger": "after 2 failed logins",
      "cooldown_typical": "4-24h after 3 failed logins"
    },
    "observed_incidents": [
      { "date": "2026-04-21", "description": "Full account cooldown after ~15 failed logins during debugging" }
    ]
  }
}
```

Registry is community-contributed and periodically audited. Connectors consult it to inform their retry policies. Runtime pulls conservative bounds from the registry.

- Pro: collective intelligence; crowdsourced from real incidents; concrete numbers.
- Con: registry maintenance burden; banks change their thresholds; information asymmetry (we only know the thresholds we've hit).

### Option E — Observability + owner-side kill switch (minimal)

The spec doesn't enforce anything. It requires the runtime to:
1. Emit a `run.risked_upstream_lockout` spine event whenever any connector's failure count in a window crosses a heuristic threshold
2. Provide an owner-visible dashboard that surfaces these events
3. Document a kill-switch procedure (`pdpp-connectors pause <connector>`) so owners can stop runaway retries

- Pro: minimum spec change; treats this as an owner's responsibility.
- Con: owners may not notice in time; "I didn't know it was retrying every hour" is exactly the failure mode a real protocol should prevent.

### Option F — Do nothing

Treat as a connector-author responsibility.

- Pro: zero spec change.
- Con: owners can and will get locked out of their own accounts. This is catastrophic for adoption if/when it happens to someone with bills due that day.

## Additional dimensions the spec needs to address

Beyond which option, the spec has to answer:

1. **Reason-class taxonomy.** Same question the partial-run-semantics note raised for SKIP_RESULT. "An auth retry" and "a download retry" have radically different risk profiles. The taxonomy must distinguish them.

2. **Window semantics.** Is the failure-budget a rolling window, a fixed window, per-day, per-grant-lifetime? Different choices produce different emergent behavior.

3. **Cross-connector coordination.** If Connector A for USAA hits a captcha and Connector B for USAA (e.g., a different scope) is about to run, does B defer? Runtime-level vs connector-level knowledge of shared state.

4. **Testability.** A connector author iterating on USAA login locally will hit the real USAA's rate-limit in a debugging session (this happened in this repo this week). Is there a spec affordance for "local development bypass" that doesn't leak into production?

5. **Recovery playbook.** When an owner's account IS flagged, what does the protocol say about recovery? Is there a standard "account locked" spine event + recommended remediation path? Does the connector know it's locked vs just "auth failing"?

## Cross-cutting

- `partial-run-semantics-open-question.md` — same retry-related concern, but this note is about ACCOUNT RISK not DATA COMPLETENESS. They intersect: the retry-execution mechanism needs both semantics.
- `gap-recovery-execution-open-question.md` — `retriable_by_runtime` skips need to respect failure budgets.
- `cursor-finality-and-gap-awareness-open-question.md` — known gaps shouldn't be retried infinitely; failure-budget policy applies here too.
- `chase-anti-bot.md` — a specific case of this pattern (profile-reputation block rather than account-wide lockout, but same class of protection).
- `usaa.md` — concrete instance of the risk surfacing this session.
- `credential-bootstrap-automation-open-question.md` — if bootstrap can get the account into a locked state, the bootstrap process itself needs failure budgets.
- `owner-self-export-open-question.md` — self-export shouldn't be triggerable in a way that locks the owner out of the source platform.

## Action items

- [ ] Decide A / B / C / D / E / F (these compose somewhat — A+D or B+E are natural combinations).
- [ ] If A/B: define the failure-reason taxonomy shared with partial-run-semantics.
- [ ] If B/D: enumerate default failure budgets per platform for the 30 polyfill connectors and reason about their risk profiles.
- [ ] Regardless: add a runtime-level "suspicious retry rate" detector as a minimum safety floor, even if the spec defers most of the decision.
- [ ] Document this session's USAA incident as a concrete test case: "these sequences of actions locked the owner out for X hours" — useful for the registry in Option D.

## Why this is worth a dedicated note rather than extending partial-run-semantics

The partial-run-semantics note is about **data honesty**: did we actually get everything the grant said we would? This note is about **owner-account safety**: did our attempts to get data cost the owner their ability to access their account at all?

A protocol that solves the first without the second is building a trebuchet for the owner to hurl themselves through their bank's fraud-detection system. The second is the more load-bearing safety concern — a silent gap in a dataset is recoverable; a frozen bank account is not.

Owner agency means the owner's relationship with the source platform is more important than the data the owner grants to PDPP. The protocol must protect that relationship actively, not just hope connector authors do it right.

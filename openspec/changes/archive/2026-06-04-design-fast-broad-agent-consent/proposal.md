## Why

Live agent testing exposed a real product and protocol tension: owners need a fast way to grant a trusted assistant enough access to be useful, but PDPP must not turn that convenience into a disguised owner token or a one-click "all data" habit.

The current reference accepts one `authorization_details[]` entry per PAR request. That preserves source boundaries, but it makes high-trust setup across email, finance, Slack, GitHub, and local agent history painfully repetitive. The likely user workaround is worse: paste an owner token or approve maximal continuous grants one source at a time without understanding cumulative risk.

## What Changes

- Promote the fast broad-consent design note into a dedicated OpenSpec investigation.
- Keep the current source-bounded grant model as the safety baseline while evaluating faster owner-facing setup ceremonies.
- Evaluate grant packages, batch consent, owner-authored permission sets, and agent roles as candidate concepts.
- Define which behaviors must not be implemented casually: multi-source PAR, approve-many UI, reusable broad presets, or root-spec language changing grant boundaries.
- Require prior-art review before any protocol or reference implementation change.

## Capabilities

### Added

- `agent-consent-bundling`: proposed semantics and safety constraints for approving multiple source-bounded grants in one owner-facing ceremony.

### Modified

- None in this design track. The accepted implementation lives in the follow-up `implement-batch-consent-ceremony` change, which promoted Option B into reference-experimental runtime behavior without changing PDPP Core.

## Impact

- Potential future protocol areas: OAuth RAR/PAR profile, PDPP grant model, consent UI requirements, audit/revocation semantics, and agent skills.
- Potential future reference areas: `/oauth/par`, pending-consent storage, consent UI, grant timeline, dashboard grants, CLI/skill workflows.
- Security impact: high. Any accepted design must preserve least privilege, source-specific audit, revocation, and owner comprehension.

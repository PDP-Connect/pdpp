## 1. Spec And Design

- [x] 1.1 Capture prior-art research in the research corpus.
- [x] 1.2 Add OpenSpec proposal, design, tasks, and spec deltas.
- [x] 1.3 Validate with `openspec validate define-connection-repair-routing --strict`.

## 2. Semantic Inventory

- [x] 2.1 Inventory current manifest setup, refresh-policy, runtime-requirement, and repair-related fields.
- [x] 2.2 Classify each field as stable mechanism, scheduling policy, runtime binding, observed state, provider-specific instruction, or compatibility hint.
- [x] 2.3 Identify any field currently used to imply live readiness, repair state, or owner actionability.
- [x] 2.4 Document which compatibility fields remain supported and which are replaced by stable mechanism plus evidence-derived repair routing.

## 3. Implementation

- [x] 3.1 Update setup planning and connector summary synthesis so current repair state comes from connection evidence, not static manifest hints alone.
- [x] 3.2 Ensure scheduled/unattended runs that require owner-mediated repair record connection repair evidence and do not open interactive repair prompts.
- [x] 3.3 Ensure owner-started repair flows attach proof and any confirming run to the existing connection.
- [x] 3.4 Ensure dashboard, Runs, Sources, CLI, and owner-agent routes consume the same required-action/actionability projection.
- [x] 3.5 Keep provider-specific repair instructions inside structured runtime action metadata rather than manifest enums or source-specific UI branches.

## 4. Verification

- [x] 4.1 Add tests for browser-session repair where a valid session, expired session, and owner-restored session share the same manifest.
- [x] 4.2 Add tests proving scheduled runs defer owner-mediated repair while owner-started repair can complete and auto-resume.
- [x] 4.3 Add tests proving expired or superseded prompts do not dominate current actionability and do not make a connection falsely healthy.
- [x] 4.4 Add tests proving connector-specific progress/error strings do not decide owner actionability.
- [x] 4.5 Run focused reference/polyfill tests plus OpenSpec validation.

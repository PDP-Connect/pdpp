## MODIFIED Requirements

### Requirement: Temporary planning notes are not authoritative
Inbox memos, scratch notes, and other temporary planning artifacts MAY exist during exploration, but they SHALL not become an authoritative source once the relevant decision is captured in OpenSpec, code, tests, or the root PDPP specs.

#### Scenario: A working memo and OpenSpec disagree
- **WHEN** an inbox memo or other temporary planning artifact conflicts with OpenSpec, executable behavior, or the root PDPP specs
- **THEN** contributors SHALL treat the memo as stale and correct or ignore it rather than steering implementation from that stale note

#### Scenario: A working memo has been absorbed
- **WHEN** the substance of a temporary planning note has been incorporated into OpenSpec, code, tests, or the root PDPP specs
- **THEN** contributors SHOULD stop extending that temporary note as an active source of execution truth

#### Scenario: Active execution planning continues
- **WHEN** work continues on a cross-cutting implementation tranche after an OpenSpec change exists for that tranche
- **THEN** contributors SHALL extend the relevant OpenSpec change rather than creating new inbox memos as the primary execution-planning layer

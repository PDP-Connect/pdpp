# GNAP decision record

Status: pointer

`design-notes/seam-spike/corpus.md` is the sole execution definition. Its Case
7 is a pure GNAP feasibility and control mapping. GNAP is non-gating for the
PR89 OAuth/RAR seam decision.

PR89 does not implement a GNAP binding or claim GNAP conformance. The map must
round-trip the Source-defined `ApprovedAuthorization` rights, represent a
narrowed approval unambiguously, and reject an unknown mandatory member. Its
control table may classify a capability as `mapped`, `GNAP-native but
binding-owned`, or `not demonstrated`. `not demonstrated` is never a pass.

The map does not define a second grant schema. It consumes the Source contract
with `source_id`, `access_mode`, and stream `name`, `instance_ids`, `fields`,
optional frozen-field `time_constraint`, and optional canonical `resources`.

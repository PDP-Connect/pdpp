# Redesign Owner Console Product Experience

## Why

The owner console still fails the product promise even after several verified UI tranches. the owner's 2026-06-18 walkthrough shows the same root pattern across Dashboard, Sources, Add Data, Explore, Runs, Grants, Traces, Owner Tokens, and local-collector recovery: the console exposes implementation artifacts as primary UX objects, computes the same truth in multiple places, and asks the owner to infer the next action.

This change treats `docs/inbox/the owner-feedback-6-18-26.md` as discovery evidence, not as a finite bug list. The goal is to establish the product model, journey ledger, acceptance gates, and implementation sequence needed to make a motivated personal-server owner feel:

> I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system.

## What Changes

- Define the owner console's essential product model: Source, Record, Grant, Run/Trace evidence, Device, Schedule, Credential.
- Normalize the console around six stable owner journeys: source inventory, source setup/configuration, record inspection, source recovery, access/grants, and activity/audit evidence.
- Define SLVP interaction-archetype standards for record workbenches, source setup, source inventory, recovery, access review, evidence timelines, and craft.
- Treat Runs, Traces, Device Exporters, diagnostics, and raw timelines as evidence layers unless the owner is debugging a specific subject.
- Require a journey-keyed evidence atlas, real browser evidence, technical truth probes, and adversarial review before broad UI implementation.
- Define implementation waves that reduce incidental complexity before adding polish.
- Establish worker/delegation rules for high-velocity low-burn execution without letting narrow lanes decide product direction.

## Capabilities

Modified:

- `reference-surface-topology`

## Impact

- No product code changes are authorized by this proposal alone.
- Future owner-console changes that affect navigation, source setup, source state, record inspection, recovery, grant/read presentation, or evidence surfaces must map to the journey ledger and acceptance gates in this change.
- Existing console UI work may need to be reverted, replaced, or re-sequenced if it improves local copy while preserving the wrong product model.
- Some current routes may remain as compatibility redirects, but owner-facing copy, navigation, and CTA destinations must converge on the new surface model.

# PDPP docs

- **[reference/](reference/)** — durable guides, architecture, and design contracts (testing policy, connector authoring, local collector, e2e testing, release policy, concept inventory, experience architecture, voice and framing).
- **[design-system/](design-system/)** — the Ink Carbon design system: spec, tokens, primitives, and reference implementations.
- **[operator/](operator/)** — runbooks and operator guides for running a PDPP deployment.
- **[agent-skills/](agent-skills/)** — packaged agent skills for accessing PDPP data and owning an instance.
- **[positioning/](positioning/)** — why PDPP exists and how it relates to adjacent standards.
- **[personas/](personas/)** — onboarding for reviewers and standards editors.
- **[explorer/](explorer/)** — UAT harness for the record explorer.
- **[research/](research/)** — prior-art studies, design investigations, and audits.

## Maintenance checks

- **[reference/ledger-freshness.md](reference/ledger-freshness.md)** — re-tests the
  status column of the owner commitments ledger against GitHub and git, so a row
  cannot silently rot into a false-open or false-closed reading. Read-only;
  `node --import tsx scripts/ledger-freshness.ts`.

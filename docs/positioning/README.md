# PDPP Positioning

Canonical answers to the recurring "where does PDPP sit / why not just X" questions.

When external person, the LFDT TAC, a reviewer like external person, or a new teammate asks where PDPP
fits relative to OAuth, DTI, verifiable credentials, or "why now," the settled answer
should be here — not re-derived from scratch each time, and consistent across whoever
is answering.

## What a position file is

Each file captures one durable stance, not bare Q&A. Format:

- **Asked as** — the real phrasings that trigger this position (the index).
- **Short answer** — 2-3 sentences; what you say first.
- **Why it's true** — reasoning + citations (link into `docs/research/` and the spec).
- **What we do NOT claim** — the honest limits and concessions. This is what keeps the
  position credible and stops overclaiming next time.
- **Status** — settled, or an open design fork.

Positions cite evidence in `docs/research/`; they do not restate it. Spec *gaps* a
position surfaces belong in OpenSpec change proposals, not here.

## Positions

- [PDPP and OAuth 2.0](pdpp-and-oauth.md) — domain profile over OAuth + RFC 9396; adds structure, not a new protocol.
- [PDPP and DTI/DTP](pdpp-and-dti.md) — consent/access layer vs. transfer mechanics; structural envelope vs. vertical content schemas.
- [Why grants are durable](why-grants-are-durable.md) — continuous access is primary; regulatory/audit secondary; sharing-as-credential is not the reason.
- [Persistence and self-sovereignty](persistence-and-self-sovereignty.md) — v0.1 is server-anchored; signed grants are the path to user-held; revocation is the residual live dependency.
- [Why a horizontal consent layer, why now](why-a-horizontal-consent-layer-why-now.md) — solved in regulated verticals; the gap is incentive/coordination, not technical; the agent-era bet.
- [The read surface](the-read-surface.md) — PDPP is a queryable substrate, not only a consent layer; the normative §8 capability inventory and what not to overclaim.

## Related

- Spec: `apps/site/content/docs/spec-core.md`

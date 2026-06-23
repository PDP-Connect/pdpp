# Position: PDPP and DTI / DTP

**Status:** Settled (v0.1), with collaboration paths open.

## Asked as

- "How does PDPP relate to the Data Transfer Initiative / Data Transfer Project?"
- "Isn't this just data portability, which DTI already does?"
- "Do PDPP and DTI compete?"

## Short answer

DTP (the Data Transfer Project, DTI's open-source project) says how a service can package
its user's data into a standard model and push it to another service. PDPP says how a
service can serve its user's data over a standard interface, so that another service or
any client can access the subset of the data the user allowed. They operate at different
points: DTP is transfer mechanics; PDPP is the consent/authorization and standing-access
layer that can precede or drive a transfer. They are complementary, not competitive.

## Why it's true

- **Interaction model differs.** DTP is built for one-shot, source-orchestrated, push
  bulk transfers: a transfer worker running inside the exporting service moves a copy A→B,
  reusing each service's existing proprietary API via adapters. PDPP defines a standing
  resource-server interface that clients pull fine-grained data from over time, under a
  scoped grant.
- **Data model differs in kind, not just detail.** DTP defines canonical per-content-type
  models — e.g. a literal `PhotoModel.java` with `albumId`, `mediaType`, `fetchableUrl`,
  plus a documented process for authoring the next vertical (calendar, mail, playlists).
  PDPP does **not** define canonical content schemas and by design does not need them: it
  defines a generic record-and-field envelope within which each service's own schema is
  declared via a connector manifest. DTP standardizes a catalog of content schemas; PDPP
  standardizes a structural contract. (PhotoModel:
  https://github.com/dtinit/data-transfer-project/blob/master/portability-types-common/src/main/java/org/datatransferproject/types/common/models/photos/PhotoModel.java)
- **Consent is the cleanest composition point.** DTP has no first-class, structured
  consent artifact — it leans on the source service's existing auth plus a user-initiated
  "transfer now." PDPP's contribution is exactly that missing piece. A PDPP grant could
  authorize a DTP-style transfer.

## Collaboration paths (not commitments)

- DTP could adopt a tailored subset of PDPP to standardize its consent/authorization step.
- DTP could build on PDPP for consented, on-demand, filtered access rather than only bulk
  export.
- Longer term, there may be natural convergence between DTP and PDPP as the consent and
  transfer layers mature.

## What we do NOT claim

- We do **not** claim PDPP "replaces" or "absorbs" DTI/DTP. DTP has its own governance and
  years of momentum; "unify" reads as "absorb" to a neutral body and should be avoided,
  especially in external/standards contexts.
- We are careful to say **DTP** (the project/codebase) for the technical contrasts and
  **DTI** (the nonprofit) for the organization — they are not interchangeable.
- DTP's "common data models" are reference-implementation Java classes used by adapters,
  not a published wire spec — describe them as such ("DTP's data models, e.g. `PhotoModel`"),
  not as a formal standard document.
- Unverified: whether a specific "Apple Photos → Google Photos" adapter route exists in DTP.
  Prefer "during a bulk photo export between services" unless confirmed.

## References

- `docs/research/pdpp-consent-artifact-persistence-and-sharing-brief-2026-06-23.md` (DTI/PDPP boundary).
- `apps/site/content/docs/spec-core.md` — Appendix B (Relationship to the Data Transfer Project), record model (§4), connector manifest.
- DTI: https://dtinit.org/ ; DTP "what is it": https://dtinit.org/docs/dtp-what-is-it ; repo: https://github.com/dtinit/data-transfer-project

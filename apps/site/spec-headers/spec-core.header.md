---
title: "Protocol"
description: "Authorization and disclosure semantics for personal data — record model, selection request, grant, manifest, and resource server interface."
---

<Callout type="info" title="Spec status">
  Status: **Normative draft**

  Date: 2026-04-06

  Scope: Authorization and disclosure semantics for personal data: record model, selection request, grant, manifest, and resource server interface.
</Callout>

## The specification set {#specification-set}

Each document carries its own status line in the repository, and that line is authoritative.

| Document | File | Status |
| --- | --- | --- |
| PDPP Core | `spec-core.md` | Normative draft · 2026-04-06 |
| Collection Profile | `spec-collection-profile.md` | Companion profile draft · 2026-04-11 |
| Extension Profile: Lexical Search | `spec-ext-lexical-search.md` | Draft extension profile · 2026-07-06 |
| Extension Profile: Aggregation | `spec-ext-aggregation.md` | Draft extension profile · 2026-07-06 |
| Semantic Retrieval Extension | `spec-semantic-retrieval-extension.md` | Draft extension profile (experimental) · 2026-04-24 |
| Deferred Concerns | `spec-deferred.md` | Informative · 2026-04-06 (revised) |
| System architecture | `spec-architecture.md` | Informative · 2026-07-07 |
| Authentication design | `spec-auth-design.md` | Informative · 2026-07-07 |
| Change tracking design | `spec-change-tracking.md` | Informative · 2026-07-07 |
| Connector ecosystem | `spec-connector-ecosystem.md` | Informative · 2026-07-07 |
| Data Query API | `spec-data-query-api.md` | Superseded · 2026-04-12 |

Only PDPP Core is normative. The Collection Profile describes how connectors collect data and write it to a resource server. A core resource server is not required to implement any of it.

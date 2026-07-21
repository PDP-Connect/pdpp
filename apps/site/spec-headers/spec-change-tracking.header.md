---
title: "Change Tracking"
description: "Design rationale for grant-relative incremental sync via changes_since cursors, not canonical changelog streams."
---

<Callout type="info" title="Spec status">
  Status: **Informative**

  Date: 2026-07-07 (revised from 2026-04-06)

  Scope: Design rationale and decision history for grant-relative incremental sync. The normative mechanics live in [spec-core](spec-core): Section 4 defines stream semantics, the snapshot model, and tombstones; Section 8 defines the `changes_since` query surface.
</Callout>
